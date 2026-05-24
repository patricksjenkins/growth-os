/**
 * FGA Company Knowledge Base
 *
 * Single source of truth for everything the inbound SMS responder
 * agent (and AI Chat Agent, and any future AI-facing surface) needs
 * to know about First Gen Automate.
 *
 * Edit this file when:
 *   - Pricing changes
 *   - A new module ships or one is retired
 *   - A new FAQ comes up enough to be worth canning an answer for
 *   - Positioning copy gets refined
 *
 * Used by:
 *   - worker/agents/inbound-sms-responder.js
 *   - worker/agents/chat-widget-responder.js (when it ships)
 *   - Any future AI agent that needs to talk about FGA itself
 *
 * To keep AI replies fast + bounded in token spend, this file is
 * statically loaded and assembled into the system prompt at agent
 * boot. No DB roundtrip. If the catalog grows beyond ~5k tokens,
 * migrate to a knowledge-base table with keyword retrieval.
 */

const FGA_KNOWLEDGE = {
  positioning: {
    tagline: 'Automate the Overhead, Focus on the Work.',
    one_liner: 'A platform that automates marketing, lead follow-up, customer communications, and review collection for businesses with 5 or fewer employees.',
    delivery: 'Delivered via a branded mobile app and web portal. Live in 7 days.',
    audience: 'Owner-operated businesses, 1-5 employees, any industry. The disqualifier is more than 5-10 employees. No industry is excluded.',
    not_what_we_are: 'NOT a software tool you configure. NOT a marketing agency that charges retainers. We install a system that runs.',
  },

  pricing: {
    setup_fee: { amount: 199, type: 'one-time', notes: 'Charged immediately at signup. Funds the branded app build. Non-refundable once the build starts (typically Day 1).' },
    growth_tier: { amount: 249, period: 'monthly', modules_included: '7 of 15 modules (customer picks which)' },
    scale_tier: { amount: 399, period: 'monthly', modules_included: 'All 15 modules + AI Voice Receptionist (Scale-only flagship) + monthly executive PDF reports + higher volume limits' },
    free_trial: '14-day free trial on the monthly subscription. The $199 setup fee is charged at signup, but the recurring monthly fee does not bill until day 15. Cancel during the trial and no monthly fee is owed.',
    contracts: 'No long-term contracts. Month-to-month after setup. Cancel anytime with 15 days notice.',
  },

  four_pillars: [
    { name: 'Marketing', desc: 'Content generation, social scheduling, done-for-you website, AI chat agent, prospecting.' },
    { name: 'Lead follow-up', desc: 'CRM, speed-to-lead text response, missed-call text-back, automated follow-up sequences, lead scoring.' },
    { name: 'Customer communications', desc: 'Branded mobile app + web portal, AI voice receptionist (Scale tier).' },
    { name: 'Review collection', desc: 'Automated Google review requests after each completed job, referral engine, referral-partner outreach.' },
  ],

  modules: [
    { name: 'AI Voice Receptionist', tier: 'scale_only', desc: 'AI picks up calls you can\'t answer, captures the lead, texts you a transcript. Never records audio.' },
    { name: 'AI Chat Agent', tier: 'both', desc: '24/7 chat assistant on your website. Answers prospect questions, captures leads.' },
    { name: 'Done-For-You Website', tier: 'both', desc: 'Simple branded site we build, host, and update so you never touch it.' },
    { name: 'Lead Capture & CRM', tier: 'both', desc: 'Every lead from every channel in one place.' },
    { name: 'Speed-to-Lead', tier: 'both', desc: 'AI text response to new leads in under 60 seconds.' },
    { name: 'Missed Call Text-Back', tier: 'both', desc: 'Auto-text callers when you can\'t pick up.' },
    { name: 'Follow-Up Sequences', tier: 'both', desc: 'Automated multi-touch follow-up for estimates, prospects, past customers.' },
    { name: 'Content Engine', tier: 'both', desc: 'AI generates social media posts from real job photos and your services.' },
    { name: 'Content Approval & Scheduling', tier: 'both', desc: 'You approve content with one tap. We schedule and post.' },
    { name: 'Review Requests', tier: 'both', desc: 'Asks happy customers for 5-star Google reviews automatically.' },
    { name: 'Branded Mobile App', tier: 'both', desc: 'Real iOS app in the App Store under YOUR business name.' },
    { name: 'Referral Engine', tier: 'both', desc: 'Turns happy customers into referral sources with built-in incentives.' },
    { name: 'Referral Partner Outreach', tier: 'both', desc: 'Keeps realtors, contractors, vendors who send you business warm automatically.' },
    { name: 'Prospecting Engine', tier: 'both', desc: 'Finds new leads in your area + drafts outreach for your approval.' },
    { name: 'Lead Scoring', tier: 'both', desc: 'AI ranks your leads so you call the hottest one first.' },
  ],

  // Volume caps customers should know about (hard limits — system enforces)
  volume_limits: {
    growth: { sms_per_month: 500, social_posts_per_month: 15, email_per_month: 500 },
    scale: { sms_per_month: 1000, social_posts_per_month: 30, email_per_month: 2000, voice_receptionist_minutes_per_month: 200 },
  },

  faqs: [
    {
      q: 'Is there a free trial?',
      a: 'Yes — 14-day free trial on the monthly subscription. The $199 setup fee is charged at signup so we can build your branded app, but the monthly fee does not start until day 15. Cancel anytime during the trial.',
    },
    {
      q: 'What\'s the difference between Growth and Scale?',
      a: 'Growth ($249/mo) lets you pick any 7 of our 15 modules. Scale ($399/mo) unlocks all 15 plus the AI Voice Receptionist (Scale-only flagship), with higher volume limits + priority support + monthly executive reports.',
    },
    {
      q: 'What does the setup fee cover?',
      a: 'Everything to get your system running: configuration for your business, branding with your logo and colors, integration setup, your first batch of content, your branded iOS app build, and a personal video walkthrough. Live in 7 days.',
    },
    {
      q: 'Are there long-term contracts?',
      a: 'No. After setup, billing is month-to-month. Cancel anytime with 15 days notice.',
    },
    {
      q: 'What if I need more SMS / posts / minutes?',
      a: 'Upgrade from Growth to Scale anytime — limits increase immediately. The system will queue overage and notify you if you ever hit a cap.',
    },
    {
      q: 'Do I need to be technical?',
      a: 'No. We set everything up. You open the app, approve content, and get back to work. If you can use a smartphone, you can use this.',
    },
    {
      q: 'Can my crew use the app?',
      a: 'Yes. Crew accounts can upload job-site photos but don\'t see leads, billing, or business settings. Owners see everything.',
    },
    {
      q: 'Does the system integrate with HubSpot?',
      a: 'Not as an ongoing sync — FGA replaces HubSpot for businesses your size, so once you\'re live you\'d typically cancel it. What we DO offer is a one-time HubSpot import at signup so your existing contacts, companies, and deals come with you. After that, FGA is the system of record.',
    },
    {
      q: 'What about Salesforce / Pipedrive / GoHighLevel / Zoho?',
      a: 'Same answer as HubSpot — we replace those tools rather than syncing with them, but we can do a one-time data import at signup so nothing\'s lost. The whole point of FGA is that you stop juggling multiple tools.',
    },
    {
      q: 'What if I already use another CRM or marketing tool?',
      a: 'We\'re built to replace that stack, not connect to it. We can import your existing contacts and deals once at signup so you don\'t lose history. Then FGA becomes your single system.',
    },
    {
      q: 'How do I see it in action?',
      a: 'Book a 15-minute demo at firstgenautomate.com/contact — we\'ll show you the system using a real sample tenant.',
    },
    {
      q: 'Where are you based?',
      a: 'Atlanta, Georgia. First Gen Automate LLC.',
    },
  ],
};

/**
 * Build a knowledge-injected system-prompt section. Designed to be
 * prepended to (or composed into) an agent's own system prompt.
 *
 * @param {Object} options
 * @param {boolean} [options.includeFaqs=true]
 * @param {boolean} [options.includeModules=true]
 * @param {boolean} [options.includePricing=true]
 * @returns {string}
 */
function buildFgaKnowledgePrompt(options = {}) {
  const { includeFaqs = true, includeModules = true, includePricing = true } = options;
  const k = FGA_KNOWLEDGE;
  const parts = [];

  parts.push('=== FGA POSITIONING ===');
  parts.push(`Tagline: "${k.positioning.tagline}"`);
  parts.push(`What it is: ${k.positioning.one_liner}`);
  parts.push(`How it's delivered: ${k.positioning.delivery}`);
  parts.push(`Who it's for: ${k.positioning.audience}`);
  parts.push(`What it is NOT: ${k.positioning.not_what_we_are}`);

  parts.push('\n=== THE FOUR PILLARS ===');
  for (const p of k.four_pillars) parts.push(`- ${p.name}: ${p.desc}`);

  if (includePricing) {
    parts.push('\n=== PRICING ===');
    parts.push(`Setup fee: $${k.pricing.setup_fee.amount} ${k.pricing.setup_fee.type}. ${k.pricing.setup_fee.notes}`);
    parts.push(`Growth tier: $${k.pricing.growth_tier.amount}/mo — ${k.pricing.growth_tier.modules_included}.`);
    parts.push(`Scale tier: $${k.pricing.scale_tier.amount}/mo — ${k.pricing.scale_tier.modules_included}.`);
    parts.push(`Free trial: ${k.pricing.free_trial}`);
    parts.push(`Contracts: ${k.pricing.contracts}`);
  }

  if (includeModules) {
    parts.push('\n=== 15 MODULES ===');
    for (const m of k.modules) {
      parts.push(`- ${m.name} [${m.tier}]: ${m.desc}`);
    }
  }

  if (includeFaqs) {
    parts.push('\n=== COMMON QUESTIONS + APPROVED ANSWERS ===');
    parts.push('Use these as your reference. Paraphrase to fit the conversational tone, never copy verbatim unless the user asks for exact info.');
    for (const f of k.faqs) {
      parts.push(`Q: ${f.q}\nA: ${f.a}\n`);
    }
  }

  return parts.join('\n');
}

module.exports = {
  FGA_KNOWLEDGE,
  buildFgaKnowledgePrompt,
};
