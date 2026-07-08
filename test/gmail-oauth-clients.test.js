const test = require('node:test');
const assert = require('node:assert');

process.env.FGA_TENANT_ID = process.env.FGA_TENANT_ID || '30566ed6-026a-45e1-9502-029e6219df31';
process.env.OAUTH_STATE_SECRET = 'x'.repeat(40);

const {
  oauthCreds,
  configuredOauthClients,
  buildGmailConnectUrl,
  verifyOauthState,
} = require('../core/drip-gmail');

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const INTERNAL = { GOOGLE_CLIENT_ID: 'int-id', GOOGLE_CLIENT_SECRET: 'int-secret' };
const EXTERNAL = { GOOGLE_EXTERNAL_CLIENT_ID: 'ext-id', GOOGLE_EXTERNAL_CLIENT_SECRET: 'ext-secret' };
const BOTH = { ...INTERNAL, ...EXTERNAL };
const NONE = {
  GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined,
  GOOGLE_EXTERNAL_CLIENT_ID: undefined, GOOGLE_EXTERNAL_CLIENT_SECRET: undefined,
};

// ---------------------------------------------------------------------------
// Credential selection. A refresh token is bound to the client_id that minted
// it, so picking the wrong pair silently breaks a mailbox.
// ---------------------------------------------------------------------------

test('oauthCreds returns the credentials for the requested client', () => {
  withEnv(BOTH, () => {
    assert.deepStrictEqual(oauthCreds('internal'), { clientId: 'int-id', clientSecret: 'int-secret', kind: 'internal' });
    assert.deepStrictEqual(oauthCreds('external'), { clientId: 'ext-id', clientSecret: 'ext-secret', kind: 'external' });
  });
});

test('oauthCreds defaults to the internal client (existing rows have no oauth_client)', () => {
  withEnv(BOTH, () => {
    assert.strictEqual(oauthCreds().clientId, 'int-id');
    assert.strictEqual(oauthCreds(undefined).clientId, 'int-id');
  });
});

test('oauthCreds never silently falls back to the other client', () => {
  // External requested but only internal configured: must THROW, not quietly
  // hand back internal credentials (which Google would reject at refresh time
  // with an opaque invalid_client, days later, in a cron).
  withEnv({ ...NONE, ...INTERNAL }, () => {
    assert.throws(() => oauthCreds('external'), /not configured/i);
  });
  withEnv({ ...NONE, ...EXTERNAL }, () => {
    assert.throws(() => oauthCreds('internal'), /not configured/i);
  });
});

test('oauthCreds rejects an unknown client kind', () => {
  withEnv(BOTH, () => {
    assert.throws(() => oauthCreds('bogus'), /Unknown Google OAuth client/);
  });
});

test('configuredOauthClients reports exactly what is present', () => {
  withEnv({ ...NONE, ...INTERNAL }, () => {
    assert.deepStrictEqual(configuredOauthClients(), ['internal']);
  });
  withEnv(BOTH, () => {
    assert.deepStrictEqual(configuredOauthClients().sort(), ['external', 'internal']);
  });
  withEnv(NONE, () => {
    assert.deepStrictEqual(configuredOauthClients(), []);
  });
});

test('a half-configured client counts as absent (id without secret)', () => {
  withEnv({ ...NONE, ...INTERNAL, GOOGLE_EXTERNAL_CLIENT_ID: 'ext-id' }, () => {
    assert.deepStrictEqual(configuredOauthClients(), ['internal']);
    assert.throws(() => oauthCreds('external'), /not configured/i);
  });
});

// ---------------------------------------------------------------------------
// The client kind must survive the round-trip through the signed state, or the
// callback exchanges the code against the wrong client.
// ---------------------------------------------------------------------------

function stateFrom(url) {
  return new URL(url).searchParams.get('state');
}

test('connect URL carries the client kind in the signed state', () => {
  withEnv(BOTH, () => {
    const ext = buildGmailConnectUrl('mailbox', 'external');
    assert.match(ext, /client_id=ext-id/);
    assert.strictEqual(verifyOauthState(stateFrom(ext)).client, 'external');
    assert.strictEqual(verifyOauthState(stateFrom(ext)).purpose, 'mailbox');

    const int = buildGmailConnectUrl('drip', 'internal');
    assert.match(int, /client_id=int-id/);
    assert.strictEqual(verifyOauthState(stateFrom(int)).client, 'internal');
    assert.strictEqual(verifyOauthState(stateFrom(int)).purpose, 'drip');
  });
});

test('connect URL requests offline access + forced consent (needed for a refresh token)', () => {
  withEnv(BOTH, () => {
    const url = buildGmailConnectUrl('mailbox', 'external');
    assert.match(url, /access_type=offline/);
    assert.match(url, /prompt=consent/);
    assert.match(url, /gmail\.readonly/);
  });
});

test('the state signature is tamper-evident (cannot swap client kind)', () => {
  withEnv(BOTH, () => {
    const url = buildGmailConnectUrl('mailbox', 'internal');
    const state = stateFrom(url);
    const [body, sig] = state.split('.');
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString());
    parsed.client = 'external';
    const forgedBody = Buffer.from(JSON.stringify(parsed)).toString('base64url');
    assert.strictEqual(verifyOauthState(`${forgedBody}.${sig}`), null);
  });
});

test('buildGmailConnectUrl rejects an unknown purpose', () => {
  withEnv(BOTH, () => {
    assert.throws(() => buildGmailConnectUrl('exfiltrate', 'internal'), /Unknown Gmail connect purpose/);
  });
});

test('buildGmailConnectUrl surfaces a clear error when external is unconfigured', () => {
  withEnv({ ...NONE, ...INTERNAL }, () => {
    assert.throws(() => buildGmailConnectUrl('mailbox', 'external'), /Personal-mailbox sign-in is not configured/);
  });
});
