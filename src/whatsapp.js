const { loadWhatsAppAuthState } = require('./auth');
const {
  parseReceiptWithAI,
  parseTransactionPatchWithAI,
  parseTransactionWithAI
} = require('./ai');
const {
  DEFAULT_ALERT_THRESHOLDS,
  clearConversationState,
  deleteTransactionById,
  getConversationState,
  getMonthlySummaryByUser,
  getRecentTransactionsByUser,
  getUserProfile,
  saveTransaction,
  setConversationState,
  updateTransactionById,
  updateUserProfile
} = require('./storage');
const {
  ALLOWED_CATEGORIES,
  fallbackParseTransaction,
  formatCurrencyBRL,
  isLikelyPromotionalText,
  logError,
  logInfo,
  logWarn,
  normalizeCategoryName,
  normalizeUserId,
  parseDateFromText,
  parseMoney,
  sanitizeText
} = require('./utils');
const {
  setWhatsAppConnected,
  setWhatsAppConnecting,
  setWhatsAppDisconnected,
  setWhatsAppLoggedOut,
  setWhatsAppPairingCode,
  setWhatsAppWaitingQr
} = require('./whatsappState');

const RECONNECT_DELAY_MS = 5000;
const CONVERSATION_STATE_TTL_SECONDS = 24 * 60 * 60;

const PAIRING_NUMBER_ENV = 'WHATSAPP_PAIRING_NUMBER';
const MESSAGE_LOGS_ENV = 'WHATSAPP_LOG_MESSAGES';
const IGNORED_MESSAGE_LOGS_ENV = 'WHATSAPP_LOG_IGNORED_MESSAGES';

const silentBaileysLogger = {
  level: 'silent',
  child() {
    return silentBaileysLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {}
};

let activeSocket = null;
let isStarting = false;
let reconnectTimer = null;
let baileysRuntimePromise = null;

async function getBaileysRuntime() {
  if (!baileysRuntimePromise) {
    baileysRuntimePromise = import('@whiskeysockets/baileys')
      .then((moduleNs) => {
        const runtime = moduleNs && typeof moduleNs === 'object' ? moduleNs : {};
        const fallback = runtime.default && typeof runtime.default === 'object'
          ? runtime.default
          : {};

        const makeWASocket = typeof runtime.default === 'function'
          ? runtime.default
          : typeof runtime.makeWASocket === 'function'
            ? runtime.makeWASocket
            : typeof fallback.makeWASocket === 'function'
              ? fallback.makeWASocket
              : null;
        const DisconnectReason = runtime.DisconnectReason || fallback.DisconnectReason || {};
        const fetchLatestBaileysVersion = runtime.fetchLatestBaileysVersion || fallback.fetchLatestBaileysVersion;
        const downloadMediaMessage = runtime.downloadMediaMessage || fallback.downloadMediaMessage;

        if (typeof makeWASocket !== 'function') {
          throw new Error('Baileys runtime inválido: makeWASocket não encontrado.');
        }

        return {
          makeWASocket,
          DisconnectReason,
          fetchLatestBaileysVersion,
          downloadMediaMessage
        };
      })
      .catch((error) => {
        baileysRuntimePromise = null;
        throw error;
      });
  }

  return baileysRuntimePromise;
}

function isEnvEnabled(name, defaultValue = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();

  if (!value) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(value);
}

function shouldLogMessages() {
  return isEnvEnabled(MESSAGE_LOGS_ENV, true);
}

function shouldLogIgnoredMessages() {
  return isEnvEnabled(IGNORED_MESSAGE_LOGS_ENV, false);
}

function getPairingNumber() {
  return String(process.env[PAIRING_NUMBER_ENV] || '').replace(/\D/g, '');
}

function formatPairingCode(rawCode) {
  const code = sanitizeText(String(rawCode || '')).replace(/\s+/g, '').toUpperCase();

  if (!code) {
    return '';
  }

  const chunks = code.match(/.{1,4}/g);
  return chunks ? chunks.join('-') : code;
}

function stripAccents(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeCommandText(text) {
  return stripAccents(sanitizeText(text).toLowerCase());
}

function normalizeCategoryToken(text) {
  return normalizeCommandText(String(text || '')).replace(/\s+/g, ' ').trim();
}

function getCustomCategories(profile) {
  if (!profile || !Array.isArray(profile.customCategories)) {
    return [];
  }

  return [...new Set(
    profile.customCategories
      .map((item) => normalizeCategoryName(item, ''))
      .filter(Boolean)
      .filter((item) => !ALLOWED_CATEGORIES.includes(item))
  )];
}

function getAllCategories(profile) {
  const categories = [...ALLOWED_CATEGORIES];

  for (const custom of getCustomCategories(profile)) {
    if (!categories.includes(custom)) {
      categories.push(custom);
    }
  }

  return categories;
}

function findCategoryByText(commandText, categories = []) {
  const normalizedText = normalizeCategoryToken(commandText);

  for (const category of categories) {
    const safeCategory = normalizeCategoryName(category, '');

    if (!safeCategory) {
      continue;
    }

    const token = normalizeCategoryToken(safeCategory);

    if (!token) {
      continue;
    }

    if (normalizedText.includes(token)) {
      return safeCategory;
    }
  }

  return null;
}

function parseYesNo(text) {
  const normalized = normalizeCommandText(text);

  if (/^(sim|s|yes|y|quero|claro|ok|pode)\b/.test(normalized)) {
    return true;
  }

  if (/^(nao|n|no|na)\b/.test(normalized)) {
    return false;
  }

  return null;
}

function isSkipKeyword(text) {
  const normalized = normalizeCommandText(text);
  return /\b(pular|ignorar|deixa|nao quero|sem)\b/.test(normalized);
}

function formatDateBR(isoDate) {
  const safeDate = sanitizeText(isoDate);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) {
    return safeDate;
  }

  const [year, month, day] = safeDate.split('-');
  return `${day}/${month}/${year}`;
}

function monthLabelFromYearMonth(year, month) {
  return `${String(month).padStart(2, '0')}/${year}`;
}

function monthLabelFromIsoDate(isoDate) {
  const safeDate = sanitizeText(isoDate);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) {
    const now = new Date();
    return monthLabelFromYearMonth(now.getFullYear(), now.getMonth() + 1);
  }

  return `${safeDate.slice(5, 7)}/${safeDate.slice(0, 4)}`;
}

function parseCategoryFromText(commandText, customCategories = []) {
  const customMatch = findCategoryByText(commandText, customCategories);

  if (customMatch) {
    return customMatch;
  }

  if (/\b(alimentacao|mercado|ifood|comida|restaurante|lanche)\b/.test(commandText)) {
    return 'Alimentação';
  }

  if (/\b(transporte|uber|taxi|onibus|metro|combustivel|gasolina|passagem)\b/.test(commandText)) {
    return 'Transporte';
  }

  if (/\b(lazer|entretenimento|cinema|bar|show|netflix|spotify|viagem)\b/.test(commandText)) {
    return 'Lazer';
  }

  if (/\b(outros?)\b/.test(commandText)) {
    return 'Outros';
  }

  return null;
}

function parseTransactionIdFromText(text) {
  const safeText = sanitizeText(text);
  const idMatch = safeText.match(/\b((?:tx|legacy)[-_][a-z0-9]{6,})\b/i);

  if (idMatch) {
    return sanitizeText(idMatch[1]);
  }

  const generic = safeText.match(/\bid\s*[:#-]?\s*([a-z0-9_-]{8,})\b/i);
  return generic ? sanitizeText(generic[1]) : null;
}

function unwrapMessageContent(messageContent) {
  let current = messageContent;

  for (let i = 0; i < 5; i += 1) {
    if (current && current.ephemeralMessage && current.ephemeralMessage.message) {
      current = current.ephemeralMessage.message;
      continue;
    }

    if (current && current.viewOnceMessageV2 && current.viewOnceMessageV2.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }

    if (current && current.viewOnceMessage && current.viewOnceMessage.message) {
      current = current.viewOnceMessage.message;
      continue;
    }

    break;
  }

  return current;
}

function extractTextMessage(messageContent) {
  const content = unwrapMessageContent(messageContent);

  if (!content) {
    return '';
  }

  if (typeof content.conversation === 'string') {
    return content.conversation;
  }

  if (content.extendedTextMessage && typeof content.extendedTextMessage.text === 'string') {
    return content.extendedTextMessage.text;
  }

  return '';
}

function extractImageMessage(messageContent) {
  const content = unwrapMessageContent(messageContent);

  if (!content) {
    return null;
  }

  if (content.imageMessage) {
    return content.imageMessage;
  }

  if (
    content.documentMessage &&
    typeof content.documentMessage.mimetype === 'string' &&
    content.documentMessage.mimetype.startsWith('image/')
  ) {
    return content.documentMessage;
  }

  return null;
}

async function downloadImageBuffer(sock, message) {
  try {
    const { downloadMediaMessage } = await getBaileysRuntime();

    if (typeof downloadMediaMessage !== 'function') {
      logWarn('WHATSAPP', 'downloadMediaMessage indisponível no runtime do Baileys.');
      return null;
    }

    const content = await downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger: silentBaileysLogger,
        reuploadRequest: sock.updateMediaMessage
      }
    );

    if (!content) {
      return null;
    }

    if (Buffer.isBuffer(content)) {
      return content;
    }

    if (content instanceof Uint8Array) {
      return Buffer.from(content);
    }

    return null;
  } catch (error) {
    logError('WHATSAPP', 'Falha ao baixar imagem da mensagem.', error.message);
    return null;
  }
}

async function safeReply(sock, jid, text) {
  try {
    if (shouldLogMessages()) {
      logInfo('WHATSAPP', 'Enviando mensagem.', {
        jid,
        text: sanitizeText(text)
      });
    }

    await sock.sendMessage(jid, { text });

    if (shouldLogMessages()) {
      logInfo('WHATSAPP', 'Mensagem enviada com sucesso.', {
        jid,
        text: sanitizeText(text)
      });
    }
  } catch (error) {
    logError('WHATSAPP', 'Falha ao enviar resposta ao usuário.', {
      jid,
      error: error.message
    });
  }
}

function buildHelpMessage() {
  return [
    'Comandos disponíveis:',
    '- resumo do mes',
    '- total por categoria',
    '- total alimentação no mes',
    '- resumo 03/2026',
    '- como estao minhas contas',
    '- orçamento do mes',
    '- saldo do mes',
    '- listar gastos',
    '- listar gastos 20',
    '- remover gasto <id> | remover ultimo gasto',
    '- editar gasto <id> para 45 no mercado ontem',
    '- desfazer ultimo gasto',
    '- meu perfil',
    '- categorias | listar categorias',
    '- criar categoria obra',
    '- criar categoria água com orçamento 250',
    '- remover categoria obra',
    '- nome <seu nome>',
    '- renda 5500',
    '- orçamento alimentação 1200',
    '- limpar orçamento alimentação',
    '- alertas 10 20 30',
    '',
    'Para registrar gasto, envie uma mensagem natural, ex:',
    'gastei 45 no mercado',
    'paguei 39 no uber hoje'
  ].join('\n');
}

function formatSignedCurrency(value) {
  const safeValue = Number(value);

  if (!Number.isFinite(safeValue)) {
    return formatCurrencyBRL(0);
  }

  if (safeValue > 0) {
    return `+${formatCurrencyBRL(safeValue)}`;
  }

  return `-${formatCurrencyBRL(Math.abs(safeValue))}`;
}

function sortCategoriesForDisplay(summary, profile) {
  const base = [...ALLOWED_CATEGORIES];
  const extras = new Set([
    ...getCustomCategories(profile),
    ...Object.keys(summary && summary.byCategory ? summary.byCategory : {}).filter(
      (category) => !ALLOWED_CATEGORIES.includes(category)
    )
  ]);

  return [...base, ...[...extras].sort((a, b) => a.localeCompare(b, 'pt-BR'))];
}

function buildBudgetProgressLines(profile, monthSummary) {
  if (!profile || !profile.budgetByCategory) {
    return [];
  }

  const categories = new Set([
    ...getAllCategories(profile),
    ...Object.keys(monthSummary && monthSummary.byCategory ? monthSummary.byCategory : {})
  ]);
  const lines = [];

  for (const category of categories) {
    const budget = Number(profile.budgetByCategory[category]);

    if (!Number.isFinite(budget) || budget <= 0) {
      continue;
    }

    const spent = Number(monthSummary.byCategory[category] || 0);
    const remaining = budget - spent;
    const remainingPercent = budget > 0 ? Math.max(0, (remaining / budget) * 100) : 0;

    lines.push(
      `- ${category}: ${formatCurrencyBRL(spent)} de ${formatCurrencyBRL(budget)} (restante ${Math.round(remainingPercent)}%)`
    );
  }

  return lines;
}

function buildMonthlySummaryMessage(summary, monthLabel, profile) {
  if (!summary.count) {
    return `📊 Nenhum gasto encontrado em ${monthLabel}.`;
  }

  const lines = [
    `📊 Resumo de ${monthLabel}:`,
    `Total: ${formatCurrencyBRL(summary.total)}`,
    `Lançamentos: ${summary.count}`,
    '',
    'Por categoria:'
  ];

  for (const category of sortCategoriesForDisplay(summary, profile)) {
    lines.push(`- ${category}: ${formatCurrencyBRL(summary.byCategory[category] || 0)}`);
  }

  const monthlyIncome = profile ? Number(profile.monthlyIncome) : Number.NaN;

  if (Number.isFinite(monthlyIncome) && monthlyIncome > 0) {
    const balance = monthlyIncome - Number(summary.total || 0);

    lines.push('');
    lines.push(`Renda mensal: ${formatCurrencyBRL(monthlyIncome)}`);
    lines.push(`Saldo estimado no mês: ${formatSignedCurrency(balance)}`);
  }

  const budgetLines = buildBudgetProgressLines(profile, summary);

  if (budgetLines.length) {
    lines.push('');
    lines.push('Orçamentos no mês:');
    lines.push(...budgetLines);
  }

  return lines.join('\n');
}

function buildCategorySummaryMessage(category, monthLabel, categoryTotal, categoryCount) {
  if (!categoryCount) {
    return `📊 Nenhum gasto de ${category.toLowerCase()} encontrado em ${monthLabel}.`;
  }

  return [
    `📊 ${category} em ${monthLabel}:`,
    `Total: ${formatCurrencyBRL(categoryTotal)}`,
    `Lançamentos: ${categoryCount}`
  ].join('\n');
}

function buildBudgetStatusMessage(profile, summary, monthLabel) {
  const lines = [`💼 Situação financeira de ${monthLabel}:`];

  const monthlyIncome = profile ? Number(profile.monthlyIncome) : Number.NaN;

  lines.push(`- Total gasto: ${formatCurrencyBRL(summary.total)}`);

  if (Number.isFinite(monthlyIncome) && monthlyIncome > 0) {
    const balance = monthlyIncome - Number(summary.total || 0);
    lines.push(`- Renda mensal: ${formatCurrencyBRL(monthlyIncome)}`);
    lines.push(`- Saldo estimado: ${formatSignedCurrency(balance)}`);
  }

  const budgetLines = buildBudgetProgressLines(profile, summary);

  if (budgetLines.length) {
    lines.push('');
    lines.push('Orçamentos por categoria:');
    lines.push(...budgetLines);
  } else {
    lines.push('');
    lines.push('Você ainda não definiu orçamento por categoria.');
    lines.push('Exemplo: orçamento alimentação 1200');
  }

  return lines.join('\n');
}

function resolveSummaryMonth(commandText, referenceDate = new Date()) {
  const resolved = new Date(referenceDate);
  const monthYearMatch = commandText.match(/\b(0?[1-9]|1[0-2])[\/-](20\d{2})\b/);

  if (monthYearMatch) {
    const month = Number.parseInt(monthYearMatch[1], 10);
    const year = Number.parseInt(monthYearMatch[2], 10);

    return {
      year,
      month,
      label: monthLabelFromYearMonth(year, month)
    };
  }

  if (/\bmes\s+passado\b/.test(commandText)) {
    resolved.setDate(1);
    resolved.setMonth(resolved.getMonth() - 1);
  }

  const monthMap = {
    janeiro: 1,
    fevereiro: 2,
    marco: 3,
    abril: 4,
    maio: 5,
    junho: 6,
    julho: 7,
    agosto: 8,
    setembro: 9,
    outubro: 10,
    novembro: 11,
    dezembro: 12
  };

  for (const [name, month] of Object.entries(monthMap)) {
    if (commandText.includes(name)) {
      resolved.setMonth(month - 1);
      break;
    }
  }

  const yearMatch = commandText.match(/\b(20\d{2})\b/);

  if (yearMatch) {
    resolved.setFullYear(Number.parseInt(yearMatch[1], 10));
  }

  const year = resolved.getFullYear();
  const month = resolved.getMonth() + 1;

  return {
    year,
    month,
    label: monthLabelFromYearMonth(year, month)
  };
}

function hasMonthlySummaryIntent(commandText) {
  if (/^\/?(resumo|relatorio)\b/.test(commandText)) {
    return true;
  }

  if (/quanto\s+gastei/.test(commandText)) {
    return true;
  }

  if (/(total|gastos?)\s+(do|no|nesse|neste)?\s*mes/.test(commandText)) {
    return true;
  }

  if (/por\s+categoria/.test(commandText)) {
    return true;
  }

  if (/^\/?total\s+.+\b(mes|m[eê]s)\b/.test(commandText)) {
    return true;
  }

  if (/^\/?total\s+\w+/.test(commandText)) {
    return true;
  }

  return false;
}

function hasBudgetStatusIntent(commandText) {
  if (/^(\/)?(orcamento|orçamento)(\s+do\s+mes)?$/.test(commandText)) {
    return true;
  }

  if (/^(\/)?(saldo(\s+do\s+mes)?|como\s+esta\s+minha\s+conta|como\s+estao\s+minhas\s+contas|como\s+estao\s+as\s+contas)$/.test(commandText)) {
    return true;
  }

  if (/(quanto\s+resta|quanto\s+sobrou|restante\s+do\s+mes)/.test(commandText)) {
    return true;
  }

  return false;
}

function shouldListExpenses(commandText) {
  return (
    /(listar|lista|mostrar|ultimos|ultimas|recentes)\s+(gastos|despesas|lancamentos|lan[cç]amentos)/.test(commandText) ||
    /(gastos|despesas)\s+recentes/.test(commandText)
  );
}

function parseListLimit(text) {
  const commandText = normalizeCommandText(text);
  const match = commandText.match(/\b(?:listar|lista|mostrar)\b.*\b(?:gastos|despesas|lancamentos|lan[cç]amentos)\b.*\b(\d{1,2})\b/);

  if (!match || !match[1]) {
    return 10;
  }

  const parsed = Number.parseInt(match[1], 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 10;
  }

  return Math.min(parsed, 50);
}

function parseDeleteIntent(text) {
  const commandText = normalizeCommandText(text);

  if (/\bdesfazer\b/.test(commandText) && /\b(gasto|despesa|lancamento|lan[cç]amento)\b/.test(commandText)) {
    return { target: 'last' };
  }

  if (!/(remover|apagar|excluir|deletar)/.test(commandText)) {
    return null;
  }

  if (/\b(ultimo|ultima|último|última)\b/.test(commandText)) {
    return { target: 'last' };
  }

  const id = parseTransactionIdFromText(text);

  if (id) {
    return { target: 'id', transactionId: id };
  }

  return { target: 'last_auto' };
}

function parseEditIntent(text) {
  const commandText = normalizeCommandText(text);

  if (!/(editar|corrigir|retificar|ajustar)/.test(commandText)) {
    return null;
  }

  const targetLast = /\b(ultimo|ultima|último|última)\b/.test(commandText);
  const transactionId = targetLast ? null : parseTransactionIdFromText(text);

  const paraMatch = text.match(/\bpara\b/i);
  let updateText = text;

  if (paraMatch && Number.isInteger(paraMatch.index)) {
    updateText = text.slice(paraMatch.index + paraMatch[0].length);
  }

  return {
    target: targetLast ? 'last' : transactionId ? 'id' : 'last_auto',
    transactionId,
    updateText: sanitizeText(updateText)
  };
}

function parsePatchFromTextFallback(text, referenceDate = new Date(), customCategories = []) {
  const clean = sanitizeText(text);

  if (!clean) {
    return null;
  }

  const patch = {};
  const normalized = normalizeCommandText(clean);

  const valueMatch = clean.match(/(?:valor|r\$)\s*[:=\-]?\s*(\d+[\d.,]*)/i) || clean.match(/\b(\d+[\d.,]*)\b/);

  if (valueMatch && valueMatch[1]) {
    const value = parseMoney(valueMatch[1]);

    if (Number.isFinite(value) && value > 0) {
      patch.valor = Number(value.toFixed(2));
    }
  }

  const category = parseCategoryFromText(normalized, customCategories);

  if (category) {
    patch.categoria = category;
  }

  if (/\b(hoje|ontem|anteontem|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\b/i.test(clean)) {
    patch.data = parseDateFromText(clean, referenceDate);
  }

  const descriptionMatch = clean.match(/(?:descricao|descrição|desc)\s*[:=\-]?\s*(.+)$/i);

  if (descriptionMatch && descriptionMatch[1]) {
    patch.descricao = sanitizeText(descriptionMatch[1]);
  }

  return Object.keys(patch).length ? patch : null;
}

function buildProfileMessage(profile) {
  const nameLine = profile.name ? `Nome: ${profile.name}` : 'Nome: não informado';
  const incomeLine = Number.isFinite(Number(profile.monthlyIncome)) && Number(profile.monthlyIncome) > 0
    ? `Renda mensal: ${formatCurrencyBRL(Number(profile.monthlyIncome))}`
    : 'Renda mensal: não informada';

  const categories = getAllCategories(profile);
  const budgetLines = categories.map((category) => {
    const value = profile.budgetByCategory && Number(profile.budgetByCategory[category]);

    if (Number.isFinite(value) && value > 0) {
      return `- ${category}: ${formatCurrencyBRL(value)}`;
    }

    return `- ${category}: não definido`;
  });

  const alertThresholds = Array.isArray(profile.alertThresholds) && profile.alertThresholds.length
    ? profile.alertThresholds.join('% / ') + '%'
    : DEFAULT_ALERT_THRESHOLDS.join('% / ') + '%';

  return [
    '👤 Seu perfil financeiro:',
    nameLine,
    incomeLine,
    `Alertas de orçamento (saldo restante): ${alertThresholds}`,
    `Categorias personalizadas: ${getCustomCategories(profile).length ? getCustomCategories(profile).join(', ') : 'nenhuma'}`,
    '',
    'Orçamento por categoria:',
    ...budgetLines
  ].join('\n');
}

function buildRecentExpensesMessage(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return 'Ainda não encontrei gastos para mostrar.';
  }

  const lines = ['🧾 Seus gastos mais recentes:'];

  for (const item of list) {
    lines.push(
      `- ${item.id} | ${formatDateBR(item.data)} | ${item.categoria} | ${formatCurrencyBRL(item.valor)} | ${sanitizeText(item.descricao)}`
    );
  }

  lines.push('');
  lines.push('Para editar/remover:');
  lines.push('- editar gasto <id> para 45 no mercado');
  lines.push('- remover gasto <id>');

  return lines.join('\n');
}

function buildOnboardingSummary(profile) {
  const thresholds = Array.isArray(profile.alertThresholds) && profile.alertThresholds.length
    ? profile.alertThresholds.join('% / ') + '%'
    : DEFAULT_ALERT_THRESHOLDS.join('% / ') + '%';
  const lines = [
    '✅ Cadastro concluído!',
    profile.name ? `Prazer, ${profile.name}!` : 'Prazer em te ajudar!',
    Number(profile.monthlyIncome) > 0
      ? `Renda mensal registrada: ${formatCurrencyBRL(Number(profile.monthlyIncome))}`
      : 'Renda mensal: não informada.'
  ];

  const hasAnyBudget = ALLOWED_CATEGORIES.some((category) => Number(profile.budgetByCategory[category]) > 0);

  if (hasAnyBudget) {
    lines.push('Orçamentos por categoria:');

    for (const category of ALLOWED_CATEGORIES) {
      const value = Number(profile.budgetByCategory[category]);

      if (Number.isFinite(value) && value > 0) {
        lines.push(`- ${category}: ${formatCurrencyBRL(value)}`);
      }
    }
  } else {
    lines.push('Você ainda não definiu orçamento por categoria.');
  }

  lines.push(`Alertas de orçamento (saldo restante): ${thresholds}`);

  lines.push('');
  lines.push('Agora você já pode mandar gastos normalmente.');
  lines.push('Exemplo: gastei 42 no mercado');

  return lines.join('\n');
}

async function startOnboarding(sock, jid, userNumber) {
  await setConversationState(
    userNumber,
    {
      step: 'onboarding_ask_name',
      data: {}
    },
    CONVERSATION_STATE_TTL_SECONDS
  );

  await safeReply(
    sock,
    jid,
    [
      '👋 Bem-vindo ao seu assistente financeiro!',
      'Antes de começar, como você prefere ser chamado?'
    ].join('\n')
  );
}

async function finalizeOnboarding(sock, jid, userNumber) {
  const profile = await updateUserProfile(userNumber, {
    onboardingComplete: true
  });

  await clearConversationState(userNumber);
  await safeReply(sock, jid, buildOnboardingSummary(profile));

  return profile;
}

async function handleOnboardingFlow(sock, jid, userNumber, text, profile, conversationState) {
  if (profile && profile.onboardingComplete) {
    return { handled: false, profile };
  }

  const commandText = normalizeCommandText(text);

  if (/\b(pular cadastro|pular onboarding|cancelar cadastro)\b/.test(commandText)) {
    const updated = await finalizeOnboarding(sock, jid, userNumber);
    return { handled: true, profile: updated };
  }

  const state = conversationState && /^onboarding_/.test(String(conversationState.step || ''))
    ? conversationState
    : null;

  if (!state) {
    await startOnboarding(sock, jid, userNumber);
    return { handled: true, profile };
  }

  if (state.step === 'onboarding_ask_name') {
    const maybeName = sanitizeText(text).replace(/^(meu nome e|me chamo|sou)\s+/i, '').trim();

    if (!maybeName || maybeName.length < 2) {
      await safeReply(sock, jid, 'Não entendi seu nome. Me diga como você prefere ser chamado.');
      return { handled: true, profile };
    }

    const updated = await updateUserProfile(userNumber, {
      name: maybeName
    });

    await setConversationState(
      userNumber,
      {
        step: 'onboarding_ask_income_opt',
        data: {}
      },
      CONVERSATION_STATE_TTL_SECONDS
    );

    await safeReply(
      sock,
      jid,
      `Perfeito, ${updated.name}! Você quer informar sua renda mensal para acompanhar melhor suas contas? (sim/não)`
    );

    return { handled: true, profile: updated };
  }

  if (state.step === 'onboarding_ask_income_opt') {
    const yesNo = parseYesNo(text);

    if (yesNo === null) {
      await safeReply(sock, jid, 'Responde com *sim* ou *não*, por favor.');
      return { handled: true, profile };
    }

    if (yesNo) {
      await setConversationState(
        userNumber,
        {
          step: 'onboarding_ask_income_value',
          data: {}
        },
        CONVERSATION_STATE_TTL_SECONDS
      );

      await safeReply(sock, jid, 'Qual é sua renda mensal aproximada? Exemplo: 5500');
      return { handled: true, profile };
    }

    const updated = await updateUserProfile(userNumber, {
      monthlyIncome: null
    });

    await setConversationState(
      userNumber,
      {
        step: 'onboarding_ask_budget_opt',
        data: {}
      },
      CONVERSATION_STATE_TTL_SECONDS
    );

    await safeReply(sock, jid, 'Quer definir orçamento mensal por categoria agora? (sim/não)');
    return { handled: true, profile: updated };
  }

  if (state.step === 'onboarding_ask_income_value') {
    const income = parseMoney(text);

    if (!Number.isFinite(income) || income <= 0) {
      await safeReply(sock, jid, 'Não consegui ler esse valor. Me manda apenas número, ex: 5500');
      return { handled: true, profile };
    }

    const updated = await updateUserProfile(userNumber, {
      monthlyIncome: Number(income.toFixed(2))
    });

    await setConversationState(
      userNumber,
      {
        step: 'onboarding_ask_budget_opt',
        data: {}
      },
      CONVERSATION_STATE_TTL_SECONDS
    );

    await safeReply(sock, jid, 'Ótimo! Quer definir orçamento mensal por categoria agora? (sim/não)');
    return { handled: true, profile: updated };
  }

  if (state.step === 'onboarding_ask_budget_opt') {
    const yesNo = parseYesNo(text);

    if (yesNo === null) {
      await safeReply(sock, jid, 'Responde com *sim* ou *não*, por favor.');
      return { handled: true, profile };
    }

    if (!yesNo) {
      const updated = await finalizeOnboarding(sock, jid, userNumber);
      return { handled: true, profile: updated };
    }

    await setConversationState(
      userNumber,
      {
        step: 'onboarding_ask_budget_category',
        data: { categoryIndex: 0 }
      },
      CONVERSATION_STATE_TTL_SECONDS
    );

    await safeReply(
      sock,
      jid,
      `Quanto é seu orçamento mensal para *${ALLOWED_CATEGORIES[0]}*? (envie número ou "pular")`
    );

    return { handled: true, profile };
  }

  if (state.step === 'onboarding_ask_budget_category') {
    const index = Number(state.data && state.data.categoryIndex);

    if (!Number.isInteger(index) || index < 0 || index >= ALLOWED_CATEGORIES.length) {
      const updated = await finalizeOnboarding(sock, jid, userNumber);
      return { handled: true, profile: updated };
    }

    const category = ALLOWED_CATEGORIES[index];
    let categoryValue = null;

    if (!isSkipKeyword(text)) {
      const parsed = parseMoney(text);

      if (!Number.isFinite(parsed) || parsed <= 0) {
        await safeReply(
          sock,
          jid,
          `Não consegui ler o orçamento de ${category}. Envie apenas número (ex: 1200) ou "pular".`
        );
        return { handled: true, profile };
      }

      categoryValue = Number(parsed.toFixed(2));
    }

    const updated = await updateUserProfile(userNumber, {
      budgetByCategory: {
        [category]: categoryValue
      }
    });

    const nextIndex = index + 1;

    if (nextIndex >= ALLOWED_CATEGORIES.length) {
      const finished = await finalizeOnboarding(sock, jid, userNumber);
      return { handled: true, profile: finished };
    }

    await setConversationState(
      userNumber,
      {
        step: 'onboarding_ask_budget_category',
        data: { categoryIndex: nextIndex }
      },
      CONVERSATION_STATE_TTL_SECONDS
    );

    await safeReply(
      sock,
      jid,
      `Perfeito. Agora, qual orçamento mensal para *${ALLOWED_CATEGORIES[nextIndex]}*? (número ou "pular")`
    );

    return { handled: true, profile: updated };
  }

  await startOnboarding(sock, jid, userNumber);
  return { handled: true, profile };
}

function parseProfileCommand(commandText, originalText, profile) {
  const customCategories = getCustomCategories(profile);

  if (/^(\/)?(meu perfil|perfil)$/.test(commandText)) {
    return { action: 'show_profile' };
  }

  if (/^(\/)?(categorias|listar categorias)$/.test(commandText)) {
    return { action: 'list_categories' };
  }

  if (/^(\/)?(reconfigurar perfil|refazer cadastro|cadastro novamente)$/.test(commandText)) {
    return { action: 'restart_onboarding' };
  }

  const createCategoryMatch = originalText.match(
    /^(?:\/?(?:criar categoria|nova categoria|adicionar categoria))\s+(.+)$/i
  );

  if (createCategoryMatch && createCategoryMatch[1]) {
    const rawCategory = sanitizeText(createCategoryMatch[1]).replace(/\s+(com|c\/)\s+orcamento.+$/i, '').trim();
    const category = normalizeCategoryName(rawCategory, '');
    const budgetValue = parseMoney(createCategoryMatch[1]);

    if (!category) {
      return { action: 'invalid_custom_category_name' };
    }

    return {
      action: 'create_category',
      category,
      budgetValue: Number.isFinite(budgetValue) && budgetValue > 0 ? Number(budgetValue.toFixed(2)) : null
    };
  }

  const removeCategoryMatch = originalText.match(
    /^(?:\/?(?:remover categoria|excluir categoria|apagar categoria))\s+(.+)$/i
  );

  if (removeCategoryMatch && removeCategoryMatch[1]) {
    const category = parseCategoryFromText(
      normalizeCommandText(removeCategoryMatch[1]),
      customCategories
    ) || normalizeCategoryName(removeCategoryMatch[1], '');

    if (!category) {
      return { action: 'invalid_custom_category_name' };
    }

    return {
      action: 'remove_category',
      category
    };
  }

  const nameMatch = originalText.match(/^(?:\/?(?:nome|alterar nome|me chame de))\s+(.+)$/i);

  if (nameMatch && nameMatch[1]) {
    return {
      action: 'set_name',
      name: sanitizeText(nameMatch[1])
    };
  }

  const incomeMatch = originalText.match(/^(?:\/?(?:renda|ganho|salario|salário)(?:\s+mensal)?)\s+(.+)$/i);

  if (incomeMatch && incomeMatch[1]) {
    const value = parseMoney(incomeMatch[1]);

    if (Number.isFinite(value) && value > 0) {
      return {
        action: 'set_income',
        monthlyIncome: Number(value.toFixed(2))
      };
    }

    return { action: 'invalid_income' };
  }

  const clearBudgetMatch = commandText.match(/^(\/)?(limpar orcamento|limpar orçamento|remover orcamento|remover orçamento)\s+(.+)$/);

  if (clearBudgetMatch && clearBudgetMatch[3]) {
    const category = parseCategoryFromText(clearBudgetMatch[3], customCategories);

    if (!category) {
      return { action: 'invalid_budget_category' };
    }

    return {
      action: 'clear_budget',
      category
    };
  }

  const budgetMatch = originalText.match(/^(?:\/?(?:orcamento|orçamento))\s+(.+)$/i);

  if (budgetMatch && budgetMatch[1]) {
    const budgetText = budgetMatch[1];
    const value = parseMoney(budgetText);

    if (!Number.isFinite(value) || value <= 0) {
      return { action: 'invalid_budget_value', category: 'categoria informada' };
    }

    const valueMatch = budgetText.match(/(\d+[\d.,]*)/);
    const categoryText = sanitizeText(
      valueMatch && valueMatch[1]
        ? budgetText.replace(valueMatch[1], '')
        : budgetText
    )
      .replace(/\b(r\$|reais?|por mes|por mês|mensal|do mes|do mês)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const parsedCategory = parseCategoryFromText(
      normalizeCommandText(categoryText),
      customCategories
    );
    const category = parsedCategory || normalizeCategoryName(categoryText, '');

    if (!category) {
      return { action: 'invalid_budget_category' };
    }

    return {
      action: 'set_budget',
      category,
      value: Number(value.toFixed(2)),
      createIfMissing: !ALLOWED_CATEGORIES.includes(category) && !customCategories.includes(category)
    };
  }

  const alertsMatch = originalText.match(/^(?:\/?(?:alertas|alerta))\s+(.+)$/i);

  if (alertsMatch && alertsMatch[1]) {
    const numbers = alertsMatch[1]
      .match(/\d{1,2}/g);

    if (!numbers || numbers.length === 0) {
      return { action: 'invalid_alerts' };
    }

    const thresholds = [...new Set(
      numbers
        .map((item) => Number.parseInt(item, 10))
        .filter((item) => Number.isInteger(item) && item > 0 && item < 100)
    )].sort((a, b) => a - b);

    if (!thresholds.length) {
      return { action: 'invalid_alerts' };
    }

    return {
      action: 'set_alerts',
      thresholds
    };
  }

  return null;
}

async function handleProfileCommand(sock, jid, userNumber, profile, command) {
  if (!command) {
    return false;
  }

  if (command.action === 'show_profile') {
    await safeReply(sock, jid, buildProfileMessage(profile));
    return true;
  }

  if (command.action === 'list_categories') {
    const base = [...ALLOWED_CATEGORIES];
    const custom = getCustomCategories(profile);
    await safeReply(
      sock,
      jid,
      [
        '🏷️ Categorias disponíveis:',
        `Base: ${base.join(', ')}`,
        `Personalizadas: ${custom.length ? custom.join(', ') : 'nenhuma'}`,
        '',
        'Para criar: criar categoria obra',
        'Para criar com orçamento: criar categoria água com orçamento 250'
      ].join('\n')
    );
    return true;
  }

  if (command.action === 'create_category') {
    if (ALLOWED_CATEGORIES.includes(command.category)) {
      await safeReply(sock, jid, `A categoria ${command.category} já existe na base.`);
      return true;
    }

    const custom = getCustomCategories(profile);

    if (custom.includes(command.category)) {
      await safeReply(sock, jid, `A categoria ${command.category} já está cadastrada.`);
      return true;
    }

    const patch = {
      customCategories: [...custom, command.category]
    };

    if (Number.isFinite(command.budgetValue) && command.budgetValue > 0) {
      patch.budgetByCategory = {
        [command.category]: command.budgetValue
      };
    }

    await updateUserProfile(userNumber, patch);

    await safeReply(
      sock,
      jid,
      Number.isFinite(command.budgetValue) && command.budgetValue > 0
        ? `Categoria ${command.category} criada com orçamento mensal de ${formatCurrencyBRL(command.budgetValue)}.`
        : `Categoria ${command.category} criada com sucesso.`
    );
    return true;
  }

  if (command.action === 'remove_category') {
    if (ALLOWED_CATEGORIES.includes(command.category)) {
      await safeReply(sock, jid, `A categoria ${command.category} é padrão e não pode ser removida.`);
      return true;
    }

    const custom = getCustomCategories(profile);

    if (!custom.includes(command.category)) {
      await safeReply(sock, jid, `Não encontrei a categoria personalizada ${command.category}.`);
      return true;
    }

    const nextCustom = custom.filter((item) => item !== command.category);

    await updateUserProfile(userNumber, {
      customCategories: nextCustom,
      budgetByCategory: {
        [command.category]: null
      }
    });

    await safeReply(sock, jid, `Categoria ${command.category} removida.`);
    return true;
  }

  if (command.action === 'restart_onboarding') {
    const updated = await updateUserProfile(userNumber, {
      onboardingComplete: false
    });

    await clearConversationState(userNumber);
    await startOnboarding(sock, jid, userNumber);
    logInfo('WHATSAPP', 'Onboarding reiniciado pelo usuário.', { user: userNumber, name: updated.name });
    return true;
  }

  if (command.action === 'set_name') {
    if (!command.name || command.name.length < 2) {
      await safeReply(sock, jid, 'Não consegui salvar esse nome. Tenta no formato: nome João');
      return true;
    }

    const updated = await updateUserProfile(userNumber, {
      name: command.name
    });

    await safeReply(sock, jid, `Perfeito! Vou te chamar de ${updated.name}.`);
    return true;
  }

  if (command.action === 'set_income') {
    const updated = await updateUserProfile(userNumber, {
      monthlyIncome: command.monthlyIncome
    });

    await safeReply(sock, jid, `Renda mensal atualizada: ${formatCurrencyBRL(updated.monthlyIncome)}.`);
    return true;
  }

  if (command.action === 'invalid_income') {
    await safeReply(sock, jid, 'Não consegui entender a renda. Exemplo: renda 5500');
    return true;
  }

  if (command.action === 'set_budget') {
    const custom = getCustomCategories(profile);
    const shouldAddCustom = command.createIfMissing && !ALLOWED_CATEGORIES.includes(command.category);
    const customCategories = shouldAddCustom
      ? [...custom, command.category]
      : custom;

    await updateUserProfile(userNumber, {
      customCategories,
      budgetByCategory: {
        [command.category]: command.value
      }
    });

    await safeReply(sock, jid, `Orçamento de ${command.category} salvo em ${formatCurrencyBRL(command.value)} por mês.`);
    return true;
  }

  if (command.action === 'clear_budget') {
    await updateUserProfile(userNumber, {
      budgetByCategory: {
        [command.category]: null
      }
    });

    await safeReply(sock, jid, `Orçamento de ${command.category} removido.`);
    return true;
  }

  if (command.action === 'set_alerts') {
    await updateUserProfile(userNumber, {
      alertThresholds: command.thresholds,
      alertSent: {}
    });

    await safeReply(
      sock,
      jid,
      `Alertas atualizados (saldo restante) para: ${command.thresholds.join('% / ')}%.`
    );
    return true;
  }

  if (command.action === 'invalid_alerts') {
    await safeReply(sock, jid, 'Formato inválido. Exemplo: alertas 10 20 30');
    return true;
  }

  if (command.action === 'invalid_budget_category') {
    await safeReply(
      sock,
      jid,
      [
        'Não identifiquei a categoria.',
        'Você pode usar uma categoria base (alimentação, transporte, lazer, outros) ou criar nova:',
        '- criar categoria obra',
        '- criar categoria água com orçamento 250'
      ].join('\n')
    );
    return true;
  }

  if (command.action === 'invalid_budget_value') {
    await safeReply(sock, jid, `Não consegui entender o valor do orçamento de ${command.category}. Exemplo: orçamento ${command.category.toLowerCase()} 1200`);
    return true;
  }

  if (command.action === 'invalid_custom_category_name') {
    await safeReply(sock, jid, 'Nome de categoria inválido. Exemplo: criar categoria dízimo');
    return true;
  }

  return false;
}

async function tryHandleBudgetStatus(sock, jid, userNumber, text, referenceDate, profile) {
  const commandText = normalizeCommandText(text);

  if (!hasBudgetStatusIntent(commandText)) {
    return false;
  }

  const resolvedMonth = resolveSummaryMonth(commandText, referenceDate);
  const summary = await getMonthlySummaryByUser(
    userNumber,
    resolvedMonth.year,
    resolvedMonth.month
  );

  await safeReply(
    sock,
    jid,
    buildBudgetStatusMessage(profile, summary, resolvedMonth.label)
  );

  return true;
}

async function tryHandleFinanceSummary(sock, jid, userNumber, text, referenceDate, profile) {
  const commandText = normalizeCommandText(text);

  if (!hasMonthlySummaryIntent(commandText)) {
    return false;
  }

  const requestedCategory = parseCategoryFromText(commandText, getCustomCategories(profile));
  const resolvedMonth = resolveSummaryMonth(commandText, referenceDate);
  const summary = await getMonthlySummaryByUser(
    userNumber,
    resolvedMonth.year,
    resolvedMonth.month
  );

  if (requestedCategory) {
    const categoryTotal = Number(summary.byCategory[requestedCategory] || 0);
    const categoryCount = summary.transactions.filter(
      (item) => item.categoria === requestedCategory
    ).length;

    await safeReply(
      sock,
      jid,
      buildCategorySummaryMessage(
        requestedCategory,
        resolvedMonth.label,
        categoryTotal,
        categoryCount
      )
    );

    logInfo('WHATSAPP', 'Resumo por categoria enviado.', {
      user: userNumber,
      category: requestedCategory,
      month: resolvedMonth.label,
      total: categoryTotal,
      count: categoryCount
    });
    return true;
  }

  await safeReply(sock, jid, buildMonthlySummaryMessage(summary, resolvedMonth.label, profile));
  logInfo('WHATSAPP', 'Resumo mensal enviado.', {
    user: userNumber,
    month: resolvedMonth.label,
    total: summary.total,
    count: summary.count
  });
  return true;
}

async function tryHandleListExpenses(sock, jid, userNumber, text) {
  const commandText = normalizeCommandText(text);

  if (!shouldListExpenses(commandText)) {
    return false;
  }

  const listLimit = parseListLimit(text);
  const list = await getRecentTransactionsByUser(userNumber, listLimit);
  await safeReply(sock, jid, buildRecentExpensesMessage(list));
  return true;
}

async function tryHandleDeleteExpense(sock, jid, userNumber, text) {
  const intent = parseDeleteIntent(text);

  if (!intent) {
    return false;
  }

  let transactionId = intent.transactionId;

  let autoSelectedLast = false;

  if (intent.target === 'last' || intent.target === 'last_auto') {
    const [latest] = await getRecentTransactionsByUser(userNumber, 1);

    if (!latest) {
      await safeReply(sock, jid, 'Você ainda não tem gastos para remover.');
      return true;
    }

    transactionId = latest.id;
    autoSelectedLast = intent.target === 'last_auto';
  }

  if (!transactionId) {
    await safeReply(sock, jid, 'Me informe o ID do gasto. Exemplo: remover gasto tx_ab12cd34');
    return true;
  }

  const removed = await deleteTransactionById(userNumber, transactionId);

  if (!removed) {
    await safeReply(sock, jid, `Não encontrei gasto com ID ${transactionId}. Use "listar gastos" para ver os IDs.`);
    return true;
  }

  await safeReply(
    sock,
    jid,
    [
      autoSelectedLast ? '🗑️ Não veio ID, então removi seu último gasto registrado:' : '🗑️ Gasto removido com sucesso:',
      `ID: ${removed.id}`,
      `Valor: ${formatCurrencyBRL(removed.valor)}`,
      `Categoria: ${removed.categoria}`,
      `Descrição: ${removed.descricao}`,
      `Data: ${formatDateBR(removed.data)}`
    ].join('\n')
  );

  return true;
}

async function parseUpdatePatch(text, referenceDate, customCategories = []) {
  const aiPatch = await parseTransactionPatchWithAI(text, referenceDate, { customCategories });

  if (aiPatch) {
    return aiPatch;
  }

  return parsePatchFromTextFallback(text, referenceDate, customCategories);
}

async function tryHandleEditExpense(sock, jid, userNumber, text, referenceDate, profile) {
  const intent = parseEditIntent(text);

  if (!intent) {
    return false;
  }

  let transactionId = intent.transactionId;

  let autoSelectedLast = false;

  if (intent.target === 'last' || intent.target === 'last_auto') {
    const [latest] = await getRecentTransactionsByUser(userNumber, 1);

    if (!latest) {
      await safeReply(sock, jid, 'Você ainda não tem gastos para editar.');
      return true;
    }

    transactionId = latest.id;
    autoSelectedLast = intent.target === 'last_auto';
  }

  if (!transactionId) {
    await safeReply(sock, jid, 'Me informe o ID do gasto para editar. Exemplo: editar gasto tx_ab12cd34 para 45 no mercado');
    return true;
  }

  const updateText = sanitizeText(intent.updateText);
  const patch = await parseUpdatePatch(updateText, referenceDate, getCustomCategories(profile));

  if (!patch) {
    await safeReply(
      sock,
      jid,
      [
        'Não consegui identificar o que você quer alterar.',
        'Exemplos:',
        '- editar gasto tx_ab12 para valor 79,90',
        '- corrigir ultimo gasto para uber 35 ontem',
        '- editar gasto tx_ab12 descrição almoço no shopping'
      ].join('\n')
    );
    return true;
  }

  const updated = await updateTransactionById(userNumber, transactionId, patch);

  if (!updated) {
    await safeReply(sock, jid, `Não encontrei gasto com ID ${transactionId}. Use "listar gastos" para ver os IDs.`);
    return true;
  }

  await safeReply(
    sock,
    jid,
    [
      autoSelectedLast ? '✏️ Não veio ID, então atualizei seu último gasto:' : '✏️ Gasto atualizado:',
      `ID: ${updated.id}`,
      `Valor: ${formatCurrencyBRL(updated.valor)}`,
      `Categoria: ${updated.categoria}`,
      `Descrição: ${updated.descricao}`,
      `Data: ${formatDateBR(updated.data)}`
    ].join('\n')
  );

  return true;
}

async function handleReceiptConfirmationFlow(sock, jid, userNumber, text, referenceDate, profile, conversationState) {
  if (!conversationState || conversationState.step !== 'receipt_confirm') {
    return false;
  }

  const pending = conversationState.data && conversationState.data.transaction;

  if (!pending || typeof pending !== 'object') {
    await clearConversationState(userNumber);
    return false;
  }

  const yesNo = parseYesNo(text);

  if (yesNo === true) {
    await clearConversationState(userNumber);

    const saveResult = await saveTransaction(userNumber, pending);

    if (saveResult.duplicate) {
      await safeReply(sock, jid, 'Esse gasto já tinha sido registrado.');
      return true;
    }

    await notifySavedTransaction(sock, jid, userNumber, profile, saveResult.record);
    return true;
  }

  if (yesNo === false) {
    await clearConversationState(userNumber);
    await safeReply(
      sock,
      jid,
      [
        'Certo, não salvei esse comprovante.',
        'Pode mandar outra foto ou escrever o gasto em texto.'
      ].join('\n')
    );
    return true;
  }

  const patch = await parseUpdatePatch(text, referenceDate, getCustomCategories(profile));

  if (!patch) {
    await safeReply(
      sock,
      jid,
      'Me responde com *sim* ou *não*. Se quiser ajustar, pode escrever: "valor 45 categoria alimentação".'
    );
    return true;
  }

  const adjusted = {
    ...pending,
    ...patch
  };

  await setConversationState(
    userNumber,
    {
      step: 'receipt_confirm',
      data: {
        transaction: adjusted,
        confidence: conversationState.data && conversationState.data.confidence
      }
    },
    CONVERSATION_STATE_TTL_SECONDS
  );

  await safeReply(
    sock,
    jid,
    [
      'Atualizei os dados do comprovante:',
      `• Valor: ${formatCurrencyBRL(adjusted.valor)}`,
      `• Categoria: ${adjusted.categoria}`,
      `• Descrição: ${adjusted.descricao}`,
      `• Data: ${formatDateBR(adjusted.data)}`,
      '',
      'Salvar agora? (sim/não)'
    ].join('\n')
  );
  return true;
}

async function tryHandleReceiptImage(sock, jid, userNumber, message, imageMessage, text, referenceDate, profile) {
  if (!imageMessage) {
    return false;
  }

  const imageBuffer = await downloadImageBuffer(sock, message);

  if (!imageBuffer || imageBuffer.length === 0) {
    await safeReply(
      sock,
      jid,
      'Não consegui baixar sua foto. Tenta enviar novamente, por favor.'
    );
    return true;
  }

  const customCategories = getCustomCategories(profile);
  const mimeType = sanitizeText(imageMessage.mimetype || 'image/jpeg');
  const receiptResult = await parseReceiptWithAI(
    imageBuffer,
    mimeType,
    text,
    referenceDate,
    { customCategories }
  );

  if (!receiptResult || !receiptResult.transaction) {
    if (text) {
      return false;
    }

    await safeReply(
      sock,
      jid,
      [
        'Não consegui identificar os dados do comprovante.',
        'Tente reenviar com boa iluminação e o valor total visível.',
        'Se preferir, envie a foto com uma legenda: "valor 465 categoria alimentação".'
      ].join('\n')
    );
    return true;
  }

  await setConversationState(
    userNumber,
    {
      step: 'receipt_confirm',
      data: {
        transaction: receiptResult.transaction,
        confidence: receiptResult.confidence
      }
    },
    CONVERSATION_STATE_TTL_SECONDS
  );

  await safeReply(sock, jid, buildReceiptConfirmationMessage(receiptResult));
  return true;
}

function buildNaturalSuccessMessage(profile, transaction, monthSummary) {
  const hasName = profile && profile.name;
  const openers = hasName
    ? [
      `${profile.name}, anotei aqui ✅`,
      `Perfeito, ${profile.name}! Já registrei ✅`,
      `${profile.name}, lançado com sucesso ✅`
    ]
    : [
      'Anotei aqui ✅',
      'Lançamento registrado ✅',
      'Perfeito, já salvei ✅'
    ];
  const greeting = openers[Math.floor(Math.random() * openers.length)];

  const categoryTotal = Number(monthSummary.byCategory[transaction.categoria] || 0);
  const monthLabel = monthLabelFromIsoDate(transaction.data);

  return [
    greeting,
    `• ID: ${transaction.id}`,
    `• Valor: ${formatCurrencyBRL(transaction.valor)}`,
    `• Categoria: ${transaction.categoria}`,
    `• Descrição: ${transaction.descricao}`,
    `• Data: ${formatDateBR(transaction.data)}`,
    '',
    `No mês (${monthLabel}):`,
    `• Total geral: ${formatCurrencyBRL(monthSummary.total)}`,
    `• Total em ${transaction.categoria}: ${formatCurrencyBRL(categoryTotal)}`,
    '',
    `Se precisar corrigir: "editar gasto ${transaction.id} para 45 no mercado".`
  ].join('\n');
}

function buildReceiptConfirmationMessage(receiptResult) {
  if (!receiptResult || !receiptResult.transaction) {
    return [
      'Não consegui extrair os dados do comprovante.',
      'Tente enviar uma foto mais nítida e com o valor visível.'
    ].join('\n');
  }

  const { transaction, confidence, estabelecimento } = receiptResult;
  const confidenceLabel = Number.isFinite(confidence)
    ? `${Math.round(confidence * 100)}%`
    : 'não informado';
  const storeLabel = sanitizeText(estabelecimento || transaction.descricao || '');

  return [
    '🧾 Li seu comprovante e encontrei:',
    `• Valor: ${formatCurrencyBRL(transaction.valor)}`,
    `• Categoria: ${transaction.categoria}`,
    `• Descrição: ${transaction.descricao}`,
    `• Data: ${formatDateBR(transaction.data)}`,
    storeLabel ? `• Estabelecimento: ${storeLabel}` : null,
    `• Confiança: ${confidenceLabel}`,
    '',
    'Deseja salvar esse gasto? (sim/não)'
  ].filter(Boolean).join('\n');
}

async function notifySavedTransaction(sock, jid, userNumber, profile, record) {
  const transactionDate = sanitizeText(record.data);
  const summaryYear = Number.parseInt(transactionDate.slice(0, 4), 10);
  const summaryMonth = Number.parseInt(transactionDate.slice(5, 7), 10);
  const monthSummary = await getMonthlySummaryByUser(userNumber, summaryYear, summaryMonth);

  await safeReply(sock, jid, buildNaturalSuccessMessage(profile, record, monthSummary));

  const refreshedProfile = await getUserProfile(userNumber);
  const budgetAlert = evaluateBudgetAlert(refreshedProfile, monthSummary, record);

  if (budgetAlert) {
    await updateUserProfile(userNumber, budgetAlert.profilePatch);
    await safeReply(sock, jid, budgetAlert.message);
  }
}

function evaluateBudgetAlert(profile, monthSummary, transaction) {
  if (!profile || !profile.budgetByCategory || !transaction) {
    return null;
  }

  const category = transaction.categoria;
  const budgetValue = Number(profile.budgetByCategory[category]);

  if (!Number.isFinite(budgetValue) || budgetValue <= 0) {
    return null;
  }

  const spent = Number(monthSummary.byCategory[category] || 0);

  if (!Number.isFinite(spent) || spent <= 0) {
    return null;
  }

  const monthKey = sanitizeText(transaction.data).slice(0, 7);

  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return null;
  }

  const alertKey = `${monthKey}:${category}`;
  const sentMap = profile.alertSent && typeof profile.alertSent === 'object'
    ? profile.alertSent
    : {};
  const sentThresholds = Array.isArray(sentMap[alertKey])
    ? sentMap[alertKey]
      .map((item) => Number.parseInt(String(item), 10))
      .filter((item) => Number.isInteger(item))
    : [];
  const alreadyExceededAlerted = sentThresholds.includes(100);

  const thresholds = Array.isArray(profile.alertThresholds) && profile.alertThresholds.length
    ? profile.alertThresholds
      .map((item) => Number.parseInt(String(item), 10))
      .filter((item) => Number.isInteger(item) && item > 0 && item < 100)
      .sort((a, b) => a - b)
    : [...DEFAULT_ALERT_THRESHOLDS];

  const remainingValue = Math.max(0, budgetValue - spent);
  const remainingPercent = budgetValue > 0 ? (remainingValue / budgetValue) * 100 : 0;
  const newlyReached = thresholds.filter(
    (threshold) => remainingPercent <= threshold && !sentThresholds.includes(threshold)
  );

  if (!newlyReached.length && spent < budgetValue) {
    return null;
  }

  if (spent >= budgetValue && alreadyExceededAlerted) {
    return null;
  }

  const updatedSent = [...new Set([
    ...sentThresholds,
    ...newlyReached,
    ...(spent >= budgetValue ? [100] : [])
  ])].sort((a, b) => a - b);
  const thresholdTriggered = newlyReached.length ? Math.min(...newlyReached) : Math.min(...thresholds);
  const monthLabel = `${monthKey.slice(5, 7)}/${monthKey.slice(0, 4)}`;

  let message;

  if (spent >= budgetValue) {
    message = [
      `⚠️ Atenção: você excedeu o orçamento de ${category} em ${monthLabel}.`,
      `Gasto: ${formatCurrencyBRL(spent)} de ${formatCurrencyBRL(budgetValue)}.`
    ].join('\n');
  } else {
    message = [
      `⚠️ Alerta de orçamento: faltam ${thresholdTriggered}% ou menos em ${category} (${monthLabel}).`,
      `Gasto: ${formatCurrencyBRL(spent)} de ${formatCurrencyBRL(budgetValue)}.`,
      `Saldo restante: ${formatCurrencyBRL(remainingValue)} (${Math.round(remainingPercent)}%).`
    ].join('\n');
  }

  return {
    message,
    profilePatch: {
      alertSent: {
        [alertKey]: updatedSent
      }
    }
  };
}

function isHelpCommand(commandText) {
  return /^(\/)?(ajuda|comandos?)\b/.test(commandText);
}

function isSupportedDirectChat(jid) {
  if (!jid || typeof jid !== 'string') {
    return false;
  }

  if (jid.endsWith('@broadcast')) {
    return false;
  }

  if (jid.endsWith('@g.us')) {
    return false;
  }

  if (jid.endsWith('@newsletter')) {
    return false;
  }

  if (jid.endsWith('@s.whatsapp.net')) {
    return true;
  }

  if (jid.endsWith('@lid')) {
    return true;
  }

  return false;
}

async function processIncomingMessage(sock, message) {
  try {
    if (!message || !message.message) {
      return;
    }

    const jid = message.key ? message.key.remoteJid : null;
    const fromMe = message.key && message.key.fromMe;

    if (fromMe) {
      if (shouldLogIgnoredMessages()) {
        logInfo('WHATSAPP', 'Mensagem ignorada (fromMe=true).', { jid });
      }
      return;
    }

    if (!isSupportedDirectChat(jid)) {
      if (shouldLogIgnoredMessages()) {
        logInfo('WHATSAPP', 'Mensagem ignorada (chat não suportado).', { jid });
      }
      return;
    }

    const rawText = extractTextMessage(message.message);
    const imageMessage = extractImageMessage(message.message);

    if (!rawText && !imageMessage) {
      if (shouldLogIgnoredMessages()) {
        logInfo('WHATSAPP', 'Mensagem ignorada (tipo não suportado).', { jid });
      }
      return;
    }

    const text = sanitizeText(rawText);

    const userNumber = normalizeUserId(jid);

    if (shouldLogMessages()) {
      logInfo('WHATSAPP', 'Mensagem recebida.', {
        jid,
        user: userNumber,
        text: text || '(sem texto)',
        hasImage: Boolean(imageMessage)
      });
    }

    const referenceDate = new Date();
    const commandText = normalizeCommandText(text);

    let profile = await getUserProfile(userNumber);

    if (!profile) {
      profile = await updateUserProfile(userNumber, {});
    }

    const conversationState = await getConversationState(userNumber);
    const onboardingResult = await handleOnboardingFlow(
      sock,
      jid,
      userNumber,
      text,
      profile,
      conversationState
    );

    if (onboardingResult.handled) {
      return;
    }

    profile = onboardingResult.profile || profile;

    if (!imageMessage && text) {
      const receiptConfirmationHandled = await handleReceiptConfirmationFlow(
        sock,
        jid,
        userNumber,
        text,
        referenceDate,
        profile,
        conversationState
      );

      if (receiptConfirmationHandled) {
        return;
      }
    }

    if (isHelpCommand(commandText)) {
      await safeReply(sock, jid, buildHelpMessage());
      return;
    }

    const budgetStatusHandled = await tryHandleBudgetStatus(
      sock,
      jid,
      userNumber,
      text,
      referenceDate,
      profile
    );

    if (budgetStatusHandled) {
      return;
    }

    const profileCommand = parseProfileCommand(commandText, text, profile);
    const profileCommandHandled = await handleProfileCommand(sock, jid, userNumber, profile, profileCommand);

    if (profileCommandHandled) {
      return;
    }

    const summaryHandled = await tryHandleFinanceSummary(
      sock,
      jid,
      userNumber,
      text,
      referenceDate,
      profile
    );

    if (summaryHandled) {
      return;
    }

    const listHandled = await tryHandleListExpenses(sock, jid, userNumber, text);

    if (listHandled) {
      return;
    }

    const deleteHandled = await tryHandleDeleteExpense(sock, jid, userNumber, text);

    if (deleteHandled) {
      return;
    }

    const editHandled = await tryHandleEditExpense(sock, jid, userNumber, text, referenceDate, profile);

    if (editHandled) {
      return;
    }

    if (imageMessage) {
      const receiptHandled = await tryHandleReceiptImage(
        sock,
        jid,
        userNumber,
        message,
        imageMessage,
        text,
        referenceDate,
        profile
      );

      if (receiptHandled) {
        return;
      }
    }

    if (!text) {
      return;
    }

    const customCategories = getCustomCategories(profile);
    let transaction = await parseTransactionWithAI(text, referenceDate, {
      customCategories
    });

    if (!transaction) {
      if (isLikelyPromotionalText(text)) {
        logInfo('WHATSAPP', 'Mensagem promocional ignorada para evitar falso positivo.', {
          user: userNumber,
          jid
        });
        return;
      }

      transaction = fallbackParseTransaction(text, referenceDate, {
        customCategories
      });

      if (transaction) {
        logInfo('WHATSAPP', 'Mensagem interpretada com fallback local.', {
          user: userNumber,
          transaction
        });
      }
    }

    if (!transaction) {
      await safeReply(
        sock,
        jid,
        [
          'Não consegui entender esse lançamento.',
          'Exemplos que funcionam bem:',
          '- gastei 45 no mercado',
          '- uber 30 hoje',
          '- paguei 120 no ifood ontem'
        ].join('\n')
      );
      return;
    }

    const explicitCategory = parseCategoryFromText(commandText, customCategories);

    if (explicitCategory) {
      transaction.categoria = normalizeCategoryName(explicitCategory, transaction.categoria || 'Outros');
    }

    const saveResult = await saveTransaction(userNumber, transaction);

    if (saveResult.duplicate) {
      await safeReply(sock, jid, 'Esse gasto já foi registrado anteriormente.');
      logWarn('WHATSAPP', 'Transação duplicada detectada.', saveResult.record);
      return;
    }

    await notifySavedTransaction(sock, jid, userNumber, profile, saveResult.record);

    logInfo('WHATSAPP', 'Transação processada com sucesso.', saveResult.record);
  } catch (error) {
    logError('WHATSAPP', 'Erro ao processar mensagem.', error.message);
  }
}

async function handleMessagesUpsert(sock, event) {
  try {
    if (!event || event.type !== 'notify' || !Array.isArray(event.messages)) {
      return;
    }

    for (const message of event.messages) {
      await processIncomingMessage(sock, message);
    }
  } catch (error) {
    logError('WHATSAPP', 'Falha no listener de mensagens.', error.message);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    startWhatsAppBot().catch((error) => {
      logError('WHATSAPP', 'Falha ao reconectar. Nova tentativa será feita.', error.message);
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
}

function createConnectionUpdateHandler(sock, state, authContext, disconnectReasonMap) {
  let pairingCodeRequested = false;
  let pairingHintLogged = false;

  return async (update) => {
    try {
      const connection = update ? update.connection : null;
      const lastDisconnect = update ? update.lastDisconnect : null;
      const qr = update ? update.qr : null;

      if (qr && !state.creds.registered) {
        const pairingNumber = getPairingNumber();

        if (!pairingNumber) {
          setWhatsAppWaitingQr(qr);

          if (!pairingHintLogged) {
            pairingHintLogged = true;
            logWarn(
              'WHATSAPP',
              'WHATSAPP_PAIRING_NUMBER não configurado. Defina o número para gerar código de pareamento.'
            );
          }
        } else if (!pairingCodeRequested) {
          pairingCodeRequested = true;

          try {
            const code = await sock.requestPairingCode(pairingNumber);
            const formattedCode = formatPairingCode(code);
            setWhatsAppPairingCode(formattedCode);
            logInfo(
              'WHATSAPP',
              `Código de pareamento: ${formattedCode}. No celular: Dispositivos conectados -> Conectar com número de telefone.`
            );
          } catch (error) {
            pairingCodeRequested = false;
            logError('WHATSAPP', 'Falha ao solicitar código de pareamento.', error.message);
          }
        }
      }

      if (connection === 'open') {
        setWhatsAppConnected();
        logInfo('WHATSAPP', 'Conexão estabelecida com sucesso.');
        return;
      }

      if (connection === 'close') {
        if (authContext && typeof authContext.close === 'function') {
          await authContext.close();
        }

        const statusCode = lastDisconnect &&
          lastDisconnect.error &&
          lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode
          : undefined;
        const loggedOutCode = disconnectReasonMap && disconnectReasonMap.loggedOut;
        const shouldReconnect = statusCode !== loggedOutCode;

        logWarn('WHATSAPP', 'Conexão encerrada.', {
          statusCode,
          shouldReconnect
        });
        setWhatsAppDisconnected({ statusCode, shouldReconnect });

        activeSocket = null;

        if (shouldReconnect) {
          scheduleReconnect();
        } else {
          setWhatsAppLoggedOut();
          logWarn('WHATSAPP', 'Sessão deslogada. Faça novo pareamento para continuar.');
        }
      }
    } catch (error) {
      logError('WHATSAPP', 'Erro ao tratar atualização de conexão.', error.message);
    }
  };
}

async function createSocket() {
  const { makeWASocket, fetchLatestBaileysVersion, DisconnectReason } = await getBaileysRuntime();
  const authContext = await loadWhatsAppAuthState();
  const { state, saveCreds } = authContext;

  try {
    let version;

    if (typeof fetchLatestBaileysVersion === 'function') {
      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
      } catch (_error) {
        logWarn('WHATSAPP', 'Não foi possível buscar a versão mais recente do Baileys.');
      }
    }

    const socketConfig = {
      auth: state,
      logger: silentBaileysLogger,
      markOnlineOnConnect: false,
      shouldIgnoreJid: (jid) => !isSupportedDirectChat(jid),
      shouldSyncHistoryMessage: () => false,
      syncFullHistory: false
    };

    if (version) {
      socketConfig.version = version;
    }

    setWhatsAppConnecting();
    const sock = makeWASocket(socketConfig);

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (error) {
        logError('WHATSAPP', 'Falha ao salvar credenciais.', error.message);
      }
    });

    const handleConnectionUpdate = createConnectionUpdateHandler(
      sock,
      state,
      authContext,
      DisconnectReason
    );

    sock.ev.on('connection.update', async (update) => {
      await handleConnectionUpdate(update);
    });

    sock.ev.on('messages.upsert', async (event) => {
      await handleMessagesUpsert(sock, event);
    });

    return sock;
  } catch (error) {
    try {
      await authContext.close();
    } catch (_closeError) {
      // noop
    }

    throw error;
  }
}

async function startWhatsAppBot() {
  if (isStarting) {
    return activeSocket;
  }

  isStarting = true;

  try {
    if (activeSocket) {
      return activeSocket;
    }

    activeSocket = await createSocket();
    logInfo('WHATSAPP', 'Socket inicializado. Aguardando mensagens...');
    return activeSocket;
  } finally {
    isStarting = false;
  }
}

module.exports = {
  startWhatsAppBot
};
