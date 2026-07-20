import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildResendPayload, buildAckPayload, createContactServer, escapeHtml, validateEnv, validateSubmission } from '../server/contact-service.mjs';
import { initStore, createNullStore, generateRef, hashContent } from '../server/contact-store.mjs';

// Default test config disables origin checks, timing, ack emails, and global burst.
const config = {
  apiKey: 'test_key',
  turnstileSecretKey: 'test_secret',
  from: 'Test <forms@example.com>',
  to: 'dest@example.com',
  host: '127.0.0.1',
  port: 0,
  allowedOrigins: [],
  dataDir: '',
  minSubmitMs: 0,
  ipRateLimit: 3,
  emailAckLimit: 2,
  duplicateWindowMs: 24 * 60 * 60 * 1000,
  ackEnabled: false,
  webhookSecret: '',
  globalBurstLimit: 0,
};

const valid = {
  name: 'Ada Lovelace',
  email: 'Ada@Example.com',
  subject: 'Research collaboration',
  message: 'I would like to discuss a potential research collaboration.',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function okSiteverify(hostname = 'localhost') { return { ok: true, json: async () => ({ success: true, hostname }) }; }
function okResend() { return { ok: true, json: async () => ({}) }; }

async function fixture(opts = {}) {
  const store = opts.store ?? createNullStore();
  const server = createContactServer({
    config: { ...config, ...opts.config },
    fetchImpl: opts.rawFetchImpl || (async (url, init) => url.includes('siteverify') ? (opts.siteverifyImpl ? opts.siteverifyImpl(url, init) : okSiteverify()) : (opts.fetchImpl ? opts.fetchImpl(url, init) : okResend())),
    log: opts.log || (() => {}),
    store,
    trustedProxies: opts.trustedProxies ?? new Set(['127.0.0.1', '::1']),
    now: opts.now,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port, address } = server.address();
  return { base: `http://${address}:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function post(base, payload, headers = {}) {
  const bodyPayload = Object.hasOwn(payload, 'cf-turnstile-response') ? payload : { ...payload, 'cf-turnstile-response': 'test-token' };
  const res = await fetch(`${base}/api/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10', ...headers },
    body: JSON.stringify(bodyPayload),
  });
  return { status: res.status, body: await res.json() };
}

async function tmpStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dr-test-'));
  const store = await initStore(dir);
  return { store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ─── Environment ────────────────────────────────────────────────────────────

test('required environment validation', () => {
  assert.throws(() => validateEnv({}), /DANIEL_RESEND_API_KEY/);
  assert.throws(
    () => validateEnv({ DANIEL_RESEND_API_KEY: 'k', DANIEL_CONTACT_FROM: 'f', DANIEL_CONTACT_TO: 't' }),
    /TURNSTILE_SECRET_KEY/,
  );
  // ackEnabled=false — no requirement for data dir or webhook secret
  assert.equal(
    validateEnv({ DANIEL_RESEND_API_KEY: 'k', DANIEL_CONTACT_FROM: 'f', DANIEL_CONTACT_TO: 't', TURNSTILE_SECRET_KEY: 'ts', DANIEL_ACK_ENABLED: 'false' }).host,
    '127.0.0.1',
  );
  assert.equal(
    validateEnv({ DANIEL_RESEND_API_KEY: 'k', DANIEL_CONTACT_FROM: 'f', DANIEL_CONTACT_TO: 't', TURNSTILE_SECRET_KEY: 'ts', DANIEL_ACK_ENABLED: 'false' }).port,
    8788,
  );
  assert.deepEqual(
    validateEnv({ DANIEL_RESEND_API_KEY: 'k', DANIEL_CONTACT_FROM: 'f', DANIEL_CONTACT_TO: 't', TURNSTILE_SECRET_KEY: 'ts', DANIEL_ACK_ENABLED: 'false' }).allowedOrigins,
    ['https://daniel.rochatka.com', 'https://www.daniel.rochatka.com'],
  );
  assert.equal(
    validateEnv({ DANIEL_RESEND_API_KEY: 'k', DANIEL_CONTACT_FROM: 'f', DANIEL_CONTACT_TO: 't', TURNSTILE_SECRET_KEY: 'ts', DANIEL_ACK_ENABLED: 'false' }).ackEnabled,
    false,
  );
  // ackEnabled=true with required vars present — succeeds
  assert.equal(
    validateEnv({
      DANIEL_RESEND_API_KEY: 'k', DANIEL_CONTACT_FROM: 'f', DANIEL_CONTACT_TO: 't', TURNSTILE_SECRET_KEY: 'ts',
      DANIEL_CONTACT_DATA_DIR: '/tmp/dr', DANIEL_RESEND_WEBHOOK_SECRET: 'whsec_test', DANIEL_ACK_ENABLED: 'true',
    }).ackEnabled,
    true,
  );
});


// ─── Turnstile verification ──────────────────────────────────────────────────

test('missing Turnstile token sends no email', async () => {
  const calls = [];
  const { base, close } = await fixture({ rawFetchImpl: async (url, init) => { calls.push({ url, init }); return url.includes('siteverify') ? okSiteverify() : okResend(); } });
  const res = await post(base, { ...valid, 'cf-turnstile-response': undefined });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
  await close();
});

test('empty Turnstile token sends no email', async () => {
  const calls = [];
  const { base, close } = await fixture({ rawFetchImpl: async (url, init) => { calls.push({ url, init }); return url.includes('siteverify') ? okSiteverify() : okResend(); } });
  const res = await post(base, { ...valid, 'cf-turnstile-response': '   ' });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
  await close();
});

for (const [label, response] of [
  ['failed Siteverify response', { ok: true, json: async () => ({ success: false, hostname: 'localhost' }) }],
  ['expired-token response', { ok: true, json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'], hostname: 'localhost' }) }],
  ['duplicate-token response', { ok: true, json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'], hostname: 'localhost' }) }],
  ['hostname mismatch', { ok: true, json: async () => ({ success: true, hostname: 'evil.example.com' }) }],
  ['malformed Siteverify response', { ok: true, json: async () => { throw new Error('bad json'); } }],
]) {
  test(`${label} sends no email`, async () => {
    const calls = [];
    const { base, close } = await fixture({
      config: { allowedOrigins: ['https://daniel.rochatka.com'] },
      rawFetchImpl: async (url, init) => { calls.push({ url, init }); return url.includes('siteverify') ? response : okResend(); },
    });
    const res = await post(base, valid, { Origin: 'https://daniel.rochatka.com' });
    assert.equal(res.status, 400);
    assert.equal(calls.filter((c) => c.url.includes('siteverify')).length, 1);
    assert.equal(calls.filter((c) => c.url.includes('api.resend.com')).length, 0);
    await close();
  });
}

test('Siteverify network failure sends no email', async () => {
  const calls = [];
  const { base, close } = await fixture({ rawFetchImpl: async (url, init) => { calls.push({ url, init }); if (url.includes('siteverify')) throw new Error('network'); return okResend(); } });
  const res = await post(base, valid);
  assert.equal(res.status, 400);
  assert.equal(calls.filter((c) => c.url.includes('api.resend.com')).length, 0);
  await close();
});

test('Siteverify timeout sends no email', async () => {
  const calls = [];
  const { base, close } = await fixture({ rawFetchImpl: async (url, init) => { calls.push({ url, init }); if (url.includes('siteverify')) throw new DOMException('aborted', 'AbortError'); return okResend(); } });
  const res = await post(base, valid);
  assert.equal(res.status, 400);
  assert.equal(calls.filter((c) => c.url.includes('api.resend.com')).length, 0);
  await close();
});

test('successful Siteverify validation sends exactly one internal notification in order', async () => {
  const calls = [];
  const { base, close } = await fixture({ rawFetchImpl: async (url, init) => { calls.push({ url, body: init.body }); return url.includes('siteverify') ? okSiteverify('localhost') : okResend(); } });
  const res = await post(base, valid);
  assert.equal(res.status, 200);
  assert.deepEqual(calls.map((c) => c.url), ['https://challenges.cloudflare.com/turnstile/v0/siteverify', 'https://api.resend.com/emails']);
  assert.equal(calls.filter((c) => c.url.includes('api.resend.com')).length, 1);
  await close();
});

test('Turnstile token is absent from Resend payload and stored submission data; no visitor email is sent', async () => {
  const calls = [];
  const saved = [];
  const store = { ...createNullStore(), save: async (sub) => { saved.push(sub); } };
  const { base, close } = await fixture({ store, rawFetchImpl: async (url, init) => { calls.push({ url, body: init.body && String(init.body) }); return url.includes('siteverify') ? okSiteverify() : okResend(); } });
  const res = await post(base, valid);
  assert.equal(res.status, 200);
  const resendPayload = JSON.parse(calls.find((c) => c.url.includes('api.resend.com')).body);
  assert.doesNotMatch(JSON.stringify(resendPayload), /test-token|cf-turnstile-response|turnstile/i);
  assert.doesNotMatch(JSON.stringify(saved[0]), /test-token|cf-turnstile-response|turnstile/i);
  assert.deepEqual(resendPayload.to, ['dest@example.com']);
  assert.notEqual(resendPayload.to[0], valid.email);
  assert.equal(calls.filter((c) => c.url.includes('api.resend.com')).length, 1);
  await close();
});


test('storage failure after successful internal notification still returns success without duplicate delivery', async () => {
  const calls = [];
  const logs = [];
  const store = { ...createNullStore(), save: async () => { throw new Error('sensitive storage path /tmp/private'); } };
  const { base, close } = await fixture({
    store,
    log: (entry) => logs.push(entry),
    rawFetchImpl: async (url, init) => {
      calls.push({ url, body: init.body && String(init.body) });
      return url.includes('siteverify') ? okSiteverify() : okResend();
    },
  });
  const res = await post(base, valid);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, message: 'Thank you. Your message has been sent.' });
  assert.equal(calls.filter((c) => c.url.includes('siteverify')).length, 1);
  const resendCalls = calls.filter((c) => c.url.includes('api.resend.com'));
  assert.equal(resendCalls.length, 1);
  const resendPayload = JSON.parse(resendCalls[0].body);
  assert.deepEqual(resendPayload.to, ['dest@example.com']);
  assert.notEqual(resendPayload.to[0], valid.email);
  const persistenceLog = logs.find((entry) => entry.category === 'contact_persistence_failure');
  assert.ok(persistenceLog, 'safe persistence failure log is present');
  assert.deepEqual(Object.keys(persistenceLog).sort(), ['category', 'ref', 'requestId', 'timestamp'].sort());
  assert.doesNotMatch(JSON.stringify(persistenceLog), /sensitive|private|Ada|Example|collaboration/i);
  await close();
});


test('legacy acknowledgement mode saves ack metadata and sends visitor acknowledgement after internal notification', async () => {
  const calls = [];
  const { store, cleanup } = await tmpStore();
  const { base, close } = await fixture({
    store,
    config: { ackEnabled: true },
    rawFetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body && String(init.body) });
      return url.includes('siteverify') ? okSiteverify() : { ok: true, json: async () => ({ id: `re_${calls.length}` }) };
    },
  });
  const res = await post(base, valid);
  assert.equal(res.status, 200);
  assert.deepEqual(calls.map((c) => c.url), [
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    'https://api.resend.com/emails',
    'https://api.resend.com/emails',
  ]);
  const resendPayloads = calls.filter((c) => c.url.includes('api.resend.com')).map((c) => ({ ...c, body: JSON.parse(c.body) }));
  assert.deepEqual(resendPayloads[0].body.to, ['dest@example.com']);
  assert.deepEqual(resendPayloads[1].body.to, ['Ada@Example.com']);
  assert.match(resendPayloads[1].headers['Idempotency-Key'], /^contact-ack-DR-/);
  const refTag = resendPayloads[1].body.tags.find((tag) => tag.name === 'submission_ref');
  assert.equal(store.findRefByResendId('re_3'), refTag.value);
  await close();
  await cleanup();
});

test('buildAckPayload contains ref, correlation tags, and no full message', () => {
  const data = { ...valid, email: 'ada@example.com', emailDisplay: 'Ada@Example.com' };
  const payload = buildAckPayload(config, data, 'DR-20260719-ABC123');
  assert.equal(payload.to[0], 'Ada@Example.com');
  assert.match(payload.text, /DR-20260719-ABC123/);
  assert.doesNotMatch(payload.text, new RegExp(valid.message));
  const catTag = payload.tags?.find((t) => t.name === 'category');
  const refTag = payload.tags?.find((t) => t.name === 'submission_ref');
  assert.equal(catTag?.value, 'contact_ack');
  assert.equal(refTag?.value, 'DR-20260719-ABC123');
});

// ─── Honeypot ────────────────────────────────────────────────────────────────

test('filled honeypot returns apparent success and sends no email', async () => {
  let sent = 0;
  const logs = [];
  const { base, close } = await fixture({
    fetchImpl: async () => { sent += 1; return { ok: true, json: async () => ({}) }; },
    log: (e) => logs.push(e),
  });
  const res = await post(base, { ...valid, website: 'bot.example' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(sent, 0);
  assert.ok(logs.some((e) => e.category === 'honeypot_blocked'));
  await close();
});

// ─── Submission timing ────────────────────────────────────────────────────────

test('submission under 2 seconds returns apparent success with no email', async () => {
  let sent = 0;
  const logs = [];
  const fixedNow = 1_000_000_000_000;
  const { base, close } = await fixture({
    config: { minSubmitMs: 2000 },
    now: () => fixedNow,
    fetchImpl: async () => { sent += 1; return { ok: true, json: async () => ({}) }; },
    log: (e) => logs.push(e),
  });
  const res = await post(base, { ...valid, _formStart: fixedNow - 500 });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(sent, 0);
  assert.ok(logs.some((e) => e.category === 'timing_blocked'));
  await close();
});

test('invalid and future timestamps are blocked', async () => {
  const fixedNow = 1_000_000_000_000;
  let sent = 0;
  const { base, close } = await fixture({
    config: { minSubmitMs: 2000 },
    now: () => fixedNow,
    fetchImpl: async () => { sent += 1; return { ok: true, json: async () => ({}) }; },
    log: () => {},
  });
  // Each case must return apparent success and must not trigger an email send.
  const cases = [
    { label: 'zero integer',     value: 0 },
    { label: 'zero string',      value: '0' },
    { label: 'empty string',     value: '' },
    { label: 'whitespace',       value: '   ' },
    { label: 'null',             value: null },
    { label: 'false',            value: false },
    { label: 'non-numeric',      value: 'notanumber' },
    { label: 'future timestamp', value: fixedNow + 9999 },
  ];
  for (const { label, value } of cases) {
    const before = sent;
    const res = await post(base, { ...valid, _formStart: value });
    assert.equal(res.status, 200, `${label}: should return apparent success`);
    assert.equal(res.body.ok, true, `${label}: body.ok should be true`);
    assert.equal(sent, before, `${label}: must not send an email`);
  }
  await close();
});

test('form left open for several hours can still be submitted', async () => {
  const fixedNow = 1_000_000_000_000;
  let sent = 0;
  const { base, close } = await fixture({
    config: { minSubmitMs: 2000 },
    now: () => fixedNow,
    fetchImpl: async () => { sent += 1; return { ok: true, json: async () => ({}) }; },
  });
  // 3-hour-old _formStart: elapsed is large but proves the form was not submitted too quickly
  const res = await post(base, { ...valid, _formStart: fixedNow - 3 * 60 * 60 * 1000 });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(sent, 1, 'old timestamp should not block submission');
  await close();
});

test('missing _formStart with timing enabled returns apparent success', async () => {
  let sent = 0;
  const logs = [];
  const fixedNow = 1_000_000_000_000;
  const { base, close } = await fixture({
    config: { minSubmitMs: 2000 },
    now: () => fixedNow,
    fetchImpl: async () => { sent += 1; return { ok: true, json: async () => ({}) }; },
    log: (e) => logs.push(e),
  });
  const res = await post(base, { name: valid.name, email: valid.email, subject: valid.subject, message: valid.message });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(sent, 0);
  assert.ok(logs.some((e) => e.category === 'timing_blocked'));
  await close();
});

test('second same-page submission with freshly reset _formStart is accepted', async () => {
  let sent = 0;
  const { base, close } = await fixture({
    config: { minSubmitMs: 2000, ipRateLimit: 10 },
    fetchImpl: async () => { sent += 1; return { ok: true, json: async () => ({}) }; },
  });
  const start1 = Date.now() - 3000;
  const r1 = await post(base, { ...valid, _formStart: start1 }, { 'X-Forwarded-For': '10.0.0.1' });
  assert.equal(r1.status, 200);
  const start2 = Date.now() - 3000;
  const r2 = await post(base, { ...valid, message: 'A second distinct message from the same visitor.', _formStart: start2 }, { 'X-Forwarded-For': '10.0.0.1' });
  assert.equal(r2.status, 200, 'second submission with valid _formStart should succeed');
  assert.equal(sent, 2, 'both submissions reach the notification endpoint');
  await close();
});

// ─── Origin enforcement ───────────────────────────────────────────────────────

test('incorrect Origin header is rejected with 403', async () => {
  const { base, close } = await fixture({
    config: { allowedOrigins: ['https://daniel.rochatka.com', 'https://www.daniel.rochatka.com'] },
  });
  const res = await post(base, valid, { Origin: 'https://evil.example.com' });
  assert.equal(res.status, 403);
  await close();
});

test('missing Origin is rejected when allowed origins are configured', async () => {
  const { base, close } = await fixture({
    config: { allowedOrigins: ['https://daniel.rochatka.com'] },
  });
  const res = await fetch(`${base}/api/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10' },
    body: JSON.stringify(valid),
  });
  assert.equal(res.status, 403);
  await close();
});

test('allowed production origin succeeds', async () => {
  const { base, close } = await fixture({
    config: { allowedOrigins: ['https://daniel.rochatka.com', 'https://www.daniel.rochatka.com'] },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  for (const origin of ['https://daniel.rochatka.com', 'https://www.daniel.rochatka.com']) {
    const res = await post(base, valid, { Origin: origin });
    assert.equal(res.status, 200, `${origin} should succeed`);
  }
  await close();
});

// ─── Validation ───────────────────────────────────────────────────────────────

test('malformed email is rejected with 422', async () => {
  const { base, close } = await fixture();
  const res = await post(base, { ...valid, email: 'not-email' });
  assert.equal(res.status, 422);
  assert.match(res.body.errors.email, /valid email/);
  await close();
});

test('invalid name', async () => {
  const { base, close } = await fixture();
  const res = await post(base, { ...valid, name: 'A' });
  assert.equal(res.status, 422);
  assert.match(res.body.errors.name, /Name/);
  await close();
});

test('oversized name is rejected', async () => {
  const { base, close } = await fixture();
  const res = await post(base, { ...valid, name: 'A'.repeat(101) });
  assert.equal(res.status, 422);
  await close();
});

test('subject over 120 characters', async () => {
  const { base, close } = await fixture();
  const res = await post(base, { ...valid, subject: 'x'.repeat(121) });
  assert.equal(res.status, 422);
  assert.match(res.body.errors.subject, /120/);
  await close();
});

test('short and oversized message', async () => {
  const { base, close } = await fixture();
  assert.equal((await post(base, { ...valid, message: 'short' })).status, 422);
  const over = await post(base, { ...valid, message: 'x'.repeat(5001) });
  assert.equal(over.status, 422);
  assert.match(over.body.errors.message, /5000/);
  await close();
});

test('unexpected request fields are rejected', async () => {
  const { base, close } = await fixture();
  const res = await post(base, { ...valid, extraField: 'hacked' });
  assert.equal(res.status, 400);
  await close();
});

test('control characters in fields are rejected', async () => {
  const { base, close } = await fixture();
  const res = await post(base, { ...valid, name: 'Ada\x00Lovelace' });
  assert.equal(res.status, 422);
  assert.match(res.body.errors.name, /invalid characters/i);
  await close();
});

// ─── URL spam ─────────────────────────────────────────────────────────────────

test('more than 3 URLs in message returns apparent success without sending email', async () => {
  let sent = 0;
  const logs = [];
  const { base, close } = await fixture({
    fetchImpl: async () => { sent += 1; return { ok: true, json: async () => ({}) }; },
    log: (e) => logs.push(e),
  });
  const res = await post(base, { ...valid, message: 'See https://a.com https://b.com https://c.com https://d.com for info.' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(sent, 0);
  assert.ok(logs.some((e) => e.category === 'url_spam_blocked'));
  await close();
});

test('3 or fewer URLs in message are allowed', async () => {
  const { base, close } = await fixture({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  const res = await post(base, { ...valid, message: 'See https://a.com and https://b.com and https://c.com for reference.' });
  assert.equal(res.status, 200);
  await close();
});

// ─── IP rate limit ────────────────────────────────────────────────────────────

test('IP rate limit is enforced (3 per 10 min)', async () => {
  const { base, close } = await fixture({
    config: { ipRateLimit: 3 },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  for (let i = 0; i < 3; i++) assert.equal((await post(base, { ...valid, email: `a${i}@example.com` })).status, 200);
  const limited = await post(base, valid);
  assert.equal(limited.status, 429);
  assert.ok(limited.body.message);
  await close();
});

test('Retry-After header is included with 429', async () => {
  const { base, close } = await fixture({
    config: { ipRateLimit: 1 },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await post(base, valid);
  const res = await fetch(`${base}/api/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10' },
    body: JSON.stringify({ ...valid, 'cf-turnstile-response': 'test-token' }),
  });
  assert.equal(res.status, 429);
  assert.ok(res.headers.get('retry-after'));
  await close();
});

// ─── Duplicate suppression ────────────────────────────────────────────────────

test('identical duplicate is suppressed for 24 hours', async () => {
  let sent = 0;
  const logs = [];
  const { store, cleanup } = await tmpStore();
  const { base, close } = await fixture({
    store,
    config: { ipRateLimit: 10 },
    fetchImpl: async () => { sent += 1; return { ok: true, json: async () => ({}) }; },
    log: (e) => logs.push(e),
  });
  await post(base, valid, { 'X-Forwarded-For': '10.0.0.1' });
  const sentAfterFirst = sent;
  await post(base, valid, { 'X-Forwarded-For': '10.0.0.2' });
  assert.equal(sent, sentAfterFirst, 'duplicate should not trigger more sends');
  assert.ok(logs.some((e) => e.category === 'duplicate_blocked'));
  await close();
  await cleanup();
});

test('different messages from same sender are not treated as duplicates', async () => {
  let sent = 0;
  const { store, cleanup } = await tmpStore();
  const { base, close } = await fixture({
    store,
    config: { ipRateLimit: 10 },
    fetchImpl: async () => { sent += 1; return { ok: true, json: async () => ({}) }; },
  });
  await post(base, { ...valid, message: 'First unique message about this topic.' }, { 'X-Forwarded-For': '10.0.0.1' });
  await post(base, { ...valid, message: 'Second unique message about something else.' }, { 'X-Forwarded-For': '10.0.0.2' });
  assert.equal(sent, 2, 'two different messages should both send');
  await close();
  await cleanup();
});

test('same email+subject+message is suppressed as a duplicate', async () => {
  let sent = 0;
  const logs = [];
  const { store, cleanup } = await tmpStore();
  const { base, close } = await fixture({
    store,
    config: { ipRateLimit: 10 },
    fetchImpl: async () => { sent += 1; return { ok: true, json: async () => ({}) }; },
    log: (e) => logs.push(e),
  });
  await post(base, valid, { 'X-Forwarded-For': '10.0.0.1' });
  await post(base, valid, { 'X-Forwarded-For': '10.0.0.2' });
  assert.equal(sent, 1, 'duplicate should not trigger a second send');
  assert.ok(logs.some((e) => e.category === 'duplicate_blocked'));
  await close();
  await cleanup();
});

test('same email and message with different subject is a distinct submission', async () => {
  let sent = 0;
  const { store, cleanup } = await tmpStore();
  const { base, close } = await fixture({
    store,
    config: { ipRateLimit: 10 },
    fetchImpl: async () => { sent += 1; return { ok: true, json: async () => ({}) }; },
  });
  await post(base, valid, { 'X-Forwarded-For': '10.0.0.1' });
  await post(base, { ...valid, subject: 'Different subject line' }, { 'X-Forwarded-For': '10.0.0.2' });
  assert.equal(sent, 2, 'different subject should produce a distinct submission');
  await close();
  await cleanup();
});

test('same email and subject with different message is a distinct submission', async () => {
  let sent = 0;
  const { store, cleanup } = await tmpStore();
  const { base, close } = await fixture({
    store,
    config: { ipRateLimit: 10 },
    fetchImpl: async () => { sent += 1; return { ok: true, json: async () => ({}) }; },
  });
  await post(base, valid, { 'X-Forwarded-For': '10.0.0.1' });
  await post(base, { ...valid, message: 'A completely different message from the same person.' }, { 'X-Forwarded-For': '10.0.0.2' });
  assert.equal(sent, 2, 'different message should produce a distinct submission');
  await close();
  await cleanup();
});

// ─── Rate limit and cache expiry ──────────────────────────────────────────────

test('rate limit window expires and allows further submissions', async () => {
  let t = 1_000_000_000_000;
  const now = () => t;
  const { base, close } = await fixture({
    config: { ipRateLimit: 3 },
    now,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  for (let i = 0; i < 3; i++) await post(base, { ...valid, email: `u${i}@example.com` });
  assert.equal((await post(base, valid)).status, 429);
  t += 11 * 60 * 1000;
  assert.equal((await post(base, valid)).status, 200, 'should allow after window expires');
  await close();
});

test('duplicate cache expires and allows resubmission', async () => {
  let t = 1_000_000_000_000;
  const now = () => t;
  const dupWindowMs = 60 * 1000;
  const { store, cleanup } = await tmpStore();
  const { base, close } = await fixture({
    store,
    now,
    config: { ipRateLimit: 10, duplicateWindowMs: dupWindowMs },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await post(base, valid);
  assert.equal((await post(base, valid)).status, 200);
  t += dupWindowMs + 1000;
  store.pruneExpired(t);
  assert.equal((await post(base, valid)).status, 200, 'should allow after dup window expires');
  await close();
  await cleanup();
});

// ─── HTML and injection escaping ──────────────────────────────────────────────

test('HTML and header-injection payloads are escaped in email', () => {
  assert.equal(escapeHtml('<script>"x" & y</script>'), '&lt;script&gt;&quot;x&quot; &amp; y&lt;/script&gt;');

  const injectedData = {
    ...valid,
    email: 'ada@example.com',
    emailDisplay: 'Ada@Example.com',
    name: '<script>alert("xss")</script>',
    subject: '<img src=x onerror=alert(1)>',
    message: 'Normal message text without HTML tags.',
  };
  const payload = buildResendPayload(config, injectedData, 'DR-20260719-TEST01', '2026-01-01T00:00:00.000Z');
  assert.doesNotMatch(payload.html, /<script>/);
  assert.doesNotMatch(payload.html, /<img/);
  assert.match(payload.html, /&lt;script&gt;/);
  assert.match(payload.html, /&lt;img/);
});

// ─── Client IP extraction ─────────────────────────────────────────────────────

test('forged X-Forwarded-For from untrusted direct connection is not trusted', async () => {
  const { base, close } = await fixture({
    config: { ipRateLimit: 3 },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    trustedProxies: new Set(),
  });
  for (let i = 0; i < 3; i++) {
    const res = await post(base, { ...valid, email: `u${i}@example.com` }, { 'X-Forwarded-For': `1.1.1.${i}` });
    assert.equal(res.status, 200, `request ${i} should pass`);
  }
  const limited = await post(base, valid, { 'X-Forwarded-For': '9.9.9.9' });
  assert.equal(limited.status, 429);
  await close();
});

test('X-Forwarded-For is trusted when connection is from trusted proxy', async () => {
  const { base, close } = await fixture({
    config: { ipRateLimit: 3 },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    trustedProxies: new Set(['127.0.0.1']),
  });
  for (let i = 0; i < 3; i++) {
    const res = await post(base, { ...valid, email: `u${i}@example.com` }, { 'X-Forwarded-For': '1.2.3.4' });
    assert.equal(res.status === 200 || res.status === 429 ? res.status : -1, i < 3 ? 200 : 429);
  }
  const res = await post(base, valid, { 'X-Forwarded-For': '5.6.7.8' });
  assert.equal(res.status, 200);
  await close();
});

// ─── File-backed store ────────────────────────────────────────────────────────

test('file-backed store survives service restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dr-restart-'));
  const s1 = await initStore(dir);

  await s1.save({
    ref: 'DR-20260719-TEST01',
    submittedAt: '2026-07-19T00:00:00.000Z',
    contentHash: 'abc123',
    dupExpiresAt: Date.now() + 1_000_000,
    email: 'test@example.com',
    emailDisplay: 'Test@Example.com',
    notificationStatus: 'sent',
    ackStatus: 'pending',
    ackResendId: 'resend_id_1',
    ackUpdatedAt: null,
    events: [],
  });

  const s2 = await initStore(dir);
  assert.equal(s2.findRefByResendId('resend_id_1'), 'DR-20260719-TEST01', 'resend index rebuilt after restart');
  assert.ok(s2.isDuplicate('abc123', Date.now()), 'dup cache rebuilt after restart');
  await rm(dir, { recursive: true, force: true });
});

// ─── Core request handling ────────────────────────────────────────────────────

test('valid submission sends notification', async () => {
  const calls = [];
  const { base, close } = await fixture({ fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({}) }; } });
  const res = await post(base, valid);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(calls.length, 1);
  await close();
});

test('valid submission without subject uses fallback subject', async () => {
  const calls = [];
  const { base, close } = await fixture({ fetchImpl: async (_url, init) => { calls.push({ body: JSON.parse(init.body) }); return { ok: true, json: async () => ({}) }; } });
  const res = await post(base, { ...valid, subject: '' });
  assert.equal(res.status, 200);
  assert.match(calls[0].body.subject, /Contact from Ada Lovelace/);
  await close();
});

test('form-encoded submission is accepted', async () => {
  const calls = [];
  const { base, close } = await fixture({ fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({}) }; } });
  const form = new URLSearchParams({ name: valid.name, email: valid.email, subject: valid.subject, message: valid.message, 'cf-turnstile-response': 'test-token' });
  const res = await fetch(`${base}/api/contact`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '203.0.113.10' }, body: form });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(calls.length, 1);
  await close();
});

test('request body size enforcement', async () => {
  const { base, close } = await fixture();
  const res = await fetch(`${base}/api/contact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...valid, message: 'x'.repeat(40_000) }) });
  assert.equal(res.status, 413);
  await close();
});

test('unsupported method', async () => {
  const { base, close } = await fixture();
  const res = await fetch(`${base}/api/contact`, { method: 'GET' });
  assert.equal(res.status, 405);
  await close();
});

test('Resend notification request construction and Reply-To behavior', async () => {
  const calls = [];
  const { base, close } = await fixture({ fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({}) }; } });
  await post(base, valid);
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test_key');
  assert.equal(payload.from, config.from);
  assert.deepEqual(payload.to, [config.to]);
  assert.equal(payload.reply_to, 'Ada@Example.com');
  assert.match(payload.subject, /Contact: Research collaboration/);
  assert.match(payload.text, /DR-\d{8}-[A-Z0-9]{6}/);
  assert.match(payload.text, /Spam checks: passed/);
  await close();
});

test('notification email includes submission reference', async () => {
  const calls = [];
  const { base, close } = await fixture({
    fetchImpl: async (_url, init) => { calls.push({ body: JSON.parse(init.body) }); return { ok: true, json: async () => ({}) }; },
  });
  await post(base, valid);
  assert.match(calls[0].body.text, /Submission reference: DR-/);
  assert.match(calls[0].body.html, /DR-\d{8}-[A-Z0-9]{6}/);
  await close();
});

test('Resend failure returns 502', async () => {
  const { base, close } = await fixture({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  const res = await post(base, valid);
  assert.equal(res.status, 502);
  assert.equal(res.body.ok, false);
  await close();
});

test('Resend network rejection returns 502 and logs without details', async () => {
  const logs = [];
  const { base, close } = await fixture({
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.resend.com secret detail'); },
    log: (entry) => logs.push(entry),
  });
  const res = await post(base, valid);
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { ok: false, message: 'Delivery failed. Please try again later.' });
  assert.ok(logs.some((e) => e.category === 'notification_failure'));
  assert.doesNotMatch(JSON.stringify(res.body), /ENOTFOUND|secret detail|api\.resend\.com/);
  await close();
});

test('Resend AbortError returns 502 without exposing details', async () => {
  const logs = [];
  const { base, close } = await fixture({
    fetchImpl: async () => { throw new DOMException('The operation was aborted with sensitive detail', 'AbortError'); },
    log: (entry) => logs.push(entry),
  });
  const res = await post(base, valid);
  assert.equal(res.status, 502);
  assert.doesNotMatch(JSON.stringify(res.body), /AbortError|aborted|sensitive detail/);
  await close();
});

test('health endpoint', async () => {
  const { base, close } = await fixture();
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  await close();
});

// ─── Store unit tests ─────────────────────────────────────────────────────────

test('generateRef produces correct DR- format', () => {
  const ref = generateRef(new Date('2026-07-19T00:00:00Z').getTime(), 'ABC123');
  assert.equal(ref, 'DR-20260719-ABC123');
  assert.match(generateRef(), /^DR-\d{8}-[A-Z0-9]{6}$/);
});

test('hashContent produces stable hex output', () => {
  const h1 = hashContent('a@b.com', 'topic', 'hello');
  const h2 = hashContent('a@b.com', 'topic', 'hello');
  const h3 = hashContent('a@b.com', 'topic', 'world');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('validateSubmission rejects unexpected fields', () => {
  const result = validateSubmission({ ...valid, email: 'a@b.com', hack: 'x' });
  assert.equal(result.ok, false);
  assert.ok(result.errors._form);
});
