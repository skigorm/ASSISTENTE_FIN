const { startWhatsAppBot } = require('./whatsapp');
const { delay, logError, logInfo, logWarn } = require('./utils');

const START_RETRY_DELAY_MS = 5000;

let supervisorPromise = null;

function isBotDisabled() {
  return String(process.env.DISABLE_WHATSAPP_BOT || '').toLowerCase() === 'true';
}

async function runStartLoop() {
  if (!process.env.OPENAI_KEY) {
    logWarn('BOT', 'OPENAI_KEY não definida. O bot continuará com fallback regex.');
  }

  while (true) {
    try {
      await startWhatsAppBot();
      logInfo('BOT', 'Cliente WhatsApp inicializado.');
      return;
    } catch (error) {
      logError('BOT', 'Falha ao iniciar WhatsApp. Nova tentativa agendada.', error.message);
      await delay(START_RETRY_DELAY_MS);
    }
  }
}

function startBotSupervisor() {
  if (isBotDisabled()) {
    logWarn('BOT', 'Inicialização do WhatsApp desativada por DISABLE_WHATSAPP_BOT=true.');
    return Promise.resolve();
  }

  if (!supervisorPromise) {
    supervisorPromise = runStartLoop().catch((error) => {
      logError('BOT', 'Supervisor finalizou com erro inesperado.', error.message);
      supervisorPromise = null;
      throw error;
    });
  }

  return supervisorPromise;
}

module.exports = {
  startBotSupervisor
};
