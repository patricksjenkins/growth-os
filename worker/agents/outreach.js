/**
 * Growth OS — Outreach Agent (Email-first, Facebook DM fallback)
 *
 * DESIGN (2026-04-21 — Patrick):
 *  - For each enriched, qualified lead that hasn't been sequenced yet, draft
 *    outreach in ONE channel:
 *      * contacts.email is present  → draft cold email (auto-sendable via Resend)
 *      * else facebook_url in metadata → draft Facebook Messenger DM (manual send)
 *    A lead must have EITHER to be reachable — enrichment already rejected
 *    leads without either so this is just re-checking at the outreach layer.
 *  - Drafts ONLY. Nothing auto-sends. They land in content_drafts / outreach_
 *    sequences for Patrick to review in the mobile app.
 *  - No SMS. Period.
 *
 * Pipeline:
 *   enriched lead → outreach (draft) → human approval → send
 */

const { askClaudeJSON } = require('../../integrations/claude');
const { stripAiTells, NO_DASH_PROMPT_RULE } = require('../../core/text-style');
const { recycleDeadDrafts } = require('../../core/revenue/actionable-drafts');
const { leadIdsWithContactEmail } = require('../../core/recipient');
const { createLogger } = require('../../core/logger');
const { getConfig, FGA_TENANT_ID } = require('../../core/config');
const { db } = require('../../db/client');
const { evaluateEmployeeFit, ICP_VERSION } = require('../../core/growth/eligibility');
const { buildFactsBlock } = require('../../core/fga-research-stats');
const { buildSignatureBlock, applyPlainSignature, applyHtmlSignature } = require('../../core/email-signature');
const { isInboundLead } = require('../../core/lead-sources');

function contactDisplayName(contact) {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim() || 'there';
}

// Hard ban list — Claude must not name specific clients in cold outreach.
// Even with prompt-level guardrails, sometimes a fabrication slips through;
// catch it here and reject the draft so the loop will skip it (re-fire next
// cron run will re-draft with a fresh prompt).
const BANNED_CLIENT_STRINGS = [
  'A Kut Above',
  'a kut above',
  'AKA Tree',
  'WellMor',
  'wellmor',
  'WellMor Benefits',
];

/**
 * Check a generated draft for banned strings (client names) and obviously
 * fabricated metrics. Returns null if clean, or an error string describing
 * the first violation found.
 */
function findGuardrailViolations(drafts) {
  const text = [
    drafts.subject || '',
    drafts.body_plain || '',
    drafts.body || '',
    drafts.body_html || '',
  ].join('\n');
  for (const banned of BANNED_CLIENT_STRINGS) {
    if (text.includes(banned)) {
      return `banned client name in draft: "${banned}"`;
    }
  }
  return null;
}

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { limit }
 */
/**
 * Choose which leads this run will draft for.
 *
 * EXPORTED so tests execute the shipped selection rather than a model of it
 * (Codex round 5: "tests a recreated selection function and source-code
 * regular expressions, not the shipped outreach agent"). Every rule that
 * decides whether an email can exist lives here and nowhere else.
 *
 * @returns {{leads: Array, starvedByUnreachable: number}}
 */
async function selectDraftCandidates(db, tenant, { dailyLimit, mode, payload = {}, stages, log }) {
  // Fetch leads in scope that haven't been sequenced yet. Source filter is
  // dropped so a manually-created lead (lead_source='manual') also gets
  // drafted — Patrick can add a lead in the app and it flows through here.
  let leadsQuery = db
    .from('leads')
    /*
     * `city` was missing from this SELECT, and it is the single most available
     * piece of personalization we hold. Over 5 days to 2026-08-09, 56 of the 65
     * drafts rejected for `missing_personalization` HAD a city on the lead, and
     * the drafter used it exactly ZERO times, because it was never given it —
     * while the prompt below simultaneously forbade any place name that is not
     * "this prospect's OWN city". An instruction to use a value the model
     * cannot see reads to it as an instruction to say nothing.
     */
    .select('id, company_name, industry, size, employee_count_actual, status, lifecycle_stage, metadata, city, hq_state, phone, lead_source, email, website, lead_score, outreach_ready')
    .eq('tenant_id', tenant.id);
  if (payload.lead_id) {
    // Single-lead mode — called from enrichment's auto-enqueue for manual leads.
    leadsQuery = leadsQuery.eq('id', payload.lead_id);
    // Remediation re-drafts (payload.only_channels) intentionally target leads
    // that are already 'sequenced' to backfill a missing channel, so skip the
    // stage filter in that mode. Normal single-lead runs keep it.
    if (!Array.isArray(payload.only_channels) || !payload.only_channels.length) {
      leadsQuery = leadsQuery.in('lifecycle_stage', stages);
    }
  } else {
    /*
     * HEAD-OF-LINE BLOCKING — why 0 emails went out for weeks (2026-07-26).
     *
     * This took the OLDEST `dailyLimit` leads at 'enriched'/'scored'. It did
     * not require that a lead have an email address. 37 of the 40 oldest had
     * no email anywhere — not on the lead, not on any contact — so the run
     * spent its entire daily budget on leads that could never be emailed,
     * produced nothing, and left them exactly where they were. Failing a gate
     * does not advance lifecycle_stage, so the SAME 37 dead leads were the
     * oldest again on the next run, and the next, forever.
     *
     * Meanwhile 209 email-contactable leads sat behind them and were never
     * reached. It "worked for one day" because that day the head of the queue
     * happened to be clean.
     *
     * Fix: read a wide candidate window, keep only leads that can actually
     * receive the channel this run sends, and THEN apply the daily limit.
     * Oldest-first fairness is preserved among leads that are actually
     * sendable. The budget can no longer be consumed by leads that cannot
     * consume it.
     */
    leadsQuery = leadsQuery.in('lifecycle_stage', stages)
      // Targeted-campaign leads get template-based drafts from their own
      // agent — exclude them so the two prospecting systems never overlap.
      .neq('lead_source', 'targeted_campaign_agent')
      /*
       * SELECTION MUST AGREE WITH THE SEND GATE.
       *
       * The drafter filtered on lifecycle_stage; the gate refuses anything
       * whose STATUS is not 'new_lead' (core/auto-outreach.js). 83 leads sit
       * at lifecycle_stage='scored' with status='contacted' — already emailed
       * long ago, therefore among the oldest, therefore picked first. Every
       * one produced a draft that the gate then skipped on lead_state. We
       * spent Claude calls writing emails that were unsendable the moment
       * they were written.
       *
       * Filtering here means a draft is only ever created for a lead the gate
       * can actually approve. (2026-07-26.)
       */
      .eq('status', 'new_lead')
      // Highest-scoring first: the gate also requires lead_score >= threshold,
      // so this puts sendable leads at the front instead of leaving them
      // behind a wall of low scorers.
      .order('lead_score', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: true })
      .limit(Math.min(Math.max(dailyLimit * 20, 200), 1000));
  }
  const { data: leadsRawAll, error: leadErr } = await leadsQuery;

  if (leadErr) throw leadErr;

  let leadsRaw = leadsRawAll || [];
  let starvedByUnreachable = 0;
  if (!payload.lead_id) {
    // An email can live on the lead OR on any of its contacts, so a single
    // batched lookup decides reachability — checking only leads.email would
    // discard leads that enrichment attached a contact email to.
    const withContactEmail = await leadIdsWithContactEmail(
      db, tenant.id, leadsRaw.map((l) => l.id),
    );
    const reachable = (l) => {
      if (l.email || withContactEmail.has(l.id)) return true;
      // Facebook DM is a secondary, manual-only channel — a lead reachable
      // ONLY that way is legitimate inventory, but not for an email run.
      return mode === 'fb_fallback' && Boolean(l.metadata?.facebook_url);
    };
    const reachableLeads = leadsRaw.filter(reachable);
    starvedByUnreachable = leadsRaw.length - reachableLeads.length;
    const sendable = tenant.id === FGA_TENANT_ID
      ? reachableLeads.filter((lead) => {
        const fit = evaluateEmployeeFit(lead);
        return fit.eligible && lead.outreach_ready === true;
      })
      : reachableLeads;
    const skippedByIcpEvidence = reachableLeads.length - sendable.length;
    leadsRaw = sendable.slice(0, dailyLimit);
    if (starvedByUnreachable) {
      log.info(
        `Skipped ${starvedByUnreachable} lead(s) with no address for this channel `
        + `(mode=${mode}); drafting ${leadsRaw.length} reachable lead(s). `
        + 'These would previously have consumed the daily budget and blocked the queue.',
      );
    }
    if (skippedByIcpEvidence) {
      log.info(
        `Held ${skippedByIcpEvidence} FGA lead(s) for employee-count or score evidence; `
        + 'only confirmed 1-9 employee, outreach-ready prospects may be drafted.',
      );
    }
  }

  return { leads: leadsRaw, starvedByUnreachable };
}

async function run(tenant, payload = {}) {
  const log = createLogger('outreach', tenant.slug);

  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');

  // Per-tenant monthly outreach cap. Skips the run entirely when over.
  // Scale tier: 600/mo (matches the 40/day approx ceiling). Growth: 0
  // (outreach is Scale-only per CLAUDE.md).
  try {
    const { checkUsageOrThrow, UsageCapExceededError } = require('../../core/usage-caps');
    await checkUsageOrThrow(tenant, 'outreach_send_count', 1);
  } catch (capErr) {
    if (capErr && capErr.name === 'UsageCapExceededError') {
      log.warn(`Outreach cap hit (${capErr.used}/${capErr.cap}/month) — skipping run`);
      return { success: true, skipped: true, reason: 'monthly_cap_reached', used: capErr.used, cap: capErr.cap };
    }
    throw capErr;
  }

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'First Gen Automate');
  const brandVoice = getConfig(
    tenant,
    'brand_voice',
    'Direct, warm, and human. We help micro-businesses automate lead capture, follow-up, and online presence so they can focus on the work they love.'
  );
  // Sender identity — used in the prompt CONTEXT (the "SENDER:" line) and the
  // email/FB sign-off. Email gets the full 3-line block below; FB DMs get a
  // short configurable sign-off (no URL — FB flags cold DMs with links).
  const senderName = getConfig(tenant, 'sender_name', 'Patrick Jenkins');
  const senderTitle = getConfig(tenant, 'sender_title', 'Founder, First Gen Automate');
  const fbDmSignature = getConfig(tenant, 'fb_dm_signature', senderName);
  // 3-line cold-outreach signature block — best-practice format:
  //   Patrick Jenkins
  //   Founder, First Gen Automate
  //   (404) 496-7983 · firstgenautomate.com
  // Built from tenant config via the shared core/email-signature helper so
  // the worker (draft) and the API (send-time refresh) stay identical.
  const emailSignatureBlock = buildSignatureBlock(tenant);
  const dailyLimit = Number(payload.limit || getConfig(tenant, 'outreach_daily_limit', 15));
  // Channel mode:
  //   'email_only' (default) — draft only email leads. FB leads stay queued.
  //   'fb_fallback'          — draft FB-DM leads too. Triggered Sunday only
  //                            (or explicit payload.mode='fb_fallback') when
  //                            the weekly email count hasn't hit target.
  const mode = payload.mode || 'email_only';

  // Which lifecycle stages are in scope for this run?
  // - email-qualified leads land at 'enriched', then the scoring agent moves
  //   them to 'scored' — BOTH must be in scope or scored leads (which still
  //   have an email/facebook_url) never get a draft. Drafted leads advance to
  //   'sequenced', which the scoring agent never reverts, so no double-drafting.
  // - facebook-only leads live at 'fb_only' — only pulled on fallback
  const stages = mode === 'fb_fallback' ? ['enriched', 'scored', 'fb_only'] : ['enriched', 'scored'];

  /*
   * Recycle first: a lead whose draft went stale or failed quality is stuck at
   * lifecycle_stage 'sequenced' and can never be selected again, even though it
   * was NEVER CONTACTED and we already paid to find its address. Superseding
   * the dead draft returns it to the pool so this run can write it a fresh
   * email. (Patrick, 2026-07-26.)
   */
  let recycled = null;
  if (!payload.lead_id && !payload.skip_recycle) {
    recycled = await recycleDeadDrafts(db, { tenantId: tenant.id });
    if (recycled.error) log.warn(`Draft recycling failed: ${recycled.error}`);
    else if (recycled.recycled) {
      log.info(`Recycled ${recycled.recycled} dead draft(s), returning `
        + `${recycled.leads_returned_to_pool} never-contacted lead(s) to the pool`);
    }
  }

  const { leads: leadsRaw, starvedByUnreachable } = await selectDraftCandidates(
    db, tenant, { dailyLimit, mode, payload, stages, log },
  );

  // HARD GATE (2026-07-14): cold outreach only ever targets prospect-sourced
  // leads (allow-list in core/lead-sources.js). Inbound leads — website form,
  // web chat, missed call, voice receptionist — are customers reaching in and
  // must never be drafted a cold pitch, no matter what lifecycle stage the
  // enrichment/scoring agents parked them at.
  const inboundSkipped = (leadsRaw || []).filter((l) => isInboundLead(l));
  const outboundCandidates = (leadsRaw || []).filter((l) => !isInboundLead(l));
  const fgaIcpSkipped = tenant.id === FGA_TENANT_ID
    ? outboundCandidates.filter((lead) => {
      const fit = evaluateEmployeeFit(lead);
      return !fit.eligible || lead.outreach_ready !== true;
    })
    : [];
  const leads = tenant.id === FGA_TENANT_ID
    ? outboundCandidates.filter((lead) => {
      const fit = evaluateEmployeeFit(lead);
      return fit.eligible && lead.outreach_ready === true;
    })
    : outboundCandidates;
  for (const skip of inboundSkipped) {
    log.info(`Skipping inbound lead ${skip.id} (source=${skip.lead_source || 'null'}) — cold outreach not allowed for inbound leads`);
  }
  if (fgaIcpSkipped.length) {
    log.info(`Held ${fgaIcpSkipped.length} FGA lead(s): confirmed 1-9 employee evidence and an outreach-ready score are required`);
  }
  if (payload.lead_id && !leads.length && inboundSkipped.length) {
    return { success: true, drafted: 0, skipped_inbound: inboundSkipped.length, message: 'Lead is inbound — cold outreach not allowed' };
  }
  if (payload.lead_id && !leads.length && fgaIcpSkipped.length) {
    return {
      success: true,
      drafted: 0,
      skipped_icp_evidence: fgaIcpSkipped.length,
      message: 'FGA lead needs confirmed 1-9 employee evidence and an outreach-ready score',
    };
  }

  if (!leads || !leads.length) {
    log.info('No enriched leads waiting for outreach');
    return { success: true, drafted: 0, message: 'No enriched leads' };
  }

  let draftedEmail = 0;
  let draftedDm = 0;
  const processed = [];
  const errors = [];

  for (const lead of leads) {
    try {
      // Find primary contact (enrichment.enrichOne inserted one if it had a name/email)
      const { data: contacts } = await db
        .from('contacts')
        .select('id, first_name, last_name, title, email, linkedin_url, is_primary_contact')
        .eq('tenant_id', tenant.id)
        .eq('lead_id', lead.id)
        .order('is_primary_contact', { ascending: false })
        .limit(5);

      // Contacts can be duplicated for one lead (enrichment has historically
      // inserted multiple rows, sometimes with one missing the email AND also
      // flagged is_primary_contact=true). Ordering by is_primary alone can grab
      // the empty row and mis-classify an email lead as FB-DM-only. So:
      //   - prefer a contact that actually HAS an email
      //   - fall back to the lead's own email (leads.email)
      // A lead with an email anywhere now ALWAYS drafts an email. (2026-06-10)
      const emailContact = (contacts || []).find((c) => c.email) || null;
      const primaryContact = emailContact || (contacts && contacts[0]) || null;
      const contactEmail = emailContact?.email || lead.email || null;
      const facebookUrl = lead.metadata?.facebook_url || null;

      // Channel decision — email is the PRIMARY auto-sendable channel.
      // 2026-06-13 (Patrick directive): Facebook DM is a SECONDARY,
      // manual-only channel. The automatic runs (daily email_only AND the
      // Sunday fb_fallback) NO LONGER auto-draft FB DMs — they were never
      // auto-sent yet still consumed the monthly outreach cap as untouched
      // backups (100/203 of the cap), starving real email drafts. FB DMs are
      // now drafted ONLY when the run targets a specific lead the owner
      // explicitly triggered (payload.lead_id present — e.g. "Create Draft
      // Now" on the prospect profile).
      // Rules:
      //   - email exists                      → always draft email
      //   - FB url exists AND single-lead run  → also draft FB DM (manual trigger)
      //   - neither / automatic FB             → skip
      const singleLeadTrigger = !!payload.lead_id;
      const channelsToDraft = [];
      if (contactEmail) channelsToDraft.push('email');
      if (facebookUrl && singleLeadTrigger) {
        channelsToDraft.push('facebook_dm');
      }

      // Remediation mode (payload.only_channels): restrict to the requested
      // channel(s) AND skip any channel that already has a sequence for this
      // lead — so re-running only FILLS THE GAP (e.g. add the missing email
      // draft) and never duplicates an existing draft. Idempotent.
      if (Array.isArray(payload.only_channels) && payload.only_channels.length) {
        const { data: existingSeqs } = await db
          .from('outreach_sequences')
          .select('sequence_type')
          .eq('tenant_id', tenant.id)
          .eq('lead_id', lead.id);
        const existingTypes = new Set((existingSeqs || []).map((s) => s.sequence_type));
        const allowed = channelsToDraft.filter(
          (c) => payload.only_channels.includes(c) && !existingTypes.has(c)
        );
        channelsToDraft.length = 0;
        channelsToDraft.push(...allowed);
      }

      if (channelsToDraft.length === 0) {
        processed.push({
          lead_id: lead.id, company: lead.company_name,
          action: facebookUrl
            ? 'skipped_fb_only_awaiting_fallback'
            : 'skipped_no_channel',
        });
        continue;
      }

      const contactName = primaryContact
        ? contactDisplayName(primaryContact)
        : (lead.metadata?.owner_name || 'there');

      // Build the channel-specific prompt
      //
      // GUARDRAILS (Patrick 2026-05-14):
      //  - NEVER name specific clients (e.g. "A Kut Above", "WellMor",
      //    "WellMor Benefits"). Past Claude runs invented client outcomes
      //    ("A Kut Above booked 4 jobs in their first week") which is a
      //    fabrication — we don't have those measured numbers. Use
      //    generic "another client" framing if a social-proof beat is
      //    needed, and ground it in a real industry statistic from
      //    `fga-research-stats.js` rather than a fake client win.
      //  - The email MUST be relevant to THIS lead's industry. Don't talk
      //    about tree service in an HVAC email or vice versa. Pull
      //    industry-specific facts and references.
      //
      // The buildFactsBlock helper returns the same FACTS YOU MAY CITE
      // block used by content generation — industry-keyed stats + cross-
      // industry fallbacks, plus the explicit "do not invent numbers" rules.
      const factsBlock = buildFactsBlock(lead.industry, [], 4, 4);

      // Voice Receptionist fit signal — set by the enrichment agent based on
      // industry, employee count, and office-staff indicators. Only TRUE for
      // owner-operator field-service trades where the owner is plausibly on a
      // job site when calls come in. Default to false (omit) when missing so
      // we never pitch Voice Receptionist to a desk-bound prospect by accident.
      const voiceSignal = lead.metadata?.voice_receptionist_signal || { relevant: false, reason: null };
      const voiceReceptionistBlock = voiceSignal.relevant
        ? `

HERO PRODUCT (FEATURE HINT) — relevant for THIS lead per enrichment:
Reason from enrichment: "${voiceSignal.reason || 'fits owner-operator field-service profile'}"
The AI Voice Receptionist is the strongest differentiator we have for this
profile. When the owner can't pick up the phone, an AI assistant ("Clara")
picks up, captures the caller's details, and texts the owner a transcript
(text only — no audio recording). Included on Scale tier.
Describe it in those terms and no stronger. Do NOT say how many rings it
answers in, do NOT say it sounds human or like a real person, and do NOT
quote a missed-call statistic — the prompt used to supply "3 rings",
"sounds like a real person" and "27-62% of calls", and the quality reviewer
rejected 17 of 18 drafts on exactly those phrases (2026-07-26). Supplying
copy here that the rules below forbid just teaches the model to write
rejects. You MAY mention this — frame it around the calls they're missing right
now while they work. You do NOT have to mention it; pick whatever angle best
matches the lead's specific situation from the outreach hooks above.`
        : `

HERO PRODUCT — NOT relevant for this lead per enrichment${voiceSignal.reason ? ` (${voiceSignal.reason})` : ''}:
DO NOT mention the AI Voice Receptionist. Pick the feature angle that best
matches this lead's actual pain — usually one of: instant SMS response to
new leads (Speed-to-Lead), automated review requests, photo-driven social
content, missed-call text-back, or follow-up sequences. Choose based on
the outreach hooks above.`;

      // Website signal — does this lead already have their OWN company
      // website? enrichment stores any discovered site on lead.website
      // (often pulled off the Facebook About page via Apify). Third-party
      // / social / directory URLs don't count as "their website". If they
      // HAVE one, we must never pitch the Done-For-You Website module or
      // imply they lack a web presence — telling a business that already
      // has a site "you don't have a website" is an instant credibility
      // killer. If they don't, the "our system is your website" angle is
      // fair game.
      const rawSite = String(lead.website || '').trim().toLowerCase();
      const isDirectorySite = [
        'facebook.com', 'yelp.com', 'nextdoor.com', 'maps.google', 'g.page',
        'google.com/maps', 'bbb.org', 'angi.com', 'thumbtack.com', 'linkedin.com',
        'instagram.com', 'tiktok.com', 'yellowpages.com', 'manta.com',
      ].some((d) => rawSite.includes(d));
      const hasOwnWebsite = !!rawSite && !isDirectorySite;
      const websiteModuleBlock = hasOwnWebsite
        ? `

WEBSITE STATUS — this lead ALREADY HAS their own website (${lead.website}):
DO NOT pitch the Done-For-You Website module. DO NOT say or imply they
don't have a website, or that our system becomes/replaces their website.
Lead instead with capture/follow-up/speed-to-lead/reviews/social angles.
It's fine to note our system works alongside their existing site, but
never suggest they lack one.`
        : `

WEBSITE STATUS — no website found for this lead:
The Done-For-You Website module is a fair angle here — our system can be
their website + CRM + social presence in one. Use it only if it fits the
hook; don't force it.`;

      const commonContext = `
BUSINESS CONTEXT:
- Company: ${lead.company_name}
- Industry: ${lead.industry}
- City: ${lead.city || 'unknown'}
- State: ${lead.hq_state || 'unknown'}
- Size: ${lead.size || '1-3'} employees
- Owner/contact: ${contactName}${primaryContact?.title ? ` (${primaryContact.title})` : ''}

NAME THIS PROSPECT. The email must contain at least one of: their company name
("${lead.company_name}")${lead.city ? `, their city ("${lead.city}")` : ''}${contactName && contactName !== 'there' ? `, or the owner's first name ("${contactName}")` : ''}.
A draft that names none of them is a template, reads as one, and is rejected
before it is ever judged on its writing. ${contactName === 'there' ? 'We do NOT know this owner\'s name, so greet without one and carry the specificity in the body instead.' : ''}

WHY WE'RE REACHING OUT (${businessName}'s pitch):
We help micro businesses with fewer than 10 people reduce missed leads and
manual follow-up without hiring.
We set up and manage the system for them: it captures leads, texts them back in
under 60 seconds, follows up automatically, posts to social, and asks for
reviews. Say "set up" or "manage" — NEVER "install" (that word is a hard
rejection in the quality gate, and FGA is deployed, never installed).
${voiceReceptionistBlock}
${websiteModuleBlock}

Offer terms you may mention: 14-day free trial, everything included at one
flat monthly price. Full pricing lives at firstgenautomate.com. Setup usually takes about a week, but do NOT put a day count in the email — a timeline in writing reads as a guarantee.
DOLLAR AMOUNTS ARE OFF-LIMITS in cold outreach (founder rule, 2026-07-09): a
price in a first touch invites a cost objection before the value has landed.
Never write a specific price — not the setup fee, not the monthly rate.

VOICE: ${brandVoice}

SENDER: ${senderName}, ${senderTitle}

${factsBlock}

HARD RULES — DO NOT BREAK:
1. INDUSTRY MATCH. This email is going to a ${lead.industry} business owner.
   Every scene, example, tool reference, and pain point in the email MUST be
   from THEIR trade. Examples:
   - ${lead.industry} = HVAC → manifold gauge, condenser, thermostat, peak cooling/heating season, service truck
   - ${lead.industry} = Plumbing → wrench on a copper joint, water heater, shutoff valve, under-sink call
   - ${lead.industry} = Electrical → panel box, breakers, multimeter, weekend wiring jobs
   - ${lead.industry} = Landscaping & Tree Service → chipper, stump grinder, chainsaw, spring cleanups
   - ${lead.industry} = Roofing → pitched roof, nail gun, hail season, insurance claim
   - ${lead.industry} = Cleaning Services → caddy, recurring schedule, customer home access
   Do NOT mix industries. If you write a tree-service scene to an HVAC owner,
   the email is wrong.
2. NO INVENTED CLIENT METRICS. Do not write "A Kut Above booked 4 jobs" or
   "our tree-service client closed X" with a specific number. We don't have
   those measured outcomes. NEVER name a client by name. If you want a social-
   proof beat, use a generic reference like "another small ${lead.industry}
   shop" or "a 1-3 person crew we set up" and pair it with a real cited
   industry statistic from the FACTS YOU MAY CITE block above.
3. NO INVENTED NUMBERS. The only numbers you may cite are from the FACTS
   block above. Use 0 or 1 number. Quote it accurately. Name the source.
4. BANNED CLIENT NAMES (do not include any of these in the email body):
   "A Kut Above", "WellMor", "WellMor Benefits", "AKA", "First Gen Automate
   client named". Generic references are fine.
`;

      // Regeneration feedback: when this run was queued in response to a
      // rejected draft, the owner's reason text is injected as a high-
      // priority directive so the new draft addresses what they didn't
      // like (e.g. "Make it more about pricing" or "Drop the formal tone").
      const regenerateFeedback = (payload.regenerate_feedback || '').trim();
      const regenerateBlock = regenerateFeedback
        ? `\n\nREGENERATION FEEDBACK FROM PATRICK (priority — this is what to fix from the prior version that was rejected):\n"""${regenerateFeedback}"""\nAddress this explicitly in your new draft. If the feedback conflicts with a HARD RULE, follow the rule but honor the spirit of the feedback.\n`
        : '';

      // 2026-06-09: dual-channel — loop over [email, facebook_dm] when
      // both contact paths exist so the lead detail page can render an
      // email approval panel AND a manual FB DM panel side-by-side.
      let lastSequenceId = null;
      const channelResults = [];
      for (const channel of channelsToDraft) {
      let systemPrompt, userPrompt;
      if (channel === 'email') {
        systemPrompt = `You write cold outreach emails for a sales prospect. Output only valid JSON.\n\n${NO_DASH_PROMPT_RULE}`;
        userPrompt = `
${commonContext}

Write a COLD EMAIL to ${contactName}. Return JSON only:

{
  "subject": "Short, specific subject line. No spammy caps. No emojis. 5-9 words max.",
  "body_plain": "Plain-text email body. 4-6 short paragraphs. Conversational, warm, direct. NOT corporate. No buzzwords. No 'I hope this email finds you well'. Reference something specific about their business if you can. End with a short closing line (e.g. 'Talk soon,' or 'Hope to hear from you,') then on the next lines append the full SIGNATURE BLOCK below VERBATIM — each item on its own line, no labels, no formatting. 120-180 words max in the body BEFORE the signature.",
  "body_html": "The same body as HTML — wrap paragraphs in <p> tags. No styling, no images, no CTAs as big buttons. Just text in <p> tags with a single plain <a> link at the end if you include one."
}

CRITICAL:
- Open with a specific observation that's RELEVANT TO ${lead.industry} —
  reference a tool, a job site scene, or a seasonal pressure from that
  trade. Don't write generic "small business owner" copy.
- Pick ONE feature angle that fits this specific lead — based on the
  outreach hooks above AND the HERO PRODUCT block (which tells you whether
  Voice Receptionist is or isn't a fit for this prospect). Don't dump the
  full feature list. If Voice Receptionist is marked relevant, it's usually
  the strongest angle; if it's marked not relevant, use one of the other
  modules instead.
- One low-friction reply CTA. Ask an easy operational question, such as whether
  they handle this manually today. Do NOT ask for a meeting or demo in the
  first email; the goal is to start a human conversation.
- NEVER include a dollar amount or any specific price. If the offer belongs
  in the email at all, soften it to the 14-day free trial and point them to
  the website only if necessary. Do not add a second CTA.
- End with a short closing line ("Talk soon," / "Hope to hear from you," / "Thanks for reading,") followed by a blank line, then the SIGNATURE BLOCK exactly as written below — every line on its own line, no labels, no markdown, no extra punctuation:

SIGNATURE BLOCK (use verbatim):
${emailSignatureBlock}

- DO NOT name any client. DO NOT invent client metrics. See the HARD RULES above.

NEVER OVERPROMISE (these are the exact failures the quality reviewer rejects,
and every one of them was written by this prompt on 2026-07-26):
- NO statistics, percentages or research citations. Not one. Every "study"
  you are inclined to cite is one you invented ("AgentZap's 2026 Plumbing
  Phone Statistics" was fabricated). A prospect who checks a made-up source
  is lost permanently. Make the point without a number.
- NO performance guarantees. Not "answers every call in 3 rings", not "live
  in 7 days", not "never miss a lead". Say what it does, not how fast or how
  reliably it will do it.
- NO claim that the AI sounds human or is indistinguishable from a person.
  That implies deceiving the caller, which is both untrue and a legal risk.
- NO place name EXCEPT this prospect's own: ${lead.city ? `their city is ${lead.city}${lead.hq_state ? `, ${lead.hq_state}` : ''} — use that exact name, not a nickname or abbreviation` : (lead.hq_state ? `their state is ${lead.hq_state}; their city is unknown, so name no city` : 'their location is unknown, so name no place at all')}.
  A job-site scene set in the wrong town proves the email is a template.
- NO capability FGA does not have. It captures leads, texts back, follows up,
  asks for reviews and generates content. It has NO view of a calendar,
  schedule, dispatch board, job queue, inventory or pricing — never imply it
  can book, schedule or dispatch anything.
- Understate. Patrick has sold for 23 years: one detected exaggeration loses a
  new-company sale outright. A quieter, true email beats an impressive one.

- JSON only. No markdown.
${regenerateBlock}`;
      } else {
        // facebook_dm
        systemPrompt = `You write short, warm Facebook Messenger DMs for cold outreach. Output only valid JSON.\n\n${NO_DASH_PROMPT_RULE}`;
        userPrompt = `
${commonContext}

Write a FACEBOOK MESSENGER DM to ${lead.company_name}'s page. You do NOT know
who personally manages this page — it could be the owner, an employee, or a
relative — so NEVER open with a personal first name. Greet the business/page
instead. Return JSON only:

{
  "body": "Short DM, 3-4 short sentences. Max 350 characters. Even more casual than email — FB DMs are personal. Open with a nameless, warm greeting anchored on their page or trade — e.g. 'Hey! Saw your page and had to reach out —' or 'Hey — came across ${lead.company_name} and...'. NEVER use a personal first name. Mention one specific thing and one offer (15-min call or a free audit). No formatting, no hashtags."
}

CRITICAL:
- Sound like a human founder, not a marketing bot
- NEVER address the reader by a personal first name — we can't be sure who
  manages the page, and a wrong name reads as a bot. Greet the page/business
  or use a nameless warm opener.
- The DM MUST reference something from THEIR trade (${lead.industry}) — a
  tool, a job, a typical scene. Not a generic small-business opener.
- Pick ONE feature angle that fits this specific lead. The HERO PRODUCT
  block tells you whether the AI Voice Receptionist is a fit; if it is,
  it's usually the strongest angle ("AI that picks up when you can't,
  like when you're on a roof / under a sink / behind the counter"). If
  it isn't, use a different module that matches their situation. Don't
  dump features.
- Never open with 'I hope this message finds you well' or similar
- Do NOT mention pricing in a DM (too early — that's an email or call thing)
- Do NOT ask for their phone number
- Do NOT send any link (FB flags DMs with links as spam)
- DO NOT name any client. DO NOT invent client metrics.
- Sign off with "— ${fbDmSignature}" at the end
- JSON only.
${regenerateBlock}`;
      }

      const drafts = await askClaudeJSON(systemPrompt, userPrompt, {
        maxTokens: 1200,
        tenantSlug: tenant.slug,
      });

      if (!drafts || typeof drafts !== 'object') {
        errors.push({ lead_id: lead.id, company: lead.company_name, error: 'Malformed Claude response' });
        continue;
      }

      // The AI often truncates the signature to just the name. Strip any
      // partial signature the AI included, then append the full block so
      // every draft reliably has name + title + phone + website.
      if (channel === 'email') {
        drafts.body_plain = applyPlainSignature(drafts.body_plain, tenant);
        if (drafts.body_html) {
          drafts.body_html = applyHtmlSignature(drafts.body_html, tenant);
        }
      }

      // House style: strip em/en dashes, curly quotes, and ellipsis so the draft
      // reads human, not AI-written. Deterministic — guarantees clean copy no
      // matter what the model emitted. Applied after the signature is appended so
      // the whole saved message (both the sequence + conversation rows) is clean.
      drafts.subject = stripAiTells(drafts.subject);
      drafts.body_plain = stripAiTells(drafts.body_plain);
      drafts.body_html = stripAiTells(drafts.body_html);
      drafts.body = stripAiTells(drafts.body);

      // Guardrail post-check: reject the draft if Claude slipped a banned
      // client name in despite the prompt-level instructions.
      const violation = findGuardrailViolations(drafts);
      if (violation) {
        log.warn(`Guardrail rejected draft for ${lead.company_name}: ${violation}`);
        errors.push({ lead_id: lead.id, company: lead.company_name, error: `Guardrail: ${violation}` });
        continue;
      }

      // Insert outreach sequence
      const sequenceRow = {
        tenant_id: tenant.id,
        lead_id: lead.id,
        contact_id: primaryContact?.id || null,
        sequence_name: `${businessName} — ${channel === 'email' ? 'Cold Email' : 'FB DM'}`,
        sequence_type: channel,
        sequence_status: 'draft',
        step_number: 1,
        message_subject: drafts.subject || null,
        message_body: drafts.body_plain || drafts.body || null,
        metadata: {
          message_version: 'wide-net-seven-touch-v1',
          icp_version: tenant.id === FGA_TENANT_ID ? ICP_VERSION : null,
          ...(payload.restart_batch_id ? { restart_batch_id: payload.restart_batch_id } : {}),
        },
      };

      const { data: sequence, error: seqErr } = await db
        .from('outreach_sequences')
        .insert(sequenceRow)
        .select()
        .single();
      if (seqErr || !sequence?.id) {
        throw seqErr || new Error('Sequence insert returned no id');
      }

      if (payload.restart_batch_id) {
        const { data: bound, error: bindError } = await db
          .from('growth_restart_candidates')
          .update({ first_touch_sequence_id: sequence.id })
          .eq('tenant_id', tenant.id)
          .eq('batch_id', payload.restart_batch_id)
          .eq('lead_id', lead.id)
          .eq('decision', 'eligible')
          .not('authorized_at', 'is', null)
          .is('first_touch_sequence_id', null)
          .select('id')
          .maybeSingle();
        if (bindError || !bound?.id) {
          await db.from('outreach_sequences')
            .update({ sequence_status: 'superseded' })
            .eq('tenant_id', tenant.id)
            .eq('id', sequence.id);
          throw bindError || new Error('Restart authorization could not be bound to sequence');
        }
      }

      if (tenant.id === FGA_TENANT_ID) {
        try {
          const { recordGrowthEvent } = require('../../core/growth/events');
          await recordGrowthEvent(db, {
            tenantId: tenant.id,
            leadId: lead.id,
            eventType: 'first_touch_drafted',
            stage: 'drafted',
            sourceSystem: 'outreach_agent',
            sourceId: sequence.id,
            actor: 'outreach',
            evidence: {
              sequence_id: sequence.id,
              quality_status: 'pending_gate',
              restart_authorized: Boolean(payload.restart_batch_id),
            },
            messageVersion: sequenceRow.metadata.message_version,
            correlationId: sequence.id,
          });
        } catch (eventError) {
          log.warn(`Growth draft evidence deferred for ${sequence.id}: ${eventError.message}`);
        }
      }

      // Increment per-tenant outreach counter (fire-and-forget).
      // V1 hardening (2026-05-24): swap empty catch for a warning log so
      // mass-failures become visible in Railway.
      try {
        const { incrementUsage } = require('../../core/usage-caps');
        incrementUsage(tenant.id, 'outreach_send_count', 1).catch((e) => {
          console.warn(`[outreach] outreach_send_count increment failed for ${tenant.slug}: ${e.message}`);
        });
      } catch (e) {
        console.warn(`[outreach] usage-caps module load failed for ${tenant.slug}: ${e.message}`);
      }

      // Also insert a conversations row so mobile app approval queue picks it up
      await db.from('conversations').insert({
        tenant_id: tenant.id,
        lead_id: lead.id,
        contact_id: primaryContact?.id || null,
        sequence_id: sequence?.id || null,
        channel: channel === 'email' ? 'email' : 'facebook_dm',
        direction: 'outbound',
        message_subject: drafts.subject || null,
        message_body: drafts.body_plain || drafts.body || null,
        metadata: {
          channel,
          body_html: drafts.body_html || null,
          facebook_url: facebookUrl,
          draft_status: 'awaiting_approval',
          generated_at: new Date().toISOString(),
        },
      });

      if (channel === 'email') draftedEmail++;
      else draftedDm++;

      lastSequenceId = sequence?.id || lastSequenceId;
      channelResults.push({ channel, sequence_id: sequence?.id });
      log.info(`Drafted ${channel} for ${lead.company_name}`);
      } // end channel loop

      // Advance lifecycle ONCE after all channel drafts complete so the
      // lead isn't re-drafted on the next run.
      if (channelResults.length > 0) {
        await db.from('leads')
          .update({ lifecycle_stage: 'sequenced' })
          .eq('id', lead.id)
          .eq('tenant_id', tenant.id);
        processed.push({
          lead_id: lead.id,
          company: lead.company_name,
          channels: channelResults.map((r) => r.channel),
          sequence_ids: channelResults.map((r) => r.sequence_id),
        });
      }
    } catch (err) {
      log.error(`Outreach failed: ${lead.company_name}`, err);
      errors.push({ lead_id: lead.id, company: lead.company_name, error: err.message });
    }
  }

  /*
   * HAND THE DRAFTS TO THE SENDER.
   *
   * Drafting and sending were two independently scheduled agents with nothing
   * connecting them. On 2026-07-26 the corrected drafter produced 25 drafts at
   * 4:44pm; the last sender had run at 4:35pm and no other was queued, so the
   * drafts sat there and the day closed at 0/25. Every job reported success.
   *
   * A draft that no sender is scheduled to look at is not progress toward the
   * outcome — it is inventory nobody asked for. Completing a draft run now
   * queues the gated sender explicitly, so the chain
   *   eligible prospect -> draft -> gate -> send
   * has no gap that depends on two crons happening to line up.
   *
   * The sender re-runs every gate itself (caps, suppression, dedupe,
   * deliverability, ICP). This enqueues an EVALUATION, it does not authorise a
   * send, and it cannot exceed the daily cap.
   */
  let senderQueued = null;
  if (draftedEmail > 0 && !payload.skip_send_handoff) {
    /*
     * IDEMPOTENT: a sender already waiting will pick these drafts up, so a
     * second job would only duplicate work and burn a queue slot. Two draft
     * runs finishing close together (the guardian can trigger one while a cron
     * run is in flight) would otherwise stack senders.
     */
    const { data: pending } = await db.from('agent_jobs')
      .select('id').eq('tenant_id', tenant.id).eq('agent_name', 'auto-outreach')
      .in('status', ['pending', 'processing']).limit(1);
    if (pending && pending.length) {
      senderQueued = { ok: true, job_id: pending[0].id, deduped: true };
      log.info(`Sender already queued (job ${pending[0].id}) — not stacking another`);
    } else {
    const { data: queued, error: qErr } = await db.from('agent_jobs').insert({
      tenant_id: tenant.id,
      agent_name: 'auto-outreach',
      status: 'pending',
      payload: { trigger: 'draft_handoff', drafted_email: draftedEmail },
    }).select('id').maybeSingle();
    if (!qErr && !queued?.id) {
      // An insert that returns no row is NOT a queued job. Reporting it as one
      // is the same false-green the queueJob helper was written to kill.
      log.error('Draft handoff insert returned no job id — treating as NOT queued');
      senderQueued = { ok: false, error: 'insert returned no job id' };
    } else if (qErr) {
      // Surfaced, never swallowed: a failed handoff means the drafts are
      // stranded again, and the run must not look clean.
      log.error(`Draft handoff FAILED to queue the sender: ${qErr.message}`);
      senderQueued = { ok: false, error: qErr.message };
    } else {
      senderQueued = { ok: true, job_id: queued.id };
      log.info(`Queued gated sender for ${draftedEmail} fresh draft(s) (job ${queued.id})`);
    }
    }
  }

  const result = {
    // A draft run that could not hand off has not completed its part of the
    // outcome chain, however many drafts it wrote.
    success: senderQueued ? senderQueued.ok !== false : true,
    error: senderQueued && senderQueued.ok === false
      ? `drafted ${draftedEmail} but failed to queue the sender: ${senderQueued.error}`
      : undefined,
    drafted_email: draftedEmail,
    drafted_facebook_dm: draftedDm,
    drafted_total: draftedEmail + draftedDm,
    skipped_unreachable: starvedByUnreachable || undefined,
    recycled_drafts: recycled?.recycled || undefined,
    sender_queued: senderQueued,
    processed,
    errors,
  };
  log.success(
    `Outreach complete: ${draftedEmail} email + ${draftedDm} FB DM = ${draftedEmail + draftedDm} drafts`
    + (senderQueued?.ok ? ' -> sender queued' : '')
  );
  return result;
}

module.exports = run;
module.exports.selectDraftCandidates = selectDraftCandidates;
