/**
 * reconcileOutreachDomain — Resend is the source of truth for the outreach
 * subdomain's status. tenant_config held a stale 'verifying' for days while
 * Resend had the domain verified, and nothing ever corrected it.
 *
 * Resend is stubbed via the module's own axios dependency (require cache).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Stub axios BEFORE core/resend-domain.js is required.
const axiosPath = require.resolve('axios', { paths: [path.join(__dirname, '..')] });
const calls = [];
let getImpl = async () => ({ data: {} });
let postImpl = async () => ({ data: {} });
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true, exports: {
    get: async (url, cfg) => { calls.push(['GET', url]); return getImpl(url, cfg); },
    post: async (url, body, cfg) => { calls.push(['POST', url]); return postImpl(url, body, cfg); },
  },
};

// db/client is required at module load; stub it so nothing touches Supabase.
const dbClientPath = require.resolve('../db/client');
require.cache[dbClientPath] = {
  id: dbClientPath, filename: dbClientPath, loaded: true,
  exports: { getServiceClient: () => { throw new Error('unused'); }, db: {} },
};

process.env.RESEND_API_KEY = 'test-key';
const { reconcileOutreachDomain, PENDING_STATUSES } = require('../core/resend-domain');

const TENANT = '30566ed6-026a-45e1-9502-029e6219df31';

/** Minimal Supabase-shaped stub over an in-memory tenant_config map. */
function makeDb(config) {
  const upserts = [];
  return {
    _upserts: upserts,
    _config: config,
    from() {
      const q = {
        _key: null,
        select() { return q; },
        eq(col, val) { if (col === 'key') q._key = val; return q; },
        maybeSingle() {
          const v = config[q._key];
          return Promise.resolve({ data: v === undefined ? null : { value: v } });
        },
        upsert(rows) {
          for (const r of [].concat(rows)) { upserts.push(r); config[r.key] = r.value; }
          return Promise.resolve({ error: null });
        },
      };
      return q;
    },
  };
}

test.beforeEach(() => { calls.length = 0; });

test('already verified: persists nothing new, never calls /verify', async () => {
  getImpl = async () => ({ data: { id: 'd1', name: 'outreach.example.com', status: 'verified', records: [] } });
  const db = makeDb({ outreach_domain_id: 'd1', outreach_domain_status: 'verified' });

  const r = await reconcileOutreachDomain(db, TENANT);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'verified');
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.triggered_verify, false);
  assert.ok(!calls.some(([m]) => m === 'POST'), 'must not re-verify an already verified domain');
});

test('stale verifying -> Resend says verified: corrects tenant_config', async () => {
  // This is the live bug: the stored guess said 'verifying' for days.
  getImpl = async () => ({ data: { id: 'd1', name: 'outreach.firstgenautomate.com', status: 'verified', records: [
    { record: 'DKIM', name: 'resend._domainkey.outreach', value: 'p=abc', status: 'verified' },
  ] } });
  const db = makeDb({ outreach_domain_id: 'd1', outreach_domain_status: 'verifying' });

  const r = await reconcileOutreachDomain(db, TENANT);
  assert.strictEqual(r.status, 'verified');
  assert.strictEqual(r.previous_status, 'verifying');
  assert.strictEqual(r.changed, true);
  assert.strictEqual(db._config.outreach_domain_status, 'verified');
  assert.strictEqual(db._config.outreach_domain_name, 'outreach.firstgenautomate.com');
  assert.ok(db._config.outreach_domain_dns.includes('DKIM'));
});

test('pending: triggers a DNS re-check and re-reads the status', async () => {
  let seq = 0;
  getImpl = async () => ({ data: { id: 'd1', name: 'x.com', status: seq++ === 0 ? 'pending' : 'verified', records: [] } });
  postImpl = async () => ({ data: { object: 'domain' } });
  const db = makeDb({ outreach_domain_id: 'd1', outreach_domain_status: 'pending' });

  const r = await reconcileOutreachDomain(db, TENANT);
  assert.strictEqual(r.triggered_verify, true);
  assert.strictEqual(r.status, 'verified', 'must re-read after asking Resend to verify');
  assert.deepStrictEqual(
    calls.map(([m]) => m), ['GET', 'POST', 'GET'],
    'GET status -> POST verify -> GET status',
  );
});

test('triggerVerify:false never POSTs even when pending', async () => {
  getImpl = async () => ({ data: { id: 'd1', name: 'x.com', status: 'pending', records: [] } });
  const db = makeDb({ outreach_domain_id: 'd1', outreach_domain_status: 'pending' });

  const r = await reconcileOutreachDomain(db, TENANT, { triggerVerify: false });
  assert.strictEqual(r.triggered_verify, false);
  assert.ok(!calls.some(([m]) => m === 'POST'));
});

test('Resend unreachable: reports the failure, keeps the stored status, never throws', async () => {
  getImpl = async () => { throw new Error('ECONNRESET'); };
  const db = makeDb({ outreach_domain_id: 'd1', outreach_domain_status: 'verifying' });

  const r = await reconcileOutreachDomain(db, TENANT);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /ECONNRESET/);
  assert.strictEqual(r.status, 'verifying', 'stored value survives an outage');
  assert.strictEqual(db._config.outreach_domain_status, 'verifying', 'must not clobber on failure');
});

test('no domain id: reports not_started rather than exploding', async () => {
  const db = makeDb({});
  const r = await reconcileOutreachDomain(db, TENANT);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'no_domain_id');
  assert.strictEqual(r.status, 'not_started');
});

test('JSON-encoded config values are unwrapped (double-quoted legacy rows)', async () => {
  getImpl = async () => ({ data: { id: 'd1', name: 'x.com', status: 'verified', records: [] } });
  const db = makeDb({ outreach_domain_id: '"d1"', outreach_domain_status: '"verified"' });
  const r = await reconcileOutreachDomain(db, TENANT);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, false, 'quoted "verified" must compare equal to verified');
  assert.ok(calls[0][1].endsWith('/domains/d1'), 'domain id must be unquoted in the URL');
});

test('PENDING_STATUSES covers the states Resend reports before success', () => {
  for (const s of ['not_started', 'pending', 'temporary_failure', 'failure']) {
    assert.ok(PENDING_STATUSES.has(s), `${s} should trigger a re-check`);
  }
  assert.ok(!PENDING_STATUSES.has('verified'));
});
