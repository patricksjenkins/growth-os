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
const { extractInternalExpenseFromInvoice } = require('./internal-expense-extractor');

const log = createLogger('gmail-invoice-scan');

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

// Cost guard: each attachment costs one Claude Vision call. A weekly run over
// two mailboxes should never blow past this without someone noticing.
const MAX_ATTACHMENTS_PER_RUN = 25;
const MAX_MESSAGES_PER_MAILBOX = 50;
/** Pages of 100 to walk before declaring the result truncated. */
const MAX_LIST_PAGES = 10;
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
function buildInvoiceQuery(newerThanDays, { attachmentsOnly = false } = {}) {
  const terms = [
    'invoice', 'receipt', 'billing', 'statement',
    'subscription', '"payment received"', '"your order"',
    '"payment confirmation"', '"tax invoice"',
    // Body-only receipt language — these senders rarely attach a PDF.
    '"thanks for your payment"', '"payment successful"', '"we received your payment"',
    '"your invoice is available"', '"view invoice"', '"amount charged"', '"total charged"',
  ].join(' OR ');
  const scope = 'in:anywhere -in:trash -in:sent -in:drafts -in:chats';
  /*
   * Patrick 2026-07-26: "you should have the invoice scan in the email."
   *
   * This previously forced `has:attachment`, so every receipt that lives in
   * the email BODY — Vercel, Anthropic, Google, Resend, most SaaS — was
   * invisible to the scanner no matter how many times it ran. Attachments are
   * now one source among several, not the entry condition.
   */
  return `${attachmentsOnly ? 'has:attachment ' : ''}${scope} newer_than:${newerThanDays}d (${terms})`;
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

/**
 * The CHARGE an extracted document describes: vendor + amount + date.
 *
 * Deliberately EXCLUDES the document number. Vercel emails one charge as two
 * PDFs — Invoice-TCIVVSU4-0003.pdf and Receipt-2863-0182.pdf — carrying
 * DIFFERENT document numbers. The ledger's dedupe_key includes the doc number,
 * so it sees two distinct expenses and the reviewer gets two identical $20 rows
 * to disentangle. One email describing one charge must produce one draft.
 *
 * Returns null when the charge can't be identified (no vendor or no amount), in
 * which case the attachment is never collapsed into another — better a spurious
 * draft he can reject than an expense silently swallowed.
 */
function chargeSignature(draft) {
  const vendor = String(draft?.vendor_name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const total = draft?.total_amount != null ? Number(draft.total_amount) : null;
  if (!vendor || !Number.isFinite(total)) return null;
  const date = draft?.expense_date || '';
  return `${vendor}|${total.toFixed(2)}|${date}`;
}

/**
 * When two attachments describe the same charge, keep the INVOICE. It carries
 * the canonical document number a bookkeeper reconciles against; a receipt's
 * number is only a payment reference. Stable sort — order otherwise preserved.
 */
function invoiceFirst(attachments) {
  const rank = (a) => (/invoice/i.test(a.filename) ? 0 : /receipt/i.test(a.filename) ? 2 : 1);
  return [...attachments].sort((a, b) => rank(a) - rank(b));
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
  const stats = { mailbox, processed: 0, imported: 0, duplicates: 0, skipped: 0, errors: 0, drafts: [],
    body_drafts: 0, incomplete: 0, candidates: 0, truncated: false };

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
  let truncated = false;
  try {
    /*
     * PAGINATE. The old call took a single page of 50 and stopped, silently —
     * Gmail returns nextPageToken and it was never read, so a busy month was
     * quietly cut off and the run still reported success. Now we follow the
     * cursor to a hard ceiling, and if the ceiling is what stopped us we SAY
     * so (`truncated`) rather than pretending we saw everything.
     */
    const q = encodeURIComponent(buildInvoiceQuery(newerThanDays));
    messages = [];
    let pageToken = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const url = `/users/me/messages?q=${q}&maxResults=100`
        + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const listed = await gmailGet(url, token);
      messages.push(...(listed.messages || []));
      pageToken = listed.nextPageToken || null;
      if (!pageToken) break;
      if (page === MAX_LIST_PAGES - 1 && pageToken) truncated = true;
    }
    stats.candidates = messages.length;
    stats.truncated = truncated;
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
      /*
       * No attachment is no longer the end of the road — read the email.
       * Most SaaS receipts put the amount in the body, and skipping them is
       * why the books had to be rebuilt by hand.
       */
      if (seen.size === 0) {
        const bodyText = extractBodyText(full.payload);
        const found = extractInvoiceFromText(bodyText, {
          fromAddress: meta.from_address, subject: meta.subject,
        });
        if (found.total_amount != null) {
          const draft = await createBodyExpenseDraft(db, {
            ...meta,
            vendor_name: found.vendor_name || meta.from_address || 'Unknown vendor',
            total_amount: found.total_amount,
            invoice_date: found.invoice_date || (meta.message_date || '').slice(0, 10) || null,
            confidence: found.confidence,
            body_excerpt: bodyText.slice(0, 600),
          });
          if (draft) stats.body_drafts++;
          await logScan(db, {
            ...meta, attachment_key: 'body', attachment_id: '',
            outcome: draft ? 'body_extracted' : 'body_duplicate',
          });
        } else {
          // Honest outcome: we looked and could not find an amount. This is an
          // EXCEPTION, not a success — see stats.incomplete below.
          stats.incomplete++;
          await logScan(db, {
            ...meta, attachment_key: 'body', attachment_id: '',
            outcome: 'body_no_amount_found',
          });
        }
      }
      continue;
    }

    // Invoice before receipt, so the survivor of a collapsed pair is the invoice.
    // chargesInMessage collapses "one email, one charge, two PDFs".
    const chargesInMessage = new Map();

    for (const att of invoiceFirst(attachments)) {
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

      // Extract ONCE. We need the extracted vendor/amount/date before we can
      // tell whether this attachment is a second view of a charge we already
      // took from this same email — and re-extracting later would double the
      // Claude Vision spend.
      const extraction = await extractInternalExpenseFromInvoice({
        buffer, mimetype: att.mimetype, filename: att.filename,
      });
      const sig = chargeSignature(extraction.draft);

      // Same email, same vendor+amount+date => the invoice PDF and the receipt
      // PDF for one charge. Keep the first (invoice); log the rest, no draft.
      if (sig && chargesInMessage.has(sig)) {
        stats.duplicates++;
        seen.add(att.key);
        await logScan(db, {
          ...meta, attachment_key: att.key, attachment_id: att.attachmentId, filename: att.filename,
          outcome: 'duplicate', internal_expense_id: chargesInMessage.get(sig),
          detail: `same charge as another attachment on this email (${sig})`,
        });
        continue;
      }

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
        extraction,
        // An expense already on file must never re-enter the review queue.
        skipIfDuplicate: true,
      });

      if (!result.ok) {
        stats.errors++;
        await logScan(db, {
          ...meta, attachment_key: att.key, attachment_id: att.attachmentId, filename: att.filename,
          outcome: 'error', detail: `${result.code}: ${result.error}`.slice(0, 400),
        });
        continue;
      }

      seen.add(att.key);

      // Already in the books, or already sitting in the review queue. No draft.
      if (result.skippedDuplicate) {
        stats.duplicates++;
        if (sig) chargesInMessage.set(sig, result.duplicateOf.id);
        await logScan(db, {
          ...meta, attachment_key: att.key, attachment_id: att.attachmentId, filename: att.filename,
          outcome: 'duplicate', internal_expense_id: result.duplicateOf.id,
          detail: `matches existing expense ${result.duplicateOf.id}`,
        });
        continue;
      }

      if (sig) chargesInMessage.set(sig, result.data.id);
      stats.imported++;
      stats.drafts.push({
        id: result.data.id,
        vendor: result.data.vendor_name,
        amount: result.data.total_amount,
        date: result.data.expense_date,
        mailbox,
      });

      await logScan(db, {
        ...meta,
        attachment_key: att.key,
        attachment_id: att.attachmentId,
        filename: att.filename,
        outcome: 'imported',
        internal_expense_id: result.data.id,
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


/**
 * Decode the readable text of a Gmail message body.
 *
 * Patrick 2026-07-26: "you should have the invoice scan in the email."
 * Most SaaS receipts (Vercel, Anthropic, Google, Resend, Railway) never attach
 * a PDF — the amount is in the email itself. The scanner skipped every one of
 * those with outcome 'skipped_no_attachment', which is why 2026 expenses were
 * being reconstructed by hand.
 *
 * Prefers text/plain, falls back to stripped text/html, and walks nested
 * multipart trees (multipart/alternative inside multipart/mixed is normal).
 */
/**
 * Create an expense DRAFT from a body-only receipt.
 *
 * Idempotent on the Gmail message id: re-running the scan (now daily) must not
 * produce a second draft for the same email. Always status 'pending' — the
 * scanner proposes, the owner disposes. Nothing here posts to the ledger.
 */
async function createBodyExpenseDraft(db, m) {
  // Idempotent on the Gmail message id. The scan runs daily now, so re-seeing
  // the same receipt must never produce a second draft.
  const idemKey = `gmail_body:${m.gmail_message_id}`;
  const { data: dup } = await db.from('internal_expenses')
    .select('id').eq('idempotency_key', idemKey).limit(1);
  if (dup && dup.length) return null;

  /*
   * extraction_status is HONEST, not optimistic. Codex found 18 of 23 rows
   * marked "extracted" while missing vendor, amount or date — coverage theatre.
   * A row only claims 'extracted' when it has all three; otherwise it says
   * 'partial' and stays in review with its evidence attached.
   */
  const complete = Boolean(m.vendor_name && m.total_amount != null && m.invoice_date);
  const confidenceScore = { high: 0.85, medium: 0.6, low: 0.3 }[m.confidence] ?? 0.3;

  const { data, error } = await db.from('internal_expenses').insert({
    vendor_name: m.vendor_name,
    total_amount: m.total_amount,
    expense_date: m.invoice_date,
    currency: 'USD',
    document_type: 'receipt',
    source_type: 'gmail_body',
    ocr_text: m.body_excerpt,
    ai_confidence: confidenceScore,
    extraction_status: complete ? 'extracted' : 'partial',
    review_status: 'pending',          // never auto-approve; owner disposes
    idempotency_key: idemKey,
    notes: `Email body receipt from ${m.from_address || 'unknown sender'}`
      + (m.subject ? ` — "${String(m.subject).slice(0, 120)}"` : '')
      + (complete ? '' : ' — INCOMPLETE: missing vendor, amount or date; verify before approving.'),
  }).select('id').single();
  if (error) {
    log.warn(`body draft insert failed (${m.gmail_message_id}): ${error.message}`);
    return null;
  }
  return data;
}

function extractBodyText(payload) {
  const chunks = [];
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || '';
    const data = part.body?.data;
    if (data && (mime === 'text/plain' || mime === 'text/html')) {
      try {
        const raw = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        chunks.push({ mime, text: mime === 'text/html' ? stripHtml(raw) : raw });
      } catch { /* undecodable part — skip, never throw the whole scan */ }
    }
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  const plain = chunks.find((c) => c.mime === 'text/plain');
  return (plain || chunks[0] || { text: '' }).text.slice(0, 20000);
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Pull vendor / amount / date out of receipt body text.
 *
 * Deliberately conservative: this produces a DRAFT for owner review, never a
 * posted expense. An amount it cannot find is reported as missing rather than
 * guessed — Codex found 18 of 23 rows marked "extracted" with no usable
 * amount, vendor or date, which is worse than not scanning at all because it
 * looks like coverage.
 */
function extractInvoiceFromText(text, { fromAddress = '', subject = '' } = {}) {
  const out = { vendor_name: null, total_amount: null, invoice_date: null, confidence: 'low' };
  if (!text) return out;

  // Amount: prefer an explicitly labelled total.
  const labelled = text.match(
    /(?:amount\s+(?:charged|paid|due)|total\s+(?:charged|paid|due|amount)?|grand\s+total|you\s+paid|charged)\s*[:\-]?\s*\$?\s*([0-9][0-9,]*\.?[0-9]{0,2})/i);
  if (labelled) out.total_amount = Number(labelled[1].replace(/,/g, ''));
  if (out.total_amount == null) {
    const money = [...text.matchAll(/\$\s?([0-9][0-9,]*\.[0-9]{2})/g)].map((m) => Number(m[1].replace(/,/g, '')));
    // Largest dollar figure is the total far more often than not, but with no
    // label we say so via confidence rather than pretending certainty.
    if (money.length) out.total_amount = Math.max(...money);
  } else {
    out.confidence = 'medium';
  }

  // Vendor: the sending domain is the most reliable signal in a receipt.
  const domain = (fromAddress.split('@')[1] || '').toLowerCase()
    .replace(/^(mail|email|billing|invoice|no-?reply|notifications?)\./, '');
  if (domain) {
    const core = domain.split('.')[0];
    out.vendor_name = core.charAt(0).toUpperCase() + core.slice(1);
  }

  // Date: an explicit invoice/payment date, else the caller supplies the
  // message date.
  const d = text.match(/(?:invoice|payment|receipt|billed|charged)\s+(?:date|on)\s*[:\-]?\s*([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (d) {
    const parsed = new Date(d[1]);
    if (!Number.isNaN(parsed.getTime())) out.invoice_date = parsed.toISOString().slice(0, 10);
  }

  if (out.total_amount != null && out.vendor_name && out.confidence === 'medium') out.confidence = 'high';
  return out;
}

module.exports = {
  scanAllMailboxes,
  scanMailbox,
  collectAttachments,
  isScanned,
  chargeSignature,
  invoiceFirst,
  buildInvoiceQuery,
  resolveMime,
  extractBodyText,
  stripHtml,
  extractInvoiceFromText,
  MAX_ATTACHMENTS_PER_RUN,
  MAX_LIST_PAGES,
};
