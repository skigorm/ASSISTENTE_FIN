const state = {
  status: 'idle',
  qr: null,
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
    message: 'Conectando ao WhatsApp...'
  });
}

function setWhatsAppWaitingQr(qr) {
  updateState({
    status: 'waiting_qr',
    qr,
    message: 'Escaneie o QR Code com o WhatsApp para parear.'
  });
}

function setWhatsAppPairingCode() {
  updateState({
    status: 'waiting_pairing_code',
    qr: null,
    message: 'Aguardando confirmação do código de pareamento no celular.'
  });
}

function setWhatsAppConnected() {
  updateState({
    status: 'connected',
    qr: null,
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
    message: `Conexão encerrada${code}.${reconnect}`
  });
}

function setWhatsAppLoggedOut() {
  updateState({
    status: 'logged_out',
    qr: null,
    message: 'Sessão deslogada. Faça novo pareamento.'
  });
}

function getWhatsAppState() {
  return {
    status: state.status,
    qr: state.qr,
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
