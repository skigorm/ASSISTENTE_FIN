const fs = require('fs/promises');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { createClient } = require('redis');
const {
  ALLOWED_CATEGORIES,
  logError,
  logInfo,
  logWarn,
  normalizeCategoryName,
  sanitizeText
} = require('./utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TRANSACTIONS_FILE = path.join(DATA_DIR, 'transactions.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const REDIS_DATA_PREFIX_ENV = 'WHATSAPP_DATA_PREFIX';
const DEFAULT_REDIS_DATA_PREFIX = 'finance-bot:transactions';
const REDIS_TLS_ENV = 'REDIS_TLS';
const REDIS_TLS_REJECT_UNAUTHORIZED_ENV = 'REDIS_TLS_REJECT_UNAUTHORIZED';

const REDIS_FALLBACK_COOLDOWN_MS = 30000;
const DEFAULT_STATE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_ALERT_THRESHOLDS = [10, 20, 30];

let writeQueue = Promise.resolve();

let redisClient = null;
let redisConnectPromise = null;
let redisUnavailableUntil = 0;
let redisErrorAlreadyLogged = false;
let redisReadyAlreadyLogged = false;

function isEnvEnabled(name, defaultValue = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();

  if (!value) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(value);
}

function getRedisDataPrefix() {
  const customPrefix = String(process.env[REDIS_DATA_PREFIX_ENV] || '').trim();
  return customPrefix || DEFAULT_REDIS_DATA_PREFIX;
}

function getRedisUrl() {
  return String(process.env.REDIS_URL || '').trim();
}

function getRedisUsersKey(prefix) {
  return `${prefix}:users`;
}

function getRedisUserTransactionsKey(prefix, user) {
  return `${prefix}:user:${sanitizeText(user)}`;
}

function getRedisUserProfileKey(prefix, user) {
  return `${prefix}:profile:${sanitizeText(user)}`;
}

function getRedisConversationStateKey(prefix, user) {
  return `${prefix}:state:${sanitizeText(user)}`;
}

function roundTo2(value) {
  return Number(Number(value).toFixed(2));
}

function createTransactionId() {
  try {
    return `tx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  } catch (_error) {
    const rand = Math.random().toString(36).slice(2, 12);
    return `tx_${Date.now().toString(36)}${rand}`;
  }
}

function buildLegacyTransactionId(record, indexHint = 0) {
  const hash = createHash('sha1')
    .update([
      sanitizeText(record.user),
      String(record.valor),
      sanitizeText(record.categoria),
      sanitizeText(record.descricao),
      sanitizeText(record.data),
      String(indexHint)
    ].join('|'))
    .digest('hex')
    .slice(0, 12);

  return `legacy_${hash}`;
}

function normalizeTransactionRecord(record, options = {}) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const assignIdIfMissing = Boolean(options.assignIdIfMissing);
  const indexHint = Number.isInteger(options.indexHint) ? options.indexHint : 0;

  const user = sanitizeText(record.user);
  const valor = Number(record.valor);
  const categoria = normalizeCategoryName(record.categoria, 'Outros');
  const descricao = sanitizeText(record.descricao);
  const data = sanitizeText(record.data);

  if (!user || !Number.isFinite(valor) || valor <= 0 || !descricao || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return null;
  }

  let id = sanitizeText(record.id);

  if (!id && assignIdIfMissing) {
    id = createTransactionId();
  }

  if (!id) {
    id = buildLegacyTransactionId(record, indexHint);
  }

  const nowIso = new Date().toISOString();
  const createdAt = sanitizeText(record.createdAt) || nowIso;
  const updatedAt = sanitizeText(record.updatedAt) || createdAt;

  return {
    id,
    user,
    valor: roundTo2(valor),
    categoria,
    descricao,
    data,
    createdAt,
    updatedAt
  };
}

function parseRedisRecord(raw, options = {}) {
  try {
    const parsed = JSON.parse(raw);
    return normalizeTransactionRecord(parsed, options);
  } catch (_error) {
    return null;
  }
}

function normalizeAlertThresholds(input) {
  const source = Array.isArray(input) ? input : DEFAULT_ALERT_THRESHOLDS;
  const filtered = source
    .map((item) => Number.parseInt(String(item), 10))
    .filter((value) => Number.isInteger(value) && value > 0 && value < 100);

  if (!filtered.length) {
    return [...DEFAULT_ALERT_THRESHOLDS];
  }

  return [...new Set(filtered)].sort((a, b) => a - b);
}

function normalizeCustomCategories(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  const normalized = input
    .map((item) => normalizeCategoryName(item, ''))
    .filter(Boolean)
    .filter((item) => !ALLOWED_CATEGORIES.includes(item));

  return [...new Set(normalized)];
}

function normalizeUserAuthAlias(value) {
  const raw = String(value || '').trim();

  if (!raw) {
    return '';
  }

  const base = raw.includes('@') ? raw.replace(/@.+$/, '') : raw;
  const digits = base.replace(/\D/g, '');

  if (digits.length < 8 || digits.length > 20) {
    return '';
  }

  return digits;
}

function normalizeAuthAliases(input, user) {
  const aliases = new Set();

  const addAlias = (value) => {
    const normalized = normalizeUserAuthAlias(value);

    if (normalized) {
      aliases.add(normalized);
    }
  };

  if (Array.isArray(input)) {
    for (const item of input) {
      addAlias(item);
    }
  }

  addAlias(user);
  return [...aliases];
}

function buildCategorySet(customCategories = []) {
  const categories = [...ALLOWED_CATEGORIES];

  for (const category of normalizeCustomCategories(customCategories)) {
    if (!categories.includes(category)) {
      categories.push(category);
    }
  }

  return categories;
}

function normalizeBudgetByCategory(input, customCategories = []) {
  const categorySet = buildCategorySet(customCategories);
  const result = {};

  for (const category of categorySet) {
    result[category] = null;
  }

  if (!input || typeof input !== 'object') {
    return result;
  }

  for (const [rawCategory, raw] of Object.entries(input)) {
    const category = normalizeCategoryName(rawCategory, '');

    if (!category) {
      continue;
    }

    if (!result[category]) {
      result[category] = null;
    }

    const value = Number(raw);

    if (Number.isFinite(value) && value > 0) {
      result[category] = roundTo2(value);
    }
  }

  return result;
}

function normalizeAlertSentMap(input) {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const result = {};

  for (const [key, list] of Object.entries(input)) {
    const safeKey = sanitizeText(key);

    if (!safeKey) {
      continue;
    }

    const values = Array.isArray(list)
      ? list
        .map((item) => Number.parseInt(String(item), 10))
        .filter((value) => Number.isInteger(value) && value > 0 && value <= 100)
      : [];

    if (!values.length) {
      continue;
    }

    result[safeKey] = [...new Set(values)].sort((a, b) => a - b);
  }

  return result;
}

function normalizeUserProfileRecord(user, profile = {}) {
  const safeUser = sanitizeText(user || profile.user);

  if (!safeUser) {
    return null;
  }

  const nowIso = new Date().toISOString();
  const monthlyIncome = Number(profile.monthlyIncome);
  const customFromList = normalizeCustomCategories(profile.customCategories);
  const customFromBudgets = profile.budgetByCategory && typeof profile.budgetByCategory === 'object'
    ? Object.keys(profile.budgetByCategory)
      .map((item) => normalizeCategoryName(item, ''))
      .filter((item) => item && !ALLOWED_CATEGORIES.includes(item))
    : [];
  const customCategories = [...new Set([...customFromList, ...customFromBudgets])];
  const authAliases = normalizeAuthAliases(profile.authAliases, safeUser);

  return {
    user: safeUser,
    name: sanitizeText(profile.name).slice(0, 80),
    authAliases,
    accessEnabled: profile.accessEnabled !== false,
    monthlyIncome: Number.isFinite(monthlyIncome) && monthlyIncome > 0 ? roundTo2(monthlyIncome) : null,
    customCategories,
    budgetByCategory: normalizeBudgetByCategory(profile.budgetByCategory, customCategories),
    alertThresholds: normalizeAlertThresholds(profile.alertThresholds),
    alertSent: normalizeAlertSentMap(profile.alertSent),
    onboardingComplete: Boolean(profile.onboardingComplete),
    createdAt: sanitizeText(profile.createdAt) || nowIso,
    updatedAt: sanitizeText(profile.updatedAt) || nowIso,
    lastInteractionAt: sanitizeText(profile.lastInteractionAt) || nowIso
  };
}

function normalizeConversationStateRecord(state) {
  if (!state || typeof state !== 'object') {
    return null;
  }

  const step = sanitizeText(state.step);

  if (!step) {
    return null;
  }

  const nowIso = new Date().toISOString();
  const expiresAt = Number(state.expiresAt);

  return {
    step,
    data: state.data && typeof state.data === 'object' ? state.data : {},
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    updatedAt: sanitizeText(state.updatedAt) || nowIso
  };
}

function buildDefaultProfile(user) {
  return normalizeUserProfileRecord(user, {
    name: '',
    authAliases: [],
    accessEnabled: true,
    monthlyIncome: null,
    customCategories: [],
    budgetByCategory: {},
    alertThresholds: DEFAULT_ALERT_THRESHOLDS,
    alertSent: {},
    onboardingComplete: false
  });
}

async function ensureStorageFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(TRANSACTIONS_FILE);
  } catch (_error) {
    await fs.writeFile(TRANSACTIONS_FILE, '[]\n', 'utf8');
  }

  try {
    await fs.access(USERS_FILE);
  } catch (_error) {
    await fs.writeFile(USERS_FILE, `${JSON.stringify({ profiles: {}, states: {} }, null, 2)}\n`, 'utf8');
  }
}

async function readTransactionsUnsafe() {
  const content = await fs.readFile(TRANSACTIONS_FILE, 'utf8');
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? parsed : [];
}

async function writeTransactionsUnsafe(list) {
  await fs.writeFile(TRANSACTIONS_FILE, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

async function readUsersUnsafe() {
  const content = await fs.readFile(USERS_FILE, 'utf8');
  const parsed = JSON.parse(content);

  if (!parsed || typeof parsed !== 'object') {
    return { profiles: {}, states: {} };
  }

  return {
    profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
    states: parsed.states && typeof parsed.states === 'object' ? parsed.states : {}
  };
}

async function writeUsersUnsafe(payload) {
  const normalized = {
    profiles: payload && payload.profiles && typeof payload.profiles === 'object' ? payload.profiles : {},
    states: payload && payload.states && typeof payload.states === 'object' ? payload.states : {}
  };

  await fs.writeFile(USERS_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

function isDuplicate(existingTransactions, transaction) {
  return existingTransactions.some((item) => {
    return (
      item.user === transaction.user &&
      Number(item.valor) === Number(transaction.valor) &&
      item.categoria === transaction.categoria &&
      sanitizeText(item.descricao).toLowerCase() === sanitizeText(transaction.descricao).toLowerCase() &&
      item.data === transaction.data
    );
  });
}

function withWriteLock(task) {
  const execution = writeQueue.then(task, task);
  writeQueue = execution.catch(() => null);
  return execution;
}

async function getRedisClient() {
  const redisUrl = getRedisUrl();

  if (!redisUrl) {
    return null;
  }

  if (Date.now() < redisUnavailableUntil) {
    return null;
  }

  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  if (redisConnectPromise) {
    return redisConnectPromise;
  }

  redisConnectPromise = (async () => {
    const useTls = isEnvEnabled(REDIS_TLS_ENV, redisUrl.startsWith('rediss://'));
    const tlsRejectUnauthorized = isEnvEnabled(REDIS_TLS_REJECT_UNAUTHORIZED_ENV, false);
    const createRedisInstance = (rejectUnauthorized) => {
      const client = createClient({
        url: redisUrl,
        socket: {
          connectTimeout: 10000,
          tls: useTls,
          rejectUnauthorized,
          reconnectStrategy: (retries) => {
            if (retries >= 3) {
              return new Error('Redis indisponível para storage.');
            }

            return Math.min((retries + 1) * 200, 1000);
          }
        }
      });

      client.on('error', (error) => {
        if (!redisErrorAlreadyLogged) {
          redisErrorAlreadyLogged = true;
          logError('STORAGE', 'Erro no cliente Redis do storage.', error.message);
        }
      });

      return client;
    };

    let client = createRedisInstance(tlsRejectUnauthorized);
    let triedRelaxedTls = false;

    try {
      await client.connect();
      redisClient = client;
      redisUnavailableUntil = 0;
      redisErrorAlreadyLogged = false;

      if (!redisReadyAlreadyLogged) {
        redisReadyAlreadyLogged = true;
        logInfo('STORAGE', 'Persistência de dados ativa via Redis.');
      }

      return client;
    } catch (error) {
      const message = error && error.message ? String(error.message) : String(error);
      const selfSignedTlsError = /self[- ]signed certificate/i.test(message);

      if (useTls && tlsRejectUnauthorized && selfSignedTlsError && !triedRelaxedTls) {
        triedRelaxedTls = true;
        logWarn(
          'STORAGE',
          'Falha TLS no Redis de dados. Tentando novamente com REDIS_TLS_REJECT_UNAUTHORIZED=false.'
        );

        try {
          client.disconnect();
        } catch (_disconnectError) {
          // noop
        }

        client = createRedisInstance(false);

        try {
          await client.connect();
          redisClient = client;
          redisUnavailableUntil = 0;
          redisErrorAlreadyLogged = false;

          if (!redisReadyAlreadyLogged) {
            redisReadyAlreadyLogged = true;
            logInfo('STORAGE', 'Persistência de dados ativa via Redis.');
          }

          return client;
        } catch (retryError) {
          try {
            client.disconnect();
          } catch (_innerDisconnectError) {
            // noop
          }

          redisUnavailableUntil = Date.now() + REDIS_FALLBACK_COOLDOWN_MS;

          if (!redisErrorAlreadyLogged) {
            redisErrorAlreadyLogged = true;
            logError('STORAGE', 'Falha ao conectar no Redis para storage.', retryError.message);
          }

          return null;
        }
      }

      redisUnavailableUntil = Date.now() + REDIS_FALLBACK_COOLDOWN_MS;

      if (!redisErrorAlreadyLogged) {
        redisErrorAlreadyLogged = true;
        logError('STORAGE', 'Falha ao conectar no Redis para storage.', error.message);
      }

      try {
        client.disconnect();
      } catch (_disconnectError) {
        // noop
      }

      return null;
    } finally {
      redisConnectPromise = null;
    }
  })();

  return redisConnectPromise;
}

function sortTransactionsByDateDesc(list) {
  return [...list].sort((left, right) => {
    if (left.data !== right.data) {
      return right.data.localeCompare(left.data);
    }

    const leftRef = sanitizeText(left.updatedAt || left.createdAt || '');
    const rightRef = sanitizeText(right.updatedAt || right.createdAt || '');
    return rightRef.localeCompare(leftRef);
  });
}

async function readAllTransactionsFromFile(options = {}) {
  const persistMissingIds = Boolean(options.persistMissingIds);

  try {
    await ensureStorageFiles();
    const list = await readTransactionsUnsafe();
    let changed = false;

    const normalized = list
      .map((item, index) => {
        const normalizedRecord = normalizeTransactionRecord(item, {
          assignIdIfMissing: true,
          indexHint: index
        });

        if (!normalizedRecord) {
          changed = true;
          return null;
        }

        if (!item.id || normalizedRecord.id !== item.id) {
          changed = true;
        }

        return normalizedRecord;
      })
      .filter(Boolean);

    if (changed && persistMissingIds) {
      await writeTransactionsUnsafe(normalized);
    }

    return normalized;
  } catch (error) {
    logError('STORAGE', 'Falha ao ler transactions.json. Retornando lista vazia.', error.message);
    return [];
  }
}

async function getTransactionsByUserFromFile(user, options = {}) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return [];
  }

  const list = await readAllTransactionsFromFile(options);
  return list.filter((item) => item.user === safeUser);
}

async function saveTransactionToFile(user, transaction) {
  await ensureStorageFiles();

  const list = await readAllTransactionsFromFile({ persistMissingIds: true });

  const nowIso = new Date().toISOString();
  const normalizedRecord = normalizeTransactionRecord(
    {
      user: sanitizeText(user),
      id: transaction.id,
      valor: Number(transaction.valor),
      categoria: sanitizeText(transaction.categoria),
      descricao: sanitizeText(transaction.descricao),
      data: sanitizeText(transaction.data),
      createdAt: transaction.createdAt || nowIso,
      updatedAt: transaction.updatedAt || nowIso
    },
    {
      assignIdIfMissing: true,
      indexHint: list.length
    }
  );

  if (!normalizedRecord) {
    throw new Error('Transação inválida para persistência');
  }

  if (isDuplicate(list, normalizedRecord)) {
    return { saved: false, duplicate: true, record: normalizedRecord };
  }

  list.push(normalizedRecord);
  await writeTransactionsUnsafe(list);

  logInfo('STORAGE', 'Transação salva com sucesso (arquivo).', normalizedRecord);
  return { saved: true, duplicate: false, record: normalizedRecord };
}

async function rewriteRedisUserTransactions(client, user, list) {
  const prefix = getRedisDataPrefix();
  const userKey = getRedisUserTransactionsKey(prefix, user);
  const usersKey = getRedisUsersKey(prefix);

  const multi = client.multi();
  multi.del(userKey);

  if (Array.isArray(list) && list.length) {
    multi.rPush(userKey, list.map((item) => JSON.stringify(item)));
    multi.sAdd(usersKey, sanitizeText(user));
  }

  await multi.exec();
}

async function getTransactionsByUserFromRedis(client, user, options = {}) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return [];
  }

  const persistMissingIds = Boolean(options.persistMissingIds);
  const prefix = getRedisDataPrefix();
  const key = getRedisUserTransactionsKey(prefix, safeUser);

  const rawList = await client.lRange(key, 0, -1);
  let changed = false;

  const normalized = rawList
    .map((raw, index) => {
      const parsed = parseRedisRecord(raw, {
        assignIdIfMissing: true,
        indexHint: index
      });

      if (!parsed) {
        changed = true;
        return null;
      }

      try {
        const original = JSON.parse(raw);

        if (!original.id || original.id !== parsed.id) {
          changed = true;
        }
      } catch (_error) {
        changed = true;
      }

      return parsed;
    })
    .filter((item) => item && item.user === safeUser);

  if (changed && persistMissingIds) {
    await rewriteRedisUserTransactions(client, safeUser, normalized);
  }

  return normalized;
}

async function readAllTransactionsFromRedis(client) {
  const prefix = getRedisDataPrefix();
  const usersKey = getRedisUsersKey(prefix);
  const users = await client.sMembers(usersKey);

  if (!Array.isArray(users) || users.length === 0) {
    return [];
  }

  const lists = await Promise.all(
    users.map(async (user) => {
      return getTransactionsByUserFromRedis(client, user, { persistMissingIds: true });
    })
  );

  return lists.flat();
}

async function saveTransactionToRedis(client, user, transaction) {
  const safeUser = sanitizeText(user);
  const existing = await getTransactionsByUserFromRedis(client, safeUser, { persistMissingIds: true });
  const nowIso = new Date().toISOString();

  const normalizedRecord = normalizeTransactionRecord(
    {
      user: safeUser,
      id: transaction.id,
      valor: Number(transaction.valor),
      categoria: sanitizeText(transaction.categoria),
      descricao: sanitizeText(transaction.descricao),
      data: sanitizeText(transaction.data),
      createdAt: transaction.createdAt || nowIso,
      updatedAt: transaction.updatedAt || nowIso
    },
    {
      assignIdIfMissing: true,
      indexHint: existing.length
    }
  );

  if (!normalizedRecord) {
    throw new Error('Transação inválida para persistência');
  }

  if (isDuplicate(existing, normalizedRecord)) {
    return { saved: false, duplicate: true, record: normalizedRecord };
  }

  existing.push(normalizedRecord);
  await rewriteRedisUserTransactions(client, safeUser, existing);

  logInfo('STORAGE', 'Transação salva com sucesso (Redis).', normalizedRecord);
  return { saved: true, duplicate: false, record: normalizedRecord };
}

async function findTransactionByIdInList(list, transactionId) {
  const safeId = sanitizeText(transactionId);

  if (!safeId) {
    return { index: -1, record: null };
  }

  const index = list.findIndex((item) => sanitizeText(item.id) === safeId);

  if (index < 0) {
    return { index: -1, record: null };
  }

  return {
    index,
    record: list[index]
  };
}

async function updateTransactionByIdInRedis(client, user, transactionId, updates) {
  const safeUser = sanitizeText(user);
  const list = await getTransactionsByUserFromRedis(client, safeUser, { persistMissingIds: true });
  const found = await findTransactionByIdInList(list, transactionId);

  if (found.index < 0) {
    return null;
  }

  const current = found.record;
  const merged = normalizeTransactionRecord(
    {
      ...current,
      ...updates,
      id: current.id,
      user: current.user,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    },
    {
      assignIdIfMissing: false,
      indexHint: found.index
    }
  );

  if (!merged) {
    throw new Error('Dados inválidos para atualizar transação');
  }

  list[found.index] = merged;
  await rewriteRedisUserTransactions(client, safeUser, list);
  return merged;
}

async function deleteTransactionByIdInRedis(client, user, transactionId) {
  const safeUser = sanitizeText(user);
  const list = await getTransactionsByUserFromRedis(client, safeUser, { persistMissingIds: true });
  const found = await findTransactionByIdInList(list, transactionId);

  if (found.index < 0) {
    return null;
  }

  const removed = list.splice(found.index, 1)[0] || null;
  await rewriteRedisUserTransactions(client, safeUser, list);
  return removed;
}

async function updateTransactionByIdInFile(user, transactionId, updates) {
  const safeUser = sanitizeText(user);
  const list = await readAllTransactionsFromFile({ persistMissingIds: true });
  const userListIndexes = [];

  for (let index = 0; index < list.length; index += 1) {
    if (list[index].user === safeUser) {
      userListIndexes.push(index);
    }
  }

  const safeId = sanitizeText(transactionId);
  const index = userListIndexes.find((listIndex) => sanitizeText(list[listIndex].id) === safeId);

  if (index === undefined) {
    return null;
  }

  const current = list[index];
  const merged = normalizeTransactionRecord(
    {
      ...current,
      ...updates,
      id: current.id,
      user: current.user,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    },
    {
      assignIdIfMissing: false,
      indexHint: index
    }
  );

  if (!merged) {
    throw new Error('Dados inválidos para atualizar transação');
  }

  list[index] = merged;
  await writeTransactionsUnsafe(list);
  return merged;
}

async function deleteTransactionByIdInFile(user, transactionId) {
  const safeUser = sanitizeText(user);
  const list = await readAllTransactionsFromFile({ persistMissingIds: true });
  const safeId = sanitizeText(transactionId);

  const index = list.findIndex(
    (item) => item.user === safeUser && sanitizeText(item.id) === safeId
  );

  if (index < 0) {
    return null;
  }

  const removed = list.splice(index, 1)[0] || null;
  await writeTransactionsUnsafe(list);
  return removed;
}

function applyUserProfilePatch(currentProfile, patchInput) {
  const patch = typeof patchInput === 'function' ? patchInput(currentProfile) : patchInput;
  const safePatch = patch && typeof patch === 'object' ? patch : {};

  const merged = {
    ...currentProfile,
    ...safePatch,
    budgetByCategory: {
      ...currentProfile.budgetByCategory,
      ...(safePatch.budgetByCategory && typeof safePatch.budgetByCategory === 'object'
        ? safePatch.budgetByCategory
        : {})
    },
    alertSent: {
      ...currentProfile.alertSent,
      ...(safePatch.alertSent && typeof safePatch.alertSent === 'object'
        ? safePatch.alertSent
        : {})
    },
    updatedAt: new Date().toISOString(),
    lastInteractionAt: new Date().toISOString()
  };

  return normalizeUserProfileRecord(currentProfile.user, merged);
}

async function getUserProfileFromRedis(client, user) {
  const safeUser = sanitizeText(user);
  const prefix = getRedisDataPrefix();
  const key = getRedisUserProfileKey(prefix, safeUser);
  const raw = await client.get(key);

  if (!raw) {
    return buildDefaultProfile(safeUser);
  }

  try {
    const parsed = JSON.parse(raw);
    return normalizeUserProfileRecord(safeUser, parsed) || buildDefaultProfile(safeUser);
  } catch (_error) {
    return buildDefaultProfile(safeUser);
  }
}

async function updateUserProfileInRedis(client, user, patchInput) {
  const safeUser = sanitizeText(user);
  const prefix = getRedisDataPrefix();
  const key = getRedisUserProfileKey(prefix, safeUser);
  const current = await getUserProfileFromRedis(client, safeUser);
  const next = applyUserProfilePatch(current, patchInput);

  await client.set(key, JSON.stringify(next));
  return next;
}

async function readUsersDataFromFile(options = {}) {
  const persistNormalized = Boolean(options.persistNormalized);

  await ensureStorageFiles();
  const usersData = await readUsersUnsafe();
  const now = Date.now();
  let changed = false;

  const normalizedProfiles = {};

  for (const [user, profile] of Object.entries(usersData.profiles)) {
    const normalized = normalizeUserProfileRecord(user, profile);

    if (!normalized) {
      changed = true;
      continue;
    }

    normalizedProfiles[normalized.user] = normalized;
  }

  const normalizedStates = {};

  for (const [user, state] of Object.entries(usersData.states)) {
    const normalized = normalizeConversationStateRecord(state);

    if (!normalized) {
      changed = true;
      continue;
    }

    if (Number.isFinite(normalized.expiresAt) && normalized.expiresAt > 0 && normalized.expiresAt < now) {
      changed = true;
      continue;
    }

    normalizedStates[sanitizeText(user)] = normalized;
  }

  if (persistNormalized && changed) {
    await writeUsersUnsafe({
      profiles: normalizedProfiles,
      states: normalizedStates
    });
  }

  return {
    profiles: normalizedProfiles,
    states: normalizedStates
  };
}

async function getUserProfileFromFile(user) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return null;
  }

  const usersData = await readUsersDataFromFile({ persistNormalized: true });
  return usersData.profiles[safeUser] || buildDefaultProfile(safeUser);
}

async function updateUserProfileInFile(user, patchInput) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return null;
  }

  const usersData = await readUsersDataFromFile({ persistNormalized: true });
  const current = usersData.profiles[safeUser] || buildDefaultProfile(safeUser);
  const next = applyUserProfilePatch(current, patchInput);

  usersData.profiles[safeUser] = next;
  await writeUsersUnsafe(usersData);
  return next;
}

async function getConversationStateFromRedis(client, user) {
  const safeUser = sanitizeText(user);
  const prefix = getRedisDataPrefix();
  const key = getRedisConversationStateKey(prefix, safeUser);
  const raw = await client.get(key);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const normalized = normalizeConversationStateRecord(parsed);

    if (!normalized) {
      await client.del(key);
      return null;
    }

    if (Number.isFinite(normalized.expiresAt) && normalized.expiresAt > 0 && normalized.expiresAt < Date.now()) {
      await client.del(key);
      return null;
    }

    return normalized;
  } catch (_error) {
    await client.del(key);
    return null;
  }
}

async function setConversationStateInRedis(client, user, state, ttlSeconds = DEFAULT_STATE_TTL_SECONDS) {
  const safeUser = sanitizeText(user);
  const prefix = getRedisDataPrefix();
  const key = getRedisConversationStateKey(prefix, safeUser);
  const ttl = Number.isFinite(Number(ttlSeconds)) && Number(ttlSeconds) > 0
    ? Number.parseInt(String(ttlSeconds), 10)
    : DEFAULT_STATE_TTL_SECONDS;

  const normalized = normalizeConversationStateRecord({
    ...state,
    expiresAt: Date.now() + ttl * 1000,
    updatedAt: new Date().toISOString()
  });

  if (!normalized) {
    throw new Error('Estado de conversa inválido');
  }

  await client.setEx(key, ttl, JSON.stringify(normalized));
  return normalized;
}

async function clearConversationStateInRedis(client, user) {
  const safeUser = sanitizeText(user);
  const prefix = getRedisDataPrefix();
  const key = getRedisConversationStateKey(prefix, safeUser);
  await client.del(key);
}

async function getConversationStateFromFile(user) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return null;
  }

  const usersData = await readUsersDataFromFile({ persistNormalized: true });
  return usersData.states[safeUser] || null;
}

async function setConversationStateInFile(user, state, ttlSeconds = DEFAULT_STATE_TTL_SECONDS) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return null;
  }

  const ttl = Number.isFinite(Number(ttlSeconds)) && Number(ttlSeconds) > 0
    ? Number.parseInt(String(ttlSeconds), 10)
    : DEFAULT_STATE_TTL_SECONDS;

  const normalized = normalizeConversationStateRecord({
    ...state,
    expiresAt: Date.now() + ttl * 1000,
    updatedAt: new Date().toISOString()
  });

  if (!normalized) {
    throw new Error('Estado de conversa inválido');
  }

  const usersData = await readUsersDataFromFile({ persistNormalized: true });
  usersData.states[safeUser] = normalized;
  await writeUsersUnsafe(usersData);
  return normalized;
}

async function clearConversationStateInFile(user) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return;
  }

  const usersData = await readUsersDataFromFile({ persistNormalized: true });

  if (usersData.states[safeUser]) {
    delete usersData.states[safeUser];
    await writeUsersUnsafe(usersData);
  }
}

async function saveTransaction(user, transaction) {
  return withWriteLock(async () => {
    try {
      const redis = await getRedisClient();

      if (redis) {
        return await saveTransactionToRedis(redis, user, transaction);
      }
    } catch (error) {
      logWarn('STORAGE', 'Falha no save via Redis. Usando fallback em arquivo.', error.message);
    }

    return saveTransactionToFile(user, transaction);
  });
}

async function readAllTransactions() {
  try {
    const redis = await getRedisClient();

    if (redis) {
      return await readAllTransactionsFromRedis(redis);
    }
  } catch (error) {
    logWarn('STORAGE', 'Falha ao ler transações do Redis. Usando fallback em arquivo.', error.message);
  }

  return readAllTransactionsFromFile({ persistMissingIds: true });
}

async function getTransactionsByUser(user) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return [];
  }

  try {
    const redis = await getRedisClient();

    if (redis) {
      return await getTransactionsByUserFromRedis(redis, safeUser, { persistMissingIds: true });
    }
  } catch (error) {
    logWarn('STORAGE', 'Falha ao ler transações do usuário no Redis. Usando fallback em arquivo.', {
      user: safeUser,
      error: error.message
    });
  }

  return getTransactionsByUserFromFile(safeUser, { persistMissingIds: true });
}

async function getRecentTransactionsByUser(user, limit = 10) {
  const safeLimit = Number.isFinite(Number(limit)) ? Number.parseInt(String(limit), 10) : 10;
  const finalLimit = safeLimit > 0 ? Math.min(safeLimit, 50) : 10;

  const list = await getTransactionsByUser(user);
  return sortTransactionsByDateDesc(list).slice(0, finalLimit);
}

async function findTransactionById(user, transactionId) {
  const list = await getTransactionsByUser(user);
  const safeId = sanitizeText(transactionId);

  if (!safeId) {
    return null;
  }

  return list.find((item) => sanitizeText(item.id) === safeId) || null;
}

async function updateTransactionById(user, transactionId, updates) {
  const safeUser = sanitizeText(user);
  const safeTransactionId = sanitizeText(transactionId);

  if (!safeUser || !safeTransactionId || !updates || typeof updates !== 'object') {
    return null;
  }

  return withWriteLock(async () => {
    try {
      const redis = await getRedisClient();

      if (redis) {
        return await updateTransactionByIdInRedis(redis, safeUser, safeTransactionId, updates);
      }
    } catch (error) {
      logWarn('STORAGE', 'Falha ao atualizar transação no Redis. Usando fallback em arquivo.', {
        user: safeUser,
        transactionId: safeTransactionId,
        error: error.message
      });
    }

    return updateTransactionByIdInFile(safeUser, safeTransactionId, updates);
  });
}

async function deleteTransactionById(user, transactionId) {
  const safeUser = sanitizeText(user);
  const safeTransactionId = sanitizeText(transactionId);

  if (!safeUser || !safeTransactionId) {
    return null;
  }

  return withWriteLock(async () => {
    try {
      const redis = await getRedisClient();

      if (redis) {
        return await deleteTransactionByIdInRedis(redis, safeUser, safeTransactionId);
      }
    } catch (error) {
      logWarn('STORAGE', 'Falha ao remover transação no Redis. Usando fallback em arquivo.', {
        user: safeUser,
        transactionId: safeTransactionId,
        error: error.message
      });
    }

    return deleteTransactionByIdInFile(safeUser, safeTransactionId);
  });
}

function buildEmptyCategoryTotals(categories = ALLOWED_CATEGORIES) {
  return categories.reduce((accumulator, category) => {
    accumulator[category] = 0;
    return accumulator;
  }, {});
}

async function getMonthlySummaryByUser(user, year, month) {
  const userTransactions = await getTransactionsByUser(user);
  const safeYear = Number.parseInt(String(year), 10);
  const safeMonth = Number.parseInt(String(month), 10);

  if (!Number.isInteger(safeYear) || !Number.isInteger(safeMonth) || safeMonth < 1 || safeMonth > 12) {
    return {
      year: safeYear,
      month: safeMonth,
      total: 0,
      count: 0,
      byCategory: buildEmptyCategoryTotals(),
      transactions: []
    };
  }

  const monthPrefix = `${safeYear}-${String(safeMonth).padStart(2, '0')}-`;
  const byCategory = buildEmptyCategoryTotals();
  const monthTransactions = [];

  for (const transaction of userTransactions) {
    if (
      !transaction ||
      typeof transaction.data !== 'string' ||
      !transaction.data.startsWith(monthPrefix)
    ) {
      continue;
    }

    const value = Number(transaction.valor);

    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }

    const category = normalizeCategoryName(transaction.categoria, 'Outros');

    if (!Object.prototype.hasOwnProperty.call(byCategory, category)) {
      byCategory[category] = 0;
    }

    byCategory[category] = roundTo2(byCategory[category] + value);

    monthTransactions.push({
      id: transaction.id,
      user: transaction.user,
      valor: roundTo2(value),
      categoria: category,
      descricao: sanitizeText(transaction.descricao),
      data: transaction.data,
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt
    });
  }

  const total = roundTo2(monthTransactions.reduce((sum, item) => sum + item.valor, 0));

  return {
    year: safeYear,
    month: safeMonth,
    total,
    count: monthTransactions.length,
    byCategory,
    transactions: sortTransactionsByDateDesc(monthTransactions)
  };
}

async function getUserProfile(user) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return null;
  }

  try {
    const redis = await getRedisClient();

    if (redis) {
      return await getUserProfileFromRedis(redis, safeUser);
    }
  } catch (error) {
    logWarn('STORAGE', 'Falha ao ler perfil do usuário no Redis. Usando fallback em arquivo.', {
      user: safeUser,
      error: error.message
    });
  }

  return getUserProfileFromFile(safeUser);
}

function sortProfilesForAdmin(list = []) {
  return [...list].sort((left, right) => {
    const leftRef = sanitizeText(left.lastInteractionAt || left.updatedAt || left.createdAt || '');
    const rightRef = sanitizeText(right.lastInteractionAt || right.updatedAt || right.createdAt || '');

    if (leftRef !== rightRef) {
      return rightRef.localeCompare(leftRef);
    }

    return sanitizeText(left.user).localeCompare(sanitizeText(right.user));
  });
}

async function listUserProfilesFromFile() {
  const usersData = await readUsersDataFromFile({ persistNormalized: true });
  return sortProfilesForAdmin(Object.values(usersData.profiles || {}));
}

async function scanRedisKeysByPattern(client, pattern) {
  const keys = [];
  let cursor = '0';

  do {
    const result = await client.scan(cursor, {
      MATCH: pattern,
      COUNT: 200
    });

    let nextCursor = '0';
    let batchKeys = [];

    if (Array.isArray(result)) {
      nextCursor = String(result[0] || '0');
      batchKeys = Array.isArray(result[1]) ? result[1] : [];
    } else if (result && typeof result === 'object') {
      nextCursor = String(result.cursor || '0');
      batchKeys = Array.isArray(result.keys) ? result.keys : [];
    }

    keys.push(...batchKeys);
    cursor = nextCursor;
  } while (cursor !== '0');

  return [...new Set(keys)];
}

async function listUserProfilesFromRedis(client) {
  const prefix = getRedisDataPrefix();
  const profilePrefix = `${prefix}:profile:`;
  const keys = await scanRedisKeysByPattern(client, `${profilePrefix}*`);

  if (!keys.length) {
    return [];
  }

  const rawProfiles = await Promise.all(keys.map((key) => client.get(key)));
  const result = [];

  for (let index = 0; index < keys.length; index += 1) {
    const key = sanitizeText(keys[index]);
    const raw = rawProfiles[index];
    const user = sanitizeText(key.slice(profilePrefix.length));

    if (!user || !raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw);
      const normalized = normalizeUserProfileRecord(user, parsed);

      if (normalized) {
        result.push(normalized);
      }
    } catch (_error) {
      // noop: ignora perfil corrompido
    }
  }

  return sortProfilesForAdmin(result);
}

async function listUserProfiles() {
  try {
    const redis = await getRedisClient();

    if (redis) {
      return await listUserProfilesFromRedis(redis);
    }
  } catch (error) {
    logWarn('STORAGE', 'Falha ao listar perfis no Redis. Usando fallback em arquivo.', error.message);
  }

  return listUserProfilesFromFile();
}

async function setUserAccessEnabled(user, enabled) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return null;
  }

  return updateUserProfile(safeUser, {
    accessEnabled: Boolean(enabled)
  });
}

async function updateUserProfile(user, patchInput) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return null;
  }

  return withWriteLock(async () => {
    try {
      const redis = await getRedisClient();

      if (redis) {
        return await updateUserProfileInRedis(redis, safeUser, patchInput);
      }
    } catch (error) {
      logWarn('STORAGE', 'Falha ao atualizar perfil no Redis. Usando fallback em arquivo.', {
        user: safeUser,
        error: error.message
      });
    }

    return updateUserProfileInFile(safeUser, patchInput);
  });
}

async function getConversationState(user) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return null;
  }

  try {
    const redis = await getRedisClient();

    if (redis) {
      return await getConversationStateFromRedis(redis, safeUser);
    }
  } catch (error) {
    logWarn('STORAGE', 'Falha ao ler estado de conversa no Redis. Usando fallback em arquivo.', {
      user: safeUser,
      error: error.message
    });
  }

  return getConversationStateFromFile(safeUser);
}

async function setConversationState(user, state, ttlSeconds = DEFAULT_STATE_TTL_SECONDS) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return null;
  }

  return withWriteLock(async () => {
    try {
      const redis = await getRedisClient();

      if (redis) {
        return await setConversationStateInRedis(redis, safeUser, state, ttlSeconds);
      }
    } catch (error) {
      logWarn('STORAGE', 'Falha ao salvar estado de conversa no Redis. Usando fallback em arquivo.', {
        user: safeUser,
        error: error.message
      });
    }

    return setConversationStateInFile(safeUser, state, ttlSeconds);
  });
}

async function clearConversationState(user) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return;
  }

  return withWriteLock(async () => {
    try {
      const redis = await getRedisClient();

      if (redis) {
        await clearConversationStateInRedis(redis, safeUser);
        return;
      }
    } catch (error) {
      logWarn('STORAGE', 'Falha ao limpar estado de conversa no Redis. Usando fallback em arquivo.', {
        user: safeUser,
        error: error.message
      });
    }

    await clearConversationStateInFile(safeUser);
  });
}

module.exports = {
  DEFAULT_ALERT_THRESHOLDS,
  DEFAULT_STATE_TTL_SECONDS,
  TRANSACTIONS_FILE,
  USERS_FILE,
  clearConversationState,
  deleteTransactionById,
  findTransactionById,
  getConversationState,
  getMonthlySummaryByUser,
  getRecentTransactionsByUser,
  getTransactionsByUser,
  getUserProfile,
  listUserProfiles,
  readAllTransactions,
  saveTransaction,
  setUserAccessEnabled,
  setConversationState,
  updateTransactionById,
  updateUserProfile
};
