const baileys = require('@whiskeysockets/baileys');
const { loadWhatsAppAuthState } = require('./auth');
const { parseTransactionWithAI } = require('./ai');
const { getMonthlySummaryByUser, saveTransaction } = require('./storage');
const {
  ALLOWED_CATEGORIES,
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
const { DisconnectReason, fetchLatestBaileysVersion } = baileys;
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

function stripAccents(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeCommandText(text) {
  return stripAccents(sanitizeText(text).toLowerCase());
}

function isHelpCommand(commandText) {
  return /^(\/)?(ajuda|comandos?)\b/.test(commandText);
}

function hasMonthlySummaryIntent(commandText) {
  if (/^\/?(resumo|relatorio)\b/.test(commandText)) {
    return true;
  }

  if (/quanto\s+gastei/.test(commandText)) {
    return true;
  }

  if (/(total|gastos?)\s+(do|no|nesse|neste)?\s*mes/.test(commandText)) {
    return true;
  }

  if (/por\s+categoria/.test(commandText)) {
    return true;
  }

  if (/^\/?total\s+(alimentacao|transporte|lazer|outros)\b/.test(commandText)) {
    return true;
  }

  return false;
}

function extractRequestedCategory(commandText) {
  if (/\b(alimentacao|mercado|ifood|comida|restaurante|lanche)\b/.test(commandText)) {
    return 'Alimentação';
  }

  if (/\b(transporte|uber|taxi|onibus|metro|combustivel|gasolina|passagem)\b/.test(commandText)) {
    return 'Transporte';
  }

  if (/\b(lazer|entretenimento|cinema|bar|show|netflix|spotify|viagem)\b/.test(commandText)) {
    return 'Lazer';
  }

  if (/\b(outros?)\b/.test(commandText)) {
    return 'Outros';
  }

  return null;
}

function resolveSummaryMonth(commandText, referenceDate = new Date()) {
  const resolved = new Date(referenceDate);
  const monthYearMatch = commandText.match(/\b(0?[1-9]|1[0-2])[\/-](20\d{2})\b/);

  if (monthYearMatch) {
    const month = Number.parseInt(monthYearMatch[1], 10);
    const year = Number.parseInt(monthYearMatch[2], 10);

    return {
      year,
      month,
      label: `${String(month).padStart(2, '0')}/${year}`
    };
  }

  if (/\bmes\s+passado\b/.test(commandText)) {
    resolved.setDate(1);
    resolved.setMonth(resolved.getMonth() - 1);
  }

  const monthMap = {
    janeiro: 1,
    fevereiro: 2,
    marco: 3,
    abril: 4,
    maio: 5,
    junho: 6,
    julho: 7,
    agosto: 8,
    setembro: 9,
    outubro: 10,
    novembro: 11,
    dezembro: 12
  };

  for (const [name, month] of Object.entries(monthMap)) {
    if (commandText.includes(name)) {
      resolved.setMonth(month - 1);
      break;
    }
  }

  const yearMatch = commandText.match(/\b(20\d{2})\b/);

  if (yearMatch) {
    resolved.setFullYear(Number.parseInt(yearMatch[1], 10));
  }

  const year = resolved.getFullYear();
  const month = resolved.getMonth() + 1;

  return {
    year,
    month,
    label: `${String(month).padStart(2, '0')}/${year}`
  };
}

function buildMonthlySummaryMessage(summary, monthLabel) {
  if (!summary.count) {
    return `📊 Nenhum gasto encontrado em ${monthLabel}.`;
  }

  const lines = [
    `📊 Resumo de ${monthLabel}:`,
    `Total: ${formatCurrencyBRL(summary.total)}`,
    `Lançamentos: ${summary.count}`,
    '',
    'Por categoria:'
  ];

  for (const category of ALLOWED_CATEGORIES) {
    lines.push(`- ${category}: ${formatCurrencyBRL(summary.byCategory[category] || 0)}`);
  }

  return lines.join('\n');
}

function buildCategorySummaryMessage(category, monthLabel, categoryTotal, categoryCount) {
  if (!categoryCount) {
    return `📊 Nenhum gasto de ${category.toLowerCase()} encontrado em ${monthLabel}.`;
  }

  return [
    `📊 ${category} em ${monthLabel}:`,
    `Total: ${formatCurrencyBRL(categoryTotal)}`,
    `Lançamentos: ${categoryCount}`
  ].join('\n');
}

function buildHelpMessage() {
  return [
    'Comandos disponíveis:',
    '- resumo do mes',
    '- total do mes',
    '- total por categoria',
    '- total alimentação no mes',
    '- resumo 03/2026',
    '',
    'Para registrar gasto, continue enviando mensagens normais, ex:',
    'gastei 45 no mercado'
  ].join('\n');
}

async function tryHandleFinanceCommand(sock, jid, userNumber, text, referenceDate) {
  const commandText = normalizeCommandText(text);

  if (isHelpCommand(commandText)) {
    await safeReply(sock, jid, buildHelpMessage());
    return true;
  }

  if (!hasMonthlySummaryIntent(commandText)) {
    return false;
  }

  const requestedCategory = extractRequestedCategory(commandText);
  const resolvedMonth = resolveSummaryMonth(commandText, referenceDate);
  const summary = await getMonthlySummaryByUser(
    userNumber,
    resolvedMonth.year,
    resolvedMonth.month
  );

  if (requestedCategory) {
    const categoryTotal = Number(summary.byCategory[requestedCategory] || 0);
    const categoryCount = summary.transactions.filter(
      (item) => item.categoria === requestedCategory
    ).length;

    await safeReply(
      sock,
      jid,
      buildCategorySummaryMessage(
        requestedCategory,
        resolvedMonth.label,
        categoryTotal,
        categoryCount
      )
    );

    logInfo('WHATSAPP', 'Resumo por categoria enviado.', {
      user: userNumber,
      category: requestedCategory,
      month: resolvedMonth.label,
      total: categoryTotal,
      count: categoryCount
    });
    return true;
  }

  await safeReply(sock, jid, buildMonthlySummaryMessage(summary, resolvedMonth.label));
  logInfo('WHATSAPP', 'Resumo mensal enviado.', {
    user: userNumber,
    month: resolvedMonth.label,
    total: summary.total,
    count: summary.count
  });
  return true;
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

    const commandHandled = await tryHandleFinanceCommand(
      sock,
      jid,
      userNumber,
      text,
      referenceDate
    );

    if (commandHandled) {
      return;
    }

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

function createConnectionUpdateHandler(sock, state, authContext) {
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
              'WHATSAPP_PAIRING_NUMBER não configurado. Defina o número para gerar código de pareamento.'
            );
          }
        } else if (!pairingCodeRequested) {
          pairingCodeRequested = true;

          try {
            const code = await sock.requestPairingCode(pairingNumber);
            const formattedCode = formatPairingCode(code);
            setWhatsAppPairingCode(formattedCode);
            logInfo(
              'WHATSAPP',
              `Código de pareamento: ${formattedCode}. No celular: Dispositivos conectados -> Conectar com número de telefone.`
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
        if (authContext && typeof authContext.close === 'function') {
          await authContext.close();
        }

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
  const authContext = await loadWhatsAppAuthState();
  const { state, saveCreds } = authContext;
  try {
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

    const handleConnectionUpdate = createConnectionUpdateHandler(sock, state, authContext);

    sock.ev.on('connection.update', async (update) => {
      await handleConnectionUpdate(update);
    });
    sock.ev.on('messages.upsert', async (event) => {
      await handleMessagesUpsert(sock, event);
    });

    return sock;
  } catch (error) {
    try {
      await authContext.close();
    } catch (_closeError) {
      // noop
    }

    throw error;
  }
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
