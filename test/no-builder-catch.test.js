/**
 * Static guard: never call .catch() on a Supabase/PostgREST query builder.
 *
 * A PostgrestBuilder is a THENABLE, not a Promise. It implements then() and
 * does NOT implement catch(). So this:
 *
 *     await db.from('conversations').insert({...}).catch(() => {});
 *
 * throws `TypeError: db.from(...).insert(...).catch is not a function` at
 * runtime — and only on the line that executes it, which is typically an
 * "optional, best-effort" write nobody exercises in tests.
 *
 * This exact bug shipped in worker/agents/drip-campaign.js and silently killed
 * the outreach follow-up campaign for a month: the email was sent, then the
 * conversations insert threw, so advanceCursor() never ran. 25 enrollments got
 * stuck retrying an already-sent touch, permanently filling the 25-slot
 * per-run budget and starving 77 other prospects. Nothing errored loudly.
 *
 * Use `.then(() => {}, () => {})` to ignore the result of a builder.
 *
 * `db.storage.from(...)` IS a real Promise — .catch() there is fine.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['core', 'worker', 'api', 'integrations', 'db'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

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

/**
 * Split on `;` and flag any statement that both opens a PostgREST builder
 * (`.from(`, but not `.storage.from(`) and calls `.catch(` on it.
 */
/** Remove // line comments and block comments (they discuss the bug, not commit it). */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)));
}

function findBuilderCatch(rawSource) {
  const source = stripComments(rawSource);
  const hits = [];
  let line = 1;
  for (const stmt of source.split(';')) {
    const startLine = line;
    line += (stmt.match(/\n/g) || []).length;

    const catchAt = stmt.indexOf('.catch(');
    if (catchAt === -1) continue;
    if (!/\.from\(/.test(stmt)) continue;

    // db.storage.from(...) returns a genuine Promise — allowed.
    const withoutStorage = stmt.replace(/\.storage\s*\.\s*from\([^)]*\)/g, '');
    if (!/\.from\(/.test(withoutStorage)) continue;

    // Require a builder verb — the shape that actually bit us.
    if (!/\.(insert|update|upsert|delete|select|rpc)\(/.test(withoutStorage)) continue;

    // `builder.then(...).catch(...)` is SAFE: .then() returns a real Promise,
    // which does have .catch(). Only a .catch() reached directly off the
    // builder throws.
    const thenAt = stmt.indexOf('.then(');
    if (thenAt !== -1 && thenAt < catchAt) continue;

    hits.push({ line: startLine, snippet: stmt.trim().slice(0, 160).replace(/\s+/g, ' ') });
  }
  return hits;
}

test('the installed PostgREST builder really has no .catch (the premise of this guard)', () => {
  const pg = require('@supabase/postgrest-js');
  const proto = pg.PostgrestBuilder && pg.PostgrestBuilder.prototype;
  assert.ok(proto, 'PostgrestBuilder.prototype should be reachable');
  assert.strictEqual(typeof proto.then, 'function', 'builder must be a thenable');
  assert.strictEqual(
    typeof proto.catch, 'undefined',
    'If postgrest-js ever adds .catch(), this guard can be relaxed — but verify first.',
  );
});

test('no source file calls .catch() on a Supabase query builder', () => {
  const offenders = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      for (const hit of findBuilderCatch(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(ROOT, file)}:${hit.line} — ${hit.snippet}`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    'Supabase builders have no .catch(). Use .then(() => {}, () => {}) instead.\n'
    + `Offenders:\n  ${offenders.join('\n  ')}`,
  );
});

test('the guard actually detects the bug shape it exists to prevent', () => {
  const bad = "await db.from('conversations').insert({ a: 1 }).catch(() => {});";
  assert.strictEqual(findBuilderCatch(bad).length, 1, 'should flag builder .catch');

  const badMultiline = `
    await db.from('activity_log').insert({
      tenant_id: t,
      metadata: { x: 1 },
    }).catch(() => {});
  `;
  assert.strictEqual(findBuilderCatch(badMultiline).length, 1, 'should flag across newlines');

  const badDelete = "await db.from('finance_entries').delete().eq('id', x).catch(() => {});";
  assert.strictEqual(findBuilderCatch(badDelete).length, 1, 'should flag builder .delete().catch');
});

test('the guard does not flag the safe forms', () => {
  const okThen = "await db.from('conversations').insert({ a: 1 }).then(() => {}, () => {});";
  assert.deepStrictEqual(findBuilderCatch(okThen), []);

  const okStorage = "await db.storage.from(BUCKET).remove([p]).catch(() => {});";
  assert.deepStrictEqual(findBuilderCatch(okStorage), [], 'db.storage returns a real Promise');

  const okAsyncFn = "await recordUsage({ provider: 'serper' }).catch(() => {});";
  assert.deepStrictEqual(findBuilderCatch(okAsyncFn), []);

  const okPush = "sendPushToTenant(id, { title: 'x' }).catch(() => {});";
  assert.deepStrictEqual(findBuilderCatch(okPush), []);

  // .then() returns a real Promise, so a .catch() AFTER it is legal.
  const okThenCatch = "db.from('activity_log').insert({ a: 1 }).then(() => {}).catch(() => {});";
  assert.deepStrictEqual(findBuilderCatch(okThenCatch), [], '.then(...).catch(...) is safe');

  const okCountThenCatch = "const c = db.from(t).select('id', { head: true }).then((r) => r.count).catch(() => 0);";
  assert.deepStrictEqual(findBuilderCatch(okCountThenCatch), []);

  // A comment describing the bug must not be reported as the bug.
  const okComment = "// never write db.from('x').insert({}).catch(() => {}) here\nconst a = 1;";
  assert.deepStrictEqual(findBuilderCatch(okComment), []);
});
