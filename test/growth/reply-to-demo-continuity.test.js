'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const { FGA_TENANT_ID } = require('../../core/config');
const {
  replyGrowthEventInput,
  recordReplyGrowthEvent,
  chooseReplyEnrollment,
  indexReplyEnrollments,
} = require('../../core/drip-gmail');
const { summarizeOutcomeStages } = require('../../worker/agents/revenue-guardian');
const { markHumanHandoff } = require('../../core/sales/coordination');

const enrollment = { lead_id: 'lead-1' };
const message = {
  id: 'gmail-1',
  threadId: 'thread-1',
  internalDate: '2026-09-11T14:00:00.000Z',
  fromAddress: 'private@example.test',
  subject: 'private subject',
  bodyText: 'private message',
};

test('interested and question replies become warm canonical outcomes without message PII', () => {
  for (const intent of ['interested', 'question']) {
    const event = replyGrowthEventInput(enrollment, message, {
      classification: 'genuine_reply', intent, confidence: 0.97,
    });
    assert.equal(event.tenantId, FGA_TENANT_ID);
    assert.equal(event.eventType, 'human_reply_received');
    assert.equal(event.stage, 'warm');
    assert.equal(event.sourceId, 'gmail-1');
    assert.deepEqual(event.evidence, {
      classification: 'genuine_reply', intent, confidence: 0.97,
    });
    assert.doesNotMatch(JSON.stringify(event), /private@example|private subject|private message/);
  }
});

test('a genuine non-warm reply is still a human reply; automation is not', () => {
  const objection = replyGrowthEventInput(enrollment, message, {
    classification: 'genuine_reply', intent: 'objection', confidence: 0.9,
  });
  assert.equal(objection.stage, 'human_reply');
  assert.equal(replyGrowthEventInput(enrollment, message, {
    classification: 'auto_reply', intent: 'auto_reply', confidence: 1,
  }), null);
});

test('canonical reply evidence failure propagates so the Gmail receipt remains retryable', async () => {
  await assert.rejects(
    recordReplyGrowthEvent({}, enrollment, message, {
      classification: 'genuine_reply', intent: 'interested', confidence: 0.9,
    }, async () => { throw new Error('database unavailable'); }),
    /database unavailable/,
  );
});

test('reply routing always chooses the live enrollment over stopped history', () => {
  const active = {
    id: 'current', status: 'active', updated_at: '2026-09-11T14:00:00Z',
    metadata: { email: 'prospect@example.test' },
  };
  const stopped = {
    id: 'history', status: 'stopped', updated_at: '2026-09-11T15:00:00Z',
    metadata: { email: 'Prospect@Example.Test' },
  };
  assert.equal(chooseReplyEnrollment(stopped, active).id, 'current');
  assert.equal(chooseReplyEnrollment(active, stopped).id, 'current');
  assert.equal(indexReplyEnrollments([active, stopped]).get('prospect@example.test').id, 'current');
  assert.equal(indexReplyEnrollments([stopped, active]).get('prospect@example.test').id, 'current');
});

test('reply routing chooses the freshest enrollment within the same lifecycle rank', () => {
  const oldActive = {
    id: 'old', status: 'active', updated_at: '2026-09-10T14:00:00Z',
    metadata: { email: 'prospect@example.test' },
  };
  const newActive = {
    id: 'new', status: 'active', updated_at: '2026-09-11T14:00:00Z',
    metadata: { email: 'prospect@example.test' },
  };
  assert.equal(indexReplyEnrollments([newActive, oldActive]).get('prospect@example.test').id, 'new');
});

test('FGA handoff cannot report success when its durable owner action was not written', async () => {
  const chain = (result) => {
    const query = {};
    for (const method of ['eq', 'is', 'gte', 'limit']) query[method] = () => query;
    query.then = (resolve) => resolve(result);
    return query;
  };
  const db = {
    from(table) {
      if (table === 'leads') {
        return { update: () => chain({ error: null }) };
      }
      if (table === 'attention_queue') {
        return {
          select: () => chain({ data: [], error: null }),
          insert: async () => ({ error: { message: 'attention store unavailable' } }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  await assert.rejects(
    markHumanHandoff(db, FGA_TENANT_ID, 'lead-1', {
      reason: 'drip_reply', action: 'sales_call',
      attentionType: 'sales_reply_interested',
    }),
    /owner_attention_insert_failed:attention store unavailable/,
  );
});

test('Revenue report counts warm prospects inside the broader human-reply cohort once', () => {
  const outcomes = summarizeOutcomeStages({
    delivered: new Set(['lead-1', 'lead-2', 'lead-3']),
    human_reply: new Set(['lead-1', 'lead-2']),
    warm: new Set(['lead-2', 'lead-3']),
  });
  assert.equal(outcomes.delivered, 3);
  assert.equal(outcomes.human_reply, 3);
  assert.equal(outcomes.warm_reply, 2);
});
