const { startBotSupervisor } = require('./botSupervisor');
const { startHttpServer } = require('./http');
const { logError, logInfo, logWarn } = require('./utils');

function registerGlobalErrorHandlers() {
  process.on('uncaughtException', (error) => {
    logError('APP', 'uncaughtException capturada. Processo mantido em execução.', error.stack || error.message);
  });

  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? reason.stack || reason.message : reason;
    logError('APP', 'unhandledRejection capturada. Processo mantido em execução.', detail);
  });
}

function registerShutdownHandlers(server) {
  const shutdown = (signal) => {
    logWarn('APP', `Sinal ${signal} recebido. Encerrando servidor HTTP...`);

    const timeout = setTimeout(() => {
      logError('APP', 'Timeout no shutdown gracioso. Encerrando processo.');
      process.exit(1);
    }, 10000);

    server.close((error) => {
      clearTimeout(timeout);

      if (error) {
        logError('APP', 'Erro ao fechar servidor HTTP.', error.message);
        process.exit(1);
        return;
      }

      logInfo('APP', 'Servidor HTTP finalizado com sucesso.');
      process.exit(0);
    });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

async function bootstrap() {
  registerGlobalErrorHandlers();

  const http = await startHttpServer(process.env.PORT || 3000);
  registerShutdownHandlers(http.server);

  startBotSupervisor().catch((error) => {
    logError('APP', 'Supervisor do WhatsApp encerrou com erro.', error.message);
  });

  logInfo('APP', 'Bootstrap concluído.');
  return http;
}

module.exports = {
  bootstrap
};
