'use strict';

/**
 * Swap modules in require.cache for the duration of fn, then always restore.
 *
 * Lets a test drive a shipped agent's real run() while replacing only its
 * outermost dependencies (db client, config), so the assertions are about the
 * code that actually ships rather than a re-implementation of it.
 */
const ROOT = require('path').resolve(__dirname, '..', '..');

async function withStubbedModules(map, fn) {
  const saved = {};
  for (const [spec, exports] of Object.entries(map)) {
    // Resolved from the REPO ROOT, not from this helper's directory, so callers
    // name modules the way the code under test names them.
    const path = require.resolve(spec.replace(/^\.\.\//, './'), { paths: [ROOT] });
    saved[path] = require.cache[path];
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }
  try { return await fn(); } finally {
    for (const [path, mod] of Object.entries(saved)) {
      if (mod) require.cache[path] = mod; else delete require.cache[path];
    }
  }
}

module.exports = { withStubbedModules };
