const fs = require('fs/promises');
const path = require('path');
const { createClient } = require('redis');
const { ALLOWED_CATEGORIES, logError, logInfo, logWarn, sanitizeText } = require('./utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TRANSACTIONS_FILE = path.join(DATA_DIR, 'transactions.json');
const REDIS_DATA_PREFIX_ENV = 'WHATSAPP_DATA_PREFIX';
const DEFAULT_REDIS_DATA_PREFIX = 'finance-bot:transactions';
const REDIS_TLS_ENV = 'REDIS_TLS';
const REDIS_TLS_REJECT_UNAUTHORIZED_ENV = 'REDIS_TLS_REJECT_UNAUTHORIZED';
const REDIS_FALLBACK_COOLDOWN_MS = 30000;

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

function normalizeTransactionRecord(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const user = sanitizeText(record.user);
  const valor = Number(record.valor);
  const categoria = ALLOWED_CATEGORIES.includes(record.categoria) ? record.categoria : 'Outros';
  const descricao = sanitizeText(record.descricao);
  const data = sanitizeText(record.data);

  if (!user || !Number.isFinite(valor) || valor <= 0 || !descricao || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return null;
  }

  return {
    user,
    valor: Number(valor.toFixed(2)),
    categoria,
    descricao,
    data
  };
}

function parseRedisRecord(raw) {
  try {
    const parsed = JSON.parse(raw);
    return normalizeTransactionRecord(parsed);
  } catch (_error) {
    return null;
  }
}

async function ensureStorageFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(TRANSACTIONS_FILE);
  } catch (_error) {
    await fs.writeFile(TRANSACTIONS_FILE, '[]\n', 'utf8');
  }
}

async function readTransactionsUnsafe() {
  const content = await fs.readFile(TRANSACTIONS_FILE, 'utf8');
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? parsed : [];
}

async function readAllTransactionsFromFile() {
  try {
    await ensureStorageFile();
    const list = await readTransactionsUnsafe();
    return list
      .map((item) => normalizeTransactionRecord(item))
      .filter(Boolean);
  } catch (error) {
    logError('STORAGE', 'Falha ao ler transactions.json. Retornando lista vazia.', error.message);
    return [];
  }
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

    const client = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 10000,
        tls: useTls,
        rejectUnauthorized: tlsRejectUnauthorized,
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

    try {
      await client.connect();
      redisClient = client;
      redisUnavailableUntil = 0;
      redisErrorAlreadyLogged = false;

      if (!redisReadyAlreadyLogged) {
        redisReadyAlreadyLogged = true;
        logInfo('STORAGE', 'Persistência de gastos ativa via Redis.');
      }

      return client;
    } catch (error) {
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

async function getTransactionsByUserFromRedis(client, user) {
  const prefix = getRedisDataPrefix();
  const key = getRedisUserTransactionsKey(prefix, user);
  const rawList = await client.lRange(key, 0, -1);

  return rawList
    .map((raw) => parseRedisRecord(raw))
    .filter((item) => item && item.user === sanitizeText(user));
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
      return getTransactionsByUserFromRedis(client, user);
    })
  );

  return lists.flat();
}

async function saveTransactionToRedis(client, user, transaction) {
  const prefix = getRedisDataPrefix();
  const userKey = getRedisUserTransactionsKey(prefix, user);
  const usersKey = getRedisUsersKey(prefix);

  const normalizedRecord = normalizeTransactionRecord({
    user,
    valor: Number(transaction.valor),
    categoria: sanitizeText(transaction.categoria),
    descricao: sanitizeText(transaction.descricao),
    data: sanitizeText(transaction.data)
  });

  if (!normalizedRecord) {
    throw new Error('Transação inválida para persistência');
  }

  const existing = await getTransactionsByUserFromRedis(client, normalizedRecord.user);

  if (isDuplicate(existing, normalizedRecord)) {
    return { saved: false, duplicate: true, record: normalizedRecord };
  }

  await client.multi()
    .rPush(userKey, JSON.stringify(normalizedRecord))
    .sAdd(usersKey, normalizedRecord.user)
    .exec();

  logInfo('STORAGE', 'Transação salva com sucesso (Redis).', normalizedRecord);
  return { saved: true, duplicate: false, record: normalizedRecord };
}

async function saveTransactionToFile(user, transaction) {
  await ensureStorageFile();

  const list = await readTransactionsUnsafe();
  const normalizedRecord = normalizeTransactionRecord({
    user: sanitizeText(user),
    valor: Number(transaction.valor),
    categoria: sanitizeText(transaction.categoria),
    descricao: sanitizeText(transaction.descricao),
    data: sanitizeText(transaction.data)
  });

  if (!normalizedRecord) {
    throw new Error('Transação inválida para persistência');
  }

  if (isDuplicate(list, normalizedRecord)) {
    return { saved: false, duplicate: true, record: normalizedRecord };
  }

  list.push(normalizedRecord);
  await fs.writeFile(TRANSACTIONS_FILE, `${JSON.stringify(list, null, 2)}\n`, 'utf8');

  logInfo('STORAGE', 'Transação salva com sucesso (arquivo).', normalizedRecord);
  return { saved: true, duplicate: false, record: normalizedRecord };
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

  return readAllTransactionsFromFile();
}

async function getTransactionsByUser(user) {
  const safeUser = sanitizeText(user);

  if (!safeUser) {
    return [];
  }

  try {
    const redis = await getRedisClient();

    if (redis) {
      return await getTransactionsByUserFromRedis(redis, safeUser);
    }
  } catch (error) {
    logWarn('STORAGE', 'Falha ao ler transações do usuário no Redis. Usando fallback em arquivo.', {
      user: safeUser,
      error: error.message
    });
  }

  const list = await readAllTransactionsFromFile();
  return list.filter((item) => item.user === safeUser);
}

function buildEmptyCategoryTotals() {
  return ALLOWED_CATEGORIES.reduce((accumulator, category) => {
    accumulator[category] = 0;
    return accumulator;
  }, {});
}

function roundTo2(value) {
  return Number(value.toFixed(2));
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

    const category = ALLOWED_CATEGORIES.includes(transaction.categoria)
      ? transaction.categoria
      : 'Outros';

    byCategory[category] = roundTo2(byCategory[category] + value);
    monthTransactions.push({
      user: transaction.user,
      valor: roundTo2(value),
      categoria: category,
      descricao: sanitizeText(transaction.descricao),
      data: transaction.data
    });
  }

  const total = roundTo2(monthTransactions.reduce((sum, item) => sum + item.valor, 0));

  return {
    year: safeYear,
    month: safeMonth,
    total,
    count: monthTransactions.length,
    byCategory,
    transactions: monthTransactions
  };
}

module.exports = {
  TRANSACTIONS_FILE,
  getMonthlySummaryByUser,
  getTransactionsByUser,
  readAllTransactions,
  saveTransaction
};
