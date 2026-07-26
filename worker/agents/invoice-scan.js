/**
 * First Gen Automate — Weekly Gmail invoice scanner (FGA-internal)
 *
 * Scans every connected Gmail inbox for invoice/receipt attachments and files
 * them as PENDING drafts in the Expenses review inbox. Patrick reviews them the
 * same way he reviews an uploaded receipt — nothing reaches the books
 * unapproved, and the mailbox is never modified (read-only scope).
 *
 * payload.newer_than_days  — lookback window (default 14; the weekly cron
 *                            overlaps deliberately so a mail that arrived while
 *                            a run was failing still gets picked up)
 *
 * FGA-internal: a no-op for every tenant except FGA.
 */

const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');
const { FGA_TENANT_ID } = require('../../core/config');
const { scanAllMailboxes } = require('../../core/gmail-invoice-scan');

async function run(tenant, payload = {}) {
  const log = createLogger('invoice-scan', tenant.slug);

  if (tenant.id !== FGA_TENANT_ID) {
    return { success: true, skipped: 'not_fga_tenant' };
  }

  const db = getServiceClient();
  const newerThanDays = Number(payload.newer_than_days) > 0
    ? Math.min(Number(payload.newer_than_days), 365)
    : 14;

  const result = await scanAllMailboxes(db, { newerThanDays });

  if (result.skipped) {
    log.info(`Invoice scan skipped: ${result.skipped}`);
    return { success: true, ...result };
  }

  const boxes = result.mailboxes.map((m) => m.mailbox).join(', ');
  log.info(
    `Scanned ${result.mailboxes.length} mailbox(es) [${boxes}]: `
    + `${result.imported} draft(s), ${result.duplicates} duplicate(s), `
    + `${result.skipped} skipped, ${result.errors} error(s)`,
  );

  // Surface new drafts in the owner's attention queue. Only when something
  // actually landed — a quiet week should stay quiet.
  if (result.imported > 0) {
    const fresh = result.imported - result.duplicates;
    const dupNote = result.duplicates > 0
      ? ` ${result.duplicates} look like duplicates of expenses already in the books.`
      : '';
    try {
      await db.from('attention_queue').insert({
        tenant_id: FGA_TENANT_ID,
        type: 'expenses_pending_review',
        severity: 'blue',
        title: `${result.imported} invoice${result.imported === 1 ? '' : 's'} found in your email`,
        summary: `Pulled from ${boxes}. ${fresh} new expense draft${fresh === 1 ? '' : 's'} waiting for review.${dupNote} Nothing has been added to your books yet.`,
        payload: {
          imported: result.imported,
          duplicates: result.duplicates,
          mailboxes: result.mailboxes.map((m) => ({ mailbox: m.mailbox, imported: m.imported })),
          drafts: result.drafts.slice(0, 20),
        },
        produced_by: 'invoice-scan',
      });
    } catch (err) {
      log.warn(`attention_queue insert failed: ${err.message}`);
    }
  }

  // A mailbox whose token died needs a human to reconnect it — say so loudly.
  const broken = result.mailboxes.filter((m) => m.fatal);
  for (const m of broken) {
    log.error(`[${m.mailbox}] ${m.fatal}`);
    try {
      await db.from('attention_queue').insert({
        tenant_id: FGA_TENANT_ID,
        type: 'gmail_connection_failed',
        severity: 'amber',
        title: `Email scanning stopped for ${m.mailbox}`,
        summary: `${m.fatal}. Reconnect the mailbox from Expenses to resume automatic invoice scanning.`,
        payload: { mailbox: m.mailbox, error: m.fatal },
        produced_by: 'invoice-scan',
      });
    } catch (_) { /* best effort */ }
  }

  if (result.budget_exhausted) {
    log.warn('Per-run attachment budget was exhausted — some messages were deferred to the next run.');
  }

  /*
   * A scan that hit its ceiling did NOT see the whole inbox. Reporting plain
   * success there is the false green that let a 19-import run with an
   * exhausted attachment budget pass as a clean sweep.
   */
  const incompleteScan = Boolean(result.truncated || result.budget_exhausted);
  return {
    success: !incompleteScan,
    incomplete_scan: incompleteScan || undefined,
    error: incompleteScan
      ? `Scan did not cover the full inbox (${[
        result.truncated ? 'results truncated' : null,
        result.budget_exhausted ? 'attachment budget exhausted' : null,
      ].filter(Boolean).join('; ')}). Receipts may be unseen.`
      : undefined,
    ...result,
  };
}

module.exports = run;
