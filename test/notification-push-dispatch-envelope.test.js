const test = require('node:test');
const assert = require('node:assert/strict');

const dbClientPath = require.resolve('../db/client');
const pushPath = require.resolve('../integrations/push');
const dispatcherPath = require.resolve('../worker/agents/notification-push');

let queuedRows = [];
const updates = [];
const outboundMessages = [];

function notificationsQuery() {
  let operation = 'read';
  let updateValue = null;
  const query = {
    select() { return query; },
    eq() { return query; },
    order() { return query; },
    limit() { return query; },
    update(value) {
      operation = 'update';
      updateValue = value;
      return query;
    },
    then(resolve) {
      const result = operation === 'update'
        ? (updates.push(updateValue), { data: null, error: null })
        : { data: queuedRows, error: null };
      return Promise.resolve(result).then(resolve);
    },
  };
  return query;
}

require.cache[dbClientPath] = {
  id: dbClientPath,
  filename: dbClientPath,
  loaded: true,
  exports: {
    db: {
      from(table) {
        assert.equal(table, 'notifications');
        return notificationsQuery();
      },
    },
  },
};
require.cache[pushPath] = {
  id: pushPath,
  filename: pushPath,
  loaded: true,
  exports: {
    sendPushToTenant: async (tenantId, message) => {
      outboundMessages.push({ tenantId, message });
      return { sent: 1, failed: 0, deactivated: 0 };
    },
  },
};

delete require.cache[dispatcherPath];
const {
  buildQueuedPushData,
  QUEUED_PUSH_TYPES,
} = require('../worker/agents/notification-push');

test.beforeEach(() => {
  queuedRows = [];
  updates.length = 0;
  outboundMessages.length = 0;
});

test('queue mapper derives type from category, not metadata', () => {
  assert.deepEqual(
    buildQueuedPushData({
      category: 'content_plan_ready',
      entity_type: 'content_plan',
      entity_id: 'plan-from-row',
      metadata: {
        type: 'finance_alert',
        category: 'finance_alert',
        plan_id: 'plan-from-metadata',
      },
    }),
    {
      type: 'content_plan_ready',
      plan_id: 'plan-from-row',
    },
  );
});

test('queue mapper never forwards raw metadata, content, routes, or tenant claims', () => {
  const data = buildQueuedPushData({
    id: 'notification-1',
    category: 'conversation_escalation',
    entity_type: 'lead',
    entity_id: 'lead-from-row',
    title: 'Customer title must not enter route data',
    message: 'Customer content must not enter route data',
    metadata: {
      lead_id: 'lead-from-metadata',
      conversation_id: 'conversation-1',
      phone: '+14045550123',
      message: 'private customer content',
      body: 'private customer content',
      route: 'AdminSecrets',
      screen: 'ArbitraryScreen',
      deep_link: '/cross-tenant',
      recipient_tenant_id: 'bd2deab7-c870-4565-bf8d-93d6511f2d09',
      tenant_id: 'bd2deab7-c870-4565-bf8d-93d6511f2d09',
      nested: { secret: true },
    },
  });

  assert.deepEqual(data, {
    type: 'conversation_escalation',
    conversation_id: 'conversation-1',
    lead_id: 'lead-from-row',
  });
  for (const forbidden of [
    'phone',
    'message',
    'body',
    'route',
    'screen',
    'deep_link',
    'recipient_tenant_id',
    'tenant_id',
    'nested',
  ]) {
    assert.equal(Object.hasOwn(data, forbidden), false);
  }
});

test('entity_id maps only through the approved category and entity-type pair', () => {
  assert.deepEqual(
    buildQueuedPushData({
      category: 'lead_handoff',
      entity_type: 'lead',
      entity_id: 'lead-123',
      metadata: {},
    }),
    { type: 'lead_handoff', lead_id: 'lead-123' },
  );

  assert.deepEqual(
    buildQueuedPushData({
      category: 'lead_handoff',
      entity_type: 'invoice',
      entity_id: 'invoice-should-not-leak',
      metadata: {},
    }),
    { type: 'lead_handoff' },
  );
});

test('AI safety queue rows receive a safe notification record binding', () => {
  assert.deepEqual(
    buildQueuedPushData({
      id: 'notification-123',
      category: 'ai_safety_alert',
      entity_type: null,
      entity_id: null,
      metadata: {
        rule: 'untrusted-rule',
        sourceTenant: 'must-not-leak',
      },
    }),
    {
      type: 'ai_safety_alert',
      notification_id: 'notification-123',
    },
  );
});

test('collection and unknown categories contain no metadata-derived fields', () => {
  assert.deepEqual(
    buildQueuedPushData({
      category: 'usage_cap_reached',
      metadata: { used: 99, cap: 100, tenant_id: 'other' },
    }),
    { type: 'usage_cap_reached' },
  );
  assert.deepEqual(
    buildQueuedPushData({
      category: 'legacy_customer_message',
      entity_type: 'lead',
      entity_id: 'lead-123',
      metadata: { lead_id: 'lead-123', customer_name: 'private' },
    }),
    { type: 'legacy_customer_message' },
  );
});

test('queue registry matches the mobile-approved notification types', () => {
  assert.deepEqual(
    Object.keys(QUEUED_PUSH_TYPES).sort(),
    [
      'approval_queue',
      'content_plan_ready',
      'content_visual_failed',
      'conversation_escalation',
      'review_negative_sentiment',
      'inbound_sms',
      'missed_call',
      'incoming_call',
      'call_completed',
      'lead_handoff',
      'finance_alert',
      'ai_safety_alert',
      'email_identity_blocked',
      'usage_cap_reached',
      'targeted_campaign',
      'test',
    ].sort(),
  );
});

test('dispatcher sends unchanged title/body with only the sanitized routing envelope', async () => {
  queuedRows = [{
    id: 'notification-1',
    tenant_id: '30566ed6-026a-45e1-9502-029e6219df31',
    channel: 'push',
    status: 'pending',
    category: 'targeted_campaign',
    entity_type: 'targeted_campaign',
    entity_id: 'campaign-from-row',
    title: 'Existing campaign title',
    message: 'Existing campaign body',
    metadata: {
      campaign_id: 'campaign-from-metadata',
      customer_name: 'must not enter Expo data',
      deep_link: '/admin/targeted-campaigns/private',
      recipient_tenant_id: 'bd2deab7-c870-4565-bf8d-93d6511f2d09',
    },
  }];

  const result = await require('../worker/agents/notification-push')({
    id: '30566ed6-026a-45e1-9502-029e6219df31',
    slug: 'test-tenant',
  });

  assert.deepEqual(result, {
    success: true,
    sent: 1,
    failed: 0,
    errors: [],
  });
  assert.equal(outboundMessages.length, 1);
  assert.deepEqual(outboundMessages[0], {
    tenantId: '30566ed6-026a-45e1-9502-029e6219df31',
    message: {
      title: 'Existing campaign title',
      body: 'Existing campaign body',
      data: {
        type: 'targeted_campaign',
        campaign_id: 'campaign-from-row',
      },
    },
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, 'sent');
});
