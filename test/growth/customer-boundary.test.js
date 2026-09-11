'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FGA_TENANT_ID } = require('../../core/config');
const {
  businessDomain,
  createProtectedOrganizationIndex,
  matchProtectedOrganization,
} = require('../../core/growth/customer-boundary');

const index = createProtectedOrganizationIndex({
  customerRows: [{ name: 'Existing Client LLC', email: 'owner@existingclient.com' }],
  tenantRows: [
    { id: FGA_TENANT_ID, name: 'First Gen Automate', owner_email: 'owner@firstgenautomate.com' },
    { id: 'customer-tenant', name: 'Protected Plumbing LLC', slug: 'protected-plumbing', owner_email: 'pat@gmail.com', is_demo: false },
    { id: 'demo-tenant', name: 'Demo Company', owner_email: 'demo@demo.example', is_demo: true },
  ],
  tenantUserRows: [{ tenant_id: 'customer-tenant', email: 'staff@protectedplumbing.com' }],
  websiteRows: [{ tenant_id: 'customer-tenant', domain: 'protectedplumbing.com' }],
});

test('protected organization boundary covers FGA customers and customer-tenant identities', () => {
  assert.equal(matchProtectedOrganization(index, { email: 'owner@existingclient.com' }).protected, true);
  assert.equal(matchProtectedOrganization(index, { email: 'sales@existingclient.com' }).reason, 'protected_domain');
  assert.equal(matchProtectedOrganization(index, { email: 'staff@protectedplumbing.com' }).protected, true);
  assert.equal(matchProtectedOrganization(index, { email: 'new@protectedplumbing.com' }).reason, 'protected_domain');
  assert.equal(matchProtectedOrganization(index, { email: 'other@gmail.com', companyName: 'Protected Plumbing, LLC' }).reason, 'protected_company');
});

test('public mailbox domains do not turn every Gmail user into a protected identity', () => {
  assert.equal(businessDomain('pat@gmail.com'), null);
  assert.equal(matchProtectedOrganization(index, { email: 'unrelated@gmail.com', companyName: 'Fresh Prospect' }).protected, false);
});

test('demo tenants and FGA itself do not pollute the customer exclusion index', () => {
  assert.equal(matchProtectedOrganization(index, { email: 'demo@demo.example' }).protected, false);
  assert.equal(matchProtectedOrganization(index, { email: 'owner@firstgenautomate.com' }).protected, false);
});
