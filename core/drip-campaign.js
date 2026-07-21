/**
 * First Gen Automate — Drip Campaign core
 *
 * Shared logic for the automated prospect email drip campaign:
 *   - touch-point definitions (Days 7/17/30/45/60/90/120/150/180)
 *   - send-window scheduling (Mon-Fri, 9:00-11:30 AM prospect-local,
 *     skips US federal holidays, randomized minute jitter)
 *   - enrollment lifecycle (enroll / pause / stop / complete)
 *   - pre-send safety rechecks (race-condition protection)
 *   - suppression list + signed unsubscribe tokens
 *   - template rendering ({{first_name}}, {{company}}, {{coupon_code}}, ...)
 *
 * Campaign Day 1 = the SUCCESSFUL send timestamp of the user-approved initial
 * outreach email. Failed sends never enroll. This module is used by the
 * admin routes (api/routes/admin-drip.js), the enrollment hook in
 * api/routes/admin.js, and the worker agent (worker/agents/drip-campaign.js).
 *
 * This is an FGA-internal (platform-owner) feature — all rows live under
 * FGA_TENANT_ID. It is NOT a customer-facing module.
 */

const crypto = require('crypto');
const { FGA_TENANT_ID } = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('drip-campaign');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Server-side kill switch. tenant_config key — when 'false', no enrollments
// and no sends; in-flight enrollments pause safely (the agent no-ops).
const DRIP_CONFIG_KEY = 'drip_campaign_enabled';

const DEFAULT_TZ = 'America/New_York';

// Send window (prospect-local time)
const WINDOW_START_MIN = 9 * 60; // 9:00 AM
const WINDOW_END_MIN = 11 * 60 + 30; // 11:30 AM

// Each touch point has a DISTINCT strategic purpose. `brief` feeds the
// Claude template-generation prompt; `coupon` marks steps that reference
// the prospect's first-month-free promotion code.
const TOUCH_POINTS = [
  { day: 7, purpose: 'helpful_follow_up', coupon: false, brief: 'Helpful, no-pressure follow-up to the initial outreach. Reference that we reached out about a week ago, add ONE genuinely useful observation about how missed leads cost small businesses, soft CTA to reply.' },
  { day: 17, purpose: 'different_pain_point', coupon: false, brief: 'Lead with a DIFFERENT pain point than the initial email and Day 7 (e.g. after-hours calls going to voicemail, review volume, follow-up slipping). New subject line, new opening, new CTA.' },
  { day: 30, purpose: 'first_month_free_offer', coupon: true, brief: 'Present the offer: first month of the Growth plan free with their personal promo code {{coupon_code}}, code expires {{coupon_expires}}. Be explicit and honest that the one-time $199 setup fee still applies — only the first monthly subscription payment is waived. Growth plan only.' },
  { day: 45, purpose: 'value_story_tagline', coupon: false, brief: 'A different value angle — what a typical week looks like with agents handling lead capture, text-back, follow-up and review requests. Must close with the exact tagline: "Automate the Overhead, Focus on the Work."' },
  { day: 60, purpose: 'offer_reminder_urgency', coupon: true, brief: 'Remind them their personal first-month-free code {{coupon_code}} is still unredeemed and expires on {{coupon_expires}} (Day 90 of their campaign). Honest urgency, no fake scarcity. Restate the $199 setup fee still applies.' },
  { day: 90, purpose: 'long_term_value', coupon: false, brief: 'Long-term relationship tone. No offer (their code has now expired — do not mention it). Focus on the compounding value of never losing a lead. Low-pressure.' },
  { day: 120, purpose: 'educational', coupon: false, brief: 'Educational: one concrete, useful idea they can apply WITHOUT buying anything (e.g. a simple missed-call text-back habit). Position FGA as the automated version of that advice.' },
  { day: 150, purpose: 'alternative_problem', coupon: false, brief: 'Address a problem not yet covered in any prior email (e.g. content/social presence going stale, referrals untracked). Fresh subject and opening.' },
  { day: 180, purpose: 'final_touch', coupon: false, brief: 'Final touch. Graceful, respectful close: this is the last scheduled email, the door stays open, one-line recap of what FGA does. No guilt-tripping.' },
];

const TOUCH_DAYS = TOUCH_POINTS.map((t) => t.day);

// Lead statuses that mean the prospect must NOT receive drip sends.
// Unified 2026-07-21: sourced from core/growth/lead-status.js (adds
// interested/declined/unsubscribed/bounced, which this set was missing —
// strictly more protective). NOTE for admin-drip re-enrollment: its
// deliberate "no_response may re-enroll" carve-out is preserved there.
const { NEVER_COLD_CONTACT } = require('./growth/lead-status');
const TERMINAL_LEAD_STATUSES = NEVER_COLD_CONTACT;

// ---------------------------------------------------------------------------
// Timezone + holiday helpers (no external date lib)
// ---------------------------------------------------------------------------

/** Read Y/M/D + weekday + H/M of an instant as seen in a given IANA tz. */
function partsInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  return {
    year: Number(map.year), month: Number(map.month), day: Number(map.day),
    hour: Number(map.hour), minute: Number(map.minute), weekday: map.weekday,
  };
}

/** UTC instant for wall-clock (y, m, d, hh, mm) in tz. Two-pass DST-safe. */
function zonedTimeToUtc(year, month, day, hour, minute, tz) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const p = partsInTz(new Date(guess), tz);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const want = Date.UTC(year, month - 1, day, hour, minute);
    guess += want - seen;
  }
  return new Date(guess);
}

function nthWeekdayOfMonth(year, month, weekday, n) {
  // month 1-12, weekday 0=Sun..6=Sat
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

function lastWeekdayOfMonth(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0)); // last day of month
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return last.getUTCDate() - offset;
}

/** Observed date for a fixed holiday (Sat -> Fri, Sun -> Mon). */
function observed(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dow = d.getUTCDay();
  if (dow === 6) return [month, day - 1 >= 1 ? day - 1 : day]; // Sat -> Fri
  if (dow === 0) return [month, day + 1]; // Sun -> Mon
  return [month, day];
}

const holidayCache = {};

/** Set of 'M-D' strings for observed US federal holidays in a year. */
function usFederalHolidays(year) {
  if (holidayCache[year]) return holidayCache[year];
  const set = new Set();
  const add = (m, d) => set.add(`${m}-${d}`);
  const addObserved = (m, d) => { const [om, od] = observed(year, m, d); add(om, od); };
  addObserved(1, 1);   // New Year's Day
  add(1, nthWeekdayOfMonth(year, 1, 1, 3));   // MLK Day (3rd Mon Jan)
  add(2, nthWeekdayOfMonth(year, 2, 1, 3));   // Presidents Day (3rd Mon Feb)
  add(5, lastWeekdayOfMonth(year, 5, 1));     // Memorial Day (last Mon May)
  addObserved(6, 19);  // Juneteenth
  addObserved(7, 4);   // Independence Day
  add(9, nthWeekdayOfMonth(year, 9, 1, 1));   // Labor Day (1st Mon Sep)
  add(10, nthWeekdayOfMonth(year, 10, 1, 2)); // Columbus Day (2nd Mon Oct)
  addObserved(11, 11); // Veterans Day
  add(11, nthWeekdayOfMonth(year, 11, 4, 4)); // Thanksgiving (4th Thu Nov)
  addObserved(12, 25); // Christmas
  // Dec 31 observed for Jan 1 falling on Saturday of NEXT year
  const nextNY = new Date(Date.UTC(year + 1, 0, 1));
  if (nextNY.getUTCDay() === 6) add(12, 31);
  holidayCache[year] = set;
  return set;
}

function isHoliday(year, month, day) {
  return usFederalHolidays(year).has(`${month}-${day}`);
}

function isWeekendDow(weekdayShort) {
  return weekdayShort === 'Sat' || weekdayShort === 'Sun';
}

/**
 * Compute the actual UTC send time for a touch point.
 * Target calendar day = Day-1 date (in tz) + dayOffset. If it lands on a
 * weekend or US federal holiday, roll FORWARD to the next business day —
 * the touch keeps its day_offset identity, only the send date shifts.
 * Time of day: random minute in 9:00-11:30 AM local (jitter).
 */
function computeSendAt(day1At, dayOffset, tz = DEFAULT_TZ) {
  const day1 = partsInTz(new Date(day1At), tz);
  // anchor at noon UTC to avoid date rollovers while adding days
  let cursor = new Date(Date.UTC(day1.year, day1.month - 1, day1.day, 12, 0));
  cursor.setUTCDate(cursor.getUTCDate() + dayOffset);

  for (let i = 0; i < 14; i++) {
    const dow = cursor.getUTCDay();
    const y = cursor.getUTCFullYear(); const m = cursor.getUTCMonth() + 1; const d = cursor.getUTCDate();
    if (dow !== 0 && dow !== 6 && !isHoliday(y, m, d)) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const minuteOfDay = WINDOW_START_MIN + Math.floor(Math.random() * (WINDOW_END_MIN - WINDOW_START_MIN + 1));
  return zonedTimeToUtc(
    cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate(),
    Math.floor(minuteOfDay / 60), minuteOfDay % 60, tz,
  );
}

/** Is `now` inside the Mon-Fri 9:00-11:30 send window in tz? */
function isWithinSendWindow(now, tz = DEFAULT_TZ) {
  const p = partsInTz(now, tz);
  if (isWeekendDow(p.weekday)) return false;
  if (isHoliday(p.year, p.month, p.day)) return false;
  const mins = p.hour * 60 + p.minute;
  return mins >= WINDOW_START_MIN && mins <= WINDOW_END_MIN;
}

/** Prospect timezone: explicit metadata wins, otherwise FGA default (ET). */
function tzForLead(lead) {
  const tz = lead?.metadata?.timezone || lead?.timezone;
  if (tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (_) { /* invalid */ }
  }
  return DEFAULT_TZ;
}

/**
 * For migrating existing prospects: the next touch point whose natural
 * date is in the FUTURE relative to `now`. Returns null when the prospect
 * is past Day 180 (-> No Response).
 */
function nextFutureTouch(day1At, now = new Date()) {
  const elapsedDays = (now.getTime() - new Date(day1At).getTime()) / 86400000;
  for (const t of TOUCH_POINTS) {
    if (t.day > elapsedDays) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unsubscribe tokens
// ---------------------------------------------------------------------------

function unsubSecret() {
  return process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || 'fga-unsub-fallback';
}

function buildUnsubscribeToken(leadId, email) {
  const payload = `${leadId}:${(email || '').toLowerCase()}`;
  const sig = crypto.createHmac('sha256', unsubSecret()).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

function verifyUnsubscribeToken(token) {
  try {
    const [b64, sig] = String(token).split('.');
    const payload = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = crypto.createHmac('sha256', unsubSecret()).update(payload).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const idx = payload.indexOf(':');
    return { leadId: payload.slice(0, idx), email: payload.slice(idx + 1) };
  } catch (_) {
    return null;
  }
}

function unsubscribeUrl(leadId, email) {
  const base = process.env.API_URL || 'https://growth-os-production-22b3.up.railway.app';
  return `${base.replace(/\/$/, '')}/api/drip/unsubscribe?token=${buildUnsubscribeToken(leadId, email)}`;
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

async function isSuppressed(db, email) {
  if (!email) return true;
  const { data } = await db
    .from('drip_suppressions')
    .select('id, reason')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('email', email.toLowerCase())
    .maybeSingle();
  return data ? data.reason : null;
}

async function suppress(db, { email, reason, source = null, leadId = null }) {
  if (!email) return;
  await db.from('drip_suppressions').upsert({
    tenant_id: FGA_TENANT_ID,
    email: email.toLowerCase(),
    reason,
    source,
    lead_id: leadId,
  }, { onConflict: 'tenant_id,email' });
}

// ---------------------------------------------------------------------------
// Campaign + flag
// ---------------------------------------------------------------------------

function isDripEnabled(tenant) {
  const { getConfig } = require('./config');
  const v = getConfig(tenant, DRIP_CONFIG_KEY, 'false');
  return v === true || v === 'true';
}

async function getActiveCampaign(db) {
  const { data } = await db
    .from('drip_campaigns')
    .select('*')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('status', 'active')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function getCampaignSteps(db, campaignId) {
  const { data } = await db
    .from('drip_campaign_steps')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('day_offset', { ascending: true });
  return data || [];
}

// ---------------------------------------------------------------------------
// Enrollment lifecycle
// ---------------------------------------------------------------------------

/**
 * Enroll a lead after a SUCCESSFUL approved initial send.
 * Never throws — returns { enrolled, enrollment? , skipped_reason? } so the
 * send path can't be broken by drip bookkeeping.
 */
async function enrollLead(db, {
  leadId, email, day1At, enrolledBy = 'system',
  startAtDay = null, catchUp = false, tenant = null, lead = null,
}) {
  try {
    if (tenant && !isDripEnabled(tenant)) {
      return { enrolled: false, skipped_reason: 'feature_disabled' };
    }
    const campaign = await getActiveCampaign(db);
    if (!campaign) return { enrolled: false, skipped_reason: 'no_active_campaign' };

    const suppressedReason = await isSuppressed(db, email);
    if (suppressedReason) return { enrolled: false, skipped_reason: `suppressed:${suppressedReason}` };

    const { data: existing } = await db
      .from('drip_enrollments')
      .select('id, status')
      .eq('lead_id', leadId)
      .in('status', ['active', 'paused', 'review'])
      .maybeSingle();
    if (existing) return { enrolled: false, skipped_reason: 'already_enrolled', enrollment: existing };

    const firstDay = startAtDay || TOUCH_DAYS[0];
    if (!TOUCH_DAYS.includes(firstDay)) {
      return { enrolled: false, skipped_reason: `invalid_start_day:${firstDay}` };
    }
    const tz = tzForLead(lead);
    const nextSendAt = computeSendAt(day1At, firstDay, tz);

    const { data: enrollment, error } = await db
      .from('drip_enrollments')
      .insert({
        tenant_id: FGA_TENANT_ID,
        lead_id: leadId,
        campaign_id: campaign.id,
        campaign_version: campaign.version,
        status: 'active',
        day1_at: new Date(day1At).toISOString(),
        next_step_day: firstDay,
        next_send_at: nextSendAt.toISOString(),
        catch_up_used: !!catchUp,
        enrolled_by: enrolledBy,
        metadata: { email: (email || '').toLowerCase(), timezone: tz },
      })
      .select()
      .single();
    if (error) {
      // unique partial index race — someone enrolled concurrently
      if (String(error.message).includes('uq_drip_enrollments_active_lead')) {
        return { enrolled: false, skipped_reason: 'already_enrolled' };
      }
      throw error;
    }

    await db.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID,
      agent: enrolledBy,
      action: 'drip_enrolled',
      entity_type: 'lead',
      entity_id: leadId,
      level: 'info',
      metadata: {
        enrollment_id: enrollment.id, campaign_id: campaign.id,
        campaign_version: campaign.version, day1_at: enrollment.day1_at,
        first_touch_day: firstDay, next_send_at: enrollment.next_send_at,
      },
    });

    return { enrolled: true, enrollment };
  } catch (err) {
    log.error(`enrollLead failed for ${leadId}: ${err.message}`);
    return { enrolled: false, skipped_reason: `error:${err.message}` };
  }
}

/** Stop an enrollment (reply / unsubscribe / bounce / manual / completed). */
async function stopEnrollment(db, enrollmentId, { status = 'stopped', reason, by = 'system' }) {
  const { data: enrollment } = await db
    .from('drip_enrollments')
    .update({
      status,
      stopped_reason: reason || null,
      stopped_by: by,
      next_send_at: null,
      next_step_day: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', enrollmentId)
    .select()
    .maybeSingle();

  // cancel any still-scheduled sends
  await db.from('drip_sends')
    .update({ status: 'skipped', skip_reason: `enrollment_${status}:${reason || ''}`, updated_at: new Date().toISOString() })
    .eq('enrollment_id', enrollmentId)
    .in('status', ['scheduled']);

  if (enrollment) {
    await db.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID,
      agent: by,
      action: `drip_${status}`,
      entity_type: 'lead',
      entity_id: enrollment.lead_id,
      level: 'info',
      metadata: { enrollment_id: enrollmentId, reason: reason || null },
    });
  }
  return enrollment;
}

async function pauseEnrollment(db, enrollmentId, { reason, until = null, by = 'system' }) {
  const { data: enrollment } = await db
    .from('drip_enrollments')
    .update({
      status: 'paused',
      paused_reason: reason || null,
      paused_until: until ? new Date(until).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', enrollmentId)
    .in('status', ['active', 'review'])
    .select()
    .maybeSingle();
  if (enrollment) {
    await db.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID, agent: by, action: 'drip_paused',
      entity_type: 'lead', entity_id: enrollment.lead_id, level: 'info',
      metadata: { enrollment_id: enrollmentId, reason, until },
    });
  }
  return enrollment;
}

async function resumeEnrollment(db, enrollmentId, { by = 'system' } = {}) {
  const { data: existing } = await db
    .from('drip_enrollments').select('*').eq('id', enrollmentId).maybeSingle();
  if (!existing || !['paused', 'review'].includes(existing.status)) return null;

  // Recompute the next send: keep the same touch point, shift the date if
  // its natural slot already passed (next business-day window).
  const stepDay = existing.next_step_day || nextFutureTouch(existing.day1_at)?.day || null;
  if (!stepDay) {
    return stopEnrollment(db, enrollmentId, { status: 'completed', reason: 'no_remaining_touches', by });
  }
  let sendAt = computeSendAt(existing.day1_at, stepDay, existing.metadata?.timezone || DEFAULT_TZ);
  if (sendAt < new Date()) {
    sendAt = computeSendAt(new Date().toISOString(), 1, existing.metadata?.timezone || DEFAULT_TZ);
  }
  const { data: enrollment } = await db
    .from('drip_enrollments')
    .update({
      status: 'active', paused_reason: null, paused_until: null,
      next_step_day: stepDay, next_send_at: sendAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', enrollmentId)
    .select()
    .maybeSingle();
  if (enrollment) {
    await db.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID, agent: by, action: 'drip_resumed',
      entity_type: 'lead', entity_id: enrollment.lead_id, level: 'info',
      metadata: { enrollment_id: enrollmentId, next_step_day: stepDay, next_send_at: sendAt.toISOString() },
    });
  }
  return enrollment;
}

// ---------------------------------------------------------------------------
// Pre-send safety recheck (race-condition protection)
// ---------------------------------------------------------------------------

/**
 * Re-verify EVERYTHING immediately before a send.
 * Returns { ok: true, lead, email } or { ok: false, action: 'skip'|'stop',
 * reason, stopStatus? }.
 */
async function preSendCheck(db, enrollment, tenant) {
  // 1. feature flag
  if (tenant && !isDripEnabled(tenant)) {
    return { ok: false, action: 'skip', reason: 'feature_disabled' };
  }

  // 2. enrollment still active
  const { data: fresh } = await db
    .from('drip_enrollments').select('*').eq('id', enrollment.id).maybeSingle();
  if (!fresh || fresh.status !== 'active') {
    return { ok: false, action: 'skip', reason: `enrollment_${fresh ? fresh.status : 'missing'}` };
  }

  // 3. campaign still active + same version family
  const { data: campaign } = await db
    .from('drip_campaigns').select('id, status').eq('id', fresh.campaign_id).maybeSingle();
  if (!campaign || campaign.status !== 'active') {
    return { ok: false, action: 'skip', reason: 'campaign_not_active' };
  }

  // 4. lead still exists + stage not terminal
  const { data: lead } = await db
    .from('leads').select('*').eq('id', fresh.lead_id).maybeSingle();
  if (!lead) return { ok: false, action: 'stop', stopStatus: 'stopped', reason: 'lead_deleted' };
  if (TERMINAL_LEAD_STATUSES.has(lead.status)) {
    const stopStatus = lead.status === 'replied' ? 'replied' : 'stopped';
    return { ok: false, action: 'stop', stopStatus, reason: `lead_status_${lead.status}` };
  }

  // 5. resolve email + suppression
  const email = fresh.metadata?.email || lead.email || null;
  if (!email) return { ok: false, action: 'stop', stopStatus: 'stopped', reason: 'no_email' };
  const suppressedReason = await isSuppressed(db, email);
  if (suppressedReason) {
    const stopStatus = suppressedReason === 'bounce' ? 'bounced' : 'unsubscribed';
    return { ok: false, action: 'stop', stopStatus, reason: `suppressed:${suppressedReason}` };
  }

  // 6. genuine reply arrived since Day 1?
  const { data: replyRow } = await db
    .from('drip_inbound')
    .select('id')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('lead_id', fresh.lead_id)
    .eq('classification', 'genuine_reply')
    .limit(1)
    .maybeSingle();
  if (replyRow) {
    return { ok: false, action: 'stop', stopStatus: 'replied', reason: 'genuine_reply_on_record' };
  }

  // 7. this touch already sent? (unique constraint is the hard guard;
  //    this avoids burning an attempt)
  const { data: priorSend } = await db
    .from('drip_sends')
    .select('id, status')
    .eq('enrollment_id', fresh.id)
    .eq('day_offset', fresh.next_step_day)
    .in('status', ['sent', 'sending'])
    .maybeSingle();
  if (priorSend) {
    return { ok: false, action: 'skip', reason: `touch_already_${priorSend.status}` };
  }

  return { ok: true, enrollment: fresh, lead, email };
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/** Replace {{token}} placeholders. Unknown tokens become '' (never leak braces). */
function renderTemplate(template, vars = {}) {
  return String(template || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Standard personalization vars for a lead. */
function templateVars(lead, extra = {}) {
  const first = (lead?.name || '').trim().split(/\s+/)[0] || 'there';
  return {
    first_name: first,
    name: lead?.name || '',
    company: lead?.company_name || lead?.company || 'your business',
    city: lead?.city || '',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Step email rendering (shared by the worker send path + admin preview)
// ---------------------------------------------------------------------------

function formatCouponExpiry(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: DEFAULT_TZ,
  });
}

/**
 * Render a touch-point email for a lead. Resolves coupon vars for
 * coupon-bearing steps (Day 30 creates the code when `ensureCoupon`,
 * Day 60 reuses it) and appends the visible unsubscribe footer.
 *
 * Returns { ok: true, subject, html, email, unsubscribeUrl: url } or
 * { ok: false, reason } (e.g. coupon redeemed/expired -> skip the touch).
 */
async function renderStepEmail(db, { step, lead, enrollment, ensureCoupon = false, preview = false }) {
  const tp = TOUCH_POINTS.find((t) => t.day === step.day_offset);
  const email = enrollment?.metadata?.email || lead.email || null;
  if (!email && !preview) return { ok: false, reason: 'no_email' };

  let couponVars = {};
  if (tp?.coupon) {
    const { ensureProspectCoupon, getActiveCoupon } = require('./drip-coupon');
    let coupon = await getActiveCoupon(db, lead.id);
    if (!coupon && ensureCoupon && !preview) {
      coupon = await ensureProspectCoupon(db, { lead, enrollment });
    }
    if (preview && (!coupon || coupon.status !== 'active')) {
      couponVars = { coupon_code: 'FGA-SAMPLE-CODE', coupon_expires: formatCouponExpiry(new Date(Date.now() + 60 * 86400000).toISOString()) };
    } else if (!coupon) {
      return { ok: false, reason: 'coupon_unavailable' };
    } else if (coupon.status === 'redeemed') {
      return { ok: false, reason: 'coupon_already_redeemed' };
    } else if (coupon.status !== 'active') {
      return { ok: false, reason: `coupon_${coupon.status}` };
    } else {
      couponVars = { coupon_code: coupon.code, coupon_expires: formatCouponExpiry(coupon.expires_at) };
    }
  }

  const unsubUrl = unsubscribeUrl(lead.id, email || 'preview@example.com');
  const vars = templateVars(lead, { ...couponVars, unsubscribe_url: unsubUrl });
  const subject = renderTemplate(step.subject_template, vars);
  const bodyHtml = renderTemplate(step.body_html_template, vars);

  // Designed-hybrid shell (core/email-shell.js): wordmark header, prose body,
  // ONE button that opens the site, tagline + unsubscribe footer. Coupon
  // touches additionally get the offer card and a one-click CTA that lands on
  // /pricing with the promo code pre-applied (PricingCard passes ?promo=
  // through to the Stripe payment link's prefilled_promo_code).
  const { renderOutreachEmail, withUtm, SITE } = require('./email-shell');
  const utmMeta = { campaign: 'drip', content: `day${step.day_offset}` };
  const shell = tp?.coupon && couponVars.coupon_code
    ? {
        offer: { code: couponVars.coupon_code, expires: couponVars.coupon_expires, headline: 'Your first month free' },
        cta: {
          label: 'Claim your first month free',
          url: withUtm(`${SITE}/pricing?promo=${encodeURIComponent(couponVars.coupon_code)}`, utmMeta),
        },
        unsubscribeUrl: unsubUrl,
      }
    : {
        cta: { label: 'See how First Gen Automate works', url: withUtm(`${SITE}/how-it-works`, utmMeta) },
        unsubscribeUrl: unsubUrl,
      };

  // `html` is the full shelled email (what previews show and what the worker
  // stores); the worker re-wraps `bodyHtml` after applying the send-time
  // signature so the signature lands INSIDE the card, not after the shell.
  const html = renderOutreachEmail({ ...shell, bodyHtml });

  return { ok: true, subject, html, bodyHtml, shell, email, unsubscribeUrl: unsubUrl };
}

module.exports = {
  DRIP_CONFIG_KEY,
  renderStepEmail,
  DEFAULT_TZ,
  TOUCH_POINTS,
  TOUCH_DAYS,
  TERMINAL_LEAD_STATUSES,
  computeSendAt,
  isWithinSendWindow,
  tzForLead,
  nextFutureTouch,
  buildUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
  isSuppressed,
  suppress,
  isDripEnabled,
  getActiveCampaign,
  getCampaignSteps,
  enrollLead,
  stopEnrollment,
  pauseEnrollment,
  resumeEnrollment,
  preSendCheck,
  renderTemplate,
  templateVars,
  usFederalHolidays,
};
