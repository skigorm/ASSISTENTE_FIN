const express = require('express');
const { timingSafeEqual } = require('crypto');
const { listUserProfiles, setUserAccessEnabled } = require('./storage');
const { logError, logInfo, normalizeUserId, sanitizeText } = require('./utils');
const { getWhatsAppState } = require('./whatsappState');

const DEFAULT_PORT = 3000;
const ADMIN_PANEL_USERNAME_ENV = 'ADMIN_PANEL_USERNAME';
const ADMIN_PANEL_PASSWORD_ENV = 'ADMIN_PANEL_PASSWORD';
const DEFAULT_ADMIN_PANEL_USERNAME = 'admin';

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getAdminCredentials() {
  const username = sanitizeText(process.env[ADMIN_PANEL_USERNAME_ENV] || DEFAULT_ADMIN_PANEL_USERNAME) || DEFAULT_ADMIN_PANEL_USERNAME;
  const password = String(process.env[ADMIN_PANEL_PASSWORD_ENV] || '').trim();

  return { username, password };
}

function isAdminPanelEnabled() {
  return getAdminCredentials().password.length > 0;
}

function safeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuthHeader(headerValue) {
  const raw = String(headerValue || '');

  if (!raw.startsWith('Basic ')) {
    return null;
  }

  const encoded = raw.slice('Basic '.length).trim();

  if (!encoded) {
    return null;
  }

  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');

    if (separatorIndex <= 0) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1)
    };
  } catch (_error) {
    return null;
  }
}

function parseBooleanInput(value) {
  if (value === true || value === false) {
    return value;
  }

  const normalized = sanitizeText(String(value || '')).toLowerCase();

  if (['1', 'true', 'sim', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'nao', 'não', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return null;
}

function buildAdminUserPayload(profile) {
  const monthlyIncome = Number(profile.monthlyIncome);

  return {
    user: sanitizeText(profile.user),
    name: sanitizeText(profile.name),
    accessEnabled: profile.accessEnabled !== false,
    monthlyIncome: Number.isFinite(monthlyIncome) && monthlyIncome > 0 ? monthlyIncome : null,
    lastInteractionAt: sanitizeText(profile.lastInteractionAt),
    updatedAt: sanitizeText(profile.updatedAt),
    createdAt: sanitizeText(profile.createdAt)
  };
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
    #code-box {
      min-height: 120px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px dashed #d1d5db;
      border-radius: 10px;
      background: #fafafa;
      overflow: hidden;
      padding: 12px;
      box-sizing: border-box;
      text-align: center;
    }
    #code-box .value {
      font-size: 28px;
      font-weight: 700;
      letter-spacing: 2px;
      color: #111827;
      word-break: break-word;
    }
    .actions {
      margin-top: 12px;
      margin-bottom: 8px;
    }
    .btn {
      border: 0;
      border-radius: 8px;
      background: #111827;
      color: #ffffff;
      padding: 8px 12px;
      font-size: 13px;
      cursor: pointer;
    }
    .btn:hover {
      background: #1f2937;
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
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1 class="title">Parear WhatsApp</h1>
      <p class="sub">No celular: <strong>Dispositivos conectados</strong> → <strong>Conectar com número de telefone</strong>.</p>
      <div id="status">Carregando status...</div>
      <div id="code-box"><span>Nenhum código disponível no momento.</span></div>
      <div class="actions">
        <button id="refresh-btn" class="btn" type="button">Atualizar Status</button>
      </div>
      <p class="hint">Sem atualização automática para reduzir chamadas no servidor.</p>
    </div>
  </div>
  <script>
    const statusEl = document.getElementById('status');
    const codeBoxEl = document.getElementById('code-box');
    const refreshBtnEl = document.getElementById('refresh-btn');

    function renderStatus(whatsapp) {
      const text = (whatsapp.message || 'Sem status') + ' (' + (whatsapp.status || 'unknown') + ')';
      statusEl.textContent = text;
    }

    async function refresh() {
      try {
        const response = await fetch('/pairing/status', { cache: 'no-store' });
        const data = await response.json();
        const whatsapp = data && data.whatsapp ? data.whatsapp : {};
        renderStatus(whatsapp);

        if (whatsapp.pairingCode) {
          codeBoxEl.innerHTML = '<span class="value mono">' + whatsapp.pairingCode + '</span>';
        } else {
          codeBoxEl.innerHTML = '<span>Nenhum código disponível no momento.</span>';
        }
      } catch (error) {
        statusEl.textContent = 'Erro ao buscar status de pareamento.';
      }
    }

    refresh();
    refreshBtnEl.addEventListener('click', refresh);
  </script>
</body>
</html>`;
}

function buildAdminPageHtml() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Finance Bot Admin</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%);
      color: #0f172a;
    }
    .wrap {
      max-width: 1080px;
      margin: 0 auto;
      padding: 24px 16px 40px;
    }
    .card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
      padding: 16px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 24px;
      letter-spacing: -0.02em;
    }
    .sub {
      margin: 0 0 14px;
      color: #475569;
      font-size: 14px;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .input {
      flex: 1;
      min-width: 220px;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 14px;
      background: #ffffff;
    }
    .btn {
      border: 0;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      background: #0f172a;
      color: #ffffff;
    }
    .btn:hover {
      background: #1e293b;
    }
    .btn-toggle {
      background: #0b6bcb;
    }
    .btn-toggle:hover {
      background: #0954a0;
    }
    .btn-enable {
      background: #0f766e;
    }
    .btn-enable:hover {
      background: #115e59;
    }
    .status {
      margin: 0 0 10px;
      font-size: 13px;
      color: #475569;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
    }
    .pill-ok {
      background: #dcfce7;
      color: #166534;
    }
    .pill-off {
      background: #fee2e2;
      color: #991b1b;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 760px;
      background: #ffffff;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid #f1f5f9;
      text-align: left;
      font-size: 13px;
      vertical-align: middle;
    }
    th {
      background: #f8fafc;
      color: #334155;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Painel de Acesso</h1>
      <p class="sub">Habilite ou desabilite usuários do bot em tempo real.</p>

      <div class="toolbar">
        <input id="search" class="input" type="search" placeholder="Filtrar por número ou nome..." />
        <button id="refresh-btn" class="btn" type="button">Atualizar</button>
      </div>

      <p id="status" class="status">Carregando usuários...</p>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Usuário</th>
              <th>Nome</th>
              <th>Acesso</th>
              <th>Última interação</th>
              <th>Ação</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </div>
  </div>
  <script>
    const state = { users: [] };
    const rowsEl = document.getElementById('rows');
    const statusEl = document.getElementById('status');
    const searchEl = document.getElementById('search');
    const refreshBtnEl = document.getElementById('refresh-btn');

    function formatDateTime(iso) {
      const value = String(iso || '').trim();

      if (!value) {
        return '-';
      }

      const date = new Date(value);

      if (Number.isNaN(date.getTime())) {
        return value;
      }

      return date.toLocaleString('pt-BR');
    }

    function updateStatus(text) {
      statusEl.textContent = text;
    }

    function renderRows() {
      const query = String(searchEl.value || '').trim().toLowerCase();
      const filtered = state.users.filter((item) => {
        if (!query) {
          return true;
        }

        return String(item.user || '').toLowerCase().includes(query)
          || String(item.name || '').toLowerCase().includes(query);
      });

      rowsEl.innerHTML = '';

      if (!filtered.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = 'Nenhum usuário encontrado.';
        tr.appendChild(td);
        rowsEl.appendChild(tr);
        return;
      }

      filtered.forEach((item) => {
        const tr = document.createElement('tr');

        const userTd = document.createElement('td');
        userTd.className = 'mono';
        userTd.textContent = item.user || '-';
        tr.appendChild(userTd);

        const nameTd = document.createElement('td');
        nameTd.textContent = item.name || '-';
        tr.appendChild(nameTd);

        const accessTd = document.createElement('td');
        const pill = document.createElement('span');
        pill.className = item.accessEnabled ? 'pill pill-ok' : 'pill pill-off';
        pill.textContent = item.accessEnabled ? 'Habilitado' : 'Desabilitado';
        accessTd.appendChild(pill);
        tr.appendChild(accessTd);

        const dateTd = document.createElement('td');
        dateTd.textContent = formatDateTime(item.lastInteractionAt || item.updatedAt || item.createdAt);
        tr.appendChild(dateTd);

        const actionTd = document.createElement('td');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = item.accessEnabled ? 'btn btn-toggle' : 'btn btn-enable';
        button.textContent = item.accessEnabled ? 'Desabilitar' : 'Habilitar';
        button.addEventListener('click', () => toggleAccess(item.user, !item.accessEnabled));
        actionTd.appendChild(button);
        tr.appendChild(actionTd);

        rowsEl.appendChild(tr);
      });
    }

    async function loadUsers() {
      updateStatus('Atualizando usuários...');

      try {
        const response = await fetch('/admin/api/users', { cache: 'no-store' });
        const payload = await response.json();

        if (!response.ok || !payload || payload.ok !== true) {
          throw new Error((payload && payload.error) || 'request_failed');
        }

        state.users = Array.isArray(payload.users) ? payload.users : [];
        updateStatus(state.users.length + ' usuário(s) carregado(s).');
        renderRows();
      } catch (error) {
        updateStatus('Falha ao carregar usuários.');
      }
    }

    async function toggleAccess(user, enabled) {
      const safeUser = String(user || '').trim();

      if (!safeUser) {
        return;
      }

      const confirmed = window.confirm(
        (enabled ? 'Habilitar' : 'Desabilitar') + ' acesso para ' + safeUser + '?'
      );

      if (!confirmed) {
        return;
      }

      try {
        const response = await fetch('/admin/api/users/' + encodeURIComponent(safeUser) + '/access', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ enabled })
        });
        const payload = await response.json();

        if (!response.ok || !payload || payload.ok !== true) {
          throw new Error((payload && payload.error) || 'request_failed');
        }

        await loadUsers();
      } catch (_error) {
        updateStatus('Falha ao atualizar acesso do usuário.');
      }
    }

    searchEl.addEventListener('input', renderRows);
    refreshBtnEl.addEventListener('click', loadUsers);
    loadUsers();
  </script>
</body>
</html>`;
}

function createAdminAuthMiddleware() {
  return (req, res, next) => {
    if (!isAdminPanelEnabled()) {
      res.status(404).type('text/plain').send('not found');
      return;
    }

    const credentials = getAdminCredentials();
    const incoming = parseBasicAuthHeader(req.headers.authorization);

    if (
      !incoming ||
      !safeEquals(incoming.username, credentials.username) ||
      !safeEquals(incoming.password, credentials.password)
    ) {
      res.set('WWW-Authenticate', 'Basic realm="Finance Bot Admin", charset="UTF-8"');
      res.status(401).type('text/plain').send('Autenticação necessária.');
      return;
    }

    next();
  };
}

function createHttpApp() {
  const app = express();
  const adminAuth = createAdminAuthMiddleware();

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
        pairingCode: escapeHtml(whatsapp.pairingCode)
      }
    });
  });

  app.get('/admin', adminAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).type('text/html').send(buildAdminPageHtml());
  });

  app.get('/admin/api/users', adminAuth, async (_req, res, next) => {
    try {
      const profiles = await listUserProfiles();
      const users = profiles.map(buildAdminUserPayload);

      res.set('Cache-Control', 'no-store');
      res.status(200).json({
        ok: true,
        count: users.length,
        users
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/api/users/:user/access', adminAuth, async (req, res, next) => {
    try {
      const requestedUser = req.params.user || (req.body && req.body.user) || '';
      const normalizedUser = normalizeUserId(String(requestedUser));
      const enabled = parseBooleanInput(req.body && req.body.enabled);

      if (!normalizedUser || normalizedUser === 'desconhecido') {
        res.status(400).json({
          ok: false,
          error: 'invalid_user'
        });
        return;
      }

      if (enabled === null) {
        res.status(400).json({
          ok: false,
          error: 'invalid_enabled_flag'
        });
        return;
      }

      const updated = await setUserAccessEnabled(normalizedUser, enabled);

      if (!updated) {
        res.status(404).json({
          ok: false,
          error: 'user_not_found'
        });
        return;
      }

      res.set('Cache-Control', 'no-store');
      res.status(200).json({
        ok: true,
        user: buildAdminUserPayload(updated)
      });
    } catch (error) {
      next(error);
    }
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
