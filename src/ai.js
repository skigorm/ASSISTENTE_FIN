const axios = require('axios');
const {
  buildExtractionSystemPrompt,
  buildReceiptSystemPrompt,
  buildUpdateSystemPrompt
} = require('./prompt');
const {
  extractJSONObject,
  inferCategoryFromText,
  logError,
  logInfo,
  logWarn,
  normalizeCategory,
  normalizeDate,
  normalizeTransaction,
  parseMoney,
  safeJsonParse,
  sanitizeText,
  toISODate
} = require('./utils');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function parseModelOutput(content) {
  if (content && typeof content === 'object') {
    return content;
  }

  if (typeof content !== 'string') {
    return null;
  }

  const direct = safeJsonParse(content);

  if (direct) {
    return direct;
  }

  const extracted = extractJSONObject(content);
  return extracted ? safeJsonParse(extracted) : null;
}

async function callOpenAIJson(messages, options = {}) {
  if (!process.env.OPENAI_KEY) {
    logWarn('AI', 'OPENAI_KEY não configurada. Usando fallback local.');
    return null;
  }

  const model = sanitizeText(options.model || process.env.OPENAI_MODEL || 'gpt-4o-mini');
  const timeout = Number.isFinite(Number(options.timeout)) && Number(options.timeout) > 0
    ? Number(options.timeout)
    : 20000;

  const payload = {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages
  };

  if (Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0) {
    payload.max_tokens = Number(options.maxTokens);
  }

  try {
    const response = await axios.post(
      OPENAI_URL,
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout
      }
    );

    const choices = response && response.data ? response.data.choices : null;
    const content = Array.isArray(choices) && choices[0] && choices[0].message
      ? choices[0].message.content
      : null;
    const parsed = parseModelOutput(content);

    if (!parsed) {
      logWarn('AI', 'Resposta da OpenAI não veio como JSON interpretável.', { content });
      return null;
    }

    return parsed;
  } catch (error) {
    const status = error && error.response ? error.response.status : undefined;
    const apiError = error && error.response && error.response.data
      ? error.response.data.error
      : error.message;

    logError('AI', 'Erro ao chamar OpenAI API.', {
      status,
      error: apiError
    });
    return null;
  }
}

function normalizeConfidence(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number.parseFloat(String(value).replace(',', '.'));

  if (!Number.isFinite(parsed)) {
    return null;
  }

  let normalized = parsed;

  if (normalized > 1 && normalized <= 100) {
    normalized = normalized / 100;
  }

  if (normalized > 1) {
    normalized = 1;
  }

  if (normalized < 0) {
    normalized = 0;
  }

  return Number(normalized.toFixed(2));
}

const RECEIPT_BRAND_HINTS = [
  /mercado\s*pago/i,
  /pag\s*seguro|pagbank|moderninha/i,
  /sumup/i,
  /stone|ton\b/i,
  /cielo/i,
  /getnet/i,
  /safra\s*pay/i,
  /infinite\s*pay|infinitepay/i
];

const RECEIPT_NOISE_HINTS = [
  /via\s*cliente|via\s*estabelecimento|comprovante/i,
  /opera[cç][aã]o|autoriza[cç][aã]o|aprovado|negado/i,
  /total|subtotal|parcela|valor\s*total/i,
  /nfc|nsu|aid|lote|terminal|cart[aã]o|estab\.?/i,
  /s[eé]rie|c[oó]digo|transa[cç][aã]o|documento/i,
  /cr[eé]dito|d[eé]bito|pix|dinheiro/i
];

function isLikelyReceiptNoiseLine(rawLine) {
  const line = sanitizeText(rawLine);

  if (!line) {
    return true;
  }

  const lower = line.toLowerCase();

  if (RECEIPT_BRAND_HINTS.some((pattern) => pattern.test(lower))) {
    return true;
  }

  if (RECEIPT_NOISE_HINTS.some((pattern) => pattern.test(lower))) {
    return true;
  }

  if (!/[a-z]/i.test(line)) {
    return true;
  }

  return false;
}

function extractAmountFromRawValue(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return Number.NaN;
  }

  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) ? rawValue : Number.NaN;
  }

  const safe = String(rawValue || '');
  const currencyMatches = safe.match(/r\$\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})|[0-9]+(?:[.,][0-9]{2})?)/gi);

  if (currencyMatches && currencyMatches.length) {
    const parsedValues = currencyMatches
      .map((item) => parseMoney(item))
      .filter((item) => Number.isFinite(item) && item > 0);

    if (parsedValues.length) {
      return Math.max(...parsedValues);
    }
  }

  return parseMoney(safe);
}

function extractAmountFromReceiptText(rawText) {
  const text = String(rawText || '');

  if (!text) {
    return Number.NaN;
  }

  const totalPatterns = [
    /(?:^|\n|\r|\s)total\s*[:\-]?\s*(?:r\$\s*)?([0-9][0-9\.,]*)/i,
    /(?:^|\n|\r|\s)valor\s*total\s*[:\-]?\s*(?:r\$\s*)?([0-9][0-9\.,]*)/i,
    /(?:^|\n|\r|\s)total\s+geral\s*[:\-]?\s*(?:r\$\s*)?([0-9][0-9\.,]*)/i
  ];

  for (const pattern of totalPatterns) {
    const match = text.match(pattern);

    if (match && match[1]) {
      const parsed = extractAmountFromRawValue(match[1]);

      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  const allMoneyMatches = text.match(/r\$\s*([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{2})|[0-9]+(?:[.,][0-9]{2})?)/gi);

  if (!allMoneyMatches || !allMoneyMatches.length) {
    return Number.NaN;
  }

  const values = allMoneyMatches
    .map((item) => parseMoney(item))
    .filter((item) => Number.isFinite(item) && item > 0);

  if (!values.length) {
    return Number.NaN;
  }

  return Math.max(...values);
}

function extractDateFromReceiptText(rawText, referenceDate) {
  const text = String(rawText || '');

  if (!text) {
    return toISODate(referenceDate);
  }

  const dateMatch = text.match(/\b([0-3]?\d)[\/\-]([01]?\d)[\/\-]((?:20)?\d{2,4})\b/);

  if (!dateMatch) {
    return normalizeDate('', referenceDate);
  }

  const day = Number.parseInt(dateMatch[1], 10);
  const month = Number.parseInt(dateMatch[2], 10);
  let year = Number.parseInt(dateMatch[3], 10);

  if (year < 100) {
    year += 2000;
  }

  const maybeDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return normalizeDate(maybeDate, referenceDate);
}

function extractEstablishmentFromReceiptText(rawText) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((line) => sanitizeText(line))
    .filter(Boolean);

  if (!lines.length) {
    return '';
  }

  for (const line of lines) {
    if (!/\d{11,14}/.test(line)) {
      continue;
    }

    const beforeDoc = sanitizeText(line.replace(/\d{11,14}.*/, ''));

    if (beforeDoc && beforeDoc.length >= 3 && !isLikelyReceiptNoiseLine(beforeDoc)) {
      return beforeDoc;
    }
  }

  for (const line of lines) {
    if (isLikelyReceiptNoiseLine(line)) {
      continue;
    }

    if (/[a-z]/i.test(line) && line.length >= 3) {
      return line;
    }
  }

  return '';
}

function extractPaymentMethodFromReceiptText(rawText) {
  const text = String(rawText || '');

  if (!text) {
    return '';
  }

  const cardMatch = text.match(/\b(cr[eé]dito|d[eé]bito)\b[^\n\r]{0,30}/i);
  if (cardMatch && cardMatch[0]) {
    return sanitizeText(cardMatch[0]);
  }

  const pixMatch = text.match(/\bpix\b/i);
  if (pixMatch) {
    return 'PIX';
  }

  const cashMatch = text.match(/\bdinheiro\b/i);
  if (cashMatch) {
    return 'Dinheiro';
  }

  return '';
}

function buildReceiptDescription(baseDescription, estabelecimento, paymentMethod) {
  const description = sanitizeText(baseDescription);

  if (description && description.toLowerCase() !== 'sem descrição') {
    return description;
  }

  if (estabelecimento && paymentMethod) {
    return sanitizeText(`Compra em ${estabelecimento} (${paymentMethod})`);
  }

  if (estabelecimento) {
    return sanitizeText(`Compra em ${estabelecimento}`);
  }

  if (paymentMethod) {
    return sanitizeText(`Compra via ${paymentMethod}`);
  }

  return 'Compra no comprovante';
}

function normalizeReceiptPayload(parsed, referenceDate, customCategories) {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const rawOcrText = String(
    parsed.texto_ocr ||
    parsed.ocr_text ||
    parsed.texto ||
    parsed.raw_text ||
    parsed.comprovante_texto ||
    ''
  );
  const ocrText = sanitizeText(rawOcrText);

  const amountCandidates = [
    parsed.valor,
    parsed.valor_total,
    parsed.total,
    parsed.amount,
    parsed.valorFinal,
    parsed.valor_final
  ];

  let amount = Number.NaN;

  for (const candidate of amountCandidates) {
    const parsedAmount = extractAmountFromRawValue(candidate);

    if (Number.isFinite(parsedAmount) && parsedAmount > 0) {
      amount = parsedAmount;
      break;
    }
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    amount = extractAmountFromReceiptText(rawOcrText || ocrText);
  }

  const parsedDate = sanitizeText(
    String(parsed.data || parsed.data_hora || parsed.dataHora || parsed.datetime || '')
  );
  const date = parsedDate
    ? normalizeDate(parsedDate, referenceDate)
    : extractDateFromReceiptText(rawOcrText || ocrText, referenceDate);

  const estabelecimento = sanitizeText(
    String(
      parsed.estabelecimento ||
      parsed.loja ||
      parsed.merchant ||
      parsed.nome_estabelecimento ||
      extractEstablishmentFromReceiptText(rawOcrText || ocrText) ||
      ''
    )
  );

  const paymentMethod = sanitizeText(
    String(
      parsed.forma_pagamento ||
      parsed.meio_pagamento ||
      parsed.pagamento ||
      parsed.metodo_pagamento ||
      extractPaymentMethodFromReceiptText(rawOcrText || ocrText) ||
      ''
    )
  );

  const categoryInput = sanitizeText(String(parsed.categoria || ''));
  const category = categoryInput
    ? normalizeCategory(categoryInput, customCategories)
    : inferCategoryFromText(`${estabelecimento} ${paymentMethod} ${ocrText}`, customCategories);

  const descricao = buildReceiptDescription(
    parsed.descricao || parsed.item || parsed.produto || '',
    estabelecimento,
    paymentMethod
  );

  const normalized = normalizeTransaction(
    {
      valor: amount,
      categoria: category || 'Outros',
      descricao,
      data: date
    },
    referenceDate,
    { customCategories }
  );

  if (!normalized.valid) {
    return {
      valid: false,
      errors: normalized.errors,
      estabelecimento
    };
  }

  return {
    valid: true,
    data: normalized.data,
    estabelecimento
  };
}

async function parseTransactionWithAI(text, referenceDate = new Date(), options = {}) {
  const cleanText = sanitizeText(text);

  if (!cleanText) {
    return null;
  }

  const referenceDateISO = toISODate(referenceDate);
  const customCategories = Array.isArray(options.customCategories) ? options.customCategories : [];
  const parsed = await callOpenAIJson([
    {
      role: 'system',
      content: buildExtractionSystemPrompt(referenceDateISO, customCategories)
    },
    {
      role: 'user',
      content: cleanText
    }
  ]);

  if (!parsed) {
    return null;
  }

  const normalized = normalizeTransaction(parsed, referenceDate, { customCategories });

  if (!normalized.valid) {
    logWarn('AI', 'JSON da OpenAI inválido após normalização.', normalized.errors);
    return null;
  }

  logInfo('AI', 'Mensagem interpretada com sucesso pela OpenAI.');
  return normalized.data;
}

async function parseTransactionPatchWithAI(text, referenceDate = new Date(), options = {}) {
  const cleanText = sanitizeText(text);

  if (!cleanText) {
    return null;
  }

  const referenceDateISO = toISODate(referenceDate);
  const customCategories = Array.isArray(options.customCategories) ? options.customCategories : [];
  const parsed = await callOpenAIJson([
    {
      role: 'system',
      content: buildUpdateSystemPrompt(referenceDateISO, customCategories)
    },
    {
      role: 'user',
      content: cleanText
    }
  ]);

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const patch = {};
  const maybeValue = parsed.valor;
  const maybeCategory = parsed.categoria;
  const maybeDescription = parsed.descricao;
  const maybeDate = parsed.data;

  if (maybeValue !== null && maybeValue !== undefined && sanitizeText(String(maybeValue))) {
    const parsedValue = parseMoney(maybeValue);

    if (Number.isFinite(parsedValue) && parsedValue > 0) {
      patch.valor = Number(parsedValue.toFixed(2));
    }
  }

  if (maybeCategory !== null && maybeCategory !== undefined && sanitizeText(String(maybeCategory))) {
    patch.categoria = normalizeCategory(maybeCategory, customCategories);
  }

  if (maybeDescription !== null && maybeDescription !== undefined && sanitizeText(String(maybeDescription))) {
    patch.descricao = sanitizeText(String(maybeDescription));
  }

  if (maybeDate !== null && maybeDate !== undefined && sanitizeText(String(maybeDate))) {
    patch.data = normalizeDate(String(maybeDate), referenceDate);
  }

  return Object.keys(patch).length ? patch : null;
}

async function parseReceiptWithAI(
  imageBuffer,
  mimeType = 'image/jpeg',
  caption = '',
  referenceDate = new Date(),
  options = {}
) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return null;
  }

  const customCategories = Array.isArray(options.customCategories) ? options.customCategories : [];
  const safeMimeType = sanitizeText(String(mimeType || '')).toLowerCase();
  const finalMimeType = /^image\/[a-z0-9.+-]+$/.test(safeMimeType) ? safeMimeType : 'image/jpeg';
  const base64Image = imageBuffer.toString('base64');

  if (!base64Image) {
    return null;
  }

  const referenceDateISO = toISODate(referenceDate);
  const cleanCaption = sanitizeText(caption);
  const visionModel = sanitizeText(process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini');
  const userText = cleanCaption
    ? `Legenda enviada junto com a imagem: "${cleanCaption}".`
    : 'Sem legenda adicional.';

  const parsed = await callOpenAIJson(
    [
      {
        role: 'system',
        content: buildReceiptSystemPrompt(referenceDateISO, customCategories)
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: userText
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${finalMimeType};base64,${base64Image}`,
              detail: 'auto'
            }
          }
        ]
      }
    ],
    {
      model: visionModel,
      timeout: 35000,
      maxTokens: 500
    }
  );

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const normalizedReceipt = normalizeReceiptPayload(parsed, referenceDate, customCategories);

  if (!normalizedReceipt || !normalizedReceipt.valid) {
    logWarn('AI', 'Comprovante inválido após normalização.', normalizedReceipt ? normalizedReceipt.errors : parsed);
    return null;
  }

  const rawConfidenceCandidates = [
    parsed.confianca,
    parsed.confianca_modelo,
    parsed.confidence,
    parsed.probabilidade
  ];
  const rawConfidence = rawConfidenceCandidates.find((item) => item !== null && item !== undefined);
  const confidence = normalizeConfidence(rawConfidence);
  const estabelecimento = sanitizeText(normalizedReceipt.estabelecimento);

  logInfo('AI', 'Comprovante interpretado com sucesso pela OpenAI.');
  return {
    transaction: normalizedReceipt.data,
    estabelecimento,
    confidence
  };
}

module.exports = {
  parseReceiptWithAI,
  parseTransactionPatchWithAI,
  parseTransactionWithAI
};
