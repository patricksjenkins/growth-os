/**
 * The outreach review queue — ONE definition of "a draft that needs Patrick".
 *
 * Built 2026-07-24 after the dashboard shipped an alert ("7 outreach drafts
 * need manual review") whose only action was a link to the Growth Engine
 * page, leaving Patrick to hunt for the 7 drafts by hand. The alert counted
 * one thing, the Pipeline showed another, and nothing let him just approve.
 *
 * Both the COUNT (dashboard attention item) and the LIST (the Review Queue
 * page) come from this module, so the number on the alert and the rows you
 * see after clicking it can never disagree. That was the whole class of bug
 * behind "the data is wrong or not matching when you actually click".
 *
 * Predicate:
 *   email-channel sequence, status 'draft', lead still 'new_lead', with an
 *   explicit `needs_review` autosend verdict for that exact newest sequence.
 * Unevaluated drafts remain agent-owned; blocked drafts remain machine
 * exceptions. Neither becomes Patrick work merely because a draft exists.
 *
 * One row per LEAD, not per sequence: a lead with three stale drafts is one
 * decision, and the newest draft is the one that would send. This keeps
 * list.length === count exactly.
 *
 * Always FGA-scoped — never cross-tenant (Command Center purpose directive).
 */

const { FGA_TENANT_ID } = require('../config');

// Hard ceiling on how much of the backlog we hydrate at once. PostgREST
// silently caps unbounded selects at 1000 rows, which is how a previous
// dashboard read the OLDEST slice of a table and reported nonsense — every
// query here is explicitly ordered and limited.
const MAX_QUEUE = 500;

/** Plain-text view of a draft body for reading in the queue. */
function toText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8217;/g, '’')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Why the autonomous sender held this one, in Patrick's words rather than
 * gate names. Returns { code, label, detail, score }.
 */
function explainHold(decision) {
  if (!decision) {
    return {
      code: 'not_evaluated',
      label: 'Not yet evaluated',
      detail: 'The autonomous sender has not reached this draft yet. Approving sends it now.',
      score: null,
    };
  }
  const score = decision.quality?.score ?? null;
  const map = {
    draft_quality: {
      label: 'Draft quality',
      detail: score != null
        ? `The draft scored ${score} out of 100 — below the bar for sending unattended. Read it and decide.`
        : 'The draft scored below the bar for sending unattended. Read it and decide.',
    },
    score_threshold: {
      label: 'Low lead score',
      detail: 'This prospect scored below the fit threshold, so it was never sent automatically.',
    },
    valid_email: {
      label: 'Email address flagged',
      detail: 'The address on file did not pass validation when this ran. Check it looks right before approving.',
    },
    dedupe: {
      label: 'Possible duplicate',
      detail: 'This prospect looks like one already contacted. Confirm before sending again.',
    },
    lead_state: {
      label: 'Stale draft',
      detail: 'The prospect had moved out of the outreach stage when this ran. The draft is still here if you want it.',
    },
  };
  const known = map[decision.reason];
  return {
    code: decision.reason || 'held',
    label: known ? known.label : 'Held for review',
    detail: known ? known.detail : 'The autonomous sender held this one for a human decision.',
    score,
  };
}

const DECISION_CHUNK = 100;

/**
 * Read the latest gate verdict for exact sequence IDs without constructing a
 * proxy-hostile URL. A lead-level verdict is not sufficient: regenerated copy
 * must return to agent ownership until that exact draft is evaluated.
 */
async function loadLatestDraftDecisions(db, sequenceIds = []) {
  const latest = new Map();
  for (let offset = 0; offset < sequenceIds.length; offset += DECISION_CHUNK) {
    const chunk = sequenceIds.slice(offset, offset + DECISION_CHUNK);
    const { data, error } = await db.from('autosend_decisions')
      .select('lead_id, sequence_id, decision, reason, quality, created_at')
      .eq('tenant_id', FGA_TENANT_ID)
      .in('sequence_id', chunk)
      .order('created_at', { ascending: false })
      .limit(chunk.length * 10);
    if (error) throw error;
    for (const row of data || []) {
      if (row.sequence_id && !latest.has(row.sequence_id)) latest.set(row.sequence_id, row);
    }
  }
  return latest;
}

/**
 * Classify every current draft by accountable owner. Only an explicit
 * `needs_review` verdict on the exact newest sequence creates Patrick work.
 * Unevaluated drafts remain with auto-outreach; a `blocked` verdict remains a
 * machine exception and cannot be manually waved through from the review UI.
 */
async function loadDraftOwnership(db, { limit = MAX_QUEUE } = {}) {
  const capped = Math.min(Number(limit) || MAX_QUEUE, MAX_QUEUE);

  const { data: drafts, error: dErr } = await db
    .from('outreach_sequences')
    .select('id, lead_id, message_subject, message_body, created_at')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('sequence_type', 'email')
    .eq('sequence_status', 'draft')
    .order('created_at', { ascending: false })
    .limit(capped);
  if (dErr) throw dErr;

  const leadIds = [...new Set((drafts || []).map((d) => d.lead_id).filter(Boolean))];
  if (leadIds.length === 0) {
    return {
      items: [],
      summary: { total: 0, owner_review: 0, agent_owned: 0, blocked: 0, autonomous_restart: 0 },
    };
  }

  // A restart candidate with a one-use autonomous authorization is already
  // owned by auto-outreach. Showing it as "waiting for Patrick" creates a
  // fake owner task and invites a manual send to race the scheduled sender.
  // Keep these drafts out of the review queue; if a gate later rejects one,
  // the dedicated autosend correction queue surfaces that evidence instead.
  const sequenceIds = (drafts || []).map((d) => d.id).filter(Boolean);
  const { data: autonomousRows, error: autonomousError } = await db
    .from('growth_restart_candidates')
    .select('first_touch_sequence_id')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('decision', 'eligible')
    .not('authorized_at', 'is', null)
    .is('first_touch_sent_at', null)
    .in('first_touch_sequence_id', sequenceIds)
    .limit(capped);
  if (autonomousError) throw autonomousError;
  const autonomouslyOwned = new Set(
    (autonomousRows || []).map((row) => row.first_touch_sequence_id).filter(Boolean),
  );

  // Re-assert the tenant on the leads read (defense in depth) and apply the
  // new_lead half of the predicate.
  const { data: leads, error: lErr } = await db
    .from('leads')
    .select('id, company_name, name, email, lead_score, industry, city, hq_state, website')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('status', 'new_lead')
    .in('id', leadIds)
    .limit(leadIds.length);
  if (lErr) throw lErr;
  const leadById = new Map((leads || []).map((l) => [l.id, l]));

  const decisionBySequence = await loadLatestDraftDecisions(db, sequenceIds);

  // Resolve the newest draft per lead before applying ownership. Otherwise an
  // old held draft can reappear behind newer agent-owned copy.
  const newestByLead = new Map();
  for (const d of drafts || []) {
    const lead = leadById.get(d.lead_id);
    if (!lead) continue;
    const current = newestByLead.get(d.lead_id);
    if (current) {
      current.older_drafts += 1;
      continue;
    }
    newestByLead.set(d.lead_id, { draft: d, lead, older_drafts: 0 });
  }

  const items = [];
  const summary = {
    total: newestByLead.size,
    owner_review: 0,
    agent_owned: 0,
    blocked: 0,
    autonomous_restart: 0,
  };
  for (const { draft: d, lead, older_drafts } of newestByLead.values()) {
    if (autonomouslyOwned.has(d.id)) {
      summary.agent_owned += 1;
      summary.autonomous_restart += 1;
      continue;
    }
    const decision = decisionBySequence.get(d.id);
    if (!decision) {
      summary.agent_owned += 1;
      continue;
    }
    if (decision.decision === 'blocked') {
      summary.blocked += 1;
      continue;
    }
    if (decision.decision !== 'needs_review') {
      summary.agent_owned += 1;
      continue;
    }
    const hold = explainHold(decision);
    summary.owner_review += 1;
    items.push({
      sequence_id: d.id,
      lead_id: d.lead_id,
      company: lead.company_name || lead.name || 'Unknown prospect',
      contact_name: lead.name || null,
      recipient: lead.email || null,
      location: [lead.city, lead.hq_state].filter(Boolean).join(', ') || null,
      industry: lead.industry || null,
      website: lead.website || null,
      lead_score: lead.lead_score ?? null,
      subject: d.message_subject || '(no subject)',
      body: toText(d.message_body),
      created_at: d.created_at,
      hold_reason: hold.code,
      hold_label: hold.label,
      hold_detail: hold.detail,
      quality_score: hold.score,
      older_drafts,
      sendable: Boolean(lead.email),
    });
  }
  return { items, summary };
}

/**
 * Every draft awaiting Patrick's decision, newest first, fully hydrated
 * (prospect, subject, readable body, and why it was held).
 */
async function listReviewableDrafts(db, options = {}) {
  return (await loadDraftOwnership(db, options)).items;
}

/** Privacy-safe aggregate used by Growth, Pipeline, and autosend status. */
async function summarizeOutreachDraftOwnership(db, options = {}) {
  return (await loadDraftOwnership(db, options)).summary;
}

/**
 * How many drafts are waiting. Same predicate as the list — the dashboard
 * alert and the queue page are guaranteed to agree.
 */
async function countReviewableDrafts(db) {
  const summary = await summarizeOutreachDraftOwnership(db);
  return { count: summary.owner_review };
}

module.exports = {
  listReviewableDrafts,
  summarizeOutreachDraftOwnership,
  loadLatestDraftDecisions,
  countReviewableDrafts,
  explainHold,
  toText,
  MAX_QUEUE,
};
