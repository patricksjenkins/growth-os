/**
 * Outreach Cadence agent — advances the Outreach Center.
 *
 * For each enrollment whose next_send_at is due:
 *   1. Stop it if it should auto-stop (quote won/lost, review received, opted out).
 *   2. Build the current step's draft message(s).
 *   3. If the type has auto-send ON and this is a FOLLOW-UP step (>1), send now
 *      and advance. Otherwise mark needs_review so the owner approves + sends.
 *
 * Step 1 (the first touch) is NEVER auto-sent — always owner-approved.
 * SMS only ever goes to completed-job contacts (enforced in core/outreach).
 */
const O = require('../../core/outreach');
const { db } = require('../../db/client');
const { getConfig } = require('../../core/config');
const { createLogger } = require('../../core/logger');

async function run(tenant, payload = {}) {
  const log = createLogger('outreach-cadence', tenant.slug);
  const tenantId = tenant.id;
  const limit = payload.limit || 50;
  const nowIso = new Date().toISOString();

  const { data: due, error } = await db.from('outreach_enrollments').select('*')
    .eq('tenant_id', tenantId).eq('status', 'active').lte('next_send_at', nowIso)
    .order('next_send_at', { ascending: true }).limit(limit);
  if (error) { log.error(`query failed: ${error.message}`); return { error: error.message }; }
  if (!due || !due.length) return { due: 0 };

  const auto = {};
  for (const t of O.OUTREACH_TYPES) {
    const v = getConfig(tenant, `outreach_autosend_${t}`, false);
    auto[t] = v === true || v === 'true';
  }

  let drafted = 0, sent = 0, stopped = 0, missing = 0, failed = 0;
  for (const enr of due) {
    try {
      const stop = await O.shouldStop(db, tenantId, enr);
      if (stop.stop) { await O.stop(db, tenantId, enr.id, stop.reason); stopped++; continue; }

      const built = await O.createDraftsForStep(db, tenantId, enr);
      if (!built.ok) {
        if (built.missing) {
          await db.from('outreach_enrollments').update({ status: 'missing_contact', updated_at: nowIso }).eq('tenant_id', tenantId).eq('id', enr.id);
          missing++;
        }
        continue;
      }

      const isFollowUp = (enr.current_step || 1) > 1;
      if (auto[enr.outreach_type] && isFollowUp) {
        let anySent = false;
        for (const m of built.drafts) { const r = await O.sendOne(db, tenant, m); if (r.ok) anySent = true; }
        if (anySent) { await O.advanceAfterSend(db, tenantId, enr); sent++; } else { failed++; }
      } else {
        await db.from('outreach_enrollments').update({ status: 'needs_review', updated_at: nowIso }).eq('tenant_id', tenantId).eq('id', enr.id);
        drafted++;
      }
    } catch (err) {
      log.warn(`enrollment ${enr.id} failed: ${err.message}`);
      failed++;
    }
  }
  log.info(`cadence: due=${due.length} drafted=${drafted} sent=${sent} stopped=${stopped} missing=${missing} failed=${failed}`);
  return { due: due.length, drafted, sent, stopped, missing, failed };
}

module.exports = run;
