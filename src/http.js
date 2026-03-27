const express = require('express');
const { timingSafeEqual } = require('crypto');
const {
  getTransactionsByUser,
  listUserProfiles,
  setUserAccessEnabled,
  updateUserProfile
} = require('./storage');
const { logError, logInfo, normalizeUserId, sanitizeText } = require('./utils');
const { getWhatsAppState } = require('./whatsappState');

const DEFAULT_PORT = 3000;
const ADMIN_PANEL_USERNAME_ENV = 'ADMIN_PANEL_USERNAME';
const ADMIN_PANEL_PASSWORD_ENV = 'ADMIN_PANEL_PASSWORD';
const DEFAULT_ADMIN_PANEL_USERNAME = 'admin';
const DASHBOARD_MONTH_RANGE = 6;
const DASHBOARD_AUTH_REALM = 'Finance Bot Dashboard';

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

function roundTo2(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Number(numeric.toFixed(2));
}

function buildYearMonthKey(year, month) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

function formatYearMonthLabel(year, month) {
  return `${String(month).padStart(2, '0')}/${year}`;
}

function shiftYearMonth(year, month, offset) {
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1
  };
}

function parseYearMonthInput(input) {
  const now = new Date();
  const fallback = {
    year: now.getFullYear(),
    month: now.getMonth() + 1
  };

  const raw = sanitizeText(String(input || ''));
  const match = raw.match(/^(\d{4})-(\d{2})$/);

  if (match) {
    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);

    if (Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12) {
      return {
        year,
        month,
        key: buildYearMonthKey(year, month),
        label: formatYearMonthLabel(year, month)
      };
    }
  }

  return {
    year: fallback.year,
    month: fallback.month,
    key: buildYearMonthKey(fallback.year, fallback.month),
    label: formatYearMonthLabel(fallback.year, fallback.month)
  };
}

function sortTransactionsByDateDesc(list = []) {
  return [...list].sort((left, right) => {
    const leftDate = sanitizeText(left.data || '');
    const rightDate = sanitizeText(right.data || '');

    if (leftDate !== rightDate) {
      return rightDate.localeCompare(leftDate);
    }

    const leftRef = sanitizeText(left.updatedAt || left.createdAt || '');
    const rightRef = sanitizeText(right.updatedAt || right.createdAt || '');
    return rightRef.localeCompare(leftRef);
  });
}

function normalizeDashboardTransaction(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const value = Number(record.valor);
  const date = sanitizeText(record.data);

  if (!Number.isFinite(value) || value <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }

  return {
    id: sanitizeText(record.id),
    user: sanitizeText(record.user),
    valor: roundTo2(value),
    categoria: sanitizeText(record.categoria) || 'Outros',
    descricao: sanitizeText(record.descricao) || 'Sem descrição',
    data: date,
    createdAt: sanitizeText(record.createdAt),
    updatedAt: sanitizeText(record.updatedAt)
  };
}

function normalizeDashboardAlias(value) {
  const normalized = normalizeUserId(String(value || ''));

  if (!normalized || normalized === 'desconhecido') {
    return '';
  }

  if (normalized.length < 8 || normalized.length > 20) {
    return '';
  }

  return normalized;
}

function extractProfileAuthAliases(profile) {
  const aliases = new Set();

  const addAlias = (value) => {
    const normalized = normalizeDashboardAlias(value);

    if (normalized) {
      aliases.add(normalized);
    }
  };

  if (profile && Array.isArray(profile.authAliases)) {
    for (const item of profile.authAliases) {
      addAlias(item);
    }
  }

  addAlias(profile && profile.user);
  return [...aliases];
}

function hasProfileMeaningfulData(profile) {
  if (!profile || typeof profile !== 'object') {
    return false;
  }

  if (sanitizeText(profile.name)) {
    return true;
  }

  const monthlyIncome = Number(profile.monthlyIncome);

  if (Number.isFinite(monthlyIncome) && monthlyIncome > 0) {
    return true;
  }

  if (profile.onboardingComplete === true) {
    return true;
  }

  if (Array.isArray(profile.customCategories) && profile.customCategories.length > 0) {
    return true;
  }

  const budgets = profile.budgetByCategory && typeof profile.budgetByCategory === 'object'
    ? Object.values(profile.budgetByCategory)
    : [];

  return budgets.some((item) => Number.isFinite(Number(item)) && Number(item) > 0);
}

function parseDashboardUserFromAuthHeader(headerValue) {
  const incoming = parseBasicAuthHeader(headerValue);

  if (!incoming) {
    return null;
  }

  const username = normalizeUserId(String(incoming.username || ''));
  const password = normalizeUserId(String(incoming.password || ''));

  if (!username || username === 'desconhecido' || username !== password) {
    return null;
  }

  return username;
}

async function resolveDashboardContextByUser(user) {
  const loginAlias = normalizeDashboardAlias(String(user || ''));

  if (!loginAlias) {
    return {
      ok: false,
      statusCode: 401,
      error: 'invalid_credentials'
    };
  }

  const profiles = await listUserProfiles();
  const safeProfiles = Array.isArray(profiles) ? profiles : [];
  const exactProfile = safeProfiles.find((item) => normalizeDashboardAlias(item && item.user) === loginAlias) || null;
  const aliasProfile = safeProfiles.find((item) => extractProfileAuthAliases(item).includes(loginAlias)) || null;

  const candidateUsers = [...new Set([
    loginAlias,
    normalizeDashboardAlias(exactProfile && exactProfile.user),
    normalizeDashboardAlias(aliasProfile && aliasProfile.user)
  ].filter(Boolean))];

  const transactionsByUser = new Map();

  await Promise.all(candidateUsers.map(async (candidateUser) => {
    const rawTransactions = await getTransactionsByUser(candidateUser);
    const normalizedTransactions = sortTransactionsByDateDesc(
      (Array.isArray(rawTransactions) ? rawTransactions : [])
        .map(normalizeDashboardTransaction)
        .filter(Boolean)
    );

    transactionsByUser.set(candidateUser, normalizedTransactions);
  }));

  const profileCandidates = [...new Map(
    [exactProfile, aliasProfile]
      .filter(Boolean)
      .map((item) => [normalizeDashboardAlias(item.user), item])
  ).values()]
    .map((profile) => {
      const profileUser = normalizeDashboardAlias(profile.user);
      const transactions = transactionsByUser.get(profileUser) || [];

      return {
        profile,
        profileUser,
        transactionCount: transactions.length,
        meaningful: hasProfileMeaningfulData(profile),
        exact: profileUser === loginAlias
      };
    })
    .sort((left, right) => {
      if (left.transactionCount !== right.transactionCount) {
        return right.transactionCount - left.transactionCount;
      }

      if (left.meaningful !== right.meaningful) {
        return left.meaningful ? -1 : 1;
      }

      if (left.exact !== right.exact) {
        return left.exact ? -1 : 1;
      }

      return left.profileUser.localeCompare(right.profileUser);
    });

  let profile = profileCandidates.length ? profileCandidates[0].profile : null;
  let canonicalUser = profileCandidates.length ? profileCandidates[0].profileUser : loginAlias;
  let transactions = transactionsByUser.get(canonicalUser) || [];

  if (!profile && transactions.length === 0) {
    profile = await updateUserProfile(loginAlias, {
      authAliases: [loginAlias]
    });
    canonicalUser = normalizeDashboardAlias(profile && profile.user) || loginAlias;
    transactions = transactionsByUser.get(canonicalUser) || [];
  }

  if (profile && profile.accessEnabled === false) {
    return {
      ok: false,
      statusCode: 403,
      error: 'access_disabled'
    };
  }

  if (!profile && transactions.length === 0) {
    return {
      ok: false,
      statusCode: 404,
      error: 'user_not_found'
    };
  }

  if (profile) {
    const existingAliases = extractProfileAuthAliases(profile);
    const requiredAliases = [...new Set([loginAlias, canonicalUser].filter(Boolean))];
    const missingAliases = requiredAliases.filter((alias) => !existingAliases.includes(alias));

    if (missingAliases.length) {
      profile = await updateUserProfile(canonicalUser, {
        authAliases: [...existingAliases, ...missingAliases]
      });
    }
  }

  return {
    ok: true,
    user: canonicalUser,
    profile: profile
      ? {
        ...profile,
        user: canonicalUser,
        name: sanitizeText(profile.name),
        accessEnabled: profile.accessEnabled !== false
      }
      : null,
    transactions
  };
}

function buildDashboardPayload(context, selectedMonth) {
  const transactions = Array.isArray(context.transactions) ? context.transactions : [];
  const monthPrefix = `${selectedMonth.key}-`;
  const selectedTransactions = transactions.filter((item) => item.data.startsWith(monthPrefix));

  const monthlyTotal = roundTo2(selectedTransactions.reduce((sum, item) => sum + item.valor, 0));
  const overallTotal = roundTo2(transactions.reduce((sum, item) => sum + item.valor, 0));
  const monthlyAverage = selectedTransactions.length > 0
    ? roundTo2(monthlyTotal / selectedTransactions.length)
    : 0;

  const categoryTotalsMap = {};

  for (const item of selectedTransactions) {
    const category = sanitizeText(item.categoria) || 'Outros';

    if (!Object.prototype.hasOwnProperty.call(categoryTotalsMap, category)) {
      categoryTotalsMap[category] = 0;
    }

    categoryTotalsMap[category] = roundTo2(categoryTotalsMap[category] + item.valor);
  }

  const categoryBreakdown = Object.entries(categoryTotalsMap)
    .map(([category, total]) => {
      const percentage = monthlyTotal > 0
        ? roundTo2((total / monthlyTotal) * 100)
        : 0;

      return {
        category,
        total,
        percentage
      };
    })
    .sort((left, right) => right.total - left.total);

  const timeline = [];
  const timelineLookup = {};

  for (let index = DASHBOARD_MONTH_RANGE - 1; index >= 0; index -= 1) {
    const shifted = shiftYearMonth(selectedMonth.year, selectedMonth.month, -index);
    const key = buildYearMonthKey(shifted.year, shifted.month);
    const point = {
      key,
      label: formatYearMonthLabel(shifted.year, shifted.month),
      total: 0
    };

    timeline.push(point);
    timelineLookup[key] = point;
  }

  for (const transaction of transactions) {
    const key = sanitizeText(transaction.data).slice(0, 7);

    if (Object.prototype.hasOwnProperty.call(timelineLookup, key)) {
      timelineLookup[key].total = roundTo2(timelineLookup[key].total + transaction.valor);
    }
  }

  const userName = context.profile && sanitizeText(context.profile.name)
    ? sanitizeText(context.profile.name)
    : '';

  return {
    user: context.user,
    name: userName,
    selectedMonth,
    summary: {
      monthlyTotal,
      monthlyCount: selectedTransactions.length,
      monthlyAverage,
      overallTotal,
      overallCount: transactions.length
    },
    categoryBreakdown,
    monthlyTimeline: timeline,
    transactions
  };
}

function escapeXml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSpreadsheetCell(value, type = 'String') {
  if (type === 'Number') {
    const numeric = Number(value);
    const safeNumeric = Number.isFinite(numeric) ? numeric : 0;
    return `<Cell><Data ss:Type="Number">${safeNumeric}</Data></Cell>`;
  }

  return `<Cell><Data ss:Type="String">${escapeXml(String(value || ''))}</Data></Cell>`;
}

function buildSpreadsheetRow(cells = []) {
  return `<Row>${cells.join('')}</Row>`;
}

function buildDashboardExcelXml(payload) {
  const summaryRows = [
    buildSpreadsheetRow([
      buildSpreadsheetCell('Usuário'),
      buildSpreadsheetCell(payload.user)
    ]),
    buildSpreadsheetRow([
      buildSpreadsheetCell('Nome'),
      buildSpreadsheetCell(payload.name || '-')
    ]),
    buildSpreadsheetRow([
      buildSpreadsheetCell('Mês'),
      buildSpreadsheetCell(payload.selectedMonth.label)
    ]),
    buildSpreadsheetRow([
      buildSpreadsheetCell('Total no mês'),
      buildSpreadsheetCell(payload.summary.monthlyTotal, 'Number')
    ]),
    buildSpreadsheetRow([
      buildSpreadsheetCell('Qtd. de despesas no mês'),
      buildSpreadsheetCell(payload.summary.monthlyCount, 'Number')
    ]),
    buildSpreadsheetRow([
      buildSpreadsheetCell('Ticket médio no mês'),
      buildSpreadsheetCell(payload.summary.monthlyAverage, 'Number')
    ]),
    buildSpreadsheetRow([
      buildSpreadsheetCell('Total acumulado'),
      buildSpreadsheetCell(payload.summary.overallTotal, 'Number')
    ]),
    buildSpreadsheetRow([
      buildSpreadsheetCell('Qtd. total de despesas'),
      buildSpreadsheetCell(payload.summary.overallCount, 'Number')
    ])
  ];

  const categoryRows = payload.categoryBreakdown.map((item) => {
    return buildSpreadsheetRow([
      buildSpreadsheetCell(item.category),
      buildSpreadsheetCell(item.total, 'Number'),
      buildSpreadsheetCell(item.percentage, 'Number')
    ]);
  });

  const timelineRows = payload.monthlyTimeline.map((item) => {
    return buildSpreadsheetRow([
      buildSpreadsheetCell(item.label),
      buildSpreadsheetCell(item.total, 'Number')
    ]);
  });

  const expenseRows = payload.transactions.map((item) => {
    return buildSpreadsheetRow([
      buildSpreadsheetCell(item.data),
      buildSpreadsheetCell(item.categoria),
      buildSpreadsheetCell(item.descricao),
      buildSpreadsheetCell(item.valor, 'Number'),
      buildSpreadsheetCell(item.id || '')
    ]);
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook
  xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:html="http://www.w3.org/TR/REC-html40">
  <Worksheet ss:Name="Resumo">
    <Table>
      ${summaryRows.join('')}
    </Table>
  </Worksheet>
  <Worksheet ss:Name="Categoria mes">
    <Table>
      ${buildSpreadsheetRow([
    buildSpreadsheetCell('Categoria'),
    buildSpreadsheetCell('Total'),
    buildSpreadsheetCell('Percentual')
  ])}
      ${categoryRows.join('')}
    </Table>
  </Worksheet>
  <Worksheet ss:Name="Ultimos meses">
    <Table>
      ${buildSpreadsheetRow([
    buildSpreadsheetCell('Mês'),
    buildSpreadsheetCell('Total')
  ])}
      ${timelineRows.join('')}
    </Table>
  </Worksheet>
  <Worksheet ss:Name="Despesas">
    <Table>
      ${buildSpreadsheetRow([
    buildSpreadsheetCell('Data'),
    buildSpreadsheetCell('Categoria'),
    buildSpreadsheetCell('Descrição'),
    buildSpreadsheetCell('Valor'),
    buildSpreadsheetCell('ID')
  ])}
      ${expenseRows.join('')}
    </Table>
  </Worksheet>
</Workbook>`;
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

function buildDashboardPageHtml() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Finance Bot Web</title>
  <style>
    :root {
      color-scheme: light;
      --bg-start: #e4f4ee;
      --bg-end: #f8efe5;
      --panel: #ffffff;
      --ink: #0f172a;
      --muted: #5b6476;
      --line: #d8e0eb;
      --accent: #0f766e;
      --accent-soft: #d4f4ef;
      --warning: #d97706;
      --danger: #be123c;
      --shadow: 0 18px 50px rgba(15, 23, 42, 0.12);
    }
    html {
      -webkit-text-size-adjust: 100%;
      text-size-adjust: 100%;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      min-height: 100vh;
      overflow-x: hidden;
      font-family: "Avenir Next", "Montserrat", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 16% 18%, rgba(15, 118, 110, 0.16), transparent 42%),
        radial-gradient(circle at 88% 8%, rgba(217, 119, 6, 0.14), transparent 40%),
        linear-gradient(150deg, var(--bg-start), var(--bg-end));
      padding: 28px 14px 40px;
    }
    .shell {
      max-width: 1120px;
      width: 100%;
      min-width: 0;
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }
    .surface {
      min-width: 0;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: var(--shadow);
      animation: rise 420ms ease both;
    }
    .hero {
      padding: 22px 22px 18px;
    }
    .eyebrow {
      margin: 0 0 8px;
      color: #1f4f4a;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-weight: 700;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 29px;
      line-height: 1.05;
      letter-spacing: -0.025em;
    }
    .hero-sub {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      max-width: 760px;
    }
    .login {
      padding: 18px;
      display: grid;
      gap: 12px;
    }
    .field-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .field {
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .label {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #334155;
    }
    .input {
      width: 100%;
      min-width: 0;
      border: 1px solid #bfccd9;
      border-radius: 12px;
      padding: 11px 12px;
      font-size: 16px;
      font-family: "Avenir Next", "Montserrat", "Segoe UI", sans-serif;
      background: #fbfdff;
      color: var(--ink);
    }
    .input:focus {
      outline: 2px solid rgba(15, 118, 110, 0.24);
      border-color: var(--accent);
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .btn {
      border: 0;
      border-radius: 11px;
      padding: 10px 14px;
      cursor: pointer;
      font-weight: 700;
      letter-spacing: 0.01em;
      font-size: 13px;
      transition: transform 0.15s ease, filter 0.15s ease;
    }
    .btn:hover {
      filter: brightness(0.98);
      transform: translateY(-1px);
    }
    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
    }
    .btn-primary {
      color: #ffffff;
      background: linear-gradient(120deg, #0f766e, #115e59);
    }
    .btn-secondary {
      color: #0f172a;
      background: #e2e8f0;
    }
    .btn-export {
      color: #ffffff;
      background: linear-gradient(120deg, #d97706, #b45309);
    }
    .hint {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
    }
    .status {
      margin: 0;
      font-size: 13px;
      color: #0f172a;
      background: #e2f3ff;
      border: 1px solid #b8dfff;
      padding: 8px 10px;
      border-radius: 10px;
    }
    .status.error {
      background: #ffe5eb;
      border-color: #fecdd3;
      color: #881337;
    }
    .is-hidden {
      display: none !important;
    }
    .dashboard {
      padding: 18px;
      display: grid;
      gap: 14px;
    }
    .dashboard > * {
      min-width: 0;
    }
    .toolbar {
      display: grid;
      grid-template-columns: 1.2fr minmax(170px, 200px) auto auto auto;
      gap: 8px;
      align-items: end;
    }
    .toolbar > * {
      min-width: 0;
    }
    .welcome {
      font-size: 14px;
      color: #334155;
      margin: 0;
      font-weight: 600;
    }
    .kpis {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .kpi {
      border: 1px solid #dce7f2;
      border-radius: 14px;
      padding: 12px;
      background: linear-gradient(160deg, #ffffff, #f8fafc);
      animation: rise 360ms ease both;
    }
    .kpi span {
      display: block;
    }
    .kpi-label {
      color: #64748b;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 8px;
      font-weight: 700;
    }
    .kpi-value {
      color: #0f172a;
      font-size: 23px;
      line-height: 1.1;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .kpi-sub {
      margin-top: 5px;
      font-size: 12px;
      color: #64748b;
    }
    .charts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .chart-card {
      border: 1px solid #dce7f2;
      border-radius: 14px;
      padding: 12px;
      background: #ffffff;
      min-height: 280px;
    }
    .chart-title {
      margin: 0 0 10px;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #334155;
      font-weight: 800;
    }
    .donut-shell {
      display: grid;
      gap: 10px;
      grid-template-columns: 160px 1fr;
      align-items: center;
    }
    .donut {
      width: 160px;
      height: 160px;
      border-radius: 50%;
      background: #d8e5f3;
      position: relative;
      margin: 0 auto;
      box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.08);
    }
    .donut::after {
      content: "";
      position: absolute;
      inset: 22px;
      border-radius: 50%;
      background: #ffffff;
      box-shadow: inset 0 0 0 1px #dbeafe;
    }
    .donut-center {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 0 18px;
    }
    .donut-center strong {
      font-size: 12px;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .donut-center span {
      font-weight: 800;
      font-size: 14px;
      color: #0f172a;
    }
    .legend {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 7px;
    }
    .legend li {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 8px;
      align-items: center;
      font-size: 13px;
      color: #334155;
      border-bottom: 1px solid #eef2f7;
      padding-bottom: 6px;
    }
    .legend b {
      font-weight: 700;
      color: #1e293b;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      display: inline-block;
    }
    .bars {
      min-height: 205px;
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 8px;
      align-items: end;
      padding-top: 8px;
    }
    .bar-item {
      display: grid;
      gap: 6px;
      justify-items: center;
    }
    .bar-track {
      width: 100%;
      height: 160px;
      border-radius: 10px;
      background: linear-gradient(180deg, #eff6ff, #dbeafe);
      position: relative;
      overflow: hidden;
      border: 1px solid #d6e3f6;
    }
    .bar-fill {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      border-radius: 10px 10px 0 0;
      background: linear-gradient(180deg, #0f766e, #115e59);
    }
    .bar-label {
      font-size: 12px;
      color: #334155;
      font-weight: 700;
      text-align: center;
    }
    .bar-value {
      font-size: 11px;
      color: #64748b;
      text-align: center;
    }
    .table-card {
      border: 1px solid #dce7f2;
      border-radius: 14px;
      padding: 12px;
      background: #ffffff;
    }
    .table-toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .table-wrap {
      width: 100%;
      max-width: 100%;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      overflow: auto;
      max-height: 420px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 760px;
    }
    th, td {
      padding: 9px 10px;
      border-bottom: 1px solid #eff4fa;
      text-align: left;
      font-size: 13px;
      color: #1e293b;
      vertical-align: middle;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #f8fafc;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-size: 11px;
      color: #475569;
    }
    .money {
      font-weight: 700;
      color: #0f172a;
    }
    .mono {
      font-family: "Menlo", "Consolas", "SFMono-Regular", monospace;
      font-size: 12px;
      color: #334155;
    }
    .rows-status {
      margin: 10px 0 0;
      font-size: 12px;
      color: #64748b;
    }
    @keyframes rise {
      from {
        opacity: 0;
        transform: translateY(7px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    @media (max-width: 980px) {
      .toolbar {
        grid-template-columns: 1fr;
      }
      .kpis {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .charts {
        grid-template-columns: 1fr;
      }
      .donut-shell {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 640px) {
      body {
        padding: 18px 10px 26px;
      }
      .field-grid {
        grid-template-columns: 1fr;
      }
      .kpis {
        grid-template-columns: 1fr;
      }
      .hero {
        padding: 18px 14px 14px;
      }
      .dashboard, .login {
        padding: 12px;
      }
      h1 {
        font-size: 24px;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="surface hero">
      <p class="eyebrow">Finance Bot Web</p>
      <h1>Resumo financeiro WEB</h1>
      <p class="hero-sub">Entre com seu telefone ou ID do usuário no bot (mesmo valor para usuário e senha) para visualizar métricas, gráficos de gastos, tabela completa de despesas e exportar planilha de Excel.</p>
    </section>

    <section id="login-panel" class="surface login">
      <form id="login-form">
        <div class="field-grid">
          <label class="field">
            <span class="label">Usuário (telefone ou ID)</span>
            <input id="login-user" class="input" type="text" autocomplete="username" placeholder="Ex: 5561983859831" />
          </label>
          <label class="field">
            <span class="label">Senha (mesmo valor)</span>
            <input id="login-pass" class="input" type="password" autocomplete="current-password" placeholder="Repita o mesmo número/ID" />
          </label>
        </div>
        <div class="actions" style="margin-top: 10px;">
          <button id="login-btn" class="btn btn-primary" type="submit">Entrar no painel</button>
        </div>
      </form>
      <p class="hint">Use telefone ou ID enviado pelo comando <strong>painel web</strong> no WhatsApp.</p>
      <p id="auth-status" class="status is-hidden"></p>
    </section>

    <section id="dashboard-panel" class="surface dashboard is-hidden">
      <div class="toolbar">
        <p id="welcome" class="welcome">Usuário:</p>
        <label class="field">
          <span class="label">Mês de referência</span>
          <input id="month-input" class="input" type="month" />
        </label>
        <button id="refresh-btn" class="btn btn-secondary" type="button">Atualizar</button>
        <button id="export-btn" class="btn btn-export" type="button">Exportar Excel</button>
        <button id="logout-btn" class="btn btn-secondary" type="button">Sair</button>
      </div>

      <p id="dashboard-status" class="status is-hidden"></p>

      <div class="kpis">
        <article class="kpi">
          <span class="kpi-label">Total no mês</span>
          <span id="kpi-month-total" class="kpi-value">R$ 0,00</span>
          <span id="kpi-month-count" class="kpi-sub">0 despesas</span>
        </article>
        <article class="kpi">
          <span class="kpi-label">Ticket médio</span>
          <span id="kpi-average" class="kpi-value">R$ 0,00</span>
          <span class="kpi-sub">Média por despesa</span>
        </article>
        <article class="kpi">
          <span class="kpi-label">Total acumulado</span>
          <span id="kpi-overall-total" class="kpi-value">R$ 0,00</span>
          <span id="kpi-overall-count" class="kpi-sub">0 despesas registradas</span>
        </article>
        <article class="kpi">
          <span class="kpi-label">Mês selecionado</span>
          <span id="kpi-month-label" class="kpi-value">--/----</span>
          <span class="kpi-sub">Referência dos gráficos</span>
        </article>
      </div>

      <div class="charts">
        <article class="chart-card">
          <h2 class="chart-title">Distribuição por categoria</h2>
          <div class="donut-shell">
            <div id="category-donut" class="donut">
              <div class="donut-center">
                <strong>Total mês</strong>
                <span id="donut-total">R$ 0,00</span>
              </div>
            </div>
            <ul id="category-legend" class="legend"></ul>
          </div>
        </article>

        <article class="chart-card">
          <h2 class="chart-title">Últimos meses</h2>
          <div id="timeline-bars" class="bars"></div>
        </article>
      </div>

      <section class="table-card">
        <h2 class="chart-title" style="margin-top: 0;">Todas as despesas</h2>
        <div class="table-toolbar">
          <input id="search-input" class="input" type="search" placeholder="Buscar por descrição, categoria ou data..." />
          <select id="category-filter" class="input">
            <option value="">Todas as categorias</option>
          </select>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Categoria</th>
                <th>Descrição</th>
                <th>Valor</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody id="rows-body"></tbody>
          </table>
        </div>
        <p id="rows-status" class="rows-status"></p>
      </section>
    </section>
  </main>

  <script>
    const STORAGE_AUTH_KEY = 'finance_dashboard_auth_header';
    const STORAGE_USER_KEY = 'finance_dashboard_user';
    const CHART_COLORS = ['#0f766e', '#d97706', '#0ea5e9', '#14b8a6', '#84cc16', '#ef4444', '#6366f1'];

    const state = {
      authHeader: '',
      payload: null,
      search: '',
      category: ''
    };

    const loginPanelEl = document.getElementById('login-panel');
    const dashboardPanelEl = document.getElementById('dashboard-panel');
    const loginFormEl = document.getElementById('login-form');
    const loginBtnEl = document.getElementById('login-btn');
    const loginUserEl = document.getElementById('login-user');
    const loginPassEl = document.getElementById('login-pass');
    const authStatusEl = document.getElementById('auth-status');

    const monthInputEl = document.getElementById('month-input');
    const refreshBtnEl = document.getElementById('refresh-btn');
    const exportBtnEl = document.getElementById('export-btn');
    const logoutBtnEl = document.getElementById('logout-btn');
    const dashboardStatusEl = document.getElementById('dashboard-status');
    const welcomeEl = document.getElementById('welcome');

    const kpiMonthTotalEl = document.getElementById('kpi-month-total');
    const kpiMonthCountEl = document.getElementById('kpi-month-count');
    const kpiAverageEl = document.getElementById('kpi-average');
    const kpiOverallTotalEl = document.getElementById('kpi-overall-total');
    const kpiOverallCountEl = document.getElementById('kpi-overall-count');
    const kpiMonthLabelEl = document.getElementById('kpi-month-label');
    const donutTotalEl = document.getElementById('donut-total');

    const categoryDonutEl = document.getElementById('category-donut');
    const categoryLegendEl = document.getElementById('category-legend');
    const timelineBarsEl = document.getElementById('timeline-bars');

    const searchInputEl = document.getElementById('search-input');
    const categoryFilterEl = document.getElementById('category-filter');
    const rowsBodyEl = document.getElementById('rows-body');
    const rowsStatusEl = document.getElementById('rows-status');

    function toCurrency(value) {
      const number = Number(value);
      const safe = Number.isFinite(number) ? number : 0;
      return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
      }).format(safe);
    }

    function normalizeUserCredential(value) {
      return String(value || '').replace(/\\D/g, '');
    }

    function getUserFromQueryParam() {
      try {
        const params = new URLSearchParams(window.location.search);
        return normalizeUserCredential(params.get('user') || '');
      } catch (_error) {
        return '';
      }
    }

    function getDefaultMonth() {
      const now = new Date();
      return String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0');
    }

    function toBRDate(isoDate) {
      const safe = String(isoDate || '').trim();

      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(safe)) {
        return safe || '-';
      }

      return safe.slice(8, 10) + '/' + safe.slice(5, 7) + '/' + safe.slice(0, 4);
    }

    function setAuthStatus(message, isError) {
      authStatusEl.classList.remove('is-hidden', 'error');
      authStatusEl.textContent = String(message || '');

      if (isError) {
        authStatusEl.classList.add('error');
      }
    }

    function hideAuthStatus() {
      authStatusEl.classList.add('is-hidden');
      authStatusEl.classList.remove('error');
      authStatusEl.textContent = '';
    }

    function setDashboardStatus(message, isError) {
      if (!message) {
        dashboardStatusEl.classList.add('is-hidden');
        dashboardStatusEl.classList.remove('error');
        dashboardStatusEl.textContent = '';
        return;
      }

      dashboardStatusEl.classList.remove('is-hidden', 'error');
      dashboardStatusEl.textContent = String(message);

      if (isError) {
        dashboardStatusEl.classList.add('error');
      }
    }

    function setBusy(isBusy) {
      loginBtnEl.disabled = isBusy;
      refreshBtnEl.disabled = isBusy;
      exportBtnEl.disabled = isBusy;
      logoutBtnEl.disabled = isBusy;
    }

    function showDashboard() {
      loginPanelEl.classList.add('is-hidden');
      dashboardPanelEl.classList.remove('is-hidden');
    }

    function showLogin() {
      dashboardPanelEl.classList.add('is-hidden');
      loginPanelEl.classList.remove('is-hidden');
    }

    function persistAuth(user, authHeader) {
      sessionStorage.setItem(STORAGE_USER_KEY, user);
      sessionStorage.setItem(STORAGE_AUTH_KEY, authHeader);
    }

    function clearPersistedAuth() {
      sessionStorage.removeItem(STORAGE_USER_KEY);
      sessionStorage.removeItem(STORAGE_AUTH_KEY);
    }

    async function parseResponse(response) {
      const fallback = { ok: false, error: 'request_failed' };

      try {
        const payload = await response.json();
        return payload && typeof payload === 'object' ? payload : fallback;
      } catch (_error) {
        return fallback;
      }
    }

    function getApiMonthQuery() {
      const month = String(monthInputEl.value || '').trim();

      if (!month) {
        return '';
      }

      return '?month=' + encodeURIComponent(month);
    }

    async function loadDashboard() {
      if (!state.authHeader) {
        throw new Error('missing_auth');
      }

      setBusy(true);
      setDashboardStatus('Carregando dados...');

      try {
        const response = await fetch('/web/api/dashboard' + getApiMonthQuery(), {
          method: 'GET',
          headers: {
            Authorization: state.authHeader
          },
          cache: 'no-store'
        });
        const payload = await parseResponse(response);

        if (!response.ok || !payload || payload.ok !== true) {
          throw new Error((payload && payload.error) || 'request_failed');
        }

        state.payload = payload;
        renderDashboard();
        showDashboard();
      } finally {
        setBusy(false);
      }
    }

    function renderDashboard() {
      const payload = state.payload || {};
      const summary = payload.summary || {};

      welcomeEl.textContent = 'Usuário: ' + (payload.name || payload.user || '-');

      kpiMonthTotalEl.textContent = toCurrency(summary.monthlyTotal);
      kpiMonthCountEl.textContent = String(summary.monthlyCount || 0) + ' despesa(s)';
      kpiAverageEl.textContent = toCurrency(summary.monthlyAverage);
      kpiOverallTotalEl.textContent = toCurrency(summary.overallTotal);
      kpiOverallCountEl.textContent = String(summary.overallCount || 0) + ' despesas registradas';
      kpiMonthLabelEl.textContent = payload.selectedMonth && payload.selectedMonth.label
        ? payload.selectedMonth.label
        : '--/----';
      donutTotalEl.textContent = toCurrency(summary.monthlyTotal);

      renderCategoryChart();
      renderMonthlyTimeline();
      refreshCategoryFilterOptions();
      renderRows();

      if (!Number(summary.overallCount || 0)) {
        setDashboardStatus(
          'Nenhum dado encontrado para este login. No WhatsApp, envie "painel web" e use telefone/ID informado na mensagem.',
          false
        );
      } else {
        setDashboardStatus('');
      }
    }

    function renderCategoryChart() {
      const payload = state.payload || {};
      const breakdown = Array.isArray(payload.categoryBreakdown) ? payload.categoryBreakdown : [];
      const valid = breakdown.filter((item) => Number(item.total) > 0);

      categoryLegendEl.innerHTML = '';

      if (!valid.length) {
        categoryDonutEl.style.background = '#d8e5f3';

        const li = document.createElement('li');
        li.textContent = 'Sem despesas no mês selecionado.';
        categoryLegendEl.appendChild(li);
        return;
      }

      let startDeg = 0;
      const gradientSegments = [];

      valid.forEach((item, index) => {
        const color = CHART_COLORS[index % CHART_COLORS.length];
        const percentage = Number(item.percentage) > 0 ? Number(item.percentage) : 0;
        const sweep = (percentage / 100) * 360;
        const endDeg = startDeg + sweep;

        gradientSegments.push(color + ' ' + startDeg + 'deg ' + endDeg + 'deg');
        startDeg = endDeg;

        const li = document.createElement('li');

        const swatch = document.createElement('span');
        swatch.className = 'dot';
        swatch.style.background = color;
        li.appendChild(swatch);

        const label = document.createElement('b');
        label.textContent = item.category || 'Outros';
        li.appendChild(label);

        const value = document.createElement('span');
        value.textContent = toCurrency(item.total) + ' (' + Number(item.percentage || 0).toFixed(1) + '%)';
        li.appendChild(value);

        categoryLegendEl.appendChild(li);
      });

      categoryDonutEl.style.background = 'conic-gradient(' + gradientSegments.join(', ') + ')';
    }

    function renderMonthlyTimeline() {
      const payload = state.payload || {};
      const timeline = Array.isArray(payload.monthlyTimeline) ? payload.monthlyTimeline : [];

      timelineBarsEl.innerHTML = '';

      if (!timeline.length) {
        const empty = document.createElement('p');
        empty.textContent = 'Sem histórico recente.';
        timelineBarsEl.appendChild(empty);
        return;
      }

      const maxValue = timeline.reduce((max, item) => Math.max(max, Number(item.total) || 0), 0) || 1;

      timeline.forEach((item) => {
        const amount = Number(item.total) || 0;
        const height = Math.max((amount / maxValue) * 100, 2);

        const wrapper = document.createElement('div');
        wrapper.className = 'bar-item';

        const track = document.createElement('div');
        track.className = 'bar-track';

        const fill = document.createElement('div');
        fill.className = 'bar-fill';
        fill.style.height = height + '%';

        track.appendChild(fill);

        const label = document.createElement('div');
        label.className = 'bar-label';
        label.textContent = item.label || '--/----';

        const value = document.createElement('div');
        value.className = 'bar-value';
        value.textContent = toCurrency(amount);

        wrapper.appendChild(track);
        wrapper.appendChild(label);
        wrapper.appendChild(value);
        timelineBarsEl.appendChild(wrapper);
      });
    }

    function refreshCategoryFilterOptions() {
      const previous = categoryFilterEl.value;
      const payload = state.payload || {};
      const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
      const categorySet = new Set();

      transactions.forEach((item) => {
        const category = String(item.categoria || '').trim();

        if (category) {
          categorySet.add(category);
        }
      });

      const categories = Array.from(categorySet).sort((left, right) => left.localeCompare(right, 'pt-BR'));

      categoryFilterEl.innerHTML = '';

      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = 'Todas as categorias';
      categoryFilterEl.appendChild(defaultOption);

      categories.forEach((category) => {
        const option = document.createElement('option');
        option.value = category;
        option.textContent = category;
        categoryFilterEl.appendChild(option);
      });

      if (categories.includes(previous)) {
        categoryFilterEl.value = previous;
        state.category = previous;
      } else {
        categoryFilterEl.value = '';
        state.category = '';
      }
    }

    function filterTransactions() {
      const payload = state.payload || {};
      const transactions = Array.isArray(payload.transactions) ? payload.transactions : [];
      const query = String(state.search || '').trim().toLowerCase();
      const selectedCategory = String(state.category || '').trim().toLowerCase();

      return transactions.filter((item) => {
        const category = String(item.categoria || '').toLowerCase();
        const description = String(item.descricao || '').toLowerCase();
        const date = String(item.data || '').toLowerCase();
        const identifier = String(item.id || '').toLowerCase();

        if (selectedCategory && category !== selectedCategory) {
          return false;
        }

        if (!query) {
          return true;
        }

        return category.includes(query)
          || description.includes(query)
          || date.includes(query)
          || identifier.includes(query);
      });
    }

    function renderRows() {
      rowsBodyEl.innerHTML = '';

      const filtered = filterTransactions();

      if (!filtered.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.textContent = 'Nenhuma despesa encontrada para o filtro atual.';
        tr.appendChild(td);
        rowsBodyEl.appendChild(tr);
        rowsStatusEl.textContent = '0 resultado(s).';
        return;
      }

      filtered.forEach((item) => {
        const tr = document.createElement('tr');

        const dateTd = document.createElement('td');
        dateTd.textContent = toBRDate(item.data);
        tr.appendChild(dateTd);

        const categoryTd = document.createElement('td');
        categoryTd.textContent = item.categoria || 'Outros';
        tr.appendChild(categoryTd);

        const descriptionTd = document.createElement('td');
        descriptionTd.textContent = item.descricao || 'Sem descrição';
        tr.appendChild(descriptionTd);

        const valueTd = document.createElement('td');
        valueTd.className = 'money';
        valueTd.textContent = toCurrency(item.valor);
        tr.appendChild(valueTd);

        const idTd = document.createElement('td');
        idTd.className = 'mono';
        idTd.textContent = item.id || '-';
        tr.appendChild(idTd);

        rowsBodyEl.appendChild(tr);
      });

      rowsStatusEl.textContent = String(filtered.length) + ' resultado(s).';
    }

    async function exportExcel() {
      if (!state.authHeader) {
        return;
      }

      setBusy(true);
      setDashboardStatus('Gerando arquivo Excel...');

      try {
        const response = await fetch('/web/api/dashboard/export' + getApiMonthQuery(), {
          method: 'GET',
          headers: {
            Authorization: state.authHeader
          }
        });

        if (!response.ok) {
          const payload = await parseResponse(response);
          throw new Error((payload && payload.error) || 'export_failed');
        }

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const disposition = String(response.headers.get('Content-Disposition') || '');
        const fileMatch = disposition.match(/filename="?([^";]+)"?/i);
        const fallbackName = 'despesas.xls';

        link.href = objectUrl;
        link.download = fileMatch && fileMatch[1] ? fileMatch[1] : fallbackName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(objectUrl);

        setDashboardStatus('Exportação concluída.');
      } finally {
        setBusy(false);
      }
    }

    function doLogout() {
      state.authHeader = '';
      state.payload = null;
      state.search = '';
      state.category = '';
      clearPersistedAuth();
      setDashboardStatus('');
      showLogin();
      setAuthStatus('Sessão encerrada.', false);
    }

    async function handleLogin(event) {
      event.preventDefault();
      hideAuthStatus();
      setDashboardStatus('');

      const username = normalizeUserCredential(loginUserEl.value);
      const password = normalizeUserCredential(loginPassEl.value);

      if (!username || !password) {
        setAuthStatus('Informe o ID do usuário em usuário e senha.', true);
        return;
      }

      if (username !== password) {
        setAuthStatus('A senha deve ser igual ao ID informado no usuário.', true);
        return;
      }

      state.authHeader = 'Basic ' + btoa(username + ':' + password);
      persistAuth(username, state.authHeader);

      try {
        await loadDashboard();
      } catch (error) {
        clearPersistedAuth();
        state.authHeader = '';
        const code = error && error.message ? String(error.message) : 'request_failed';
        const map = {
          invalid_credentials: 'Credenciais inválidas.',
          user_not_found: 'Login não encontrado. Envie "painel web" no WhatsApp para receber telefone/ID correto.',
          access_disabled: 'Seu acesso ao assistente está desabilitado.'
        };
        setAuthStatus(map[code] || 'Falha ao autenticar no painel.', true);
      }
    }

    async function safeRefresh() {
      try {
        await loadDashboard();
      } catch (error) {
        const code = error && error.message ? String(error.message) : 'request_failed';
        const map = {
          invalid_credentials: 'Credenciais inválidas. Faça login novamente.',
          user_not_found: 'Login não encontrado. Use o comando "painel web" no WhatsApp.',
          access_disabled: 'Acesso desabilitado para este usuário.'
        };
        setDashboardStatus(map[code] || 'Falha ao atualizar dados.', true);

        if (code === 'invalid_credentials') {
          doLogout();
        }
      }
    }

    loginFormEl.addEventListener('submit', handleLogin);
    refreshBtnEl.addEventListener('click', safeRefresh);
    exportBtnEl.addEventListener('click', async () => {
      try {
        await exportExcel();
      } catch (error) {
        const code = error && error.message ? String(error.message) : 'export_failed';
        setDashboardStatus(code === 'access_disabled'
          ? 'Acesso desabilitado para exportar.'
          : 'Falha ao exportar arquivo Excel.', true);
      }
    });
    logoutBtnEl.addEventListener('click', doLogout);

    searchInputEl.addEventListener('input', (event) => {
      state.search = String(event.target.value || '');
      renderRows();
    });

    categoryFilterEl.addEventListener('change', (event) => {
      state.category = String(event.target.value || '');
      renderRows();
    });

    monthInputEl.value = getDefaultMonth();

    const queryUser = getUserFromQueryParam();
    const persistedUser = sessionStorage.getItem(STORAGE_USER_KEY) || '';
    const persistedAuth = sessionStorage.getItem(STORAGE_AUTH_KEY) || '';

    if (queryUser) {
      clearPersistedAuth();
      state.authHeader = '';
      loginUserEl.value = queryUser;
      loginPassEl.value = queryUser;
      setAuthStatus('Login preenchido automaticamente pelo link. Clique em "Entrar no painel".', false);
    } else if (persistedUser) {
      loginUserEl.value = persistedUser;
      loginPassEl.value = persistedUser;
    }

    if (!queryUser && persistedAuth) {
      state.authHeader = persistedAuth;
      safeRefresh().catch(() => null);
    }
  </script>
</body>
</html>`;
}

function createDashboardAuthMiddleware() {
  return async (req, res, next) => {
    try {
      const userFromAuth = parseDashboardUserFromAuthHeader(req.headers.authorization);

      if (!userFromAuth) {
        res.set('WWW-Authenticate', `Basic realm="${DASHBOARD_AUTH_REALM}", charset="UTF-8"`);
        res.status(401).json({
          ok: false,
          error: 'invalid_credentials'
        });
        return;
      }

      const context = await resolveDashboardContextByUser(userFromAuth);

      if (!context.ok) {
        if (context.statusCode === 401) {
          res.set('WWW-Authenticate', `Basic realm="${DASHBOARD_AUTH_REALM}", charset="UTF-8"`);
        }

        res.status(context.statusCode).json({
          ok: false,
          error: context.error
        });
        return;
      }

      req.dashboardContext = context;
      next();
    } catch (error) {
      next(error);
    }
  };
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
  const dashboardAuth = createDashboardAuthMiddleware();

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

  app.get('/web', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).type('text/html').send(buildDashboardPageHtml());
  });

  app.get('/web/api/dashboard', dashboardAuth, (req, res) => {
    const selectedMonth = parseYearMonthInput(req.query && req.query.month);
    const payload = buildDashboardPayload(req.dashboardContext, selectedMonth);

    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      ...payload
    });
  });

  app.get('/web/api/dashboard/export', dashboardAuth, (req, res) => {
    const selectedMonth = parseYearMonthInput(req.query && req.query.month);
    const payload = buildDashboardPayload(req.dashboardContext, selectedMonth);
    const xml = buildDashboardExcelXml(payload);
    const safeUser = sanitizeText(payload.user).replace(/\D/g, '') || 'usuario';
    const safeMonth = sanitizeText(payload.selectedMonth.key).replace(/[^0-9-]/g, '') || 'mes';

    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="despesas-${safeUser}-${safeMonth}.xls"`);
    res.status(200).send(xml);
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
