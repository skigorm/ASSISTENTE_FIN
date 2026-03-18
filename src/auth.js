const path = require('path');
const baileys = require('@whiskeysockets/baileys');
const { createClient } = require('redis');
const { logError, logInfo, logWarn } = require('./utils');

const { BufferJSON, initAuthCreds, proto, useMultiFileAuthState } = baileys;

const AUTH_FOLDER = path.join(__dirname, '..', 'data', 'baileys_auth');
const REDIS_AUTH_PREFIX_ENV = 'WHATSAPP_AUTH_PREFIX';
const DEFAULT_REDIS_AUTH_PREFIX = 'finance-bot:baileys-auth';

function getRedisAuthPrefix() {
  const customPrefix = String(process.env[REDIS_AUTH_PREFIX_ENV] || '').trim();
  return customPrefix || DEFAULT_REDIS_AUTH_PREFIX;
}

function fixKeyName(name) {
  return String(name || '')
    .replace(/\//g, '__')
    .replace(/:/g, '-');
}

function buildRedisKey(prefix, name) {
  return `${prefix}:${fixKeyName(name)}`;
}

async function useRedisAuthState(redisUrl, prefix) {
  const client = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 10000
    }
  });

  client.on('error', (error) => {
    logError('AUTH', 'Erro no cliente Redis de autenticação.', error.message);
  });

  await client.connect();

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
