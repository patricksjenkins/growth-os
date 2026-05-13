/**
 * Growth OS — FGA Research Stats (v1, 2026-05-13)
 *
 * Curated, real, internet-researched statistics that Claude is allowed to
 * cite in FGA content posts.
 *
 * WHY THIS FILE EXISTS:
 *   Phase 1 launch testing on 2026-05-12 produced posts citing fabricated
 *   client outcomes ("A Kut Above booked 3 of their next 5 estimates"). We
 *   have no verified per-client numbers and shouldn't invent them. Patrick's
 *   directive (2026-05-13): "find stat on the internet from research. For
 *   example when I was a car salesman we were told a stat that only 20
 *   percent of the people who leave the dealership will come back".
 *
 * HOW THIS FILE IS USED:
 *   - content-generation.js loads FACTS_BY_INDUSTRY[focusIndustry] and
 *     CROSS_INDUSTRY_FACTS at prompt-build time.
 *   - The system prompt gets a "FACTS YOU MAY CITE" block — Claude is
 *     instructed to pick from these or omit numbers entirely. Anything
 *     numeric in the output that isn't from this list is a hallucination
 *     and the post fails review.
 *   - Stat Card pillar (Format 3) REQUIRES a cite from this list — if no
 *     entry fits, the agent picks a CROSS_INDUSTRY_FACTS entry.
 *
 * SOURCING RULES:
 *   - Only published, attributable sources (BrightLocal, ServiceTitan,
 *     IBISWorld, NALP, NICB, Invoca, BLS, Google research, NOAA, Statista,
 *     Jobber Academy, Workyard, MaidCentral).
 *   - Every entry MUST have a source string and a year. If a number floats
 *     around the internet but the original source can't be located, do not
 *     include it.
 *   - Numbers are quoted as published — no rounding, no "approximately".
 *   - When two sources disagree, pick the more conservative number and note
 *     the source.
 */

// ---------------------------------------------------------------------------
// Cross-industry facts — apply to any small service business. Used when the
// week's focus industry has no specific stat that fits the pillar, or for
// Founder Voice / Contrarian POV / Anti-Pattern posts that aren't trade-bound.
// ---------------------------------------------------------------------------
const CROSS_INDUSTRY_FACTS = [
  {
    stat: '62% of inbound calls to home service businesses go unanswered.',
    source: 'Invoca, 2024 Home Services Call Study',
    use: 'Anti-Pattern, missed-call hook, Stat Card.',
  },
  {
    stat: 'Responding to a lead within 1 minute increases conversion 391% compared to waiting 2 minutes.',
    source: 'Velocify lead-response study, cited by Invoca 2024',
    use: 'Speed-to-lead Anti-Pattern, Stat Card.',
  },
  {
    stat: '78% of customers buy from the first business that responds to their inquiry.',
    source: 'Lead Connect / InsideSales response-time study',
    use: 'Speed-to-lead hook, Stat Card, Contrarian POV.',
  },
  {
    stat: '47% of consumers will not use a local business with fewer than 20 reviews.',
    source: 'BrightLocal Local Consumer Review Survey 2024',
    use: 'Reviews Anti-Pattern, Stat Card, Tactical How-To.',
  },
  {
    stat: '74% of consumers only trust reviews written in the last 3 months.',
    source: 'BrightLocal Local Consumer Review Survey 2024',
    use: 'Review-request cadence, Stat Card.',
  },
  {
    stat: '88% of consumers would use a business that responds to both positive and negative reviews; only 47% would use one that ignores reviews.',
    source: 'BrightLocal Local Consumer Review Survey 2024',
    use: 'Review-response Anti-Pattern, Stat Card.',
  },
  {
    stat: '80% of U.S. consumers search online for local businesses weekly; 32% search daily.',
    source: 'BrightLocal Local SEO Statistics 2025',
    use: 'Local-search hook, Industry Spotlight, Stat Card.',
  },
  {
    stat: 'Complete Google Business Profiles get 7x more clicks than empty ones.',
    source: 'Google internal data, cited by BrightLocal 2024',
    use: 'GBP Tactical How-To, Stat Card.',
  },
  {
    stat: 'Customers are 2.7x more likely to consider a business reputable when it has a complete Google Business Profile.',
    source: 'Google "How People Use Google Search" 2023',
    use: 'GBP Anti-Pattern, Stat Card.',
  },
  {
    stat: 'The average missed call costs a home service business $285 in lost revenue.',
    source: 'AgentZap / Invoca 2024 missed-call analysis',
    use: 'Anti-Pattern, missed-call CTA, Stat Card.',
  },
  {
    stat: '58% of calls to home service providers involve some level of urgency.',
    source: 'Angi 2023 Home Services Demand Report',
    use: 'Speed-to-lead, Industry Spotlight.',
  },
  {
    stat: 'Nearly half of all home service inquiries come in before 8am, after 6pm, or on weekends.',
    source: 'IBISWorld home services analysis 2024',
    use: 'Off-hours coverage Anti-Pattern, Tactical How-To.',
  },
];

// ---------------------------------------------------------------------------
// Industry-keyed facts — keyed on the EXACT strings used in
// tenant_config.target_industries. If a target_industries entry doesn't
// appear here, content-generation.js falls back to CROSS_INDUSTRY_FACTS.
// ---------------------------------------------------------------------------
const FACTS_BY_INDUSTRY = {
  'Plumbing': [
    {
      stat: 'The first plumbing contractor to respond to an emergency inquiry wins the job 78% of the time.',
      source: 'AgentZap 2026 Plumbing Phone Statistics',
      use: 'Speed-to-lead hook, Anti-Pattern.',
    },
    {
      stat: '60% of emergency plumbing jobs are booked within 1 hour of the customer search.',
      source: 'AgentZap 2026 Plumbing Phone Statistics',
      use: 'Speed-to-lead, Tactical How-To.',
    },
    {
      stat: '72% of U.S. plumbing businesses operate with just 1-3 employees.',
      source: 'IBISWorld Plumbing Industry 2024',
      use: 'Industry Spotlight, Founder Voice.',
    },
    {
      stat: 'Over 95% of plumbing businesses in the U.S. have fewer than 10 employees.',
      source: 'IBISWorld Plumbing Industry 2024',
      use: 'Industry Spotlight, Contrarian POV.',
    },
    {
      stat: '84% of consumers searching for a plumber use Google as their first source.',
      source: 'AgentZap 2026 Plumbing Phone Statistics',
      use: 'GBP Tactical How-To, Stat Card.',
    },
    {
      stat: '64% of consumers will not contact a plumber whose website takes more than 5 seconds to load.',
      source: 'AgentZap 2026 Plumbing Phone Statistics',
      use: 'Website Anti-Pattern, Tactical How-To.',
    },
  ],

  'HVAC': [
    {
      stat: 'The average HVAC customer acquisition cost is $296 per new customer.',
      source: 'ServiceTitan HVAC Statistics 2024',
      use: 'Industry Spotlight, Anti-Pattern (paying twice for the same lead).',
    },
    {
      stat: 'Average HVAC residential customer lifetime value is $15,340.',
      source: 'ServiceTitan HVAC Statistics 2024',
      use: 'Industry Spotlight, Founder Voice, Tactical How-To (follow-up math).',
    },
    {
      stat: 'HVAC call volume jumps 35% during peak cooling and heating seasons.',
      source: 'WebFX 2026 HVAC Marketing Benchmarks',
      use: 'Industry Spotlight, Tactical How-To (capacity planning).',
    },
    {
      stat: 'HVAC emergency keywords cost $25-$45 per click on Google Ads during peak season.',
      source: 'WebFX 2026 HVAC Marketing Benchmarks',
      use: 'Stat Card, Anti-Pattern (ad spend without follow-up).',
    },
    {
      stat: 'The average HVAC cost-per-lead from Google Ads is $104.',
      source: 'WebFX 2026 HVAC Marketing Benchmarks',
      use: 'Stat Card, Tactical How-To.',
    },
  ],

  'Electrical': [
    {
      stat: 'There are 261,958 electrician businesses in the U.S. as of 2026; industry revenue is $347.5B.',
      source: 'IBISWorld Electricians Industry 2026',
      use: 'Industry Spotlight, Founder Voice.',
    },
    {
      stat: 'For specialized electrical work, a single missed call can cost $1,000+ in lost revenue.',
      source: 'IBISWorld / Invoca home services analysis 2024',
      use: 'Anti-Pattern, Stat Card.',
    },
    {
      stat: 'Small home service businesses miss nearly two-thirds of incoming calls during business hours.',
      source: 'IBISWorld home services analysis 2024',
      use: 'Anti-Pattern, Tactical How-To.',
    },
    {
      stat: 'Monday mornings see the highest electrician call volume as homeowners address weekend issues.',
      source: 'IBISWorld home services analysis 2024',
      use: 'Industry Spotlight, Tactical How-To (Monday capacity).',
    },
  ],

  'Landscaping & Tree Service': [
    {
      stat: 'The U.S. landscape services industry is a $188.8B market with 692,777 businesses and 1.4M employees.',
      source: 'NALP Landscape Industry Statistics 2025',
      use: 'Industry Spotlight, Founder Voice.',
    },
    {
      stat: 'Tree trimming is a $38.2B annual U.S. market.',
      source: 'IBISWorld Tree Trimming Services 2025',
      use: 'Industry Spotlight, Stat Card.',
    },
    {
      stat: 'Most landscape companies earn the bulk of their revenue between April and September.',
      source: 'NALP Landscape Industry Statistics 2025',
      use: 'Industry Spotlight, Anti-Pattern (off-season cash flow).',
    },
    {
      stat: '62% of landscaping and tree-service revenue comes from single-family residential homes.',
      source: 'NALP 2025 Financial Benchmark Study',
      use: 'Industry Spotlight, Tactical How-To (where to focus marketing).',
    },
    {
      stat: 'NALP benchmark companies report a median of 355 customers generating $14,682 per customer annually.',
      source: 'NALP 2025 Financial Benchmark Study',
      use: 'Stat Card, Industry Spotlight.',
    },
  ],

  'Roofing': [
    {
      stat: 'U.S. roofing repair and replacement costs reached nearly $31B in 2024 — a 30% increase since 2022.',
      source: 'National Insurance Crime Bureau, cited by Roofing Contractor 2024',
      use: 'Industry Spotlight, Stat Card.',
    },
    {
      stat: 'NOAA recorded 5,373 hail events in the U.S. in 2024.',
      source: 'National Oceanic and Atmospheric Administration 2024',
      use: 'Industry Spotlight (storm season), Tactical How-To.',
    },
    {
      stat: 'Homes with roofs over 20 years old are 3x more likely to file a wind or hail claim.',
      source: 'NICB roof claim analysis 2024',
      use: 'Industry Spotlight, Anti-Pattern (waiting too long), Tactical How-To.',
    },
    {
      stat: 'Roof line items now account for over 25% of total residential insurance claim value.',
      source: 'NICB roof claim analysis 2024',
      use: 'Industry Spotlight, Founder Voice.',
    },
    {
      stat: 'Nearly 47% of Texas home insurance claims were closed without any payment in 2024.',
      source: 'Texas Department of Insurance, cited by Roofing Contractor 2024',
      use: 'Industry Spotlight, Anti-Pattern (claim handling).',
    },
  ],

  'Cleaning Services': [
    {
      stat: 'Recurring cleaning services account for 75% of residential cleaning revenue.',
      source: 'MaidCentral Cleaning Industry Statistics 2026',
      use: 'Industry Spotlight, Tactical How-To (book the next visit before leaving).',
    },
    {
      stat: 'Most cleaning companies maintain a customer retention rate of 70-80% on recurring contracts.',
      source: 'MaidCentral Cleaning Industry Statistics 2026',
      use: 'Industry Spotlight, Anti-Pattern (one-time-only mindset).',
    },
    {
      stat: 'Cleaning customers on monthly billing are 30-40% less likely to cancel than per-visit customers.',
      source: 'ZenMaid retention study 2024',
      use: 'Tactical How-To, Stat Card.',
    },
    {
      stat: 'Cleaning companies using automated booking see 50% higher customer retention.',
      source: 'Jobber Academy Cleaning Industry Trends 2026',
      use: 'Stat Card, Anti-Pattern (manual scheduling).',
    },
    {
      stat: '62% of cleaning service bookings are now made online or through mobile apps.',
      source: 'Jobber Academy Cleaning Industry Trends 2026',
      use: 'Industry Spotlight, Tactical How-To.',
    },
  ],
};

/**
 * Format the facts block that gets injected into the Claude system prompt.
 * Returns a string that lists up to N facts for the focus industry, plus
 * a few cross-industry fallbacks, each with source attribution.
 *
 * @param {string|null} focusIndustry - e.g. "HVAC"
 * @param {number} maxIndustry - max industry-specific facts to include
 * @param {number} maxCross - max cross-industry facts to include
 * @returns {string}
 */
function buildFactsBlock(focusIndustry, maxIndustry = 6, maxCross = 6) {
  const industryFacts = (focusIndustry && FACTS_BY_INDUSTRY[focusIndustry])
    ? FACTS_BY_INDUSTRY[focusIndustry].slice(0, maxIndustry)
    : [];

  const crossFacts = CROSS_INDUSTRY_FACTS.slice(0, maxCross);

  const lines = [];
  lines.push('FACTS YOU MAY CITE (these are the ONLY numbers you may use in this post):');
  lines.push('');

  if (industryFacts.length > 0) {
    lines.push(`-- ${focusIndustry}-specific --`);
    industryFacts.forEach((f, i) => {
      lines.push(`  ${i + 1}. ${f.stat}`);
      lines.push(`     Source: ${f.source}`);
    });
    lines.push('');
  }

  lines.push('-- Cross-industry (any small service business) --');
  crossFacts.forEach((f, i) => {
    lines.push(`  ${i + 1}. ${f.stat}`);
    lines.push(`     Source: ${f.source}`);
  });
  lines.push('');

  lines.push('RULES FOR USING FACTS:');
  lines.push('- Use 0 or 1 number per post. NEVER stack multiple numbers in one post.');
  lines.push('- If you use a number, quote it accurately and name the source in the slide or caption.');
  lines.push('- DO NOT invent numbers. DO NOT cite "studies show" without naming a source above.');
  lines.push('- DO NOT cite percentages, dollar amounts, or counts that are not on this list.');
  lines.push('- For client-result claims: we have NO verified per-client numbers. Do not say "A Kut Above did X" or "WellMor did Y" with a number. You may reference them as real clients in general terms ("our tree-service client in Georgia") but never with fabricated metrics.');
  lines.push('- If the format calls for a stat (Stat Card / Industry Data pillar) and no listed fact fits, pick the closest cross-industry fact rather than inventing one.');

  return lines.join('\n');
}

module.exports = {
  CROSS_INDUSTRY_FACTS,
  FACTS_BY_INDUSTRY,
  buildFactsBlock,
};
