const express = require('express');
const { logError, logInfo } = require('./utils');
const { getWhatsAppState } = require('./whatsappState');

const DEFAULT_PORT = 3000;

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildPairingPageHtml() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Finance Bot Pairing</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f3f4f6;
      color: #111827;
    }
    .wrap {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      width: 100%;
      max-width: 460px;
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.08);
      padding: 20px;
    }
    .title {
      margin: 0 0 8px;
      font-size: 22px;
      font-weight: 700;
    }
    .sub {
      margin: 0 0 12px;
      color: #4b5563;
      font-size: 14px;
    }
    #status {
      margin-bottom: 12px;
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 14px;
      background: #eef2ff;
      color: #1f2937;
    }
    #qr-box {
      min-height: 320px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px dashed #d1d5db;
      border-radius: 10px;
      background: #fafafa;
      overflow: hidden;
    }
    #qr-box canvas {
      max-width: 100%;
      height: auto;
    }
    .hint {
      margin-top: 12px;
      font-size: 13px;
      color: #6b7280;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js"></script>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1 class="title">Parear WhatsApp</h1>
      <p class="sub">Escaneie o QR abaixo em <strong>Dispositivos conectados</strong>.</p>
      <div id="status">Carregando status...</div>
      <div id="qr-box"><span>Nenhum QR disponível no momento.</span></div>
      <p class="hint">A página atualiza automaticamente a cada 3 segundos.</p>
    </div>
  </div>
  <script>
    const statusEl = document.getElementById('status');
    const qrBoxEl = document.getElementById('qr-box');
    let lastQr = '';

    function renderStatus(whatsapp) {
      const text = (whatsapp.message || 'Sem status') + ' (' + (whatsapp.status || 'unknown') + ')';
      statusEl.textContent = text;
    }

    async function drawQr(qr) {
      qrBoxEl.innerHTML = '';
      const canvas = document.createElement('canvas');
      qrBoxEl.appendChild(canvas);
      await QRCode.toCanvas(canvas, qr, {
        width: 300,
        margin: 1
      });
    }

    async function refresh() {
      try {
        const response = await fetch('/pairing/status', { cache: 'no-store' });
        const data = await response.json();
        const whatsapp = data && data.whatsapp ? data.whatsapp : {};
        renderStatus(whatsapp);

        if (whatsapp.qr) {
          if (lastQr !== whatsapp.qr) {
            lastQr = whatsapp.qr;
            await drawQr(whatsapp.qr);
          }
        } else {
          lastQr = '';
          qrBoxEl.innerHTML = '<span>Nenhum QR disponível no momento.</span>';
        }
      } catch (error) {
        statusEl.textContent = 'Erro ao buscar status de pareamento.';
      }
    }

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}

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

  app.get('/pairing', (_req, res) => {
    res.status(200).type('text/html').send(buildPairingPageHtml());
  });

  app.get('/pairing/status', (_req, res) => {
    const whatsapp = getWhatsAppState();

    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      service: 'finance-bot',
      whatsapp: {
        status: escapeHtml(whatsapp.status),
        message: escapeHtml(whatsapp.message),
        updatedAt: whatsapp.updatedAt,
        qr: whatsapp.qr
      }
    });
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
