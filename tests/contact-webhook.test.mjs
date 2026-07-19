import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Webhook } from 'svix';
import { handleWebhookEvent } from '../server/contact-webhook.mjs';
import { initStore, shouldUpdateStatus } from '../server/contact-store.mjs';
import { createContactServer } from '../server/contact-service.mjs';

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_SECRET = 'whsec_dGVzdHNlY3JldA=='; // whsec_ + base64('testsecret')
const wh = new Webhook(TEST_SECRET);

// Returns svix headers with a valid signature. Uses current time by default so
// the 5-minute timestamp tolerance enforced by wh.verify() is always satisfied.
function makeSvixHeaders(body, id = 'msg_001', date = new Date()) {
  const ts = Math.floor(date.getTime() / 1000).toString();
  const sig = wh.sign(id, date, body); // 'v1,{base64}'
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig };
}

async function tmpStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dr-wh-'));
  const store = await initStore(dir);
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// Resend webhook event body. created_at lives at the top level (not inside data).
function resendEvent(eventType, resendId = 'resend_test_id', extraData = {}) {
  return JSON.stringify({
    type: eventType,
    created_at: new Date().toISOString(),
    data: { email_id: resendId, ...extraData },
  });
}

function makeSub(ref, resendId, overrides = {}) {
  return {
    ref,
    submittedAt: '2026-07-19T00:00:00.000Z',
    contentHash: `ch_${ref}`,
    dupExpiresAt: Date.now() + 1e9,
    email: `${ref.toLowerCase()}@example.com`,
    emailDisplay: `${ref}@Example.com`,
    notificationStatus: 'sent',
    ackStatus: 'pending',
    ackResendId: resendId,
    ackUpdatedAt: null,
    events: [],
    ...overrides,
  };
}

// ─── Signature verification ───────────────────────────────────────────────────

test('valid signature is accepted', async () => {
  const { store, cleanup } = await tmpStore();
  const body = resendEvent('email.delivered');
  const result = await handleWebhookEvent(store, () => {}, body, makeSvixHeaders(body), TEST_SECRET);
  assert.equal(result.status, 200);
  await cleanup();
});

test('invalid signature is rejected with 401', async () => {
  const { store, cleanup } = await tmpStore();
  const body = resendEvent('email.delivered');
  const ts = Math.floor(Date.now() / 1000).toString();
  const headers = { 'svix-id': 'msg_x', 'svix-timestamp': ts, 'svix-signature': 'v1,invalidsig' };
  const result = await handleWebhookEvent(store, () => {}, body, headers, TEST_SECRET);
  assert.equal(result.status, 401);
  await cleanup();
});

test('tampered body is rejected with 401', async () => {
  const { store, cleanup } = await tmpStore();
  const body = resendEvent('email.delivered');
  const headers = makeSvixHeaders(body);
  const tampered = resendEvent('email.bounced');
  const result = await handleWebhookEvent(store, () => {}, tampered, headers, TEST_SECRET);
  assert.equal(result.status, 401);
  await cleanup();
});

test('expired timestamp (6 minutes old) is rejected with 401', async () => {
  const { store, cleanup } = await tmpStore();
  const body = resendEvent('email.delivered');
  const sixMinsAgo = new Date(Date.now() - 6 * 60 * 1000);
  const result = await handleWebhookEvent(store, () => {}, body, makeSvixHeaders(body, 'msg_old', sixMinsAgo), TEST_SECRET);
  assert.equal(result.status, 401);
  await cleanup();
});

test('future timestamp (6 minutes ahead) is rejected with 401', async () => {
  const { store, cleanup } = await tmpStore();
  const body = resendEvent('email.delivered');
  const sixMinsFuture = new Date(Date.now() + 6 * 60 * 1000);
  const result = await handleWebhookEvent(store, () => {}, body, makeSvixHeaders(body, 'msg_future', sixMinsFuture), TEST_SECRET);
  assert.equal(result.status, 401);
  await cleanup();
});

test('multiple signatures - one invalid + one valid is accepted', async () => {
  const { store, cleanup } = await tmpStore();
  const body = resendEvent('email.delivered');
  const validHeaders = makeSvixHeaders(body, 'msg_multi');
  const combined = `v1,invalidsig ${validHeaders['svix-signature']}`;
  const result = await handleWebhookEvent(store, () => {}, body, { ...validHeaders, 'svix-signature': combined }, TEST_SECRET);
  assert.equal(result.status, 200);
  await cleanup();
});

test('missing webhook secret returns 401', async () => {
  const { store, cleanup } = await tmpStore();
  const body = resendEvent('email.delivered');
  const result = await handleWebhookEvent(store, () => {}, body, makeSvixHeaders(body), '');
  assert.equal(result.status, 401);
  await cleanup();
});

// ─── Status tracking ──────────────────────────────────────────────────────────

test('email.delivered updates ack status to delivered', async () => {
  const { store, cleanup } = await tmpStore();
  await store.save(makeSub('DR-20260719-TEST01', 'resend_test_id'));
  const body = resendEvent('email.delivered', 'resend_test_id');
  const logs = [];
  const result = await handleWebhookEvent(store, (e) => logs.push(e), body, makeSvixHeaders(body), TEST_SECRET);
  assert.equal(result.status, 200);
  assert.ok(logs.some((e) => e.category === 'webhook_event_recorded'));
  await cleanup();
});

test('email.bounced marks email as suppressed', async () => {
  const { store, cleanup } = await tmpStore();
  const sub = makeSub('DR-20260719-TEST02', 'resend_bounce_id');
  sub.email = 'bounce@example.com';
  await store.save(sub);
  const body = resendEvent('email.bounced', 'resend_bounce_id');
  const result = await handleWebhookEvent(store, () => {}, body, makeSvixHeaders(body), TEST_SECRET);
  assert.equal(result.status, 200);
  assert.ok(store.isSuppressedEmail('bounce@example.com'));
  await cleanup();
});

test('delivery_delayed, failed, suppressed, complained events are handled', async () => {
  const events = [
    ['email.delivery_delayed', 'delivery_delayed'],
    ['email.failed', 'failed'],
    ['email.suppressed', 'suppressed'],
    ['email.complained', 'complained'],
  ];

  for (const [eventType, expectedStatus] of events) {
    const { store, cleanup } = await tmpStore();
    const resendId = `resend_${expectedStatus}`;
    await store.save(makeSub(`DR-20260719-${expectedStatus.toUpperCase().slice(0, 6)}`, resendId));
    const body = resendEvent(eventType, resendId);
    const result = await handleWebhookEvent(store, () => {}, body, makeSvixHeaders(body, `msg_${expectedStatus}`), TEST_SECRET);
    assert.equal(result.status, 200, `${eventType} should return 200`);
    await cleanup();
  }
});

test('invalid webhook signature does not mutate state', async () => {
  const { store, cleanup } = await tmpStore();
  await store.save(makeSub('DR-20260719-NOSIGN', 'resend_nosign'));
  const body = resendEvent('email.delivered', 'resend_nosign');
  const validHeaders = makeSvixHeaders(body);
  const result = await handleWebhookEvent(store, () => {}, body, { ...validHeaders, 'svix-signature': 'v1,invalidsig' }, TEST_SECRET);
  assert.equal(result.status, 401);
  assert.equal(store.findRefByResendId('resend_nosign'), 'DR-20260719-NOSIGN');
  await cleanup();
});

test('unsupported Resend event type is acknowledged silently', async () => {
  const { store, cleanup } = await tmpStore();
  const body = JSON.stringify({ type: 'email.opened', created_at: new Date().toISOString(), data: { email_id: 'id1' } });
  const result = await handleWebhookEvent(store, () => {}, body, makeSvixHeaders(body), TEST_SECRET);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  await cleanup();
});

test('unknown Resend email ID is handled without crashing', async () => {
  const logs = [];
  const { store, cleanup } = await tmpStore();
  const body = resendEvent('email.delivered', 'unknown_resend_id');
  const result = await handleWebhookEvent(store, (e) => logs.push(e), body, makeSvixHeaders(body), TEST_SECRET);
  assert.equal(result.status, 200);
  assert.ok(logs.some((e) => e.category === 'webhook_unknown_resend_id'));
  await cleanup();
});

// ─── svix-id idempotency ──────────────────────────────────────────────────────

test('replaying the same svix-id is idempotent', async () => {
  const logs = [];
  const { store, cleanup } = await tmpStore();
  await store.save(makeSub('DR-20260719-IDEMP1', 'resend_idemp'));
  const body = resendEvent('email.delivered', 'resend_idemp');
  const headers = makeSvixHeaders(body, 'msg_idemp_unique');
  const r1 = await handleWebhookEvent(store, (e) => logs.push(e), body, headers, TEST_SECRET);
  const r2 = await handleWebhookEvent(store, (e) => logs.push(e), body, headers, TEST_SECRET);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200, 'replay returns 200');
  assert.equal(logs.filter((e) => e.category === 'webhook_event_recorded').length, 1, 'event recorded exactly once');
  await cleanup();
});

test('two distinct svix-ids for same submission are each recorded', async () => {
  const logs = [];
  const { store, cleanup } = await tmpStore();
  await store.save(makeSub('DR-20260719-TWOID', 'resend_two'));
  const body1 = resendEvent('email.delivery_delayed', 'resend_two');
  const body2 = resendEvent('email.delivered', 'resend_two');
  await handleWebhookEvent(store, (e) => logs.push(e), body1, makeSvixHeaders(body1, 'msg_two_a'), TEST_SECRET);
  await handleWebhookEvent(store, (e) => logs.push(e), body2, makeSvixHeaders(body2, 'msg_two_b'), TEST_SECRET);
  assert.equal(logs.filter((e) => e.category === 'webhook_event_recorded').length, 2, 'both events recorded');
  await cleanup();
});

// ─── shouldUpdateStatus unit tests ───────────────────────────────────────────

test('shouldUpdateStatus: delivery_delayed → delivered upgrades', () => {
  assert.equal(shouldUpdateStatus('delivery_delayed', '2026-07-19T10:00:00Z', 'delivered', '2026-07-19T10:01:00Z'), true);
});

test('shouldUpdateStatus: late delivery_delayed does not downgrade delivered', () => {
  assert.equal(shouldUpdateStatus('delivered', '2026-07-19T10:02:00Z', 'delivery_delayed', '2026-07-19T10:00:00Z'), false);
});

test('shouldUpdateStatus: newer bounced (10:01) overwrites earlier delivered (10:00)', () => {
  // bounced arrives after delivered — timestamp ordering allows it, priority (3 ≥ 2) allows it
  assert.equal(shouldUpdateStatus('delivered', '2026-07-19T10:00:00Z', 'bounced', '2026-07-19T10:01:00Z'), true);
});

test('shouldUpdateStatus: older bounced (10:01) does not overwrite newer delivered (10:05)', () => {
  // bounced is older than the recorded delivered — timestamp ordering rejects regardless of priority
  assert.equal(shouldUpdateStatus('delivered', '2026-07-19T10:05:00Z', 'bounced', '2026-07-19T10:01:00Z'), false);
});

test('shouldUpdateStatus: older delivered (10:01) does not overwrite newer bounced (10:05)', () => {
  // delivered is older than recorded bounced — timestamp ordering rejects it
  assert.equal(shouldUpdateStatus('bounced', '2026-07-19T10:05:00Z', 'delivered', '2026-07-19T10:01:00Z'), false);
});

test('shouldUpdateStatus: delivered is overwritten by complained', () => {
  assert.equal(shouldUpdateStatus('delivered', '2026-07-19T10:00:00Z', 'complained', '2026-07-19T10:01:00Z'), true);
});

test('shouldUpdateStatus: complained is never overwritten', () => {
  for (const status of ['delivered', 'bounced', 'failed', 'delivery_delayed', 'pending']) {
    assert.equal(shouldUpdateStatus('complained', '2026-07-19T10:01:00Z', status, '2026-07-19T10:02:00Z'), false, `${status} must not overwrite complained`);
  }
});

test('shouldUpdateStatus: same-priority same-timestamp uses priority as tie-breaker (strict)', () => {
  const ts = '2026-07-19T10:01:00Z';
  // Same timestamp, same priority → no update
  assert.equal(shouldUpdateStatus('delivery_delayed', ts, 'delivery_delayed', ts), false);
  // Same timestamp, higher-priority incoming → update
  assert.equal(shouldUpdateStatus('delivery_delayed', ts, 'delivered', ts), true);
  // Same timestamp, lower-priority incoming → no update
  assert.equal(shouldUpdateStatus('delivered', ts, 'delivery_delayed', ts), false);
});

// ── Four canonical ordering scenarios (from PR review) ──────────────────────

test('ordering: current delivered at 10:05, incoming bounced at 10:01 → remains delivered', () => {
  // Bounced is older: timestamp ordering rejects even though bounced has higher priority.
  assert.equal(shouldUpdateStatus('delivered', '2026-07-19T10:05:00Z', 'bounced', '2026-07-19T10:01:00Z'), false);
});

test('ordering: current bounced at 10:05, incoming delivered at 10:01 → remains bounced', () => {
  assert.equal(shouldUpdateStatus('bounced', '2026-07-19T10:05:00Z', 'delivered', '2026-07-19T10:01:00Z'), false);
});

test('ordering: current delivered at 10:01, incoming bounced at 10:05 → becomes bounced', () => {
  assert.equal(shouldUpdateStatus('delivered', '2026-07-19T10:01:00Z', 'bounced', '2026-07-19T10:05:00Z'), true);
});

test('ordering: current complained, any incoming event at later timestamp → remains complained', () => {
  for (const status of ['delivered', 'bounced', 'failed', 'delivery_delayed', 'pending', 'suppressed']) {
    assert.equal(shouldUpdateStatus('complained', '2026-07-19T10:01:00Z', status, '2026-07-19T10:05:00Z'), false);
  }
});

// ─── Tag-based correlation ────────────────────────────────────────────────────

test('tag-based correlation attaches resend ID when webhook arrives before updateAckResendId', async () => {
  const { store, cleanup } = await tmpStore();
  const ref = 'DR-20260719-TAG01';
  const resendId = 'resend_tag_1';
  // Save submission without ackResendId — simulates webhook arriving before updateAckResendId()
  await store.save(makeSub(ref, null, { ackResendId: null }));
  const body = JSON.stringify({
    type: 'email.delivered',
    created_at: new Date().toISOString(),
    data: {
      email_id: resendId,
      tags: [
        { name: 'category', value: 'contact_ack' },
        { name: 'submission_ref', value: ref },
      ],
    },
  });
  const logs = [];
  const result = await handleWebhookEvent(store, (e) => logs.push(e), body, makeSvixHeaders(body, 'msg_tag_1'), TEST_SECRET);
  assert.equal(result.status, 200);
  assert.ok(logs.some((e) => e.category === 'webhook_event_recorded'));
  assert.equal(store.findRefByResendId(resendId), ref, 'resend ID now in index after tag-based attachment');
  await cleanup();
});

// ─── Concurrency ──────────────────────────────────────────────────────────────

test('concurrent events for the same submission are serialized safely', async () => {
  const { store, cleanup } = await tmpStore();
  const resendId = 'resend_conc';
  await store.save(makeSub('DR-20260719-CONC01', resendId));
  const now = new Date().toISOString();

  const [r1, r2] = await Promise.all([
    store.updateAckStatus(resendId, 'delivery_delayed', now, 'svix_conc_1'),
    store.updateAckStatus(resendId, 'delivered', now, 'svix_conc_2'),
  ]);

  assert.equal(r1, 'DR-20260719-CONC01', 'first event processed');
  assert.equal(r2, 'DR-20260719-CONC01', 'second event processed');
  // Idempotency check confirms both events were persisted
  const r3 = await store.updateAckStatus(resendId, 'delivered', now, 'svix_conc_2');
  assert.equal(r3, false, 'second svix-id is idempotent (already recorded)');
  await cleanup();
});

// ─── Webhook endpoint integration ─────────────────────────────────────────────

test('webhook endpoint rejects invalid signature via HTTP', async () => {
  const { store, cleanup } = await tmpStore();
  const cfg = {
    apiKey: 'test_key', from: 'f@e.com', to: 'd@e.com',
    host: '127.0.0.1', port: 0, allowedOrigins: [], dataDir: '',
    minSubmitMs: 0, ipRateLimit: 0, emailAckLimit: 2,
    duplicateWindowMs: 86400000, ackEnabled: false,
    webhookSecret: TEST_SECRET, globalBurstLimit: 0,
  };
  const server = createContactServer({ config: cfg, store, log: () => {}, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port, address } = server.address();
  const body = resendEvent('email.delivered', 'any_id');
  const ts = Math.floor(Date.now() / 1000).toString();
  const res = await fetch(`http://${address}:${port}/api/resend/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'svix-id': 'x', 'svix-timestamp': ts, 'svix-signature': 'v1,badsig' },
    body,
  });
  assert.equal(res.status, 401);
  await new Promise((r) => server.close(r));
  await cleanup();
});

test('webhook endpoint accepts valid signature via HTTP', async () => {
  const { store, cleanup } = await tmpStore();
  const cfg = {
    apiKey: 'test_key', from: 'f@e.com', to: 'd@e.com',
    host: '127.0.0.1', port: 0, allowedOrigins: [], dataDir: '',
    minSubmitMs: 0, ipRateLimit: 0, emailAckLimit: 2,
    duplicateWindowMs: 86400000, ackEnabled: false,
    webhookSecret: TEST_SECRET, globalBurstLimit: 0,
  };
  const server = createContactServer({ config: cfg, store, log: () => {}, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port, address } = server.address();
  const body = resendEvent('email.delivered', 'any_valid_id');
  const headers = makeSvixHeaders(body, 'msg_http_valid');
  const res = await fetch(`http://${address}:${port}/api/resend/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  assert.equal(res.status, 200);
  await new Promise((r) => server.close(r));
  await cleanup();
});

test('webhook endpoint returns 405 for non-POST', async () => {
  const { store, cleanup } = await tmpStore();
  const cfg = {
    apiKey: 'k', from: 'f', to: 't', host: '127.0.0.1', port: 0,
    allowedOrigins: [], dataDir: '', minSubmitMs: 0, ipRateLimit: 0,
    emailAckLimit: 2, duplicateWindowMs: 86400000, ackEnabled: false,
    webhookSecret: TEST_SECRET, globalBurstLimit: 0,
  };
  const server = createContactServer({ config: cfg, store, log: () => {}, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port, address } = server.address();
  const res = await fetch(`http://${address}:${port}/api/resend/webhook`, { method: 'GET' });
  assert.equal(res.status, 405);
  await new Promise((r) => server.close(r));
  await cleanup();
});

test('webhook endpoint returns 503 when secret not configured', async () => {
  const { store, cleanup } = await tmpStore();
  const cfg = {
    apiKey: 'k', from: 'f', to: 't', host: '127.0.0.1', port: 0,
    allowedOrigins: [], dataDir: '', minSubmitMs: 0, ipRateLimit: 0,
    emailAckLimit: 2, duplicateWindowMs: 86400000, ackEnabled: false,
    webhookSecret: '', globalBurstLimit: 0,
  };
  const server = createContactServer({ config: cfg, store, log: () => {}, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port, address } = server.address();
  const body = resendEvent('email.delivered');
  const headers = makeSvixHeaders(body);
  const res = await fetch(`http://${address}:${port}/api/resend/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  assert.equal(res.status, 503);
  await new Promise((r) => server.close(r));
  await cleanup();
});
