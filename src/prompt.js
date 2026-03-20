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
    'O comprovante pode ser de qualquer adquirente, banco ou emissor; não assuma marca específica.',
    'Exemplos apenas ilustrativos: Mercado Pago, Cielo, Stone, Getnet, SumUp, PagSeguro, SafraPay.',
    'Responda apenas com JSON válido, sem markdown, sem texto adicional e sem comentários.',
    'Formato obrigatório de saída:',
    `{"valor": number, "categoria": "${categoryRule}", "descricao": "string", "data": "YYYY-MM-DD", "estabelecimento": "string", "confianca": number, "forma_pagamento": "string", "texto_ocr": "string"}`,
    'Regras obrigatórias:',
    '1) valor deve ser número positivo com ponto para casas decimais.',
    '2) Para comprovante de cartão, priorize o valor do campo TOTAL/VALOR TOTAL.',
    '3) Ignore parcelas quando não mudarem o valor total (ex: 1x R$ 465,00).',
    `4) categoria deve ser exatamente uma das opções: ${categoryList.join(', ')}.`,
    '5) descricao deve ser curta e objetiva, descrevendo o gasto principal.',
    '6) data deve estar em YYYY-MM-DD.',
    `7) Se a data não estiver legível, use a data de referência ${referenceDate}.`,
    '8) estabelecimento deve trazer o nome da loja/empresa (não o nome da adquirente da maquininha, quando houver).',
    '9) forma_pagamento deve trazer algo como: CRÉDITO AMEX 7429, DÉBITO, PIX, DINHEIRO.',
    '10) confianca deve ser número entre 0 e 1.',
    '11) texto_ocr deve conter texto relevante lido da imagem (pode ser vazio se ilegível).',
    '12) Nunca retorne null ou texto fora do JSON.'
  ].join('\n');
}

module.exports = {
  buildExtractionSystemPrompt,
  buildReceiptSystemPrompt,
  buildUpdateSystemPrompt
};
