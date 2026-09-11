'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLAN_KEY } = require('../../core/growth/seven-touch-plan');
const { CREATIVE_VERSION } = require('../../core/growth/message-experiment');
const {
  classifyRefreshBinding,
  countBy,
} = require('../../scripts/refresh-fga-conversation-drafts');

const candidate = {
  batch_id: 'batch-1',
  authorized_at: '2026-09-11T00:00:00Z',
  first_touch_sent_at: null,
  first_touch_sequence_id: 'sequence-1',
};
const sequence = {
  id: 'sequence-1',
  sequence_status: 'draft',
  metadata: { restart_batch_id: 'batch-1', message_version: PLAN_KEY },
};
const completed = new Set(['batch-1']);

test('only unconsumed old draft or superseded restart bindings may be refreshed', () => {
  assert.equal(classifyRefreshBinding(candidate, sequence, completed), 'refresh');
  assert.equal(classifyRefreshBinding(candidate, { ...sequence, sequence_status: 'superseded' }, completed), 'refresh');
  assert.equal(classifyRefreshBinding({ ...candidate, first_touch_sent_at: 'sent' }, sequence, completed), 'not_unconsumed_authority');
  assert.equal(classifyRefreshBinding(candidate, { ...sequence, sequence_status: 'sent' }, completed), 'sequence_sent');
  assert.equal(classifyRefreshBinding(candidate, { ...sequence, metadata: { ...sequence.metadata, delivered: {} } }, completed), 'provider_evidence_present');
  assert.equal(classifyRefreshBinding(candidate, { ...sequence, metadata: { ...sequence.metadata, creative_version: CREATIVE_VERSION } }, completed), 'already_current');
  assert.equal(classifyRefreshBinding(candidate, {
    ...sequence,
    metadata: {
      ...sequence.metadata,
      creative_version: CREATIVE_VERSION,
      autosend_quality: { ok: false, problems: ['generic'] },
    },
  }, completed), 'quality_rejected');
  assert.equal(classifyRefreshBinding(candidate, sequence, new Set()), 'batch_not_completed');
});

test('an interrupted unbound refresh is resumable only with its durable receipt', () => {
  const unbound = { ...candidate, first_touch_sequence_id: null };
  assert.equal(classifyRefreshBinding(unbound, null, completed), 'unbound_without_refresh_receipt');
  assert.equal(classifyRefreshBinding({
    ...unbound,
    evidence: { draft_refresh: { state: 'pending', creative_version: CREATIVE_VERSION } },
  }, null, completed), 'resume_pending');
});

test('summary aggregation does not expose prospect identity', () => {
  assert.deepEqual(countBy([{ reason: 'refresh' }, { reason: 'refresh' }, { reason: 'already_current' }], 'reason'), {
    refresh: 2,
    already_current: 1,
  });
});

test('write path is exact-FGA, confirmation-gated, provider-free, and leaves sending paused', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/refresh-fga-conversation-drafts.js'), 'utf8');
  assert.match(source, /confirmation !== FGA_TENANT_ID/);
  assert.match(source, /\.eq\('tenant_id', FGA_TENANT_ID\)/);
  assert.match(source, /skip_send_handoff: true/);
  assert.match(source, /sending remains paused/i);
  assert.doesNotMatch(source, /sendEmail|sendSms|resend\.emails|telnyx/i);
});
