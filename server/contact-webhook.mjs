import { Webhook } from 'svix';

const ACK_EVENT_STATUS = new Map([
  ['email.delivered', 'delivered'],
  ['email.bounced', 'bounced'],
  ['email.delivery_delayed', 'delivery_delayed'],
  ['email.failed', 'failed'],
  ['email.suppressed', 'suppressed'],
  ['email.complained', 'complained'],
]);

function parseEventTimestamp(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  if (!isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// svixHeaders must contain 'svix-id', 'svix-timestamp', 'svix-signature'.
// webhookSecret must be in whsec_... format.
// Uses the official Svix library which enforces a 5-minute timestamp tolerance.
export async function handleWebhookEvent(store, log, rawBody, svixHeaders, webhookSecret) {
  if (!webhookSecret) {
    return { status: 401, body: { ok: false, message: 'Invalid signature.' } };
  }

  let event;
  try {
    const wh = new Webhook(webhookSecret);
    event = wh.verify(rawBody, svixHeaders);
  } catch {
    return { status: 401, body: { ok: false, message: 'Invalid signature.' } };
  }

  const svixId = svixHeaders['svix-id'];
  const eventType = event.type;
  const newStatus = ACK_EVENT_STATUS.get(eventType);

  if (!newStatus) {
    return { status: 200, body: { ok: true } };
  }

  const receiptTimestamp = new Date().toISOString();
  const eventTimestamp = parseEventTimestamp(event.created_at) ?? receiptTimestamp;

  const resendId = event.data?.email_id;
  if (!resendId || typeof resendId !== 'string') {
    log({ category: 'webhook_missing_id', eventType });
    return { status: 200, body: { ok: true } };
  }

  let ref = store.findRefByResendId(resendId);

  if (!ref) {
    const tags = event.data?.tags ?? [];
    const catTag = tags.find((t) => t.name === 'category');
    const refTag = tags.find((t) => t.name === 'submission_ref');
    if (catTag?.value === 'contact_ack' && refTag?.value) {
      const attached = await store.attachResendIdByRef(refTag.value, resendId);
      if (attached) ref = refTag.value;
    }
  }

  if (!ref) {
    log({ category: 'webhook_unknown_resend_id', eventType });
    return { status: 200, body: { ok: true } };
  }

  const result = await store.updateAckStatus(resendId, newStatus, eventTimestamp, svixId);
  if (result === null) {
    log({ category: 'webhook_unknown_resend_id', eventType });
  } else if (result === false) {
    // svix-id already processed — idempotent replay, return 200 silently.
  } else {
    log({ category: 'webhook_event_recorded', ref: result, eventType, newStatus });
  }

  return { status: 200, body: { ok: true } };
}
