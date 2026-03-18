const axios = require('axios');
const { buildExtractionSystemPrompt, buildUpdateSystemPrompt } = require('./prompt');
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

async function callOpenAIJson(messages) {
  if (!process.env.OPENAI_KEY) {
    logWarn('AI', 'OPENAI_KEY não configurada. Usando fallback local.');
    return null;
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  try {
    const response = await axios.post(
      OPENAI_URL,
      {
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
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

async function parseTransactionWithAI(text, referenceDate = new Date()) {
  const cleanText = sanitizeText(text);

  if (!cleanText) {
    return null;
  }

  const referenceDateISO = toISODate(referenceDate);
  const parsed = await callOpenAIJson([
    {
      role: 'system',
      content: buildExtractionSystemPrompt(referenceDateISO)
    },
    {
      role: 'user',
      content: cleanText
    }
  ]);

  if (!parsed) {
    return null;
  }

  const normalized = normalizeTransaction(parsed, referenceDate);

  if (!normalized.valid) {
    logWarn('AI', 'JSON da OpenAI inválido após normalização.', normalized.errors);
    return null;
  }

  logInfo('AI', 'Mensagem interpretada com sucesso pela OpenAI.');
  return normalized.data;
}

async function parseTransactionPatchWithAI(text, referenceDate = new Date()) {
  const cleanText = sanitizeText(text);

  if (!cleanText) {
    return null;
  }

  const referenceDateISO = toISODate(referenceDate);
  const parsed = await callOpenAIJson([
    {
      role: 'system',
      content: buildUpdateSystemPrompt(referenceDateISO)
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
    patch.categoria = normalizeCategory(maybeCategory);
  }

  if (maybeDescription !== null && maybeDescription !== undefined && sanitizeText(String(maybeDescription))) {
    patch.descricao = sanitizeText(String(maybeDescription));
  }

  if (maybeDate !== null && maybeDate !== undefined && sanitizeText(String(maybeDate))) {
    patch.data = normalizeDate(String(maybeDate), referenceDate);
  }

  return Object.keys(patch).length ? patch : null;
}

module.exports = {
  parseTransactionPatchWithAI,
  parseTransactionWithAI
};
