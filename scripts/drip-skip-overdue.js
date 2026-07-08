#!/usr/bin/env node
/**
 * One-off repair: skip drip touches that are overdue, instead of firing them late.
 *
 * Context (2026-07-08): a `.catch()` on a Supabase builder threw between the
 * email send and advanceCursor(), wedging 25 enrollments on their already-sent
 * Day-7 touch. Because the due query is order(next_send_at).limit(25), those 25
 * filled every slot on every run and starved 77 others for a month.
 *
 * The code bug is fixed and the queue now self-heals. But that leaves ~100
 * touches that are days-to-weeks overdue. Firing them would mean a prospect
 * receiving a "just following up on my note from last week" a month late —
 * which reads as neglect, not persistence.
 *
 * So: advance every overdue enrollment to its next touch whose NATURAL date
 * (day1_at + touch_day) is still in the future. Nothing is sent. The campaign
 * resumes on schedule from the next touch that hasn't come due yet.
 *
 * An enrollment with no future touch left has effectively finished its
 * sequence; it is completed exactly the way advanceCursor() completes one, and
 * the lead moves to `no_response`.
 *
 * Usage:
 *   node scripts/drip-skip-overdue.js            # dry run (default) — prints the plan
 *   node scripts/drip-skip-overdue.js --apply    # write
 */

require('dotenv').config();

const { getServiceClient } = require('../db/client');
const { FGA_TENANT_ID } = require('../core/config');
const drip = require('../core/drip-campaign');

const APPLY = process.argv.includes('--apply');

function fmt(d) {
  return d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '(none)';
}

async function main() {
  const db = getServiceClient();
  const now = new Date();

  // NOT `next_send_at <= now`. advanceCursor() reschedules a late touch into the
  // next business-day window, so an enrollment whose Day-17 email is three weeks
  // overdue looks perfectly "due tomorrow". The honest test is whether the
  // CURRENT touch's NATURAL date (day1_at + next_step_day) has already passed.
  const { data: all, error } = await db
    .from('drip_enrollments')
    .select('id, lead_id, next_step_day, next_send_at, day1_at, metadata, status')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('status', 'active')
    .not('next_send_at', 'is', null)
    .order('next_send_at', { ascending: true });
  if (error) throw error;

  const GRACE_HOURS = Number(process.env.DRIP_OVERDUE_GRACE_HOURS || 24);
  const cutoff = new Date(now.getTime() - GRACE_HOURS * 3600 * 1000);
  const due = all.filter((e) => {
    const tz = e.metadata?.timezone || drip.DEFAULT_TZ;
    return drip.computeSendAt(e.day1_at, e.next_step_day, tz) <= cutoff;
  });

  console.log(`\nTOUCH_DAYS: ${drip.TOUCH_DAYS.join(', ')}`);
  console.log(`Active enrollments: ${all.length}`);
  console.log(`Whose CURRENT touch is >${GRACE_HOURS}h past its natural date: ${due.length}`);
  console.log(APPLY ? '\n*** APPLYING ***\n' : '\n(dry run — pass --apply to write)\n');

  const plan = { advanced: [], completed: [], unchanged: [] };

  for (const e of due) {
    const tz = e.metadata?.timezone || drip.DEFAULT_TZ;

    // The next touch whose natural send date is still ahead of us.
    const nextDay = drip.TOUCH_DAYS.find((day) => {
      if (day <= e.next_step_day) return false;              // already passed this touch
      return drip.computeSendAt(e.day1_at, day, tz) > now;   // natural date still future
    });

    if (!nextDay) {
      plan.completed.push({ id: e.id, lead_id: e.lead_id, from_day: e.next_step_day });
      continue;
    }

    const nextAt = drip.computeSendAt(e.day1_at, nextDay, tz);
    const naturalDue = drip.computeSendAt(e.day1_at, e.next_step_day, tz);
    plan.advanced.push({
      id: e.id,
      from_day: e.next_step_day,
      to_day: nextDay,
      days_late: Math.round((now - naturalDue) / 86400000),
      was_due: fmt(e.next_send_at),
      now_due: fmt(nextAt),
      skipped_days: drip.TOUCH_DAYS.filter((d) => d >= e.next_step_day && d < nextDay),
    });
  }

  // ---- report -------------------------------------------------------------
  const byHop = {};
  for (const a of plan.advanced) {
    const k = `${a.from_day} -> ${a.to_day}`;
    byHop[k] = (byHop[k] || 0) + 1;
  }
  console.log('Advance (no email sent):');
  for (const [hop, n] of Object.entries(byHop)) console.log(`  day ${hop.padEnd(12)} x${n}`);
  if (plan.advanced.length) {
    const s = plan.advanced[0];
    console.log(`  e.g. ${s.id}: ${s.days_late}d late, was due ${s.was_due} -> now due ${s.now_due} (skips days ${s.skipped_days.join(',') || 'none'})`);
    const late = plan.advanced.map((a) => a.days_late).sort((a, b) => a - b);
    console.log(`  lateness of skipped touches: min ${late[0]}d, median ${late[Math.floor(late.length / 2)]}d, max ${late[late.length - 1]}d`);
  }
  console.log(`Complete (no future touch left): ${plan.completed.length}`);
  console.log(`Total: ${plan.advanced.length} advanced, ${plan.completed.length} completed\n`);

  if (!APPLY) return;

  // ---- apply --------------------------------------------------------------
  let ok = 0;
  for (const a of plan.advanced) {
    const e = due.find((x) => x.id === a.id);
    const tz = e.metadata?.timezone || drip.DEFAULT_TZ;
    const nextAt = drip.computeSendAt(e.day1_at, a.to_day, tz);
    const { error: uErr } = await db.from('drip_enrollments')
      .update({
        next_step_day: a.to_day,
        next_send_at: nextAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', a.id)
      .eq('status', 'active');          // don't clobber a concurrent stop/reply
    if (uErr) console.error(`  ! ${a.id}: ${uErr.message}`);
    else ok++;
  }

  let done = 0;
  for (const c of plan.completed) {
    const { error: cErr } = await db.from('drip_enrollments')
      .update({ status: 'completed', next_step_day: null, next_send_at: null, updated_at: new Date().toISOString() })
      .eq('id', c.id)
      .eq('status', 'active');
    if (cErr) { console.error(`  ! ${c.id}: ${cErr.message}`); continue; }
    await db.from('leads')
      .update({ status: 'no_response' })
      .eq('id', c.lead_id)
      .eq('tenant_id', FGA_TENANT_ID);
    done++;
  }

  await db.from('activity_log').insert({
    tenant_id: FGA_TENANT_ID,
    agent: 'drip-campaign',
    action: 'drip_overdue_skipped',
    level: 'info',
    metadata: {
      advanced: ok, completed: done, reason: 'builder_catch_wedge_repair_2026_07_08',
    },
  }).then(() => {}, () => {});

  console.log(`Applied: ${ok} advanced, ${done} completed. No emails sent.\n`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
