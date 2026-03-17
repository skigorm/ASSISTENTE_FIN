const path = require('path');
const baileys = require('@whiskeysockets/baileys');
const { parseTransactionWithAI } = require('./ai');
const { saveTransaction } = require('./storage');
const {
  fallbackParseTransaction,
  formatCurrencyBRL,
  logError,
  logInfo,
  logWarn,
  normalizeUserId,
  sanitizeText
} = require('./utils');

const makeWASocket = baileys.default;
const { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys;

const AUTH_FOLDER = path.join(__dirname, '..', 'data', 'baileys_auth');
const RECONNECT_DELAY_MS = 5000;

let activeSocket = null;
let isStarting = false;
let reconnectTimer = null;

function unwrapMessageContent(messageContent) {
  let current = messageContent;

  for (let i = 0; i < 5; i += 1) {
    if (current && current.ephemeralMessage && current.ephemeralMessage.message) {
      current = current.ephemeralMessage.message;
      continue;
    }

    if (current && current.viewOnceMessageV2 && current.viewOnceMessageV2.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }

    if (current && current.viewOnceMessage && current.viewOnceMessage.message) {
      current = current.viewOnceMessage.message;
      continue;
    }

    break;
  }

  return current;
}

function extractTextMessage(messageContent) {
  const content = unwrapMessageContent(messageContent);

  if (!content) {
    return '';
  }

  if (typeof content.conversation === 'string') {
    return content.conversation;
  }

  if (content.extendedTextMessage && typeof content.extendedTextMessage.text === 'string') {
    return content.extendedTextMessage.text;
  }

  return '';
}

async function safeReply(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch (error) {
    logError('WHATSAPP', 'Falha ao enviar resposta ao usuário.', {
      jid,
      error: error.message
    });
  }
}

function buildSuccessMessage(transaction) {
  return [
    '💰 Gasto registrado:',
    `Valor: ${formatCurrencyBRL(transaction.valor)}`,
    `Categoria: ${transaction.categoria}`
  ].join('\n');
}

async function processIncomingMessage(sock, message) {
  try {
    if (!message || !message.message || (message.key && message.key.fromMe)) {
      return;
    }

    const jid = message.key ? message.key.remoteJid : null;

    if (!jid || jid.endsWith('@broadcast')) {
      return;
    }

    if (jid.endsWith('@g.us')) {
      logInfo('WHATSAPP', 'Mensagem de grupo ignorada.', { jid });
      return;
    }

    const rawText = extractTextMessage(message.message);

    if (!rawText) {
      logInfo('WHATSAPP', 'Mensagem ignorada (não é texto).', { jid });
      return;
    }

    const text = sanitizeText(rawText);

    if (!text) {
      return;
    }

    const userNumber = normalizeUserId(jid);
    logInfo('WHATSAPP', 'Mensagem recebida.', { user: userNumber, text });

    const referenceDate = new Date();
    let transaction = await parseTransactionWithAI(text, referenceDate);

    if (!transaction) {
      transaction = fallbackParseTransaction(text, referenceDate);

      if (transaction) {
        logInfo('WHATSAPP', 'Mensagem interpretada com fallback local.', {
          user: userNumber,
          transaction
        });
      }
    }

    if (!transaction) {
      await safeReply(sock, jid, 'Não consegui entender, pode tentar novamente?');
      return;
    }

    const saveResult = await saveTransaction(userNumber, transaction);

    if (saveResult.duplicate) {
      await safeReply(sock, jid, 'Esse gasto já foi registrado anteriormente.');
      logWarn('WHATSAPP', 'Transação duplicada detectada.', saveResult.record);
      return;
    }

    await safeReply(sock, jid, buildSuccessMessage(saveResult.record));
    logInfo('WHATSAPP', 'Transação processada com sucesso.', saveResult.record);
  } catch (error) {
    logError('WHATSAPP', 'Erro ao processar mensagem.', error.message);
  }
}

async function handleMessagesUpsert(sock, event) {
  try {
    if (!event || event.type !== 'notify' || !Array.isArray(event.messages)) {
      return;
    }

    for (const message of event.messages) {
      await processIncomingMessage(sock, message);
    }
  } catch (error) {
    logError('WHATSAPP', 'Falha no listener de mensagens.', error.message);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    startWhatsAppBot().catch((error) => {
      logError('WHATSAPP', 'Falha ao reconectar. Nova tentativa será feita.', error.message);
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
}

function handleConnectionUpdate(update) {
  try {
    const connection = update ? update.connection : null;
    const lastDisconnect = update ? update.lastDisconnect : null;

    if (connection === 'open') {
      logInfo('WHATSAPP', 'Conexão estabelecida com sucesso.');
      return;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect &&
        lastDisconnect.error &&
        lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : undefined;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logWarn('WHATSAPP', 'Conexão encerrada.', {
        statusCode,
        shouldReconnect
      });

      activeSocket = null;

      if (shouldReconnect) {
        scheduleReconnect();
      } else {
        logWarn('WHATSAPP', 'Sessão deslogada. Faça novo pareamento via QR Code.');
      }
    }
  } catch (error) {
    logError('WHATSAPP', 'Erro ao tratar atualização de conexão.', error.message);
  }
}

async function createSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  let version;

  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch (error) {
    logWarn('WHATSAPP', 'Não foi possível buscar a versão mais recente do Baileys.');
  }

  const socketConfig = {
    auth: state,
    markOnlineOnConnect: false,
    printQRInTerminal: true,
    syncFullHistory: false
  };

  if (version) {
    socketConfig.version = version;
  }

  const sock = makeWASocket(socketConfig);

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (error) {
      logError('WHATSAPP', 'Falha ao salvar credenciais.', error.message);
    }
  });

  sock.ev.on('connection.update', handleConnectionUpdate);
  sock.ev.on('messages.upsert', async (event) => {
    await handleMessagesUpsert(sock, event);
  });

  return sock;
}

async function startWhatsAppBot() {
  if (isStarting) {
    return activeSocket;
  }

  isStarting = true;

  try {
    if (activeSocket) {
      return activeSocket;
    }

    activeSocket = await createSocket();
    logInfo('WHATSAPP', 'Socket inicializado. Aguardando mensagens...');
    return activeSocket;
  } finally {
    isStarting = false;
  }
}

module.exports = {
  startWhatsAppBot
};
