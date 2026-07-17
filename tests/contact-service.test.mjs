import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { buildResendPayload, createContactServer, escapeHtml, validateEnv } from '../server/contact-service.mjs';

const config = { apiKey: 'test_key', from: 'Test <forms@example.com>', to: 'dest@example.com', host: '127.0.0.1', port: 0 };
const valid = { name: 'Ada Lovelace', email: 'Ada@Example.com', subject: 'Research collaboration', message: 'I would like to discuss a potential research collaboration.' };

test('required environment validation', () => {
  assert.throws(() => validateEnv({}), /DANIEL_RESEND_API_KEY/);
  assert.equal(validateEnv({ DANIEL_RESEND_API_KEY: 'k', DANIEL_CONTACT_FROM: 'f', DANIEL_CONTACT_TO: 't' }).host, '127.0.0.1');
  assert.equal(validateEnv({ DANIEL_RESEND_API_KEY: 'k', DANIEL_CONTACT_FROM: 'f', DANIEL_CONTACT_TO: 't' }).port, 8788);
});

test('valid submission sends email', async () => {
  const calls = [];
  const { base, close } = await fixture({ fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true }; } });
  const res = await post(base, valid);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(calls.length, 1);
  await close();
});

test('valid submission without subject', async () => {
  const calls = [];
  const { base, close } = await fixture({ fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true }; } });
  const res = await post(base, { ...valid, subject: '' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].init.body);
  assert.match(payload.subject, /Contact from Ada Lovelace/);
  await close();
});

test('form-encoded submission supports non-JavaScript fallback', async () => {
  const calls = [];
  const { base, close } = await fixture({ fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true }; } });
  const form = new URLSearchParams(valid);
  const res = await fetch(`${base}/api/contact`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(calls.length, 1);
  await close();
});

test('invalid name', async () => {
  const { base, close } = await fixture();
  const res = await post(base, { ...valid, name: 'A' });
  assert.equal(res.status, 422);
  assert.match(res.body.errors.name, /Name/);
  await close();
});

test('invalid email', async () => {
  const { base, close } = await fixture();
  const res = await post(base, { ...valid, email: 'not-email' });
  assert.equal(res.status, 422);
  assert.match(res.body.errors.email, /valid email/);
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

test('honeypot behavior returns success without sending', async () => {
  let sent = 0;
  const { base, close } = await fixture({ fetchImpl: async () => { sent += 1; return { ok: true }; } });
  const res = await post(base, { ...valid, website: 'bot.example' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(sent, 0);
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

test('rate limiting', async () => {
  const { base, close } = await fixture({ fetchImpl: async () => ({ ok: true }) });
  for (let i = 0; i < 5; i++) assert.equal((await post(base, { ...valid, email: `a${i}@example.com` })).status, 200);
  assert.equal((await post(base, valid)).status, 429);
  await close();
});

test('Resend request construction and Reply-To behavior', async () => {
  const calls = [];
  const { base, close } = await fixture({ fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true }; } });
  await post(base, valid);
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test_key');
  assert.equal(payload.from, config.from);
  assert.deepEqual(payload.to, [config.to]);
  assert.equal(payload.reply_to, 'ada@example.com');
  assert.match(payload.subject, /Contact: Research collaboration/);
  await close();
});

test('HTML escaping', () => {
  assert.equal(escapeHtml('<script>"x" & y</script>'), '&lt;script&gt;&quot;x&quot; &amp; y&lt;/script&gt;');
  const payload = buildResendPayload(config, { ...valid, name: '<Ada>', message: 'Hello <b>world</b>' }, '2026-01-01T00:00:00.000Z');
  assert.match(payload.html, /&lt;Ada&gt;/);
  assert.doesNotMatch(payload.html, /<b>world<\/b>/);
});

test('Resend failure handling', async () => {
  const { base, close } = await fixture({ fetchImpl: async () => ({ ok: false, status: 401 }) });
  const res = await post(base, valid);
  assert.equal(res.status, 502);
  assert.equal(res.body.ok, false);
  await close();
});

test('Resend network rejection returns 502 and logs resend_failure without details', async () => {
  const logs = [];
  const { base, close } = await fixture({
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.resend.com secret detail'); },
    log: (entry) => logs.push(entry),
  });
  const res = await post(base, valid);
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { ok: false, message: 'Delivery failed. Please try again later.' });
  assert.equal(logs.at(-1).category, 'resend_failure');
  assert.doesNotMatch(JSON.stringify(res.body), /ENOTFOUND|secret detail|api\.resend\.com/);
  await close();
});

test('Resend AbortError returns 502 and logs resend_failure without details', async () => {
  const logs = [];
  const { base, close } = await fixture({
    fetchImpl: async () => { throw new DOMException('The operation was aborted with sensitive detail', 'AbortError'); },
    log: (entry) => logs.push(entry),
  });
  const res = await post(base, valid);
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { ok: false, message: 'Delivery failed. Please try again later.' });
  assert.equal(logs.at(-1).category, 'resend_failure');
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

async function fixture(opts = {}) {
  const server = createContactServer({ config, fetchImpl: opts.fetchImpl || (async () => ({ ok: true })), log: opts.log || (() => {}) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port, address } = server.address();
  return { base: `http://${address}:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function post(base, payload) {
  const res = await fetch(`${base}/api/contact`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10' }, body: JSON.stringify(payload) });
  return { status: res.status, body: await res.json() };
}
