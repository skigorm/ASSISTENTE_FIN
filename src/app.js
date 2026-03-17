require('dotenv').config();

const { bootstrap } = require('./bootstrap');
const { logError } = require('./utils');

bootstrap().catch((error) => {
  logError('APP', 'Erro crítico no bootstrap.', error.stack || error.message);
  process.exit(1);
});
