import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { generateRef, hashContent, createNullStore } from './contact-store.mjs';
import { handleWebhookEvent } from './contact-webhook.mjs';

const MAX_BODY_BYTES = 32 * 1024;
const IP_WINDOW_MS = 10 * 60 * 1000;
const EMAIL_ACK_WINDOW_MS = 24 * 60 * 60 * 1000;
const GLOBAL_BURST_WINDOW_MS = 60 * 1000;
const SUCCESS = { ok: true, message: 'Thank you. Your message has been sent.' };

// Fields accepted in a contact submission body
const ALLOWED_FIELDS = new Set(['name', 'email', 'subject', 'message', 'website', '_formStart']);

const CTRL_STRICT = /[\x00-\x1F\x7F]/;
const CTRL_MESSAGE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const URL_RE = /https?:\/\//gi;
const MAX_URLS = 3;

function parseOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function validateEnv(env = process.env) {
  const required = ['DANIEL_RESEND_API_KEY', 'DANIEL_CONTACT_FROM', 'DANIEL_CONTACT_TO'];
  const missing = required.filter((key) => !String(env[key] ?? '').trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

  const ackEnabled = env.DANIEL_ACK_ENABLED !== 'false';
  if (ackEnabled) {
    const ackRequired = [
      ['DANIEL_CONTACT_DATA_DIR', env.DANIEL_CONTACT_DATA_DIR],
      ['DANIEL_RESEND_WEBHOOK_SECRET', env.DANIEL_RESEND_WEBHOOK_SECRET],
    ].filter(([, v]) => !String(v ?? '').trim()).map(([k]) => k);
    if (ackRequired.length) {
      throw new Error(`Acknowledgement delivery requires: ${ackRequired.join(', ')}. Set DANIEL_ACK_ENABLED=false to disable.`);
    }
  }

  return {
    apiKey: env.DANIEL_RESEND_API_KEY,
    from: env.DANIEL_CONTACT_FROM,
    to: env.DANIEL_CONTACT_TO,
    host: env.DANIEL_CONTACT_HOST || '127.0.0.1',
    port: Number.parseInt(env.DANIEL_CONTACT_PORT || '8788', 10),
    allowedOrigins: parseOrigins(env.DANIEL_ALLOWED_ORIGINS || 'https://daniel.rochatka.com,https://www.daniel.rochatka.com'),
    dataDir: env.DANIEL_CONTACT_DATA_DIR || '',
    minSubmitMs: Number.parseInt(env.DANIEL_MIN_SUBMIT_SECONDS || '2', 10) * 1000,
    ipRateLimit: Number.parseInt(env.DANIEL_IP_RATE_LIMIT || '3', 10),
    emailAckLimit: Number.parseInt(env.DANIEL_EMAIL_ACK_LIMIT || '2', 10),
    duplicateWindowMs: Number.parseInt(env.DANIEL_DUPLICATE_WINDOW_HOURS || '24', 10) * 60 * 60 * 1000,
    ackEnabled,
    webhookSecret: env.DANIEL_RESEND_WEBHOOK_SECRET || '',
    globalBurstLimit: Number.parseInt(env.DANIEL_GLOBAL_BURST_LIMIT || '20', 10),
  };
}

export function validateSubmission(input) {
  const errors = {};
  const value = input && typeof input === 'object' ? input : {};

  const extraFields = Object.keys(value).filter((k) => !ALLOWED_FIELDS.has(k));
  if (extraFields.length > 0) return { ok: false, data: null, errors: { _form: 'Invalid request.' } };

  const data = {
    name: normalize(value.name),
    email: normalize(value.email).toLowerCase(),
    emailDisplay: normalize(value.email),
    subject: normalize(value.subject),
    message: normalizeMessage(value.message),
    website: normalize(value.website),
    _formStart: value._formStart,
  };

  if (data.name.length < 2 || data.name.length > 100) errors.name = 'Name must be between 2 and 100 characters.';
  else if (CTRL_STRICT.test(data.name)) errors.name = 'Name contains invalid characters.';

  if (!isEmail(data.email) || data.email.length > 254) errors.email = 'Enter a valid email address.';
  else if (CTRL_STRICT.test(data.email)) errors.email = 'Email contains invalid characters.';

  if (data.subject.length > 120) errors.subject = 'Subject must be 120 characters or fewer.';
  else if (data.subject && CTRL_STRICT.test(data.subject)) errors.subject = 'Subject contains invalid characters.';

  if (data.message.length < 10) errors.message = 'Message must be at least 10 characters.';
  else if (data.message.length > 5000) errors.message = 'Message must be 5000 characters or fewer.';
  else if (CTRL_MESSAGE.test(data.message)) errors.message = 'Message contains invalid characters.';

  return { ok: Object.keys(errors).length === 0, data, errors };
}

export function createContactServer(options) {
  const config = options.config;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const log = options.log || (() => {});
  const store = options.store || createNullStore();
  const trustedProxies = options.trustedProxies ?? new Set(['127.0.0.1', '::1']);

  const ipRateMap = new Map();
  const emailAckMap = new Map();
  const globalBurst = { count: 0, resetAt: 0 };

  const cleanup = setInterval(() => {
    const t = now();
    cleanupWindow(ipRateMap, t);
    cleanupWindow(emailAckMap, t);
    store.pruneExpired(t);
  }, IP_WINDOW_MS).unref();

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const timestamp = new Date(now()).toISOString();
    try {
      if (req.url === '/healthz') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'Method not allowed.' }, { Allow: 'GET' });
        return json(res, 200, { ok: true });
      }

      if (req.url === '/api/resend/webhook') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'Method not allowed.' }, { Allow: 'POST' });
        if (!config.webhookSecret) {
          log({ category: 'webhook_not_configured' });
          return json(res, 503, { ok: false, message: 'Webhook endpoint not configured.' });
        }
        const rawBody = await readBody(req, MAX_BODY_BYTES);
        const result = await handleWebhookEvent(store, log, rawBody, {
          'svix-id': req.headers['svix-id'],
          'svix-timestamp': req.headers['svix-timestamp'],
          'svix-signature': req.headers['svix-signature'],
        }, config.webhookSecret);
        return json(res, result.status, result.body);
      }

      if (req.url !== '/api/contact') return json(res, 404, { ok: false, message: 'Not found.' });
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'Method not allowed.' }, { Allow: 'POST' });

      const origin = req.headers['origin'];
      if (config.allowedOrigins.length > 0 && (!origin || !config.allowedOrigins.includes(origin))) {
        return json(res, 403, { ok: false, message: 'Forbidden.' });
      }

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
      if (!validation.ok) {
        if (validation.errors._form) return json(res, 400, { ok: false, message: validation.errors._form });
        return json(res, 422, { ok: false, message: 'Please correct the highlighted fields.', errors: validation.errors });
      }

      const data = validation.data;

      if (data.website) {
        log({ requestId, timestamp, category: 'honeypot_blocked' });
        return json(res, 200, SUCCESS);
      }

      if (config.minSubmitMs > 0) {
        const ts = Number(data._formStart);
        const elapsed = now() - ts;
        // Missing, non-positive, non-numeric, future, or too-fast timestamps are suppressed.
        // An old timestamp is acceptable: it proves the form was not submitted too quickly.
        if (data._formStart === undefined || !isFinite(ts) || ts <= 0 || elapsed < 0 || elapsed < config.minSubmitMs) {
          log({ requestId, timestamp, category: 'timing_blocked' });
          return json(res, 200, SUCCESS);
        }
      }

      const urlCount = (data.message.match(URL_RE) || []).length;
      if (urlCount > MAX_URLS) {
        log({ requestId, timestamp, category: 'url_spam_blocked' });
        return json(res, 200, SUCCESS);
      }

      const contentHashVal = hashContent(data.email, data.subject, data.message);
      if (store.isDuplicate(contentHashVal, now())) {
        log({ requestId, timestamp, category: 'duplicate_blocked' });
        return json(res, 200, SUCCESS);
      }

      const ip = clientIp(req, trustedProxies);

      if (config.ipRateLimit > 0 && !allowWindow(ipRateMap, ip, now(), IP_WINDOW_MS, config.ipRateLimit)) {
        log({ requestId, timestamp, category: 'rate_limited_ip' });
        const retryAfter = Math.ceil((ipRateMap.get(ip)?.resetAt - now()) / 1000);
        return json(res, 429, { ok: false, message: 'Too many submissions. Please try again later.' }, retryAfter > 0 ? { 'Retry-After': String(retryAfter) } : {});
      }

      if (config.globalBurstLimit > 0 && !allowGlobalBurst(globalBurst, now(), config.globalBurstLimit)) {
        log({ requestId, timestamp, category: 'rate_limited_global' });
        return json(res, 429, { ok: false, message: 'Service temporarily busy. Please try again shortly.' }, { 'Retry-After': '60' });
      }

      const ref = generateRef(now());
      const submittedAt = timestamp;

      const notificationPayload = buildResendPayload(config, data, ref, submittedAt);
      let notificationStatus = 'pending';
      const notifController = new AbortController();
      const notifTimeout = setTimeout(() => notifController.abort(), 10_000);
      try {
        const upstream = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(notificationPayload),
          signal: notifController.signal,
        });
        notificationStatus = upstream.ok ? 'sent' : 'failed';
      } catch {
        notificationStatus = 'failed';
      } finally {
        clearTimeout(notifTimeout);
      }

      if (notificationStatus === 'failed') {
        log({ requestId, timestamp, ref, category: 'notification_failure' });
        return json(res, 502, { ok: false, message: 'Delivery failed. Please try again later.' });
      }

      const sub = {
        ref,
        submittedAt,
        contentHash: contentHashVal,
        dupExpiresAt: now() + config.duplicateWindowMs,
        email: data.email,
        emailDisplay: data.emailDisplay,
        notificationStatus,
        ackStatus: 'pending',
        ackResendId: null,
        ackUpdatedAt: null,
        events: [],
      };
      await store.save(sub);

      let ackSent = false;
      if (config.ackEnabled && !store.isSuppressedEmail(data.email) && allowWindow(emailAckMap, data.email, now(), EMAIL_ACK_WINDOW_MS, config.emailAckLimit)) {
        const ackPayload = buildAckPayload(config, data, ref);
        const ackController = new AbortController();
        const ackTimeout = setTimeout(() => ackController.abort(), 10_000);
        try {
          const ackUpstream = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': `contact-ack-${ref}`,
            },
            body: JSON.stringify(ackPayload),
            signal: ackController.signal,
          });
          if (ackUpstream.ok) {
            const ackBody = await ackUpstream.json().catch(() => ({}));
            if (ackBody.id) await store.updateAckResendId(ref, ackBody.id);
            ackSent = true;
          }
        } catch { /* ack failure does not affect submission outcome */ } finally {
          clearTimeout(ackTimeout);
        }
      }

      log({ requestId, timestamp, ref, category: 'sent', ackSent });
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

export function buildResendPayload(config, data, ref, timestamp) {
  const subjectLine = data.subject ? `Contact: ${data.subject}` : `Contact from ${data.name}`;
  const lines = [
    `Submission reference: ${ref}`,
    `Submitted: ${timestamp}`,
    `Spam checks: passed`,
    '',
    `Name: ${data.name}`,
    `Email: ${data.emailDisplay || data.email}`,
    ...(data.subject ? [`Subject: ${data.subject}`] : []),
    '',
    data.message,
  ];
  const metaRows = [
    ['Reference', ref],
    ['Submitted', timestamp],
    ['Spam checks', 'passed'],
    ['Name', data.name],
    ['Email', data.emailDisplay || data.email],
    ...(data.subject ? [['Subject', data.subject]] : []),
  ].map(([k, v]) => `<tr><th align="left">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('');
  return {
    from: config.from,
    to: [config.to],
    reply_to: data.emailDisplay || data.email,
    subject: subjectLine,
    text: lines.join('\n'),
    html: `<h1>daniel.rochatka.com contact</h1><table>${metaRows}</table><h2>Message</h2><p>${escapeHtml(data.message).replace(/\n/g, '<br>')}</p>`,
  };
}

export function buildAckPayload(config, data, ref) {
  const text = [
    'Thank you for getting in touch.',
    '',
    'Your message has been received and will be reviewed as soon as possible.',
    '',
    `Reference: ${ref}`,
    '',
    'No confirmation or additional action is required.',
  ].join('\n');
  const html = `<p>Thank you for getting in touch.</p><p>Your message has been received and will be reviewed as soon as possible.</p><p><strong>Reference:</strong> ${escapeHtml(ref)}</p><p>No confirmation or additional action is required.</p>`;
  return {
    from: config.from,
    to: [data.emailDisplay || data.email],
    subject: 'Your message has been received',
    text,
    html,
    tags: [
      { name: 'category', value: 'contact_ack' },
      { name: 'submission_ref', value: ref },
    ],
  };
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
}

function normalize(value) { return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''; }
function normalizeMessage(value) { return typeof value === 'string' ? value.trim().replace(/\r\n?/g, '\n') : ''; }
function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

function normalizeIp(ip) {
  if (!ip) return 'unknown';
  const base = String(ip).replace(/%.*$/, '');
  const v4mapped = base.match(/^::ffff:((?:\d+\.){3}\d+)$/i);
  if (v4mapped) return v4mapped[1];
  return base.toLowerCase();
}

function clientIp(req, trustedProxies) {
  const remoteAddr = normalizeIp(req.socket?.remoteAddress);
  if (trustedProxies.has(remoteAddr)) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return normalizeIp(forwarded);
  }
  return remoteAddr;
}

function allowWindow(map, key, time, windowMs, max) {
  const e = map.get(key);
  if (!e || e.resetAt <= time) { map.set(key, { count: 1, resetAt: time + windowMs }); return true; }
  if (e.count >= max) return false;
  e.count += 1;
  return true;
}

function allowGlobalBurst(burst, time, max) {
  if (burst.resetAt <= time) { burst.count = 1; burst.resetAt = time + GLOBAL_BURST_WINDOW_MS; return true; }
  if (burst.count >= max) return false;
  burst.count += 1;
  return true;
}

function cleanupWindow(map, time) { for (const [k, e] of map) if (e.resetAt <= time) map.delete(k); }

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}

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
