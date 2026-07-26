const test = require('node:test');
const assert = require('node:assert');

const {
  collectAttachments,
  resolveMime,
  buildInvoiceQuery,
  isScanned,
  chargeSignature,
  invoiceFirst,
} = require('../core/gmail-invoice-scan');

// ---------------------------------------------------------------------------
// resolveMime — Gmail's mimeType is authoritative when we recognize it, and
// the filename extension is the fallback. Real receipts routinely arrive as
// application/octet-stream, so the fallback is not a nicety.
// ---------------------------------------------------------------------------

test('resolveMime trusts a recognized declared mimeType', () => {
  assert.strictEqual(resolveMime({ mimeType: 'application/pdf', filename: 'invoice.pdf' }), 'application/pdf');
  assert.strictEqual(resolveMime({ mimeType: 'image/png', filename: 'shot.png' }), 'image/png');
});

test('resolveMime falls back to the filename extension for octet-stream', () => {
  assert.strictEqual(resolveMime({ mimeType: 'application/octet-stream', filename: 'Receipt-2026.PDF' }), 'application/pdf');
  assert.strictEqual(resolveMime({ mimeType: 'application/octet-stream', filename: 'photo.JPEG' }), 'image/jpeg');
  assert.strictEqual(resolveMime({ mimeType: '', filename: 'scan.heic' }), 'image/heic');
});

test('resolveMime returns null for things we cannot extract', () => {
  assert.strictEqual(resolveMime({ mimeType: 'application/zip', filename: 'invoices.zip' }), null);
  assert.strictEqual(resolveMime({ mimeType: 'text/calendar', filename: 'meeting.ics' }), null);
  assert.strictEqual(resolveMime({ mimeType: 'application/octet-stream', filename: 'noext' }), null);
});

// ---------------------------------------------------------------------------
// collectAttachments — depth-first walk of a real-shaped Gmail payload.
// ---------------------------------------------------------------------------

test('collectAttachments finds nested attachments and skips inline body parts', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      // plain body — no filename, no attachmentId
      { mimeType: 'text/plain', filename: '', body: { data: 'aGVsbG8' } },
      {
        mimeType: 'multipart/alternative',
        filename: '',
        parts: [{ mimeType: 'text/html', filename: '', body: { data: 'PGI-' } }],
      },
      {
        mimeType: 'application/pdf',
        filename: 'invoice-483.pdf',
        body: { attachmentId: 'ATT_1', size: 12345 },
      },
      {
        mimeType: 'multipart/related',
        filename: '',
        parts: [
          { mimeType: 'image/png', filename: 'receipt.png', body: { attachmentId: 'ATT_2', size: 999 } },
        ],
      },
    ],
  };

  const found = collectAttachments(payload);
  assert.strictEqual(found.length, 2);
  assert.deepStrictEqual(found.map((a) => a.attachmentId), ['ATT_1', 'ATT_2']);
  assert.strictEqual(found[0].mimetype, 'application/pdf');
  assert.strictEqual(found[0].size, 12345);
  assert.strictEqual(found[1].mimetype, 'image/png');
});

test('collectAttachments marks unsupported attachments with a null mimetype (never drops them silently)', () => {
  const payload = {
    parts: [
      { mimeType: 'application/zip', filename: 'all-invoices.zip', body: { attachmentId: 'ATT_Z', size: 10 } },
    ],
  };
  const found = collectAttachments(payload);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].mimetype, null);
  assert.strictEqual(found[0].declaredMime, 'application/zip');
});

test('collectAttachments requires BOTH a filename and an attachmentId', () => {
  // An inline image has an attachmentId but Gmail may report no filename.
  const payload = {
    parts: [
      { mimeType: 'image/png', filename: '', body: { attachmentId: 'INLINE_1' } },
      { mimeType: 'application/pdf', filename: 'orphan.pdf', body: { size: 5 } },
    ],
  };
  assert.deepStrictEqual(collectAttachments(payload), []);
});

test('collectAttachments tolerates a null/empty payload', () => {
  assert.deepStrictEqual(collectAttachments(null), []);
  assert.deepStrictEqual(collectAttachments({}), []);
});

// ---------------------------------------------------------------------------
// THE regression that matters. Gmail regenerates attachmentId on every
// messages.get, so dedupe MUST key on the stable `key`. Getting this wrong
// re-imports every invoice on every weekly run (it did — 6 drafts for 3
// attachments — before this was fixed).
// ---------------------------------------------------------------------------

const payloadWith = (attIds) => ({
  parts: [
    { mimeType: 'text/plain', filename: '', body: { data: 'aGk' } },
    { mimeType: 'application/pdf', filename: 'Invoice-0002.pdf', body: { attachmentId: attIds[0], size: 111 } },
    { mimeType: 'application/pdf', filename: 'Receipt-2913.pdf', body: { attachmentId: attIds[1], size: 222 } },
  ],
});

test('attachment key is STABLE even though Gmail rotates attachmentId between fetches', () => {
  const first = collectAttachments(payloadWith(['ANGjdJ_ephemeral_AAA', 'ANGjdJ_ephemeral_BBB']));
  const second = collectAttachments(payloadWith(['ANGjdJ_totally_DIFFERENT_1', 'ANGjdJ_totally_DIFFERENT_2']));

  // The ephemeral ids differ across fetches...
  assert.notDeepStrictEqual(
    first.map((a) => a.attachmentId),
    second.map((a) => a.attachmentId),
  );
  // ...but the stable keys are identical, so alreadyScanned() matches.
  assert.deepStrictEqual(first.map((a) => a.key), second.map((a) => a.key));
  assert.deepStrictEqual(first.map((a) => a.key), ['0:Invoice-0002.pdf:111', '1:Receipt-2913.pdf:222']);
});

test('attachment keys distinguish two attachments in the SAME message', () => {
  const found = collectAttachments(payloadWith(['a', 'b']));
  assert.strictEqual(new Set(found.map((a) => a.key)).size, 2);
});

test('attachment key changes when the file content changes (different size)', () => {
  const [a] = collectAttachments({ parts: [{ mimeType: 'application/pdf', filename: 'inv.pdf', body: { attachmentId: 'x', size: 100 } }] });
  const [b] = collectAttachments({ parts: [{ mimeType: 'application/pdf', filename: 'inv.pdf', body: { attachmentId: 'x', size: 200 } }] });
  assert.notStrictEqual(a.key, b.key);
});

// ---------------------------------------------------------------------------
// buildInvoiceQuery — narrow on structure, broad on words.
// ---------------------------------------------------------------------------

test('buildInvoiceQuery scans BODIES too, excludes chats, and honors the window', () => {
  // Changed 2026-07-26 on Patrick's directive ("you should have the invoice
  // scan in the email"). The old contract REQUIRED has:attachment, so every
  // body-only receipt — Vercel, Anthropic, Google, Resend — was invisible no
  // matter how often the scan ran. Attachments are now one source, not the
  // entry condition; the opt-in flag preserves the narrow behaviour.
  const q = buildInvoiceQuery(14);
  assert.doesNotMatch(q, /has:attachment/, 'body-only receipts must be reachable');
  assert.match(buildInvoiceQuery(14, { attachmentsOnly: true }), /has:attachment/);
  assert.match(q, /-in:chats/);
  assert.match(q, /newer_than:14d/);
  assert.match(q, /invoice OR receipt/);
  assert.match(q, /payment successful/, 'body-receipt phrasing must be searched');
});

test('buildInvoiceQuery does not restrict to in:inbox (receipts get auto-archived)', () => {
  assert.doesNotMatch(buildInvoiceQuery(7), /[^-]in:inbox/);
});

test('buildInvoiceQuery searches Spam (forwarded invoices land there) but never Trash', () => {
  const q = buildInvoiceQuery(14);
  assert.match(q, /in:anywhere/);   // default Gmail search skips Spam
  assert.match(q, /-in:trash/);     // ...but don't resurrect deleted mail
});

test('buildInvoiceQuery excludes Sent — an invoice WE send a client is revenue, not an expense', () => {
  const q = buildInvoiceQuery(14);
  assert.match(q, /-in:sent/);
  assert.match(q, /-in:drafts/);
});

// ---------------------------------------------------------------------------
// isScanned — must honor BOTH the stable key and the legacy filename-only rows
// backfilled by migration 065. Missing the legacy form re-imports each
// pre-existing invoice exactly once, which is how this bug was found the
// second time.
// ---------------------------------------------------------------------------

const att = { key: '0:Invoice-0002.pdf:116690', filename: 'Invoice-0002.pdf' };

test('isScanned matches a stable-key row', () => {
  assert.strictEqual(isScanned(new Set(['0:Invoice-0002.pdf:116690']), att), true);
});

test('isScanned matches a LEGACY filename-only row (pre-migration-065 backfill)', () => {
  assert.strictEqual(isScanned(new Set(['Invoice-0002.pdf']), att), true);
});

test('isScanned does not match an unrelated attachment', () => {
  assert.strictEqual(isScanned(new Set(['Receipt-9999.pdf', '3:Other.pdf:1']), att), false);
});

test('isScanned on an empty set is false (first sighting)', () => {
  assert.strictEqual(isScanned(new Set(), att), false);
});

// ---------------------------------------------------------------------------
// chargeSignature / invoiceFirst — "one email, one charge, one draft".
//
// Vercel emails a single $20 charge as TWO PDFs whose document numbers differ
// (Invoice-TCIVVSU4-0003 vs Receipt-2863-0182), so the ledger's dedupe_key —
// which includes the doc number — sees two separate expenses. The reviewer got
// two identical $20 rows. The charge signature must ignore the doc number.
// ---------------------------------------------------------------------------

test('chargeSignature ignores the document number (the Vercel invoice/receipt pair)', () => {
  const invoice = { vendor_name: 'Vercel Inc.', total_amount: 20, expense_date: '2026-07-04', document_number: 'TCIVVSU4 0003' };
  const receipt = { vendor_name: 'Vercel Inc.', total_amount: 20, expense_date: '2026-07-04', document_number: '2863 0182' };
  assert.strictEqual(chargeSignature(invoice), chargeSignature(receipt));
  assert.strictEqual(chargeSignature(invoice), 'vercel inc.|20.00|2026-07-04');
});

test('chargeSignature normalizes vendor case and whitespace', () => {
  const a = { vendor_name: '  Resend ', total_amount: 20, expense_date: '2026-07-04' };
  const b = { vendor_name: 'resend', total_amount: 20.0, expense_date: '2026-07-04' };
  assert.strictEqual(chargeSignature(a), chargeSignature(b));
});

test('chargeSignature separates genuinely different charges', () => {
  const base = { vendor_name: 'Vercel', total_amount: 20, expense_date: '2026-07-04' };
  assert.notStrictEqual(chargeSignature(base), chargeSignature({ ...base, total_amount: 40 }));
  assert.notStrictEqual(chargeSignature(base), chargeSignature({ ...base, expense_date: '2026-08-04' }));
  assert.notStrictEqual(chargeSignature(base), chargeSignature({ ...base, vendor_name: 'Resend' }));
});

test('chargeSignature returns null when the charge is unidentifiable (never collapse blindly)', () => {
  assert.strictEqual(chargeSignature({ vendor_name: 'Vercel', total_amount: null }), null);
  assert.strictEqual(chargeSignature({ vendor_name: '', total_amount: 20 }), null);
  assert.strictEqual(chargeSignature(null), null);
  assert.strictEqual(chargeSignature(undefined), null);
});

test('invoiceFirst keeps the invoice ahead of the receipt', () => {
  const atts = [
    { filename: 'Receipt-2863-0182.pdf' },
    { filename: 'Invoice-TCIVVSU4-0003.pdf' },
  ];
  assert.deepStrictEqual(invoiceFirst(atts).map((a) => a.filename), [
    'Invoice-TCIVVSU4-0003.pdf', 'Receipt-2863-0182.pdf',
  ]);
});

test('invoiceFirst puts unlabelled attachments between invoice and receipt', () => {
  const atts = [
    { filename: 'receipt.pdf' }, { filename: 'scan.pdf' }, { filename: 'invoice.pdf' },
  ];
  assert.deepStrictEqual(invoiceFirst(atts).map((a) => a.filename), [
    'invoice.pdf', 'scan.pdf', 'receipt.pdf',
  ]);
});

test('invoiceFirst does not mutate its input', () => {
  const atts = [{ filename: 'receipt.pdf' }, { filename: 'invoice.pdf' }];
  invoiceFirst(atts);
  assert.strictEqual(atts[0].filename, 'receipt.pdf');
});
