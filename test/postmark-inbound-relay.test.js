/**
 * The 923A inbound relay: big Postmark payloads must have their attachment
 * bytes moved to storage and replaced by a fetchable URL; small ones pass
 * through untouched; and the route must be mounted ahead of the 10mb global
 * JSON parser or it can never receive the payloads it exists for.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';
const { stagePayload, needsStaging, PASSTHROUGH_BYTES } = require('../api/webhooks/postmark-inbound-relay');

test('small bodies pass through; anything over the threshold (or unknown) is staged', () => {
  assert.equal(needsStaging(1024), false);
  assert.equal(needsStaging(PASSTHROUGH_BYTES), false);
  assert.equal(needsStaging(PASSTHROUGH_BYTES + 1), true);
  assert.equal(needsStaging(0), true);
  assert.equal(needsStaging(undefined), true);
});

test('stagePayload moves base64 content to storage and leaves a ContentUrl in its place', async () => {
  const bytes = Buffer.from('CNC-RENDER-BYTES');
  const payload = {
    MessageID: 'msg/1 2',
    From: 'sales52@erichgift.com',
    Attachments: [
      { Name: 'Q-0897 CNC.jpg', ContentType: 'image/jpeg', ContentLength: 99, Content: bytes.toString('base64'), ContentID: 'x@y' },
      { Name: 'names-only.pdf', ContentType: 'application/pdf', ContentLength: 5 },
    ],
  };
  const uploads = [];
  const { slim, staged } = await stagePayload(payload, {
    messageId: payload.MessageID,
    upload: async (p, buf, ct) => { uploads.push({ p, buf, ct }); },
    signedUrl: async (p) => `https://example.supabase.co/storage/v1/object/sign/project-proofs/${p}?token=t`,
  });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].p, 'inbound-relay/msg_1_2/0-Q-0897_CNC.jpg');
  assert.ok(uploads[0].buf.equals(bytes), 'exact bytes are staged');
  assert.equal(uploads[0].ct, 'image/jpeg');
  assert.deepEqual(staged, ['inbound-relay/msg_1_2/0-Q-0897_CNC.jpg']);
  const a = slim.Attachments[0];
  assert.equal(a.Content, undefined, 'base64 must not be forwarded');
  assert.equal(a.ContentLength, bytes.length);
  assert.equal(a.ContentID, 'x@y', 'inline marker survives (the webhook uses it)');
  assert.match(a.ContentUrl, /^https:\/\/example\.supabase\.co\/storage\/v1\//);
  assert.deepEqual(slim.Attachments[1], { Name: 'names-only.pdf', ContentType: 'application/pdf', ContentLength: 5 });
  assert.equal(slim.From, 'sales52@erichgift.com', 'everything else is forwarded as-is');
});

test('the relay is mounted before the global 10mb JSON parser', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'server.js'), 'utf8');
  const mount = src.indexOf("app.use('/webhooks/postmark-inbound-relay'");
  const globalJson = src.indexOf("app.use(express.json({ limit: '10mb'");
  assert.ok(mount > 0, 'relay route is mounted');
  assert.ok(globalJson > 0, 'global parser still present');
  assert.ok(mount < globalJson, 'relay must be mounted BEFORE the global parser');
});
