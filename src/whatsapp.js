const path = require('path');
const baileys = require('@whiskeysockets/baileys');
const { parseTransactionWithAI } = require('./ai');
const { saveTransaction } = require('./storage');
const {
  fallbackParseTransaction,
  formatCurrencyBRL,
  isLikelyPromotionalText,
  logError,
  logInfo,
  logWarn,
  normalizeUserId,
  sanitizeText
} = require('./utils');
const {
  setWhatsAppConnected,
  setWhatsAppConnecting,
  setWhatsAppDisconnected,
  setWhatsAppLoggedOut,
  setWhatsAppPairingCode,
  setWhatsAppWaitingQr
} = require('./whatsappState');

const makeWASocket = baileys.default;
const { DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys;

const AUTH_FOLDER = path.join(__dirname, '..', 'data', 'baileys_auth');
const RECONNECT_DELAY_MS = 5000;
const PAIRING_NUMBER_ENV = 'WHATSAPP_PAIRING_NUMBER';
const MESSAGE_LOGS_ENV = 'WHATSAPP_LOG_MESSAGES';
const IGNORED_MESSAGE_LOGS_ENV = 'WHATSAPP_LOG_IGNORED_MESSAGES';

const silentBaileysLogger = {
  level: 'silent',
  child() {
    return silentBaileysLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {}
};

let activeSocket = null;
let isStarting = false;
let reconnectTimer = null;

function isEnvEnabled(name, defaultValue = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();

  if (!value) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(value);
}

function shouldLogMessages() {
  return isEnvEnabled(MESSAGE_LOGS_ENV, true);
}

function shouldLogIgnoredMessages() {
  return isEnvEnabled(IGNORED_MESSAGE_LOGS_ENV, false);
}

function getPairingNumber() {
  return String(process.env[PAIRING_NUMBER_ENV] || '').replace(/\D/g, '');
}

function formatPairingCode(rawCode) {
  const code = sanitizeText(String(rawCode || '')).replace(/\s+/g, '').toUpperCase();

  if (!code) {
    return '';
  }

  const chunks = code.match(/.{1,4}/g);
  return chunks ? chunks.join('-') : code;
}

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
    if (shouldLogMessages()) {
      logInfo('WHATSAPP', 'Enviando mensagem.', {
        jid,
        text: sanitizeText(text)
      });
    }

    await sock.sendMessage(jid, { text });

    if (shouldLogMessages()) {
      logInfo('WHATSAPP', 'Mensagem enviada com sucesso.', {
        jid,
        text: sanitizeText(text)
      });
    }
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

function isSupportedDirectChat(jid) {
  if (!jid || typeof jid !== 'string') {
    return false;
  }

  if (jid.endsWith('@broadcast')) {
    return false;
  }

  if (jid.endsWith('@g.us')) {
    return false;
  }

  if (jid.endsWith('@newsletter')) {
    return false;
  }

  if (jid.endsWith('@s.whatsapp.net')) {
    return true;
  }

  if (jid.endsWith('@lid')) {
    return true;
  }

  return false;
}

async function processIncomingMessage(sock, message) {
  try {
    if (!message || !message.message) {
      return;
    }

    const jid = message.key ? message.key.remoteJid : null;
    const fromMe = message.key && message.key.fromMe;

    if (fromMe) {
      if (shouldLogIgnoredMessages()) {
        logInfo('WHATSAPP', 'Mensagem ignorada (fromMe=true).', { jid });
      }
      return;
    }

    if (!isSupportedDirectChat(jid)) {
      if (shouldLogIgnoredMessages()) {
        logInfo('WHATSAPP', 'Mensagem ignorada (chat não suportado).', { jid });
      }
      return;
    }

    const rawText = extractTextMessage(message.message);

    if (!rawText) {
      if (shouldLogIgnoredMessages()) {
        logInfo('WHATSAPP', 'Mensagem ignorada (não é texto).', { jid });
      }
      return;
    }

    const text = sanitizeText(rawText);

    if (!text) {
      return;
    }

    const userNumber = normalizeUserId(jid);
    if (shouldLogMessages()) {
      logInfo('WHATSAPP', 'Mensagem recebida.', {
        jid,
        user: userNumber,
        text
      });
    }

    const referenceDate = new Date();
    let transaction = await parseTransactionWithAI(text, referenceDate);

    if (!transaction) {
      if (isLikelyPromotionalText(text)) {
        logInfo('WHATSAPP', 'Mensagem promocional ignorada para evitar falso positivo.', {
          user: userNumber,
          jid
        });
        return;
      }

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

function createConnectionUpdateHandler(sock, state) {
  let pairingCodeRequested = false;
  let pairingHintLogged = false;

  return async (update) => {
    try {
      const connection = update ? update.connection : null;
      const lastDisconnect = update ? update.lastDisconnect : null;
      const qr = update ? update.qr : null;

      if (qr && !state.creds.registered) {
        const pairingNumber = getPairingNumber();

        if (!pairingNumber) {
          setWhatsAppWaitingQr(qr);

          if (!pairingHintLogged) {
            pairingHintLogged = true;
            logWarn(
              'WHATSAPP',
              'QR gerado. Acesse /pairing no navegador para escanear.'
            );
          }
        } else if (!pairingCodeRequested) {
          pairingCodeRequested = true;

          try {
            const code = await sock.requestPairingCode(pairingNumber);
            setWhatsAppPairingCode();
            logInfo(
              'WHATSAPP',
              `Código de pareamento: ${formatPairingCode(code)}. No celular: Dispositivos conectados -> Conectar com número de telefone.`
            );
          } catch (error) {
            pairingCodeRequested = false;
            logError('WHATSAPP', 'Falha ao solicitar código de pareamento.', error.message);
          }
        }
      }

      if (connection === 'open') {
        setWhatsAppConnected();
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
        setWhatsAppDisconnected({ statusCode, shouldReconnect });

        activeSocket = null;

        if (shouldReconnect) {
          scheduleReconnect();
        } else {
          setWhatsAppLoggedOut();
          logWarn('WHATSAPP', 'Sessão deslogada. Faça novo pareamento para continuar.');
        }
      }
    } catch (error) {
      logError('WHATSAPP', 'Erro ao tratar atualização de conexão.', error.message);
    }
  };
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
    logger: silentBaileysLogger,
    markOnlineOnConnect: false,
    shouldIgnoreJid: (jid) => !isSupportedDirectChat(jid),
    shouldSyncHistoryMessage: () => false,
    syncFullHistory: false
  };

  if (version) {
    socketConfig.version = version;
  }

  setWhatsAppConnecting();
  const sock = makeWASocket(socketConfig);

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (error) {
      logError('WHATSAPP', 'Falha ao salvar credenciais.', error.message);
    }
  });

  const handleConnectionUpdate = createConnectionUpdateHandler(sock, state);

  sock.ev.on('connection.update', async (update) => {
    await handleConnectionUpdate(update);
  });
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
