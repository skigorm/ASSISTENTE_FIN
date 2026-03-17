const express = require('express');
const { logError, logInfo } = require('./utils');

const DEFAULT_PORT = 3000;

function createHttpApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use((req, res, next) => {
    const startedAt = Date.now();

    res.on('finish', () => {
      logInfo('HTTP', `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
    });

    next();
  });

  app.get('/', (_req, res) => {
    res.status(200).type('text/plain').send('finance-bot online');
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'finance-bot' });
  });

  app.use((error, req, res, next) => {
    logError('HTTP', 'Erro não tratado em rota HTTP.', {
      method: req.method,
      path: req.path,
      error: error && error.message ? error.message : String(error)
    });

    if (res.headersSent) {
      return next(error);
    }

    return res.status(500).json({
      ok: false,
      error: 'internal_error'
    });
  });

  return app;
}

function startHttpServer(portInput) {
  const requestedPort = Number(portInput || process.env.PORT || DEFAULT_PORT);
  const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_PORT;
  const app = createHttpApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      logInfo('HTTP', `Servidor HTTP escutando na porta ${port}.`);
      resolve({ app, server, port });
    });

    server.once('error', (error) => {
      logError('HTTP', 'Falha ao iniciar servidor HTTP.', error.message);
      reject(error);
    });
  });
}

module.exports = {
  createHttpApp,
  startHttpServer
};
