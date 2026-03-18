const path = require('path');
const { createClient } = require('redis');
const { logError, logInfo, logWarn } = require('./utils');

const AUTH_FOLDER = path.join(__dirname, '..', 'data', 'baileys_auth');
const REDIS_AUTH_PREFIX_ENV = 'WHATSAPP_AUTH_PREFIX';
const DEFAULT_REDIS_AUTH_PREFIX = 'finance-bot:baileys-auth';
const REDIS_TLS_ENV = 'REDIS_TLS';
const REDIS_TLS_REJECT_UNAUTHORIZED_ENV = 'REDIS_TLS_REJECT_UNAUTHORIZED';
let baileysRuntimePromise = null;

async function getBaileysRuntime() {
  if (!baileysRuntimePromise) {
    baileysRuntimePromise = import('@whiskeysockets/baileys')
      .then((moduleNs) => {
        const runtime = moduleNs && typeof moduleNs === 'object' ? moduleNs : {};
        const fallback = runtime.default && typeof runtime.default === 'object'
          ? runtime.default
          : {};

        const BufferJSON = runtime.BufferJSON || fallback.BufferJSON;
        const initAuthCreds = runtime.initAuthCreds || fallback.initAuthCreds;
        const proto = runtime.proto || fallback.proto;
        const useMultiFileAuthState = runtime.useMultiFileAuthState || fallback.useMultiFileAuthState;

        if (!BufferJSON || !initAuthCreds || !proto || !useMultiFileAuthState) {
          throw new Error('Baileys runtime incompleto para autenticação.');
        }

        return {
          BufferJSON,
          initAuthCreds,
          proto,
          useMultiFileAuthState
        };
      })
      .catch((error) => {
        baileysRuntimePromise = null;
        throw error;
      });
  }

  return baileysRuntimePromise;
}

function getRedisAuthPrefix() {
  const customPrefix = String(process.env[REDIS_AUTH_PREFIX_ENV] || '').trim();
  return customPrefix || DEFAULT_REDIS_AUTH_PREFIX;
}

function isEnvEnabled(name, defaultValue = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();

  if (!value) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(value);
}

function fixKeyName(name) {
  return String(name || '')
    .replace(/\//g, '__')
    .replace(/:/g, '-');
}

function buildRedisKey(prefix, name) {
  return `${prefix}:${fixKeyName(name)}`;
}

async function useRedisAuthState(redisUrl, prefix, options = {}) {
  const { BufferJSON, initAuthCreds, proto } = await getBaileysRuntime();
  const useTls = typeof options.useTls === 'boolean'
    ? options.useTls
    : isEnvEnabled(REDIS_TLS_ENV, redisUrl.startsWith('rediss://'));
  const tlsRejectUnauthorized = typeof options.tlsRejectUnauthorized === 'boolean'
    ? options.tlsRejectUnauthorized
    : isEnvEnabled(REDIS_TLS_REJECT_UNAUTHORIZED_ENV, false);
  const allowRetry = options.allowRetry !== false;
  let lastErrorLogAt = 0;

  const client = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 10000,
      tls: useTls,
      rejectUnauthorized: tlsRejectUnauthorized,
      reconnectStrategy: (retries) => {
        if (retries >= 3) {
          return new Error('Redis auth indisponível após tentativas de conexão.');
        }

        return Math.min((retries + 1) * 200, 1000);
      }
    }
  });

  client.on('error', (error) => {
    if (Date.now() - lastErrorLogAt > 30000) {
      lastErrorLogAt = Date.now();
      logError('AUTH', 'Erro no cliente Redis de autenticação.', error.message);
    }
  });

  try {
    await client.connect();
  } catch (error) {
    try {
      client.disconnect();
    } catch (_disconnectError) {
      // noop
    }

    const message = error && error.message ? String(error.message) : String(error);
    const selfSignedTlsError = /self[- ]signed certificate/i.test(message);

    if (useTls && tlsRejectUnauthorized && selfSignedTlsError && allowRetry) {
      logWarn(
        'AUTH',
        'Falha TLS no Redis de autenticação. Tentando novamente com REDIS_TLS_REJECT_UNAUTHORIZED=false.'
      );

      return useRedisAuthState(redisUrl, prefix, {
        useTls: true,
        tlsRejectUnauthorized: false,
        allowRetry: false
      });
    }

    throw error;
  }

  const readData = async (name) => {
    try {
      const key = buildRedisKey(prefix, name);
      const raw = await client.get(key);

      if (!raw) {
        return null;
      }

      return JSON.parse(raw, BufferJSON.reviver);
    } catch (error) {
      logWarn('AUTH', 'Falha ao ler dado de autenticação no Redis.', {
        name,
        error: error.message
      });
      return null;
    }
  };

  const writeData = async (name, value) => {
    const key = buildRedisKey(prefix, name);
    const raw = JSON.stringify(value, BufferJSON.replacer);
    await client.set(key, raw);
  };

  const removeData = async (name) => {
    const key = buildRedisKey(prefix, name);
    await client.del(key);
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    backend: 'redis',
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};

          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`key:${type}:${id}`);

              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }

              data[id] = value;
            })
          );

          return data;
        },
        set: async (data) => {
          const tasks = [];

          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const keyName = `key:${category}:${id}`;

              if (value) {
                tasks.push(writeData(keyName, value));
              } else {
                tasks.push(removeData(keyName));
              }
            }
          }

          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
    close: async () => {
      try {
        await client.quit();
      } catch (_error) {
        try {
          client.disconnect();
        } catch (_innerError) {
          // noop
        }
      }
    }
  };
}

async function loadWhatsAppAuthState() {
  const { useMultiFileAuthState } = await getBaileysRuntime();
  const redisUrl = String(process.env.REDIS_URL || '').trim();

  if (redisUrl) {
    const prefix = getRedisAuthPrefix();

    try {
      const redisState = await useRedisAuthState(redisUrl, prefix);
      logInfo('AUTH', `Autenticação WhatsApp carregada via Redis (${prefix}).`);
      return redisState;
    } catch (error) {
      logError(
        'AUTH',
        'Falha ao inicializar autenticação via Redis. Voltando para arquivo local.',
        error.message
      );
    }
  }

  logWarn('AUTH', 'REDIS_URL ausente ou indisponível. Usando auth local em arquivo.');
  const local = await useMultiFileAuthState(AUTH_FOLDER);
  return {
    backend: 'file',
    state: local.state,
    saveCreds: local.saveCreds,
    close: async () => {}
  };
}

module.exports = {
  loadWhatsAppAuthState
};
