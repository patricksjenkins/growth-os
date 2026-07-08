/**
 * Growth OS — Gmail invoice scanner (FGA-internal)
 *
 * Walks every connected Gmail inbox for invoice/receipt-shaped mail with a
 * PDF or image attachment, runs each attachment through the same Claude Vision
 * extractor the manual upload uses, and drops a PENDING draft into the Expenses
 * review inbox.
 *
 * Hard rules:
 *   - NOTHING is auto-approved. Every draft lands review_status='pending' and
 *     waits for Patrick, exactly like an uploaded receipt. The books are never
 *     touched by this agent.
 *   - Read-only. The granted scope is gmail.readonly; we never label, archive,
 *     move, or delete mail. Patrick's inbox looks untouched.
 *   - Every message/attachment pair is logged to gmail_invoice_scans BEFORE we
 *     forget about it, so a rejected draft (which deletes the row) is never
 *     re-imported by next week's run.
 *   - Non-invoice mail is ignored entirely. We fetch metadata for candidates
 *     only, and only ever download attachments from messages that pass the
 *     invoice heuristic.
 *
 * Attachment handling lives here because core/drip-gmail.js only ever needed
 * message bodies; it owns OAuth + token refresh, which we reuse.
 */

const { createLogger } = require('./logger');
const { FGA_TENANT_ID } = require('./config');
const { getGmailConnections, ensureValidToken, gmailGet } = require('./drip-gmail');
const { createExpenseDraftFromBuffer, ALLOWED_MIME } = require('./internal-expense-draft');

const log = createLogger('gmail-invoice-scan');

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

// Cost guard: each attachment costs one Claude Vision call. A weekly run over
// two mailboxes should never blow past this without someone noticing.
const MAX_ATTACHMENTS_PER_RUN = 25;
const MAX_MESSAGES_PER_MAILBOX = 50;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/**
 * Gmail search for invoice-shaped mail. Deliberately narrow on the STRUCTURE
 * (has an attachment) and broad on the WORDS, because a missed invoice just
 * means Patrick uploads it by hand — while a false positive costs an AI call
 * and a draft he has to dismiss.
 *
 * Scope decisions, each one load-bearing:
 *   in:anywhere  — Gmail's default search skips Spam. Invoices auto-forwarded
 *                  from a personal account routinely land there because SPF
 *                  breaks on forward. Reading Spam is safe: every hit is still
 *                  human-reviewed before it can touch the books.
 *   -in:trash    — but never resurrect something already thrown away.
 *   -in:sent     — an invoice WE send a client is revenue, not an expense.
 *                  Gmail's default search includes Sent, so without this a
 *                  customer invoice could be booked as a cost.
 *   -in:drafts   — unsent drafts aren't transactions.
 *   -in:chats    — Hangouts/Chat transcripts.
 *
 * We do NOT restrict to in:inbox — receipts are commonly auto-filtered or
 * archived straight past it by Gmail rules.
 */
function buildInvoiceQuery(newerThanDays) {
  const terms = [
    'invoice', 'receipt', 'billing', 'statement',
    'subscription', '"payment received"', '"your order"',
    '"payment confirmation"', '"tax invoice"',
  ].join(' OR ');
  const scope = 'in:anywhere -in:trash -in:sent -in:drafts -in:chats';
  return `has:attachment ${scope} newer_than:${newerThanDays}d (${terms})`;
}

/** Attachment filenames worth extracting (Gmail reports mimeType unreliably). */
const ATTACHMENT_EXT_RE = /\.(pdf|jpe?g|png|heic|heif|webp)$/i;

const MIME_BY_EXT = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp',
};

/** Gmail's mimeType is authoritative when we recognize it; else infer from ext. */
function resolveMime(part) {
  const declared = (part.mimeType || '').toLowerCase();
  if (ALLOWED_MIME.has(declared)) return declared;
  const m = (part.filename || '').match(ATTACHMENT_EXT_RE);
  if (m) return MIME_BY_EXT[m[1].toLowerCase()] || null;
  return null;
}

/**
 * Depth-first walk of a Gmail payload collecting downloadable attachments.
 *
 * Each attachment gets a STABLE `key` in addition to Gmail's `attachmentId`.
 *
 * This distinction is load-bearing. Gmail's attachmentId is an EPHEMERAL token:
 * it is regenerated on every messages.get and differs between calls. Keying the
 * "have we already scanned this?" check on it means the check never matches, and
 * every weekly run re-imports every invoice. (Observed live: 2 messages produced
 * 6 distinct attachmentIds across 2 scans.)
 *
 * The stable identity is the attachment's POSITION in the MIME tree plus its
 * filename and byte size — all deterministic for a given message.
 */
function collectAttachments(payload) {
  const out = [];
  let index = 0;
  const walk = (part) => {
    if (!part) return;
    const filename = part.filename || '';
    const attachmentId = part.body?.attachmentId;
    if (filename && attachmentId) {
      const size = part.body?.size || 0;
      out.push({
        attachmentId,                   // ephemeral — only valid for THIS fetch
        key: `${index}:${filename}:${size}`, // stable across fetches
        filename,
        mimetype: resolveMime(part),    // null => unsupported, logged + skipped
        declaredMime: part.mimeType || null,
        size,
      });
      index += 1;
    }
    for (const p of part.parts || []) walk(p);
  };
  walk(payload);
  return out;
}

async function getMessageFull(token, id) {
  return gmailGet(`/users/me/messages/${id}?format=full`, token);
}

/** Download one attachment as a Buffer (base64url payload). */
async function downloadAttachment(token, messageId, attachmentId) {
  const res = await fetch(
    `${GMAIL_API}/users/me/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json();
  if (data.error) throw new Error(`Gmail attachment fetch: ${data.error.message}`);
  if (!data.data) throw new Error('Gmail returned an empty attachment body');
  return Buffer.from(data.data, 'base64url');
}

function headerMap(payload) {
  const h = {};
  for (const x of payload?.headers || []) h[x.name.toLowerCase()] = x.value;
  return h;
}

function parseFrom(raw) {
  const m = (raw || '').match(/<([^>]+)>/);
  return (m ? m[1] : raw || '').trim().toLowerCase();
}

/**
 * Every attachment key already logged for a message. One query per message
 * instead of one per attachment.
 *
 * Returns BOTH the stable keys and the bare filenames, because rows written
 * before the stable-key fix (migration 065) were backfilled with the filename
 * alone. Matching either form keeps those rows honoring the never-rescan
 * guarantee instead of silently re-importing once.
 */
async function scannedKeysForMessage(db, gmailMessageId) {
  const { data } = await db
    .from('gmail_invoice_scans')
    .select('attachment_key, filename')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('gmail_message_id', gmailMessageId);
  const seen = new Set();
  for (const r of data || []) {
    if (r.attachment_key) seen.add(r.attachment_key);
    if (r.filename) seen.add(r.filename);   // legacy backfilled rows
  }
  return seen;
}

/** Stable key OR the legacy filename-only form. */
function isScanned(seen, att) {
  return seen.has(att.key) || seen.has(att.filename);
}

async function logScan(db, entry) {
  const { error } = await db.from('gmail_invoice_scans').insert({
    ...entry,
    tenant_id: FGA_TENANT_ID,
    // Must come AFTER the spread: the unique index keys on
    // COALESCE(attachment_key,''), and an undefined here would break the
    // "never rescan" guarantee. attachment_id is kept for debugging only —
    // it is ephemeral and must never be used for identity.
    attachment_key: entry.attachment_key || '',
    attachment_id: entry.attachment_id || '',
  });
  // A unique violation means a concurrent run already logged it — benign.
  if (error && !/duplicate key|unique/i.test(error.message)) {
    log.warn(`gmail_invoice_scans insert failed: ${error.message}`);
  }
}

/**
 * Scan a single mailbox.
 * @returns {Promise<{mailbox, processed, imported, duplicates, skipped, errors, drafts:[]}>}
 */
async function scanMailbox(db, connection, { newerThanDays = 14, budget = { left: MAX_ATTACHMENTS_PER_RUN } } = {}) {
  const mailbox = connection.email_address || 'unknown';
  const stats = { mailbox, processed: 0, imported: 0, duplicates: 0, skipped: 0, errors: 0, drafts: [] };

  let conn;
  try {
    conn = await ensureValidToken(db, connection);
  } catch (err) {
    log.error(`[${mailbox}] token refresh failed: ${err.message}`);
    stats.errors++;
    stats.fatal = `token_refresh_failed: ${err.message}`;
    return stats;
  }
  const token = conn.access_token;

  let messages;
  try {
    const q = encodeURIComponent(buildInvoiceQuery(newerThanDays));
    const listed = await gmailGet(`/users/me/messages?q=${q}&maxResults=${MAX_MESSAGES_PER_MAILBOX}`, token);
    messages = listed.messages || [];
  } catch (err) {
    log.error(`[${mailbox}] message list failed: ${err.message}`);
    stats.errors++;
    stats.fatal = `list_failed: ${err.message}`;
    return stats;
  }

  log.info(`[${mailbox}] ${messages.length} candidate message(s) in the last ${newerThanDays}d`);

  for (const m of messages) {
    if (budget.left <= 0) {
      log.warn(`[${mailbox}] attachment budget exhausted (${MAX_ATTACHMENTS_PER_RUN}/run) — remaining messages deferred to the next run`);
      stats.budget_exhausted = true;
      break;
    }

    let full;
    try {
      full = await getMessageFull(token, m.id);
    } catch (err) {
      log.warn(`[${mailbox}] message fetch failed (${m.id}): ${err.message}`);
      stats.errors++;
      continue;
    }

    const headers = headerMap(full.payload);
    const meta = {
      connection_id: connection.id,
      mailbox,
      gmail_message_id: m.id,
      from_address: parseFrom(headers.from),
      subject: headers.subject || '',
      message_date: full.internalDate ? new Date(Number(full.internalDate)).toISOString() : null,
    };

    const attachments = collectAttachments(full.payload);
    const seen = await scannedKeysForMessage(db, m.id);

    if (attachments.length === 0) {
      if (seen.size === 0) {
        await logScan(db, { ...meta, attachment_key: '', attachment_id: '', outcome: 'skipped_no_attachment' });
      }
      continue;
    }

    for (const att of attachments) {
      if (budget.left <= 0) { stats.budget_exhausted = true; break; }
      if (isScanned(seen, att)) continue;

      stats.processed++;

      if (!att.mimetype) {
        stats.skipped++;
        await logScan(db, {
          ...meta, attachment_key: att.key, attachment_id: att.attachmentId, filename: att.filename,
          outcome: 'skipped_unsupported', detail: `mimeType=${att.declaredMime || 'unknown'}`,
        });
        continue;
      }
      if (att.size > MAX_ATTACHMENT_BYTES) {
        stats.skipped++;
        await logScan(db, {
          ...meta, attachment_key: att.key, attachment_id: att.attachmentId, filename: att.filename,
          outcome: 'skipped_unsupported', detail: `too large (${att.size} bytes)`,
        });
        continue;
      }

      let buffer;
      try {
        buffer = await downloadAttachment(token, m.id, att.attachmentId);
      } catch (err) {
        stats.errors++;
        await logScan(db, {
          ...meta, attachment_key: att.key, attachment_id: att.attachmentId, filename: att.filename,
          outcome: 'error', detail: err.message.slice(0, 400),
        });
        continue;
      }

      budget.left--;

      // Same storage + extraction + dedupe + idempotency as a manual upload.
      // The idempotency key makes a re-run within the same week a no-op even
      // before the scan log is consulted.
      const result = await createExpenseDraftFromBuffer({
        db,
        buffer,
        mimetype: att.mimetype,
        filename: att.filename,
        size: buffer.length,
        sourceType: 'gmail',
        // Stable key, not the ephemeral attachmentId — otherwise the second
        // safety net (idempotency) fails for exactly the same reason the first
        // one did, and a re-run silently duplicates every draft.
        idempotencyKey: `gmail:${m.id}:${att.key}`,
        createdBy: null,
        notesPrefix: `Imported from ${mailbox} — "${meta.subject}" from ${meta.from_address}`,
      });

      if (!result.ok) {
        stats.errors++;
        await logScan(db, {
          ...meta, attachment_key: att.key, attachment_id: att.attachmentId, filename: att.filename,
          outcome: 'error', detail: `${result.code}: ${result.error}`.slice(0, 400),
        });
        continue;
      }

      const isDuplicate = !!result.duplicateOf;
      if (isDuplicate) {
        stats.duplicates++;
        // Say so ON the draft. Vendors like Resend attach BOTH an invoice and a
        // receipt PDF for one charge, so this fires every month — the reviewer
        // needs to see which of the two pending drafts to reject, without
        // cross-referencing the scan log.
        const dup = result.duplicateOf;
        const warning = `Possible duplicate of an expense already recorded (${dup.vendor_name || 'same vendor'}, `
          + `$${Number(dup.total_amount || 0).toFixed(2)}, ${dup.expense_date || 'same date'}). `
          + 'Reject this draft if it is the same charge.';
        const notes = [warning, result.data.notes].filter(Boolean).join('\n\n');
        const { error: noteErr } = await db
          .from('internal_expenses')
          .update({ notes })
          .eq('id', result.data.id);
        if (noteErr) log.warn(`could not annotate duplicate draft ${result.data.id}: ${noteErr.message}`);
        else result.data.notes = notes;
      }
      stats.imported++;
      stats.drafts.push({
        id: result.data.id,
        vendor: result.data.vendor_name,
        amount: result.data.total_amount,
        date: result.data.expense_date,
        mailbox,
        duplicate_of: result.duplicateOf?.id || null,
      });

      seen.add(att.key);
      await logScan(db, {
        ...meta,
        attachment_key: att.key,
        attachment_id: att.attachmentId,
        filename: att.filename,
        outcome: isDuplicate ? 'duplicate' : 'imported',
        internal_expense_id: result.data.id,
        detail: isDuplicate ? `matches existing expense ${result.duplicateOf.id}` : null,
      });
    }
  }

  await db.from('email_connections')
    .update({ last_invoice_scan_at: new Date().toISOString() })
    .eq('id', connection.id);

  log.info(`[${mailbox}] ${stats.imported} draft(s) created, ${stats.duplicates} flagged duplicate, ${stats.skipped} skipped, ${stats.errors} error(s)`);
  return stats;
}

/** Scan every Gmail inbox with scan_invoices = true. */
async function scanAllMailboxes(db, { newerThanDays = 14 } = {}) {
  const connections = await getGmailConnections(db, { onlyInvoiceScanning: true });
  if (connections.length === 0) {
    return { skipped: 'no_gmail_connection', mailboxes: [] };
  }

  const budget = { left: MAX_ATTACHMENTS_PER_RUN };
  const mailboxes = [];
  for (const conn of connections) {
    mailboxes.push(await scanMailbox(db, conn, { newerThanDays, budget }));
  }

  const totals = mailboxes.reduce((acc, m) => ({
    processed: acc.processed + m.processed,
    imported: acc.imported + m.imported,
    duplicates: acc.duplicates + m.duplicates,
    skipped: acc.skipped + m.skipped,
    errors: acc.errors + m.errors,
  }), { processed: 0, imported: 0, duplicates: 0, skipped: 0, errors: 0 });

  return {
    mailboxes,
    ...totals,
    budget_exhausted: mailboxes.some((m) => m.budget_exhausted),
    drafts: mailboxes.flatMap((m) => m.drafts),
  };
}

module.exports = {
  scanAllMailboxes,
  scanMailbox,
  collectAttachments,
  isScanned,
  buildInvoiceQuery,
  resolveMime,
  MAX_ATTACHMENTS_PER_RUN,
};
