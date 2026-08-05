'use strict';

/**
 * The wizard write path, exercised through the ACTUAL ENDPOINT.
 *
 * FOUND BY REVIEW, 2026-08-02. POST /api/tenant/onboarding-step wrote
 * `Object.entries(data)` straight into tenant_config with no allow-list. An
 * authenticated tenant could mark the service terms accepted with no
 * signature, declare the whole wizard finished in one request, or overwrite
 * any tenant_config key at all.
 *
 * FOUND BY REVIEW AGAIN, 2026-08-03: the tests written to prove that fix
 * matched SOURCE TEXT with regexes. They asserted that the file contains
 * `const allowed = new Set(...)`, not that a hostile request is refused. A
 * rename would have broken them; a reordering that moved the gate after the
 * write would NOT have, because they only checked that one string appeared
 * before another. They also could not see the defects still live at the time:
 * every step accepted empty data, `{step:'complete'}` finished the wizard, and
 * agreement_versions was whatever the browser said it was.
 *
 * So this file now calls the route handler. Every test states a REQUEST and
 * asserts on the RESPONSE and on what actually landed in the database.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const TENANT = 'tenant-under-test';

// --- a fake tenant_config the handler can really read and write ------------

function fakeDb(seedConfig = {}) {
  const rows = Object.entries(seedConfig).map(([key, value]) => ({ tenant_id: TENANT, key, value }));
  const tables = {
    tenant_config: rows,
    tenant_modules: [{ tenant_id: TENANT, module: 'lead_capture', enabled: true }],
    onboarding_steps: [],
    onboarding_workflows: [],
  };
  function make(name) {
    // The handler touches tables beyond the ones this test seeds (activity
    // logs, job queues). An undefined table used to throw inside the route and
    // surface as a 500, which reads exactly like a rejection and would have
    // let a genuinely broken success path pass as "refused".
    if (!tables[name]) tables[name] = [];
    const filters = [];
    let patch = null;
    const matching = () => tables[name].filter((r) => filters.every((f) => f(r)));
    function run() {
      if (patch) { const hit = matching(); hit.forEach((r) => Object.assign(r, patch)); return { data: hit, error: null }; }
      return { data: matching(), error: null };
    }
    const api = {
      select: () => api, order: () => api, limit: () => api,
      eq(c, v) { filters.push((r) => r[c] === v); return api; },
      in(c, v) { filters.push((r) => v.includes(r[c])); return api; },
      update(p) { patch = p; return api; },
      upsert(p) {
        for (const row of (Array.isArray(p) ? p : [p])) {
          const found = tables[name].find((r) => r.tenant_id === row.tenant_id && r.key === row.key);
          if (found) found.value = row.value; else tables[name].push({ ...row });
        }
        return api;
      },
      insert(p) { tables[name].push(...(Array.isArray(p) ? p : [p])); return api; },
      single() { const r = run(); return Promise.resolve({ data: r.data[0] || null, error: r.error }); },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data[0] || null, error: r.error }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return {
    from: make,
    _tables: tables,
    config() {
      return Object.fromEntries(tables.tenant_config.map((r) => [r.key, r.value]));
    },
  };
}

// --- drive the real route --------------------------------------------------

let currentDb = null;
// The handler builds its client through db/userClient. Point that at the fake
// BEFORE the route module is loaded, so the endpoint under test is the real
// one and only its database is substituted.
require.cache[require.resolve('../db/userClient')] = {
  id: require.resolve('../db/userClient'),
  filename: require.resolve('../db/userClient'),
  loaded: true,
  exports: { getUserClient: () => currentDb },
};

const tenantRouter = require('../api/routes/tenant');

function handlerFor(method, routePath) {
  const layer = tenantRouter.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method],
  );
  assert.ok(layer, `route not registered: ${method.toUpperCase()} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

/** POST a wizard step as the tenant. Returns {status, body, db}. */
async function postStep(db, step, data, headers = {}) {
  currentDb = db;
  const res = {
    statusCode: 200, body: null,
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
  };
  await handlerFor('post', '/onboarding-step')(
    { tenantId: TENANT, body: { step, data }, headers, ip: '203.0.113.9', socket: {}, user: {}, tenant: {} },
    res,
  );
  return { status: res.statusCode, body: res.body, db };
}

// --- the original hole: arbitrary config writes -----------------------------

test('a step cannot write a key belonging to another step', async () => {
  const db = fakeDb();
  const r = await postStep(db, 'logo', { logo_url: 'https://x/l.png', telnyx_phone_number: '+15550001111' });
  assert.strictEqual(r.status, 400, 'the request must be refused, not silently filtered');
  assert.match(r.body.error, /telnyx_phone_number/);
  assert.strictEqual(db.config().telnyx_phone_number, undefined, 'and nothing may be written');
});

test('a step cannot overwrite the operator\'s own controls', async () => {
  const db = fakeDb({ wizard_excluded_steps: ['photos'] });
  for (const key of ['wizard_excluded_steps', 'preflight_passed_at', 'owner_email', 'tier', 'onboarding_stage']) {
    const r = await postStep(db, 'colors', { color_primary: '#111', [key]: 'hijacked' });
    assert.strictEqual(r.status, 400, `${key} must be refused`);
  }
  assert.deepStrictEqual(db.config().wizard_excluded_steps, ['photos'], 'untouched');
});

test('a caller cannot declare the whole wizard finished in one request', async () => {
  // onboarding_steps_completed is re-read by the handler immediately after the
  // write, so accepting it skipped every step at once.
  const db = fakeDb();
  const r = await postStep(db, 'logo', {
    logo_url: 'https://x/l.png',
    onboarding_steps_completed: ['welcome', 'business_basics', 'agreement', 'complete'],
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /onboarding_steps_completed/);
});

// --- empty steps are not completed steps -----------------------------------

test('a required step cannot be completed with no data', async () => {
  const db = fakeDb();
  const r = await postStep(db, 'business_basics', {});
  assert.strictEqual(r.status, 400, 'a business with no name is not a completed step');
  assert.match(r.body.error, /business_name/);
  assert.ok(!(db.config().onboarding_steps_completed || []).includes('business_basics'));
});

test('whitespace is not an answer', async () => {
  const db = fakeDb();
  const r = await postStep(db, 'business_basics', { business_name: '   ' });
  assert.strictEqual(r.status, 400);
});

test('an optional step may legitimately be empty', async () => {
  // The guard must not be so broad it strands a real customer. A business with
  // no Instagram has to be able to move past the social step.
  const db = fakeDb();
  const r = await postStep(db, 'social', {});
  assert.strictEqual(r.status, 200, 'not every step has something to collect');
});

test('a value outside the allowed set is refused', async () => {
  const db = fakeDb();
  const r = await postStep(db, 'path_choice', { delivery_path: 'whatever' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /owned, managed/);
  const ok = await postStep(fakeDb(), 'path_choice', { delivery_path: 'owned' });
  assert.strictEqual(ok.status, 200);
});

// --- consent ---------------------------------------------------------------

test('the agreement cannot be accepted with an empty body', async () => {
  const db = fakeDb();
  const r = await postStep(db, 'agreement', {});
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /signature/i);
  assert.strictEqual(db.config().agreement_accepted_at, undefined, 'nothing recorded');
});

test('a client cannot supply its own acceptance IP at all', async () => {
  // The IP is not a client-writable field, so the request is refused outright
  // rather than having the value quietly replaced.
  const db = fakeDb();
  const r = await postStep(db, 'agreement', {
    agreement_signature: 'Jane Smith',
    agreement_acceptance_ip: '1.1.1.1',
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /agreement_acceptance_ip/);
});

test('acceptance time and IP come from the SERVER, not the request body', async () => {
  const db = fakeDb();
  const before = Date.now();
  const r = await postStep(db, 'agreement', {
    agreement_signature: 'Jane Smith',
    // A client trying to backdate its own consent. This field IS accepted, for
    // backwards compatibility with older wizard builds, and then overwritten.
    agreement_accepted_at: '2001-01-01T00:00:00.000Z',
  }, { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' });

  assert.strictEqual(r.status, 200, r.body && r.body.error);
  const cfg = db.config();
  const recorded = Date.parse(cfg.agreement_accepted_at);
  assert.ok(recorded >= before,
    `the acceptance time must be the server clock, not the browser's (got ${cfg.agreement_accepted_at})`);
  assert.strictEqual(cfg.agreement_acceptance_ip, '198.51.100.7',
    'the IP must be the one the server observed, through the proxy header');
});

test('WHICH documents were accepted is recorded by the server', async () => {
  // This was the remaining hole: agreement_versions came from the request and
  // was only checked for being a nonempty object, so {"anything":"0.0.1"} was
  // recorded as the versions accepted. A record of consent sourced from the
  // consenting party is not evidence.
  const { currentVersions } = require('../core/legal-documents');
  const db = fakeDb();
  const r = await postStep(db, 'agreement', {
    agreement_signature: 'Jane Smith',
    agreement_versions: { 'Something I Made Up': '0.0.1' },
  });

  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(db.config().agreement_versions, currentVersions(),
    'the versions recorded must be OUR list, whatever the client sent');
  assert.ok(!('Something I Made Up' in db.config().agreement_versions));
});

test('every required legal document is recorded with a version', async () => {
  const { LEGAL_DOCUMENTS } = require('../core/legal-documents');
  const db = fakeDb();
  await postStep(db, 'agreement', { agreement_signature: 'Jane Smith' });
  const recorded = db.config().agreement_versions;
  for (const doc of LEGAL_DOCUMENTS.filter((d) => d.required)) {
    assert.strictEqual(recorded[doc.name], doc.version, `${doc.name} must be recorded`);
  }
});

// --- the final step has to earn it -----------------------------------------

test('the wizard cannot be completed while required steps are empty', async () => {
  const db = fakeDb();
  const r = await postStep(db, 'complete', {});
  assert.strictEqual(r.status, 400, 'POST {step:"complete"} used to finish onboarding outright');
  assert.ok(Array.isArray(r.body.unfinished_steps) && r.body.unfinished_steps.length > 0);
  assert.notStrictEqual(db.config().onboarding_stage, 'in_app_intake_complete');
});

test('the wizard CAN be completed once the required steps are answered', async () => {
  const db = fakeDb();
  await postStep(db, 'business_basics', { business_name: 'Acme Tree Service' });
  await postStep(db, 'path_choice', { delivery_path: 'managed' });
  await postStep(db, 'agreement', { agreement_signature: 'Jane Smith' });

  const r = await postStep(db, 'complete', {});
  assert.strictEqual(r.status, 200, r.body && r.body.error);
  assert.strictEqual(db.config().onboarding_stage, 'in_app_intake_complete');
});

// --- the allow-list still has to cover every step the wizard can render -----

test('every step the resolver can show has an allow-list entry', async () => {
  // A step the wizard renders but the allow-list does not know about would
  // reject every field and strand the customer on it. Checked by POSTing to
  // each one rather than by reading the table.
  const { STEP_DEFINITIONS } = require('../core/onboarding-step-resolver');
  for (const def of STEP_DEFINITIONS) {
    const r = await postStep(fakeDb(), def.key, {});
    assert.notStrictEqual(r.status, 500, `${def.key} must not error`);
    // 400 is fine (required fields missing); what must not happen is the step
    // being unknown to the allow-list, which surfaces as every field rejected.
    if (r.status === 400) {
      assert.doesNotMatch(r.body.error || '', /are not part of the/,
        `${def.key} has no allow-list entry — the customer could never finish it`);
    }
  }
});

/*
 * THE CUSTOMER'S CORRECTIONS LAND — through the real endpoint.
 */

test('the customer can correct the business name Patrick typed', async () => {
  // Staged as "Acme Tree"; it is legally "Acme Tree LLC". The corrected name
  // must be what tenant_config holds afterwards — it goes on their app, their
  // invoices, and their agreement.
  const db = fakeDb({ business_name: 'Acme Tree', owner_name: 'Jane Smith' });
  const r = await postStep(db, 'business_basics', { business_name: 'Acme Tree LLC' });
  assert.strictEqual(r.status, 200, r.body && r.body.error);
  assert.strictEqual(db.config().business_name, 'Acme Tree LLC');
});

test('the customer can add the second owner Patrick did not know about', async () => {
  const db = fakeDb({ business_name: 'Acme Tree LLC', owner_name: 'Jane Smith' });
  const r = await postStep(db, 'business_basics', {
    business_name: 'Acme Tree LLC',
    co_owner_name: 'John Smith',
    co_owner_email: 'john@acmetree.test',
    co_owner_phone: '555-0102',
  });
  assert.strictEqual(r.status, 200, r.body && r.body.error);
  assert.strictEqual(db.config().co_owner_name, 'John Smith');
  assert.strictEqual(db.config().co_owner_email, 'john@acmetree.test');
});

test('correcting the basics still cannot touch owner_email', async () => {
  // The co-owner's contacts are the customer's facts to state; owner_email is
  // where every send goes and stays operator-only.
  const db = fakeDb({ owner_email: 'jane@acmetree.test' });
  const r = await postStep(db, 'business_basics', {
    business_name: 'Acme Tree LLC',
    owner_email: 'attacker@evil.test',
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(db.config().owner_email, 'jane@acmetree.test');
});
