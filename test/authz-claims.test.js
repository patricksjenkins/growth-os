'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTenantClaim, resolveRoleClaim } = require('../core/authz/claims');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

test('authoritative app tenant wins during shadow compatibility', () => {
  const claim = resolveTenantClaim({
    app_metadata: { tenant_id: A },
    user_metadata: { tenant_id: B },
  });

  assert.equal(claim.tenantId, A);
  assert.equal(claim.source, 'app_metadata');
  assert.equal(claim.conflict, true);
});

test('strict enforcement rejects an app/user tenant conflict', () => {
  const claim = resolveTenantClaim({
    app_metadata: { tenant_id: A },
    user_metadata: { tenant_id: B },
  }, { enforce: true });

  assert.equal(claim.allowed, false);
  assert.equal(claim.tenantId, null);
  assert.equal(claim.reason, 'tenant_claim_conflict');
});

test('legacy tenant fallback remains available only before enforcement', () => {
  const user = { app_metadata: {}, user_metadata: { tenant_id: B } };
  assert.equal(resolveTenantClaim(user).tenantId, B);
  assert.equal(resolveTenantClaim(user).legacyFallback, true);

  const strict = resolveTenantClaim(user, { enforce: true });
  assert.equal(strict.allowed, false);
  assert.equal(strict.tenantId, null);
});

test('strict role resolution never trusts editable user metadata', () => {
  const user = { app_metadata: {}, user_metadata: { role: 'owner' } };
  assert.equal(resolveRoleClaim(user).role, 'owner');
  assert.equal(resolveRoleClaim(user).legacyFallback, true);

  const strict = resolveRoleClaim(user, { enforce: true });
  assert.equal(strict.allowed, false);
  assert.equal(strict.role, null);
});
