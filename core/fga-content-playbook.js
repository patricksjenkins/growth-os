/**
 * Growth OS — FGA Content Playbook (v3 — Launch Edition)
 *
 * Source of truth for what good FGA content looks like.
 *
 * REWRITE 2026-05-13 (Patrick, pre-launch):
 *   - Pillars: 6 → 8, paired 1:1 with formats (see FORMAT_PILLAR_MAP)
 *   - Voice: keep v2 base + banned phrases, ADD positive sentence
 *     patterns (PATTERNS_TO_USE) so Claude has both what NOT to write
 *     and what TO write
 *   - Industry-aware tone microdoses lives in
 *     core/fga-content-formats.js (INDUSTRY_TONE_HINTS) — not here,
 *     because it's keyed on target_industries which is content-formats domain.
 *
 * What gets upserted into Supabase tenant_config for the FGA tenant:
 *   - content_pillars  → CONTENT_PILLARS (8 array)
 *   - brand_voice      → BRAND_VOICE (string with patterns appended)
 */

// ---------------------------------------------------------------------------
// 8 Pillars — Paired 1:1 with the 8 formats in core/fga-content-formats.js
// Each pillar is a topical territory. Each format renders that territory in
// its native visual style. The pairing is rigid so the content + visual
// always reinforce each other.
// ---------------------------------------------------------------------------
const CONTENT_PILLARS = [
  // 1 → Format 1 (One-Liner)
  `Contrarian POV — A specific, defensible stance against something most small-business advice gets wrong. Real opinion, real reasoning, not edgy-for-edge's-sake. ONE sentence, max 25 words. Examples (style only — do not reuse): "Stop running Google Ads until you fix your follow-up.", "Most plumbers don't need a website — they need a Google Business Profile and a missed-call text." The reader nods or argues back; never shrugs.`,

  // 2 → Format 2 (Quote Card)
  `Founder Voice — Patrick's personal principles, lessons from building FGA, beliefs about small service businesses. Spoken in first person ("I…") OR second person ("You think…"). Quotable. 12-25 words for the main line + 5-10 word context/attribution. Should sound like something a founder would post on LinkedIn after a long day, not a brand statement.`,

  // 3 → Format 3 (Stat Card)
  `Industry Data — A real, cited statistic relevant to this week's focus industry. Format: big number + one-line plain-English explanation + cited source. NEVER invent statistics. If no real data is available for this industry beat, return an error rather than fabricating. Acceptable sources: BrightLocal, Google research, Pew, Yelp Economic Average, ServiceTitan trends, Houzz contractor survey, Bureau of Labor Statistics, IBISWorld, industry trade association reports.`,

  // 4 → Format 4 (Before/After)
  `Industry Proof — A real, sourced industry statistic dramatized as a before/after. We do NOT have verified per-client numbers, so do NOT cite client outcomes with specific metrics ("A Kut Above booked 4 jobs" = fabrication). Instead: pick ONE stat from the FACTS YOU MAY CITE block (e.g. "62% of inbound home-service calls go unanswered — Invoca 2024"), then frame slide 1 as the "before" state that statistic describes, and slide 2 as what changes when the small shop fixes that one thing. Source must appear in the post or caption. NEVER invent percentages or dollar amounts. You MAY reference real clients in general descriptive terms ("our tree-service client in Georgia") but never with numeric outcomes we have not measured.`,

  // 5 → Format 5 (Pattern/Anti-Pattern)
  `Anti-Pattern — Name a specific bad habit small service businesses fall into, with enough behavioral detail that the reader thinks "that's me." Then show the alternative. Two-panel structure: (1) the wrong way — name it, describe the behavior concretely, show the cost; (2) the right way — name it, describe the alternative behavior, show the outcome. NOT moralizing — describe behavior, not feelings.`,

  // 6 → Format 6 (Three-Beat)
  `Tactical How-To — A single, specific, actionable skill that a 1-3 person service business owner can implement themselves this week. The post must include a concrete script, template, or step-by-step. ONE thing only — never a list of 5 tips. Examples (subject only — write fresh): how to send a missed-call text that books the job; the 3-text follow-up sequence; what to put in your Google Business Profile description.`,

  // 7 → Format 7 (Midnight Hero) — NEW pillar
  `Industry Spotlight — Pick ONE specific industry and go deep on what makes it different. The seasonal pressures, customer types, regulatory wrinkles, slow-season cash crunch, what wins look like. Long-form (5-slide narrative). Should read like a beat reporter wrote it after spending a season with the trade. Rotate industries across posts — plumbing, HVAC, electrical, tree service, roofing, cleaning, salon, gym, dental, retail, photography, food service. Never repeat the same industry two posts in a row.`,

  // 8 → Format 8 (Documentary) — refactored to be more specific
  `Behind The Build — Specific mechanics of how FGA agents work, shown not told. Pick ONE agent or workflow. Walk through what happens, in order, with timing. Name the agent. Show the handoff. No "AI-powered" or "intelligent automation" — describe what the system does and when. Example subject (write fresh): "Here's what happens when a lead fills out your form: (1) text goes out in under 60 seconds with their name, (2) if no reply in 4 hours, the system sends a check-in, (3) if they reply, you get a push notification with the conversation."`,

  // 9 → Format 9 (Module Spotlight) — Problem → Module → Solution
  `Problem → Module → Solution — Pick ONE specific FGA module from this list and build the entire post around it:
  - Speed-to-Lead: instant text response when a new lead comes in
  - Missed Call Text-Back: auto-texts the caller when you can't answer
  - Follow-Up Sequences: automated follow-ups for estimates and past customers
  - Review Requests: asks happy customers for 5-star reviews automatically
  - Content Engine + Content Approval: AI creates social posts from job photos, you approve with one tap
  - AI Voice Receptionist: AI picks up calls you can't, captures the lead, texts you a transcript
  - Referral Engine: turns satisfied customers into referral sources automatically
  - Prospecting Engine: finds and contacts new potential customers in your area
  - AI Chat Agent: 24/7 chat on your website that answers questions and captures leads
  - Done-For-You Website: simple branded site we build, host, and update

  Structure: Slide 1 — name the SPECIFIC problem a small business owner faces (concrete scenario, not abstract). Slide 2 — what most owners do about it (nothing, or a bad workaround). Slide 3 — name the FGA module by its real name and explain exactly what it does in plain English. Slide 4 — show the result: what changes for the business owner day-to-day. Slide 5 — CTA. Every post should make the reader think "I have that exact problem and I didn't know there was a fix." Do NOT cover multiple modules — ONE module per post, go deep.`,
];

// ---------------------------------------------------------------------------
// Brand Voice — v2 base + new PATTERNS_TO_USE block
// ---------------------------------------------------------------------------
const BRAND_VOICE = `
Confident, direct, plain-spoken. Like talking to another business owner at a
coffee shop — not like a marketer trying to sell something. Speak to a
1-10 person small business owner — ANY industry: plumber, electrician, tree
service, landscaper, HVAC, roofer, cleaning service, salon, gym, accountant,
photographer, retail shop, dental office, food truck, consultant, art gallery.
They're too busy doing the actual work to mess with marketing. VARY the
industries you reference across posts — never lean on one trade for more than
two consecutive posts.

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

BANNED FLUFF PHRASES (these slipped past v2 — explicitly banned in v3):
- "stopped losing jobs to silence"
- "recovered booked work"
- "without you touching it"
- "stopped chasing quotes"
- "without lifting a finger"
- "on autopilot"
- "set it and forget it"
- "completely hands-off"
- "won back" (when paired with vague outcomes like "lost time", "wasted dollars")
- "say goodbye to..."
- "no more..."  (as a one-line headline)
- Any vague outcome like "more revenue", "more leads", "more bookings"
  without a specific number tied to it.

HEADLINE STRUCTURE RULES:
- HARD BAN: Do NOT use the "[Statement]. [Echo statement].", pattern.
  Examples of what this looks like (all banned):
    - "You worked all day. And still lost money."
    - "The Chipper's Running. Your Phone Isn't."
    - "The Job You Quoted on Friday Is Gone by Monday Morning."
    - "It rang. You missed it."
  This pattern was used in EVERY test post on 2026-05-12. It is no longer
  acceptable. Use a different headline structure: a question, a single
  declarative sentence, a list anchor (number + thing), or a direct
  instruction.
- No two consecutive posts may use the same headline structure.
- Avoid headlines that work for ANY business — the headline should give
  away that this is for a service business specifically.

SPECIFICITY REQUIREMENT (every post must include at least one):
- A real number from a real source (cite the source).
- A real client name (A Kut Above or WellMor Benefits — never invented).
- A specific scenario with a time and place ("Tuesday 2pm, you're on a roof").
- A literal script, template, or step that the reader can copy.

CTA RULES:
- Vary the CTA. "Visit www.firstgenautomate.com" once per 8-post rotation max.
- Other acceptable CTAs: "DM me 'system' and I'll show you what it looks like",
  "If you want the script we use, comment 'script' below", "I'll send you the
  template — DM me", "Want this set up for your shop? DM me.", "Visit the link
  in bio to see how it works".
- The CTA should be specific to the post, not a generic site visit.
- CRITICAL: The CTA must offer something NOT already shown in the post.
  If the post already contains the full script/template, the CTA cannot
  say "comment 'script' for the script". That's hollow. Examples:
    BAD (script already in post): "Comment 'script' to get the script."
    GOOD (something new): "DM me 'setup' and I'll show you how to
          automate this so you don't have to type it yourself."
  A reader who finished the post should still want what the CTA offers.

PATTERNS TO USE (do these, actively — these are positive examples, not bans):

1. OPEN IN A SCENE. First sentence places the reader on a job site, in a
   truck, at a Google reviews page, under a sink — never in the abstract.
   BAD:  "Most plumbers struggle with follow-up."
   GOOD: "You're under a sink on a Tuesday and the phone buzzes — that's
         the third lead this week."

2. ANCHOR IN THE FIRST 25 WORDS. Include a number, weekday, tool name,
   dollar amount, or town. Something physical and specific.
   BAD:  "Lots of small businesses miss opportunities."
   GOOD: "Three calls between 11am and 2pm. You answered one."

3. END SECTIONS WITH A DIRECTIVE OR A QUESTION. Either give a literal
   thing to do ("Send this exact text:") with a 1-line script, OR ask
   a specific question ("When was the last time you asked?"). Never end
   on a platitude.

4. SECOND PERSON, 70%+ OF SENTENCES. "You" and "your shop" — not
   "small businesses" or "service owners."

5. ACTIVE VOICE. Present tense for instruction, past tense for proof.
   BAD:  "The text should be sent within 60 seconds."
   GOOD: "Send the text within 60 seconds." (instruction)
   GOOD: "We installed it Tuesday. They booked 4 jobs by Friday." (proof)
`.trim();

// ---------------------------------------------------------------------------
// 1:1 mapping — format id → pillar (index into CONTENT_PILLARS, 0-based)
// content-generation.js uses this instead of pickRandom(content_pillars).
// ---------------------------------------------------------------------------
const FORMAT_PILLAR_MAP = {
  1: 0, // One-Liner       → Contrarian POV
  2: 1, // Quote Card      → Founder Voice
  3: 2, // Stat Card       → Industry Data
  4: 3, // Before/After    → Client Proof
  5: 4, // Pattern/Anti    → Anti-Pattern
  6: 5, // Three-Beat      → Tactical How-To
  7: 6, // Midnight Hero   → Industry Spotlight
  8: 7, // Documentary     → Behind The Build
  9: 8, // Module Spotlight → Problem → Module → Solution
};

module.exports = {
  CONTENT_PILLARS,
  BRAND_VOICE,
  FORMAT_PILLAR_MAP,
};
