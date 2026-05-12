/**
 * Growth OS — FGA Content Playbook (v2)
 *
 * Source of truth for what good FGA content looks like. The values in this
 * file get upserted into tenant_config keys: content_pillars, brand_voice,
 * content_forbidden_phrases, content_required_specificity.
 *
 * REWRITE 2026-05-12 (Patrick): direction (small-biz problem/solution
 * carousels for 1-3 person service businesses) is correct. Execution was
 * bad — overlapping pillars produced repetitive posts, generic motivational
 * coach-voice copy, no concrete specifics, and the same CTAs every time.
 *
 * Changes from v1:
 * - 6 pillars now cover DISTINCT territories (educational, proof, contrarian,
 *   tactical, anti-pattern, behind-the-build). No more "guilt about missed
 *   opportunities" appearing as 4 different pillars.
 * - brand_voice expanded with concrete do/don't rules including a banned-
 *   phrases list that strips out the generic-coach idioms.
 * - Each post must include at least ONE specific anchor: a real number,
 *   a real client name, a real timeframe, or a named scenario. No vague
 *   "you're losing money" filler.
 */

const CONTENT_PILLARS = [
  // 1. TACTICAL HOW-TO — teach the niche owner a specific skill in 5 slides.
  //    Distinguishing trait: the post is genuinely useful even if they
  //    never hire FGA. Builds authority.
  `Tactical How-To — A single, specific, actionable skill that a 1-3 person service business owner can implement themselves this week. Format the carousel as: hook + the problem in plain language + the 2-3 steps + what to expect + offer to handle it for them. Each post teaches ONE thing only — not a list of 5 tips. Examples: "How to send a missed-call text that actually books the job (the exact script)", "The 3-text follow-up sequence that gets you reviews without begging", "What to say in your Google Business Profile description so it actually ranks". The post must include a concrete script, template, or step-by-step that the reader can use today.`,

  // 2. PROOF — real outcomes from real FGA clients. Distinguishing trait:
  //    the post contains a real number tied to a real business. No invented
  //    stats. If we don't have a real proof point, this pillar is skipped.
  `Client Proof — A specific result from a real FGA client. Use ONLY facts we have: A Kut Above (Patrick's mother's tree service in Georgia) and WellMor Benefits (benefits consulting in NC). DO NOT invent client names, numbers, or outcomes. If you don't have a verified fact, do not generate this post — return an error. Format: hook with the headline number, the situation before, what changed, the specific result, offer to build the same for the viewer. Avoid hype words ("crushing it", "10x", "game-changer") — let the number do the work.`,

  // 3. CONTRARIAN POV — take a clear stance against an industry assumption.
  //    Distinguishing trait: someone could disagree. Higher engagement,
  //    polarizing on purpose. The kind of post that gets saved and shared.
  `Contrarian POV — A clear, defensible stance against something most small-business advice gets wrong. Real opinion, real reasoning, not edgy-for-edge's-sake. Examples: "Stop running Google Ads until you fix your follow-up — you're paying to send leads to your voicemail", "Most plumbers don't need a website. They need a Google Business Profile and a missed-call text", "Hiring an agency for $2k/mo to post on social is the wrong problem to solve". Each post: state the stance, defend it with reasoning, address the obvious objection, end with what to do instead. NOT vague hot takes — the position must be specific enough that the reader nods or argues back.`,

  // 4. INDUSTRY DATA — real statistics from real sources, framed for the
  //    1-3 person service business. Distinguishing trait: cites a source,
  //    grounds the conversation, not invented.
  `Industry Data — A real statistic from a credible source (BrightLocal, Google, Pew, Yelp Economic Average, ServiceTitan trends report, Houzz contractor survey, etc.), framed in plain language for a service business owner. Cite the source in the carousel. NEVER invent statistics. If the only available numbers are vague generalities, do not generate this post. Format: hook with the stat as a one-line headline, what it actually means for a 1-3 person shop, the implication they probably haven't considered, what they can do about it, offer.`,

  // 5. ANTI-PATTERN — a common mistake small-business owners make, named
  //    specifically. Distinguishing trait: calls out a behavior, not a
  //    feeling. The reader recognizes themselves in the mistake.
  `Anti-Pattern — Name a specific bad habit small service businesses fall into, with enough detail that the reader thinks "that's me". Then explain why it costs them and what the alternative looks like. Examples: "The 'I'll get to it later' inbox" (treating Facebook DMs and Google Business messages as low priority), "The thank-you-text gap" (closing the job without a follow-up), "Reviews-by-mood" (only asking for reviews when you feel like it). Format: name the anti-pattern, describe the specific behavior (not vague), show the math of what it costs, name the alternative system, offer to install it. Do NOT moralize — describe behavior, not feelings.`,

  // 6. BEHIND THE BUILD — what FGA actually is, with specifics. Distinguishing
  //    trait: shows mechanics, not marketing. Photo of the dashboard, a real
  //    workflow, the actual agent doing the actual thing.
  `Behind The Build — Specific mechanics of how FGA works, shown not told. Pick ONE agent or workflow and explain it the way a curious owner would want it explained. Not "we automate everything" — instead: "Here's exactly what happens when a lead fills out your form: 1) text goes out in under 60 seconds with their name and what they asked about, 2) if no reply in 4 hours, the system sends a check-in, 3) if they reply, you get a push notification with the conversation". Name the specific agent. Show the timing. Show the handoff. No "AI-powered" or "intelligent" language — just describe what the system does.`,
];

const BRAND_VOICE = `
Confident, direct, plain-spoken. Like a contractor talking to another contractor
at a coffee shop — not like a marketer trying to sell something. Speak to a
1-3 person service business owner (plumber, electrician, tree service,
landscaper, HVAC, roofer, cleaning) who is too busy doing the actual work
to mess with marketing.

VOICE RULES:
- Short sentences. Single-syllable words where they work.
- Real numbers when you have them; specifics over generalities.
- Speak in scenes ("you're on a roof, the phone rings"), not abstractions.
- Use second person ("you", "your shop") consistently.
- No jargon: avoid "leverage", "optimize", "scale", "synergy", "ecosystem",
  "ROI", "KPI", "AI-powered", "intelligent automation", "next-level",
  "game-changing", "crushing it", "unlock", "unleash", "transform".

BANNED PHRASES (do NOT use any variant of these — they're stock-coach filler):
- "Stop leaving money on the table"
- "Your business deserves [more / better / this]"
- "While you sleep" / "While you work" (as a CTA hook)
- "Your business runs itself"
- "Work smarter, not harder"
- "Take your business to the next level"
- "What if [aspirational scenario]"
- "Are you tired of..."
- "Imagine if..."
- "It's time to..."
- "Here's the truth:"
- "Let me ask you something:"
- "The best businesses do X"
- "Top operators don't [generic behavior]"

HEADLINE STRUCTURE RULES:
- Do NOT use the pattern "[Statement]. [Echo statement]." in every post
  (e.g. "You worked all day. And still lost money."). Use it at most once
  per 6-post rotation.
- No two consecutive posts may use the same headline structure.
- Avoid headlines that work for ANY business — the headline should give
  away that this is for a service business specifically.

SPECIFICITY REQUIREMENT (every post must include at least one):
- A real number from a real source (cite the source).
- A real client name (A Kut Above or WellMor Benefits — never invented).
- A specific scenario with a time and place ("Tuesday 2pm, you're on a roof").
- A literal script, template, or step that the reader can copy.

CTA RULES:
- Vary the CTA. "Visit www.firstgenautomate.com" once per 6-post rotation max.
- Other acceptable CTAs: "DM me 'system' and I'll show you what it looks like",
  "If you want the script we use, comment 'script' below", "I'll send you the
  template — DM me", "Want this set up for your shop? DM me.", "Visit the link
  in bio to see how it works".
- The CTA should be specific to the post, not a generic site visit.
`.trim();

module.exports = {
  CONTENT_PILLARS,
  BRAND_VOICE,
};
