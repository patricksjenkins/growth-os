/**
 * Growth OS — Worker Service (deprecated entrypoint)
 *
 * HISTORICAL NOTE: this file used to register its own agent list and start
 * its own scheduler/processor, which produced a dangerous dual-registry:
 * worker/index.js and api/server.js each had their own agent map that
 * drifted over time (worker/index.js still registered 'schedule' and
 * 'missed-call' after they were retired, and pointed 'social-engagement'
 * at a different file than api/server.js).
 *
 * There is now ONE source of truth: api/server.js registers every agent
 * and starts the scheduler + job processor in-process. Railway's `npm start`
 * runs `node api/server.js` and needs nothing else.
 *
 * If your Railway deployment has a separate "worker" service that runs
 * `npm run worker` (i.e., this file), we now just boot api/server.js from
 * here. That way both paths converge on the same registry and schedule.
 * Long term, delete the separate worker service in Railway and remove this
 * file entirely.
 */

require('./shim-warn');
require('../api/server');
