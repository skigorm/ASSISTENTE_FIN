const ALLOWED_CATEGORIES = ['Alimentação', 'Transporte', 'Lazer', 'Outros'];

function log(level, scope, message, meta) {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] [${level}] [${scope}] ${message}`;

  if (meta !== undefined) {
    console.log(base, meta);
    return;
  }

  console.log(base);
}

function logInfo(scope, message, meta) {
  log('INFO', scope, message, meta);
}

function logWarn(scope, message, meta) {
  log('WARN', scope, message, meta);
}

function logError(scope, message, meta) {
  log('ERROR', scope, message, meta);
}

function sanitizeText(input) {
  if (typeof input !== 'string') {
    return '';
  }

  return input
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function safeJsonParse(raw) {
  if (typeof raw !== 'string') {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function extractJSONObject(raw) {
  if (typeof raw !== 'string') {
    return null;
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return raw.slice(start, end + 1);
}

function formatCurrencyBRL(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(value);
}

function toISODate(dateInput = new Date()) {
  const date = new Date(dateInput);

  if (Number.isNaN(date.getTime())) {
    return toISODate(new Date());
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseMoney(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : Number.NaN;
  }

  if (typeof value !== 'string') {
    return Number.NaN;
  }

  let normalized = value.replace(/[^\d.,-]/g, '');

  if (!normalized) {
    return Number.NaN;
  }

  const hasComma = normalized.includes(',');
  const hasDot = normalized.includes('.');
  const looksLikeThousands = /^\d{1,3}(\.\d{3})+$/.test(normalized);

  if (hasComma && hasDot) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    normalized = normalized.replace(',', '.');
  } else if (looksLikeThousands) {
    normalized = normalized.replace(/\./g, '');
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizeCategory(inputCategory) {
  const normalized = sanitizeText(String(inputCategory || '')).toLowerCase();

  if (!normalized) {
    return 'Outros';
  }

  if (normalized.includes('aliment')) {
    return 'Alimentação';
  }

  if (normalized.includes('transport')) {
    return 'Transporte';
  }

  if (normalized.includes('lazer') || normalized.includes('entreten')) {
    return 'Lazer';
  }

  if (normalized.includes('outro')) {
    return 'Outros';
  }

  return 'Outros';
}

function inferCategoryFromText(text) {
  const normalized = sanitizeText(text).toLowerCase();

  if (/(mercado|ifood|restaurante|comida|lanche|pizza|padaria|caf[eé]|janta|almo[cç]o)/i.test(normalized)) {
    return 'Alimentação';
  }

  if (/(uber|99|taxi|t[aá]xi|[oô]nibus|onibus|metr[oô]|gasolina|combust[ií]vel|transporte|passagem)/i.test(normalized)) {
    return 'Transporte';
  }

  if (/(cinema|bar|show|festa|netflix|spotify|lazer|viagem|jogo|game)/i.test(normalized)) {
    return 'Lazer';
  }

  return 'Outros';
}

function parseDateFromText(text, referenceDate = new Date()) {
  const normalized = sanitizeText(text).toLowerCase();
  const baseDate = new Date(referenceDate);

  if (normalized.includes('anteontem')) {
    baseDate.setDate(baseDate.getDate() - 2);
    return toISODate(baseDate);
  }

  if (normalized.includes('ontem')) {
    baseDate.setDate(baseDate.getDate() - 1);
    return toISODate(baseDate);
  }

  if (normalized.includes('hoje')) {
    return toISODate(baseDate);
  }

  const isoMatch = normalized.match(/\b(\d{4}-\d{2}-\d{2})\b/);

  if (isoMatch) {
    return isoMatch[1];
  }

  const brDateMatch = normalized.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);

  if (brDateMatch) {
    const day = Number.parseInt(brDateMatch[1], 10);
    const month = Number.parseInt(brDateMatch[2], 10);
    const yearRaw = brDateMatch[3];

    let year = baseDate.getFullYear();

    if (yearRaw) {
      year = yearRaw.length === 2 ? 2000 + Number.parseInt(yearRaw, 10) : Number.parseInt(yearRaw, 10);
    }

    const parsed = new Date(year, month - 1, day);

    if (
      parsed.getFullYear() === year &&
      parsed.getMonth() === month - 1 &&
      parsed.getDate() === day
    ) {
      return toISODate(parsed);
    }
  }

  return toISODate(baseDate);
}

function normalizeDate(inputDate, referenceDate = new Date()) {
  if (typeof inputDate !== 'string' || !sanitizeText(inputDate)) {
    return toISODate(referenceDate);
  }

  const clean = sanitizeText(inputDate);

  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return clean;
  }

  return parseDateFromText(clean, referenceDate);
}

function cleanupDescription(text) {
  const clean = sanitizeText(text)
    .replace(/\b(gastei|gasto|paguei|comprei|custou|foi|deu|no|na|do|da|em|por|hoje|ontem|anteontem|reais|real|r\$)\b/gi, ' ')
    .replace(/\d+[\d.,]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return clean || 'Sem descrição';
}

function validateTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object') {
    return { valid: false, errors: ['Transação inválida'] };
  }

  const errors = [];

  if (!Number.isFinite(transaction.valor) || transaction.valor <= 0) {
    errors.push('Valor inválido');
  }

  if (!ALLOWED_CATEGORIES.includes(transaction.categoria)) {
    errors.push('Categoria inválida');
  }

  if (typeof transaction.descricao !== 'string' || !sanitizeText(transaction.descricao)) {
    errors.push('Descrição inválida');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(transaction.data)) {
    errors.push('Data inválida');
  }

  return {
    valid: errors.length === 0,
    errors,
    data: {
      valor: Number(transaction.valor.toFixed(2)),
      categoria: transaction.categoria,
      descricao: sanitizeText(transaction.descricao),
      data: transaction.data
    }
  };
}

function normalizeTransaction(payload, referenceDate = new Date()) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Payload vazio ou inválido'] };
  }

  const normalized = {
    valor: parseMoney(payload.valor),
    categoria: normalizeCategory(payload.categoria),
    descricao: sanitizeText(payload.descricao || ''),
    data: normalizeDate(String(payload.data || ''), referenceDate)
  };

  if (!normalized.descricao) {
    normalized.descricao = 'Sem descrição';
  }

  return validateTransaction(normalized);
}

function fallbackParseTransaction(text, referenceDate = new Date()) {
  const clean = sanitizeText(text);

  if (!clean) {
    return null;
  }

  const amountMatch = clean.match(/(?:r\$\s*)?(\d+[\d.,]*)/i);

  if (!amountMatch) {
    return null;
  }

  const value = parseMoney(amountMatch[1]);

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const candidate = {
    valor: value,
    categoria: inferCategoryFromText(clean),
    descricao: cleanupDescription(clean),
    data: parseDateFromText(clean, referenceDate)
  };

  const validation = validateTransaction(candidate);
  return validation.valid ? validation.data : null;
}

function isLikelyPromotionalText(text) {
  const normalized = sanitizeText(text).toLowerCase();

  if (!normalized) {
    return false;
  }

  const hasUrl = /(https?:\/\/|www\.)/i.test(normalized);
  const hasPromoKeyword = /(oferta|promo[cç][aã]o|cupom|desconto|imperd[ií]vel|frete|kit\s+\d+|de\s*~?\s*\d|por\s*\*?\s*\d|mercadolivre|shopee)/i.test(normalized);
  const hasPromoSymbols = /[🔥✅🔗]/.test(text);
  const looksBroadcastCopy = normalized.length > 140;

  if (hasUrl && (hasPromoKeyword || hasPromoSymbols || looksBroadcastCopy)) {
    return true;
  }

  if ((hasPromoKeyword || hasPromoSymbols) && looksBroadcastCopy) {
    return true;
  }

  return false;
}

function normalizeUserId(jid) {
  if (typeof jid !== 'string') {
    return 'desconhecido';
  }

  const onlyDigits = jid.replace(/@.+$/, '').replace(/\D/g, '');
  return onlyDigits || 'desconhecido';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  ALLOWED_CATEGORIES,
  cleanupDescription,
  delay,
  extractJSONObject,
  fallbackParseTransaction,
  formatCurrencyBRL,
  isLikelyPromotionalText,
  logError,
  logInfo,
  logWarn,
  normalizeCategory,
  normalizeDate,
  normalizeTransaction,
  normalizeUserId,
  parseDateFromText,
  parseMoney,
  safeJsonParse,
  sanitizeText,
  toISODate,
  validateTransaction
};
