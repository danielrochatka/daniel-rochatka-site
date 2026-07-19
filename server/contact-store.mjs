import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SUFFIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// Priority determines which status "wins" when events arrive out of order.
// Higher priority statuses are never overwritten by lower-priority ones.
const STATUS_PRIORITY = new Map([
  ['pending', 0],
  ['delivery_delayed', 1],
  ['delivered', 2],
  ['failed', 2],
  ['suppressed', 2],
  ['bounced', 3],
  ['complained', 4],
]);

export function generateRef(nowMs = Date.now(), suffixOverride = null) {
  const ymd = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = suffixOverride ?? Array.from(randomBytes(6), (b) => SUFFIX_CHARS[b % SUFFIX_CHARS.length]).join('');
  return `DR-${ymd}-${suffix}`;
}

export function hashContent(normalizedEmail, normalizedSubject, normalizedMessage) {
  return createHash('sha256')
    .update(`${normalizedEmail}\x00${normalizedSubject}\x00${normalizedMessage}`)
    .digest('hex');
}

// Ordering rules:
//   1. complained is always terminal.
//   2. When both timestamps are valid, an older event never overwrites the
//      current status regardless of priority.
//   3. A newer (or timestamp-unknown) event must still have equal or higher
//      priority to prevent a lower-priority event from downgrading the status.
//   4. Equal timestamps use priority as a deterministic tie-breaker (strict >).
export function shouldUpdateStatus(currentStatus, currentUpdatedAt, newStatus, newEventTimestamp) {
  if (currentStatus === 'complained') return false;

  const curMs = currentUpdatedAt ? Date.parse(currentUpdatedAt) : NaN;
  const newMs = newEventTimestamp ? Date.parse(newEventTimestamp) : NaN;
  const curP = STATUS_PRIORITY.get(currentStatus) ?? 0;
  const newP = STATUS_PRIORITY.get(newStatus) ?? 0;

  if (isFinite(curMs) && isFinite(newMs)) {
    if (newMs < curMs) return false;
    if (newMs === curMs) return newP > curP;
    return newP >= curP;
  }

  return newP >= curP;
}

// Serialises concurrent reads and writes for the same submission file.
class SubmissionMutex {
  constructor() { this._chain = new Map(); }

  withLock(ref, fn) {
    const prev = this._chain.get(ref) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => fn());
    this._chain.set(ref, next.catch(() => {}));
    return next;
  }
}

export function createNullStore() {
  return {
    isDuplicate: () => false,
    isSuppressedEmail: () => false,
    save: async () => {},
    updateAckResendId: async () => {},
    updateAckStatus: async () => null,
    attachResendIdByRef: async () => false,
    findRefByResendId: () => null,
    pruneExpired: () => {},
  };
}

export async function initStore(dataDir) {
  const submissionsDir = join(dataDir, 'submissions');
  await mkdir(submissionsDir, { recursive: true });

  const resendIndex = new Map();
  const dupCache = new Map();
  const suppressedEmails = new Map();
  const mutex = new SubmissionMutex();

  let files = [];
  try { files = await readdir(submissionsDir); } catch {}
  for (const file of files) {
    if (file.includes('.tmp')) {
      try { await unlink(join(submissionsDir, file)); } catch {}
      continue;
    }
    if (!file.endsWith('.json')) continue;
    try {
      const sub = JSON.parse(await readFile(join(submissionsDir, file), 'utf8'));
      if (sub.ackResendId) resendIndex.set(sub.ackResendId, sub.ref);
      if (sub.contentHash && sub.dupExpiresAt) {
        dupCache.set(sub.contentHash, { ref: sub.ref, expiresAt: sub.dupExpiresAt });
      }
      if (sub.email && (sub.ackStatus === 'complained' || sub.ackStatus === 'bounced')) {
        suppressedEmails.set(sub.email, sub.ackStatus);
      }
    } catch {}
  }

  const subPath = (ref) => join(submissionsDir, `${ref}.json`);

  async function atomicWrite(ref, data) {
    const p = subPath(ref);
    const tmpName = `${ref}.${randomBytes(4).toString('hex')}.tmp`;
    const tmp = join(submissionsDir, tmpName);
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await rename(tmp, p);
    } catch (err) {
      try { await unlink(tmp); } catch {}
      throw err;
    }
  }

  async function readSub(ref) {
    try { return JSON.parse(await readFile(subPath(ref), 'utf8')); } catch { return null; }
  }

  return {
    isDuplicate(hash, now) {
      const e = dupCache.get(hash);
      return !!e && e.expiresAt > now;
    },

    isSuppressedEmail(email) {
      return suppressedEmails.has(email);
    },

    async save(sub) {
      if (sub.ackResendId) resendIndex.set(sub.ackResendId, sub.ref);
      if (sub.contentHash && sub.dupExpiresAt) {
        dupCache.set(sub.contentHash, { ref: sub.ref, expiresAt: sub.dupExpiresAt });
      }
      await mutex.withLock(sub.ref, () => atomicWrite(sub.ref, sub));
    },

    async updateAckResendId(ref, resendId) {
      return mutex.withLock(ref, async () => {
        const sub = await readSub(ref);
        if (!sub) return;
        sub.ackResendId = resendId;
        resendIndex.set(resendId, ref);
        await atomicWrite(ref, sub);
      });
    },

    // Returns:
    //   null   – resendId not found in index
    //   false  – svix-id already in event history (idempotent replay)
    //   string – the submission ref (event recorded)
    async updateAckStatus(resendId, newStatus, eventTimestamp, svixId) {
      const ref = resendIndex.get(resendId);
      if (!ref) return null;

      return mutex.withLock(ref, async () => {
        const sub = await readSub(ref);
        if (!sub) return null;

        sub.events = sub.events || [];

        if (svixId && sub.events.some((e) => e.webhookId === svixId)) {
          return false;
        }

        const eventType = `email.${newStatus}`;
        const statusUpdated = shouldUpdateStatus(sub.ackStatus, sub.ackUpdatedAt, newStatus, eventTimestamp);

        if (statusUpdated) {
          sub.ackStatus = newStatus;
          sub.ackUpdatedAt = eventTimestamp;
          if (newStatus === 'complained' || newStatus === 'bounced') {
            suppressedEmails.set(sub.email, newStatus);
          }
        }

        sub.events.push({ type: eventType, resendId, timestamp: eventTimestamp, webhookId: svixId ?? null });
        await atomicWrite(ref, sub);
        return ref;
      });
    },

    async attachResendIdByRef(ref, resendId) {
      return mutex.withLock(ref, async () => {
        const sub = await readSub(ref);
        if (!sub) return false;
        if (!sub.ackResendId) {
          sub.ackResendId = resendId;
          resendIndex.set(resendId, ref);
          await atomicWrite(ref, sub);
        }
        return true;
      });
    },

    findRefByResendId(resendId) {
      return resendIndex.get(resendId) ?? null;
    },

    pruneExpired(now) {
      for (const [h, e] of dupCache) if (e.expiresAt <= now) dupCache.delete(h);
    },
  };
}
