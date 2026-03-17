const axios = require('axios');
const { buildExtractionSystemPrompt } = require('./prompt');
const {
  extractJSONObject,
  logError,
  logInfo,
  logWarn,
  normalizeTransaction,
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

async function parseTransactionWithAI(text, referenceDate = new Date()) {
  const cleanText = sanitizeText(text);

  if (!cleanText) {
    return null;
  }

  if (!process.env.OPENAI_KEY) {
    logWarn('AI', 'OPENAI_KEY não configurada. Usando fallback local.');
    return null;
  }

  const referenceDateISO = toISODate(referenceDate);
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  try {
    const response = await axios.post(
      OPENAI_URL,
      {
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: buildExtractionSystemPrompt(referenceDateISO)
          },
          {
            role: 'user',
            content: cleanText
          }
        ]
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

    const normalized = normalizeTransaction(parsed, referenceDate);

    if (!normalized.valid) {
      logWarn('AI', 'JSON da OpenAI inválido após normalização.', normalized.errors);
      return null;
    }

    logInfo('AI', 'Mensagem interpretada com sucesso pela OpenAI.');
    return normalized.data;
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

module.exports = {
  parseTransactionWithAI
};
