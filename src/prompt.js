function buildExtractionSystemPrompt(referenceDate, customCategories = []) {
  const safeCustomCategories = Array.isArray(customCategories)
    ? customCategories.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const categoryList = ['Alimentação', 'Transporte', 'Lazer', 'Outros', ...safeCustomCategories];
  const categoryRule = categoryList.join('|');

  return [
    'Você extrai dados financeiros de mensagens informais em português.',
    'Responda apenas com JSON válido, sem markdown, sem texto adicional e sem comentários.',
    'Formato obrigatório de saída:',
    `{"valor": number, "categoria": "${categoryRule}", "descricao": "string", "data": "YYYY-MM-DD"}`,
    'Regras obrigatórias:',
    '1) valor deve ser número positivo (use ponto para casas decimais).',
    `2) categoria deve ser exatamente uma das opções: ${categoryList.join(', ')}.`,
    '3) descricao deve ser curta e objetiva.',
    '4) data deve estar no formato YYYY-MM-DD.',
    `5) Considere a data de referência como ${referenceDate}. Interprete termos relativos como hoje/ontem/anteontem.`,
    '6) Nunca inclua chaves extras.',
    '7) Nunca retorne null ou texto fora do JSON.'
  ].join('\n');
}

function buildUpdateSystemPrompt(referenceDate, customCategories = []) {
  const safeCustomCategories = Array.isArray(customCategories)
    ? customCategories.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const categoryList = ['Alimentação', 'Transporte', 'Lazer', 'Outros', ...safeCustomCategories];
  const categoryRule = categoryList.join('|');

  return [
    'Você extrai possíveis alterações de um gasto financeiro a partir de texto informal em português.',
    'Responda apenas com JSON válido, sem markdown, sem texto adicional e sem comentários.',
    'Formato obrigatório de saída:',
    `{"valor": number|null, "categoria": "${categoryRule}"|null, "descricao": "string|null", "data": "YYYY-MM-DD|null"}`,
    'Regras obrigatórias:',
    '1) Retorne null para campos não informados claramente.',
    '2) valor deve ser número positivo quando presente.',
    '3) categoria deve ser exatamente uma das opções quando presente.',
    '4) descricao deve ser curta e objetiva quando presente.',
    '5) data deve estar em YYYY-MM-DD quando presente.',
    `6) Considere a data de referência como ${referenceDate}. Interprete hoje/ontem/anteontem.`,
    '7) Nunca inclua chaves extras.',
    '8) Nunca retorne texto fora do JSON.'
  ].join('\n');
}

function buildReceiptSystemPrompt(referenceDate, customCategories = []) {
  const safeCustomCategories = Array.isArray(customCategories)
    ? customCategories.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const categoryList = ['Alimentação', 'Transporte', 'Lazer', 'Outros', ...safeCustomCategories];
  const categoryRule = categoryList.join('|');

  return [
    'Você extrai dados de comprovantes financeiros em português a partir de imagem.',
    'Responda apenas com JSON válido, sem markdown, sem texto adicional e sem comentários.',
    'Formato obrigatório de saída:',
    `{"valor": number, "categoria": "${categoryRule}", "descricao": "string", "data": "YYYY-MM-DD", "estabelecimento": "string", "confianca": number}`,
    'Regras obrigatórias:',
    '1) valor deve ser número positivo com ponto para casas decimais.',
    `2) categoria deve ser exatamente uma das opções: ${categoryList.join(', ')}.`,
    '3) descricao deve ser curta e objetiva, descrevendo o gasto principal.',
    '4) data deve estar em YYYY-MM-DD.',
    `5) Se a data não estiver legível, use a data de referência ${referenceDate}.`,
    '6) estabelecimento deve ser string curta (nome da loja/empresa) ou string vazia quando ausente.',
    '7) confianca deve ser número entre 0 e 1.',
    '8) Nunca inclua chaves extras.',
    '9) Nunca retorne null ou texto fora do JSON.'
  ].join('\n');
}

module.exports = {
  buildExtractionSystemPrompt,
  buildReceiptSystemPrompt,
  buildUpdateSystemPrompt
};
