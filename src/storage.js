const fs = require('fs/promises');
const path = require('path');
const { logError, logInfo, sanitizeText } = require('./utils');

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

module.exports = {
  TRANSACTIONS_FILE,
  getTransactionsByUser,
  readAllTransactions,
  saveTransaction
};
