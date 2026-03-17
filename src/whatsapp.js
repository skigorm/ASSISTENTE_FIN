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

let activeSocket = null;
let isStarting = false;
let reconnectTimer = null;

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
    markOnlineOnConnect: false,
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
