const axios = require('axios');
const {
  buildExtractionSystemPrompt,
  buildReceiptSystemPrompt,
  buildUpdateSystemPrompt
} = require('./prompt');
const {
  extractJSONObject,
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

  const normalized = normalizeTransaction(parsed, referenceDate, { customCategories });

  if (!normalized.valid) {
    logWarn('AI', 'Comprovante inválido após normalização.', normalized.errors);
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
  const estabelecimento = sanitizeText(
    String(parsed.estabelecimento || parsed.loja || parsed.merchant || '')
  );

  logInfo('AI', 'Comprovante interpretado com sucesso pela OpenAI.');
  return {
    transaction: normalized.data,
    estabelecimento,
    confidence
  };
}

module.exports = {
  parseReceiptWithAI,
  parseTransactionPatchWithAI,
  parseTransactionWithAI
};
