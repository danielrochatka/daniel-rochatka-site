import http from 'node:http';
import { randomUUID } from 'node:crypto';

const MAX_BODY_BYTES = 32 * 1024;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ACCEPTED = 5;
const SUCCESS = { ok: true, message: 'Thank you. Your message has been sent.' };

export function validateEnv(env = process.env) {
  const required = ['DANIEL_RESEND_API_KEY', 'DANIEL_CONTACT_FROM', 'DANIEL_CONTACT_TO'];
  const missing = required.filter((key) => !String(env[key] ?? '').trim());
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return {
    apiKey: env.DANIEL_RESEND_API_KEY,
    from: env.DANIEL_CONTACT_FROM,
    to: env.DANIEL_CONTACT_TO,
    host: env.DANIEL_CONTACT_HOST || '127.0.0.1',
    port: Number.parseInt(env.DANIEL_CONTACT_PORT || '8788', 10),
  };
}

export function validateSubmission(input) {
  const errors = {};
  const value = input && typeof input === 'object' ? input : {};
  const data = {
    name: normalize(value.name),
    email: normalize(value.email).toLowerCase(),
    subject: normalize(value.subject),
    message: normalizeMessage(value.message),
    website: normalize(value.website),
  };

  if (data.name.length < 2 || data.name.length > 100) errors.name = 'Name must be between 2 and 100 characters.';
  if (!isEmail(data.email) || data.email.length > 254) errors.email = 'Enter a valid email address.';
  if (data.subject.length > 120) errors.subject = 'Subject must be 120 characters or fewer.';
  if (data.message.length < 10) errors.message = 'Message must be at least 10 characters.';
  if (data.message.length > 5000) errors.message = 'Message must be 5000 characters or fewer.';

  return { ok: Object.keys(errors).length === 0, data, errors };
}

export function createContactServer(options) {
  const config = options.config;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const log = options.log || (() => {});
  const rateLimit = new Map();
  const cleanup = setInterval(() => cleanupRateLimit(rateLimit, now()), WINDOW_MS).unref();

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const timestamp = new Date().toISOString();
    try {
      if (req.url === '/healthz') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'Method not allowed.' }, { Allow: 'GET' });
        return json(res, 200, { ok: true });
      }
      if (req.url !== '/api/contact') return json(res, 404, { ok: false, message: 'Not found.' });
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'Method not allowed.' }, { Allow: 'POST' });

      const contentType = req.headers['content-type'] || '';
      const isJson = /^application\/json(?:;|$)/i.test(contentType);
      const isForm = /^application\/x-www-form-urlencoded(?:;|$)/i.test(contentType);
      if (!isJson && !isForm) {
        return json(res, 415, { ok: false, message: 'Use application/json or application/x-www-form-urlencoded.' });
      }

      const body = await readBody(req, MAX_BODY_BYTES);
      let parsed;
      try {
        parsed = isJson ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
      } catch {
        return json(res, 400, { ok: false, message: isJson ? 'Malformed JSON.' : 'Malformed form data.' });
      }

      const validation = validateSubmission(parsed);
      if (!validation.ok) return json(res, 422, { ok: false, message: 'Please correct the highlighted fields.', errors: validation.errors });

      if (validation.data.website) {
        log({ requestId, timestamp, category: 'honeypot_success' });
        return json(res, 200, SUCCESS);
      }

      const ip = clientIp(req);
      if (!allowSubmission(rateLimit, ip, now())) {
        log({ requestId, timestamp, category: 'rate_limited' });
        return json(res, 429, { ok: false, message: 'Too many submissions. Please try again later.' });
      }

      const payload = buildResendPayload(config, validation.data, new Date(now()).toISOString());
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let upstream;
      try {
        upstream = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch {
        log({ requestId, timestamp, category: 'resend_failure' });
        return json(res, 502, { ok: false, message: 'Delivery failed. Please try again later.' });
      } finally {
        clearTimeout(timeout);
      }

      if (!upstream.ok) {
        log({ requestId, timestamp, category: 'resend_failure' });
        return json(res, 502, { ok: false, message: 'Delivery failed. Please try again later.' });
      }

      log({ requestId, timestamp, category: 'sent' });
      return json(res, 200, SUCCESS);
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') return json(res, 413, { ok: false, message: 'Request body is too large.' });
      log({ requestId, timestamp, category: 'internal_error' });
      return json(res, 500, { ok: false, message: 'Internal server error.' });
    }
  });

  server.on('close', () => clearInterval(cleanup));
  return server;
}

export function buildResendPayload(config, data, timestamp) {
  const subjectLine = data.subject
    ? `Contact: ${data.subject}`
    : `Contact from ${data.name}`;
  const lines = [
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    ...(data.subject ? [`Subject: ${data.subject}`] : []),
    `Submitted: ${timestamp}`,
    '',
    data.message,
  ];
  const rows = [
    ['Name', data.name],
    ['Email', data.email],
    ...(data.subject ? [['Subject', data.subject]] : []),
    ['Submitted', timestamp],
  ].map(([k, v]) => `<tr><th align="left">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('');
  return {
    from: config.from,
    to: [config.to],
    reply_to: data.email,
    subject: subjectLine,
    text: lines.join('\n'),
    html: `<h1>Contact form submission</h1><table>${rows}</table><h2>Message</h2><p>${escapeHtml(data.message).replace(/\n/g, '<br>')}</p>`,
  };
}

function normalize(value) { return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''; }
function normalizeMessage(value) { return typeof value === 'string' ? value.trim().replace(/\r\n?/g, '\n') : ''; }
function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
export function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]); }
function clientIp(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'; }
function cleanupRateLimit(map, time) { for (const [ip, entry] of map) if (entry.resetAt <= time) map.delete(ip); }
function allowSubmission(map, ip, time) { const e = map.get(ip); if (!e || e.resetAt <= time) { map.set(ip, { count: 1, resetAt: time + WINDOW_MS }); return true; } if (e.count >= MAX_ACCEPTED) return false; e.count += 1; return true; }
function json(res, status, payload, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(payload)); }
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > max) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) { const err = new Error('Body too large'); err.code = 'BODY_TOO_LARGE'; reject(err); return; }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}
