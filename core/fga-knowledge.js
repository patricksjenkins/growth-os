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
    // V1 hardening (2026-05-24): canonical headcount rule per CLAUDE.md
    // is "fewer than 10." This file previously said "5 or fewer" in one
    // place and "1-5... more than 5-10" in another, contradicting the
    // source-of-truth doc + the AI rule that Patrick decides per-lead.
    one_liner: 'A platform that automates marketing, lead follow-up, customer communications, and review collection for businesses with fewer than 10 employees.',
    delivery: 'Delivered via a branded mobile app and web portal. Live in 7 days.',
    audience: 'Owner-operated businesses, 1-9 employees, any industry. Ten or more employees are outside autonomous prospecting, though Patrick may still decide whether to take an inbound demo. No industry is excluded.',
    not_what_we_are: 'NOT a software tool you configure. NOT a marketing agency that charges retainers. We install a system that runs.',
  },

  pricing: {
    setup_fee: { amount: 199, type: 'one-time', notes: 'Charged immediately at signup. Funds the branded app build. Non-refundable once the build starts (typically Day 1).' },
    growth_tier: { amount: 249, period: 'monthly', modules_included: '7 of 14 standard modules (customer picks which). AI Voice Receptionist is NOT available on Growth — it is exclusive to Scale.' },
    scale_tier: { amount: 399, period: 'monthly', modules_included: 'All 14 standard modules PLUS the AI Voice Receptionist (Scale-exclusive flagship — not offered on Growth at any price). Includes monthly executive PDF reports + higher volume limits + priority support.' },
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
      a: 'Growth ($249/mo) lets you pick any 7 of our 14 standard modules. Scale ($399/mo) unlocks all 14 plus the AI Voice Receptionist (Scale-exclusive flagship — not available on Growth), with higher volume limits, priority support, and monthly executive reports.',
    },
    {
      q: 'Can I get the AI Voice Receptionist on the Growth plan?',
      a: 'The AI Voice Receptionist is exclusive to the Scale plan — that feature isn\'t available on Growth at any price. If the voice receptionist is what you\'re after, Scale ($399/mo) is the tier you\'d want.',
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
      a: 'Not as an ongoing sync, but we can do a one-time HubSpot import at signup so your existing contacts, companies, and deals come with you. From there, keep whatever tools you like — most customers start to move away from them naturally once they see what FGA covers on its own.',
    },
    {
      q: 'What about Salesforce / Pipedrive / GoHighLevel / Zoho?',
      a: 'Same answer as HubSpot — one-time data import at signup so nothing\'s lost, no ongoing sync, and you keep whatever you want. Most customers find they shift to FGA on their own once it\'s running.',
    },
    {
      q: 'What if I already use another CRM or marketing tool?',
      a: 'Totally fine — we can import your existing contacts and deals once at signup so you have a clean starting point inside FGA. You\'re free to keep your other tools as long as they\'re useful. Most customers gradually consolidate into FGA over the first couple of months.',
    },
    {
      q: 'How do I see it in action?',
      a: 'Book a 15-minute demo at firstgenautomate.com/contact — we\'ll show you the system using a real sample tenant.',
    },
    {
      q: 'Where are you based?',
      a: 'Atlanta, Georgia. First Gen Automate LLC.',
    },
    {
      q: 'Who is behind First Gen Automate? / What are your qualifications?',
      a: 'The founder, Patrick Jenkins, has 23+ years of sales and technology experience at companies like Salesforce, Microsoft, and American Express. He built First Gen Automate to give small businesses the same enterprise-grade systems those big companies use — without the enterprise complexity or price tag. So you\'re in good hands.',
    },
    {
      q: 'Are you a real company? / Have you done this before?',
      a: 'Yes — First Gen Automate LLC, based in Atlanta. The founder has spent his career building and selling business systems at companies like Salesforce and Microsoft. The technology and approach here are battle-tested; it\'s just packaged for small businesses now.',
    },

    // === Cancellation, pause, data ownership ===
    {
      q: 'What happens to my data and my branded app if I cancel?',
      a: 'You own your data. On cancel we give you a 30-day export window — leads, customers, conversations, content library, photos — delivered as CSVs and a downloadable archive. After 30 days the account is purged. Your branded app stays in the App Store but switches to a "service ended — reactivate to continue" screen. If you ever come back inside the 30-day window, the same app reactivates with your data restored.',
    },
    {
      q: 'Can I pause my subscription?',
      a: 'Yes — up to a 3-month pause per year. During pause: no monthly fee, automations stop running, the app shows a pause screen, and your data is preserved. Resume anytime by reactivating from the portal.',
    },

    // === Migration / existing setup ===
    {
      q: 'Can I keep my current business phone number?',
      a: 'Three options. Easiest: keep your number and forward unanswered calls to the FGA number we provision — most customers do this. We can also port your number to us, or you can use the new number we provide as your primary. Whatever fits your setup.',
    },
    {
      q: 'What happens to my existing Instagram / Facebook accounts and my followers?',
      a: 'We connect to the accounts you already use — your followers, your past posts, all stay exactly where they are. We just start publishing new content into the same accounts. Nothing to migrate.',
    },
    {
      q: 'What if I already have a website?',
      a: 'Totally up to you. If your current site is getting old or you don\'t love it, we can rebuild it as part of your setup. If you\'re happy with what you have, skip the website module — on Growth you\'d pick a different one from your 7. On Scale you have access to the Done-For-You Website but nothing forces you to use it.',
    },
    {
      q: 'Which social platforms do you publish to?',
      a: 'Instagram, Facebook, LinkedIn, TikTok, Twitter/X, Threads, Bluesky, and Google Business Profile. You pick which accounts to connect during onboarding. The system tailors caption length and format per platform automatically.',
    },

    // === Sales objections (agents should use these almost verbatim) ===
    {
      q: 'That sounds expensive. / $249 is too much.',
      a: 'I get it — $249 is real money. But think about it this way: most of the jobs you do are worth more than that. If the system books you ONE extra job a month, it\'s paid for itself. And realistically the speed-to-lead piece alone usually catches more than one.',
    },
    {
      q: 'I need to think about it. / Let me get back to you.',
      a: 'Totally fair — this is a real decision, take your time. How about this — let me send you the brochure with more detail on the modules so you\'ve got everything to review at your own pace. What\'s the best email to send it to? (If you already have their email, just confirm and send.)',
    },
    {
      q: 'Do you have a customer just like me / in my exact industry?',
      a: 'We work with a range of small businesses across different industries. Honest answer — every business is different, which is exactly why we don\'t sell a cookie-cutter template. The system gets configured to YOUR business, your services, your customers, your voice — not the same setup we\'d give someone else just because you\'re in the same general space.',
    },

    // === Competition, refunds, multi-business ===
    {
      q: 'Do you work with my competitors? / Is there territory exclusivity?',
      a: 'We\'re not exclusive by territory, but we don\'t share details about who else uses the system. Your competitors\' info stays private — and so does yours.',
    },
    {
      q: 'Do you offer refunds?',
      a: 'We don\'t do mid-month refunds — but billing is month-to-month, so you\'re never locked in. If something\'s not working, we\'d rather fix it than refund you. If it just isn\'t a fit, you cancel with 15 days notice and stop being billed. The 14-day free trial up front is your no-risk way to make sure it\'s right before you commit.',
    },
    {
      q: 'I own two businesses — do I need two subscriptions?',
      a: 'Each business gets its own setup — separate branded app, phone number, content stream, and social accounts. We do offer a discount on the second business, but Patrick handles that personally on a quick call to make sure both setups make sense for you.',
    },
    {
      q: 'I have multiple locations under one business — does that work?',
      a: 'Yes — works fine for a single business with multiple locations. One subscription covers all locations.',
    },

    // === Reviews / Voice receptionist / time commitment ===
    {
      q: 'Which review platforms do you support?',
      a: 'Today we automate Google review requests — that\'s where most customers search. Yelp and Facebook reviews are on the roadmap. We don\'t oversell it: Google is the one we do well right now.',
    },
    {
      q: 'Can I pick the voice for the AI Voice Receptionist?',
      a: 'Yes — during onboarding you pick from 5 voices: Clara (warm professional female), Nico (young casual male), Kai (friendly relaxed male), Godfrey (energetic male), and Savannah (US Southern female). You can change it anytime in settings.',
    },
    {
      q: 'Does the AI Voice Receptionist speak Spanish?',
      a: 'English only today. The underlying technology supports Spanish, but we haven\'t deployed it end-to-end yet. Once we have, it will roll out to existing Scale customers automatically.',
    },
    {
      q: 'What about emergency or after-hours calls?',
      a: 'During onboarding you set "emergency keywords" — words like leak, flood, no heat, downed tree on house. If the AI hears those, it immediately tries to transfer the call to your cell. You also set after-hours behavior: take a message and text you the transcript, or attempt the same emergency transfer.',
    },
    {
      q: 'How much of my time does this actually take per week?',
      a: 'About 5-10 minutes a week. A few seconds a day to glance at the lead digest, 60 seconds at the end of the week to approve scheduled content, and a couple of minutes here and there to upload job photos if you want to feed the content engine. That\'s it.',
    },
  ],

  // Hard rules every channel must enforce, regardless of FAQ phrasing.
  // The agent should treat these as policy — they override any softer
  // wording it might paraphrase from the FAQs.
  tier_rules: [
    'AI Voice Receptionist is Scale-only. If a prospect on Growth (or considering Growth) asks for it, say it\'s exclusive to Scale — the upgrade path is the answer, not a workaround.',
    'Growth includes 7 modules. Scale includes all 14 standard modules + the AI Voice Receptionist (15 total).',
    'No a la carte modules. No add-ons. The two tiers are the only options.',
    'Setup fee ($199) is the same on both tiers. Non-refundable once the branded app build starts.',
    'The branded mobile app is for the OWNER and CREW — not customers. Customers interact with the business via SMS, the branded website, and the AI chat agent. Customers do NOT download the app. Never imply otherwise.',
    'No territory exclusivity. Never name, describe, or characterize any other customer publicly — privacy works both ways.',
    'No mid-month refunds. Month-to-month flexibility + the 14-day trial are the safety net. If something is broken, we fix it; we do not process refunds.',
    'Pause: up to 3 months per year. $0/mo during pause, automations halted, data preserved, resume from portal.',
    'On cancel: 30-day data export window, then full purge. Branded app stays in App Store with a "service ended — reactivate to continue" screen.',
  ],

  // Founder background — used ONLY when caller asks about credentials,
  // qualifications, the company's track record, or "who's behind this".
  // Never lead with this. The brand voice is plain-spoken, not resume-y.
  founder: {
    name: 'Patrick Jenkins',
    summary: '23+ years in sales and technology — Salesforce, Microsoft, American Express, plus medical capital equipment (MRI/CT) and auto finance earlier in his career.',
    why_it_matters: 'Built FGA to bring enterprise-grade systems to small businesses. The platform reflects what actually works at the top of the market, simplified for a 1-5 person team.',
    use_when: 'Only surface when caller explicitly asks about credentials, qualifications, track record, or who runs the company. Keep it short, then pivot back to their needs so they feel at ease and we keep moving.',
  },
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

  if (Array.isArray(k.tier_rules) && k.tier_rules.length > 0) {
    parts.push('\n=== TIER RULES (policy — never bend these) ===');
    for (const r of k.tier_rules) parts.push(`- ${r}`);
  }

  if (includeFaqs) {
    parts.push('\n=== COMMON QUESTIONS + APPROVED ANSWERS ===');
    parts.push('Use these as your reference. Paraphrase to fit the conversational tone, never copy verbatim unless the user asks for exact info.');
    for (const f of k.faqs) {
      parts.push(`Q: ${f.q}\nA: ${f.a}\n`);
    }
  }

  // Founder bio — kept separate so the agent has the info but knows
  // not to lead with it. Only surface when the caller explicitly asks
  // about credentials, qualifications, or who's behind the company.
  if (k.founder) {
    parts.push('\n=== FOUNDER BIO (only mention if asked) ===');
    parts.push(`Name: ${k.founder.name}`);
    parts.push(`Background: ${k.founder.summary}`);
    parts.push(`Why it matters to a small-business owner: ${k.founder.why_it_matters}`);
    parts.push(`When to use: ${k.founder.use_when}`);
    parts.push('IMPORTANT: Do NOT volunteer this in opening lines, intros, or pitches. Only mention if caller asks "who are you", "what\'s your background", "have you done this before", "are you a real company", or similar. Keep it to one sentence then pivot back to the caller.');
  }

  return parts.join('\n');
}

module.exports = {
  FGA_KNOWLEDGE,
  buildFgaKnowledgePrompt,
};
