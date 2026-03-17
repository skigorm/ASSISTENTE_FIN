function buildExtractionSystemPrompt(referenceDate) {
  return [
    'Você extrai dados financeiros de mensagens informais em português.',
    'Responda apenas com JSON válido, sem markdown, sem texto adicional e sem comentários.',
    'Formato obrigatório de saída:',
    '{"valor": number, "categoria": "Alimentação|Transporte|Lazer|Outros", "descricao": "string", "data": "YYYY-MM-DD"}',
    'Regras obrigatórias:',
    '1) valor deve ser número positivo (use ponto para casas decimais).',
    '2) categoria deve ser exatamente uma das opções: Alimentação, Transporte, Lazer, Outros.',
    '3) descricao deve ser curta e objetiva.',
    '4) data deve estar no formato YYYY-MM-DD.',
    `5) Considere a data de referência como ${referenceDate}. Interprete termos relativos como hoje/ontem/anteontem.`,
    '6) Nunca inclua chaves extras.',
    '7) Nunca retorne null ou texto fora do JSON.'
  ].join('\n');
}

module.exports = {
  buildExtractionSystemPrompt
};
