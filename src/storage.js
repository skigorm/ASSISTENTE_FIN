const fs = require('fs/promises');
const path = require('path');
const { ALLOWED_CATEGORIES, logError, logInfo, sanitizeText } = require('./utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TRANSACTIONS_FILE = path.join(DATA_DIR, 'transactions.json');

let writeQueue = Promise.resolve();

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

async function readAllTransactions() {
  try {
    await ensureStorageFile();
    return await readTransactionsUnsafe();
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

async function saveTransaction(user, transaction) {
  return withWriteLock(async () => {
    await ensureStorageFile();

    const list = await readTransactionsUnsafe();
    const normalizedRecord = {
      user: sanitizeText(user),
      valor: Number(transaction.valor),
      categoria: sanitizeText(transaction.categoria),
      descricao: sanitizeText(transaction.descricao),
      data: sanitizeText(transaction.data)
    };

    if (isDuplicate(list, normalizedRecord)) {
      return { saved: false, duplicate: true, record: normalizedRecord };
    }

    list.push(normalizedRecord);
    await fs.writeFile(TRANSACTIONS_FILE, `${JSON.stringify(list, null, 2)}\n`, 'utf8');

    logInfo('STORAGE', 'Transação salva com sucesso.', normalizedRecord);
    return { saved: true, duplicate: false, record: normalizedRecord };
  });
}

async function getTransactionsByUser(user) {
  const list = await readAllTransactions();
  return list.filter((item) => item.user === user);
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
