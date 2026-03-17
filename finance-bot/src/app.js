require('dotenv').config();

const { startWhatsAppBot } = require('./whatsapp');
const { delay, logError, logInfo, logWarn } = require('./utils');

const START_RETRY_DELAY_MS = 5000;

function registerGlobalErrorHandlers() {
  process.on('uncaughtException', (error) => {
    logError('APP', 'uncaughtException capturada. Processo mantido em execução.', error.stack || error.message);
  });

  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? reason.stack || reason.message : reason;
    logError('APP', 'unhandledRejection capturada. Processo mantido em execução.', detail);
  });
}

async function bootstrap() {
  registerGlobalErrorHandlers();

  if (!process.env.OPENAI_KEY) {
    logWarn('APP', 'OPENAI_KEY não definida. O bot funcionará apenas com fallback regex.');
  }

  while (true) {
    try {
      await startWhatsAppBot();
      logInfo('APP', 'Bot iniciado com sucesso.');
      break;
    } catch (error) {
      logError('APP', 'Falha ao iniciar bot. Nova tentativa agendada.', error.message);
      await delay(START_RETRY_DELAY_MS);
    }
  }
}

bootstrap().catch((error) => {
  logError('APP', 'Erro crítico no bootstrap.', error.stack || error.message);
});
