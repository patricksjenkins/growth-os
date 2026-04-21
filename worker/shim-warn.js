/**
 * Loud warning so anyone who runs `npm run worker` knows this entrypoint is
 * now a thin shim over api/server.js.
 */
const { createLogger } = require('../core/logger');
const log = createLogger('worker-shim');
log.warn('worker/index.js is now a shim — booting api/server.js for the unified registry.');
log.warn('If you still have a separate Railway "worker" service, consider deleting it; one process is enough.');
