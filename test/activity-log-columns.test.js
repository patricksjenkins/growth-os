/**
 * activity_log has exactly these writable columns: tenant_id, agent, action
 * (NOT NULL), entity_type, entity_id, level, metadata, created_at.
 *
 * The 2026-07-21 audit found FOUR writers inserting `type:`/`details:` keys —
 * columns that don't exist — so the inserts failed silently (best-effort
 * wrappers ate the error) and, in usage-caps' case, broke its own dedupe so
 * cap warnings could repeat. This static guard pins the convention.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['core', 'worker', 'api', 'integrations'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'archived']);

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && e.name.endsWith('.js')) yield full;
  }
}

// Look at the ~500 chars following each activity_log insert for keys that are
// not real columns. `entity_type:` is fine; a bare `type:` or `details:` is
// the bug. Word-boundary lookbehind keeps entity_type/metadata safe.
function findBadKeys(source) {
  const hits = [];
  const re = /\.from\(\s*['"]activity_log['"]\s*\)\s*\.insert\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    // Bound the window at the end of THIS insert call ("})" then ")") so it
    // can't bleed into an adjacent insert on a different table (which may
    // legitimately have a `type:` key, e.g. attention_queue).
    const tail = source.slice(m.index, m.index + 900);
    const end = tail.indexOf('})');
    const windowSrc = end === -1 ? tail.slice(0, 500) : tail.slice(0, end + 2);
    if (/(?<![a-zA-Z_])details\s*:/.test(windowSrc)) hits.push('details');
    if (/(?<![a-zA-Z_.])type\s*:/.test(windowSrc)) hits.push('type');
  }
  return hits;
}

test('no activity_log writer uses non-existent columns (type/details)', () => {
  const offenders = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const bad = findBadKeys(fs.readFileSync(file, 'utf8'));
      if (bad.length) offenders.push(`${path.relative(ROOT, file)} — ${bad.join(', ')}`);
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    'activity_log columns are agent/action/entity_type/entity_id/level/metadata. '
    + `Use metadata (not details) and action (not type).\nOffenders:\n  ${offenders.join('\n  ')}`,
  );
});

test('the guard detects the exact bug shape it exists to prevent', () => {
  const bad = "await db.from('activity_log').insert({ tenant_id: t, type: 'x', details: { a: 1 } });";
  assert.deepStrictEqual(findBadKeys(bad).sort(), ['details', 'type']);
  const ok = "await db.from('activity_log').insert({ tenant_id: t, agent: 'a', action: 'x', entity_type: 'lead', metadata: { a: 1 } });";
  assert.deepStrictEqual(findBadKeys(ok), []);
});
