const state = {
  status: 'idle',
  qr: null,
  pairingCode: null,
  message: 'Aguardando inicialização do bot.',
  updatedAt: new Date().toISOString()
};

function updateState(patch) {
  Object.assign(state, patch, {
    updatedAt: new Date().toISOString()
  });
}

function setWhatsAppConnecting() {
  updateState({
    status: 'connecting',
    qr: null,
    pairingCode: null,
    message: 'Conectando ao WhatsApp...'
  });
}

function setWhatsAppWaitingQr(qr) {
  updateState({
    status: 'waiting_pairing_number',
    qr: null,
    pairingCode: null,
    message: 'Configure WHATSAPP_PAIRING_NUMBER para gerar código de pareamento.'
  });
}

function setWhatsAppPairingCode(pairingCode) {
  updateState({
    status: 'waiting_pairing_code',
    qr: null,
    pairingCode: String(pairingCode || ''),
    message: 'Digite o código de pareamento no celular.'
  });
}

function setWhatsAppConnected() {
  updateState({
    status: 'connected',
    qr: null,
    pairingCode: null,
    message: 'WhatsApp conectado.'
  });
}

function setWhatsAppDisconnected(meta) {
  const code = meta && meta.statusCode !== undefined ? ` (${meta.statusCode})` : '';
  const reconnect = meta && meta.shouldReconnect === false
    ? ' Repareamento necessário.'
    : ' Tentando reconectar.';

  updateState({
    status: 'disconnected',
    qr: null,
    pairingCode: null,
    message: `Conexão encerrada${code}.${reconnect}`
  });
}

function setWhatsAppLoggedOut() {
  updateState({
    status: 'logged_out',
    qr: null,
    pairingCode: null,
    message: 'Sessão deslogada. Faça novo pareamento.'
  });
}

function getWhatsAppState() {
  return {
    status: state.status,
    qr: state.qr,
    pairingCode: state.pairingCode,
    message: state.message,
    updatedAt: state.updatedAt
  };
}

module.exports = {
  getWhatsAppState,
  setWhatsAppConnected,
  setWhatsAppConnecting,
  setWhatsAppDisconnected,
  setWhatsAppLoggedOut,
  setWhatsAppPairingCode,
  setWhatsAppWaitingQr
};
