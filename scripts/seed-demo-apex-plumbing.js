/**
 * Growth OS — Demo Tenant: Apex Plumbing
 *
 * Seeds a realistic 1–2 person plumbing shop named "Apex Plumbing" with 6
 * rolling months of data. This is the tenant behind demo@firstgenautomate.com.
 *
 * When a prospect logs in with the demo credentials they see the EXACT SAME
 * 5-tab FGA app Patrick sees (Overview / Pipeline / Accounts / Finance /
 * Content) — but every tab shows Apex Plumbing's own business data instead
 * of FGA's multi-client founder-console data. The mobile app swaps
 * /api/admin/* -> /api/tenant/* based on user_metadata.role.
 *
 * Key seeding choices:
 *   - Vertical: home_services (plumbing). Per the product spec, service-
 *     business P&L — NO recurring revenue, NO subscription MRR concept.
 *   - Crew: owner + one apprentice. Matches the 1-2 person target shop.
 *   - Accounts (end-customers in mobile): seeded as contacts with
 *     contact_type='customer' so /api/tenant/clients returns them. 18 unique
 *     customers across completed jobs + 3 referral partners.
 *   - Content: plumbing-flavored posts (faucet swaps, drain clears,
 *     water heater installs). Stage mix: posted/approved/draft.
 *   - Finance: ~$15k revenue / ~$8k expenses over 6 months. Service revenue
 *     recorded per-job (category="Service Revenue").
 *
 * Usage:
 *   node scripts/seed-demo-apex-plumbing.js
 *   node scripts/seed-demo-apex-plumbing.js --reset
 */

require('dotenv').config();
const { db } = require('../db/client');

const DEMO_SLUG = 'demo-apex-plumbing';
const BUSINESS_NAME = 'Apex Plumbing';
const OWNER_EMAIL = 'demo@firstgenautomate.com';

const DEMO_TENANT = {
  name: BUSINESS_NAME,
  slug: DEMO_SLUG,
  vertical: 'home_services',
  status: 'active',
  owner_email: OWNER_EMAIL,
  is_demo: true,
  branding: {
    business_name: BUSINESS_NAME,
    primary_color: '#0B1120',
    secondary_color: '#22C55E',
    accent_color: '#F59E0B',
  },
};

const now = new Date();
const isoDaysAgo = (n) => new Date(now - n * 86400000).toISOString();
const dateDaysAgo = (n) => new Date(now - n * 86400000).toISOString().split('T')[0];

// ---------------------------------------------------------------------------
// 32 leads / 6-month rolling window. Each has days_ago relative to today.
// ---------------------------------------------------------------------------
const LEADS = [
  // Current month — 6 active pipeline
  // lifecycle_stage: 'enriched' = Ready tab, 'fb_only' = FB Only tab, null/other = Other tab
  { name: 'Dana Whitfield',  phone: '(555) 220-4419', email: 'danaw@email.com',  service_type: 'drain_cleaning', lead_source: 'google_search',    status: 'new_lead',           address: '412 Birch St',   city: 'Eastside',  notes: 'Kitchen sink backup since yesterday',                                                             days_ago: 0, lifecycle_stage: 'enriched' },
  { name: 'Marcus Ruiz',     phone: '(555) 221-8832', email: 'mruiz@email.com',  service_type: 'water_heater',   lead_source: 'facebook',         status: 'new_lead',           address: '88 Maple Ave',   city: 'Downtown',  notes: '10-year-old tank, wants estimate for tankless replacement',                                       days_ago: 1, lifecycle_stage: 'fb_only' },
  { name: 'Priya Desai',     phone: '(555) 222-1156', email: 'priyad@email.com', service_type: 'leak_repair',    lead_source: 'missed_call',      status: 'contacted',          address: '23 Cedar Ln',    city: 'Westfield', notes: 'Small leak under master bath sink — bucket under it',                                             days_ago: 2, lifecycle_stage: 'enriched' },
  { name: 'Greg Morrow',     phone: '(555) 223-9447', email: 'gmorrow@email.com',service_type: 'repipe',         lead_source: 'referral_customer',status: 'estimate_scheduled', estimate_amount: null, address: '507 Oak Park',   city: 'Northwood', notes: 'Old galvanized pipes — whole house repipe estimate scheduled for Wed', days_ago: 3, lifecycle_stage: 'enriched' },
  { name: 'Aisha Brown',     phone: '(555) 224-2288', email: 'abrown@email.com', service_type: 'toilet_repair',  lead_source: 'google_ads',       status: 'estimate_given',     estimate_amount: 340,  address: '14 Pine Ct',     city: 'Eastside',  notes: 'Running toilet, wax seal likely',                                                                 days_ago: 4, lifecycle_stage: 'fb_only' },
  { name: 'Tyler Jensen',    phone: '(555) 225-5591', email: 'tjensen@email.com',service_type: 'water_heater',   lead_source: 'yard_sign',        status: 'won',                estimate_amount: 1850, address: '902 Willow Way', city: 'Downtown',  notes: 'Going with tankless install — scheduled for next week',                                           days_ago: 5, lifecycle_stage: 'enriched' },
  // 2026-05-27: two seed leads added to showcase the new pipeline UI badges
  // + the facebook-prospecting agent's output for demo prospects.
  //
  // text_message_sent lead — populates the new indigo kanban column and shows
  // that an SMS auto-fired from the cold prospect. Phone is real (10 digits).
  { name: 'Jorge Velasquez', phone: '(555) 248-2233', email: '',                  service_type: 'fixture_install', lead_source: 'prospecting_agent', status: 'text_message_sent', address: '142 Stonewood Ave', city: 'Westfield', notes: 'Plumber 2-truck shop reached via Facebook page. SMS #1 fired automatically. Awaiting reply.', days_ago: 1, lifecycle_stage: 'sequenced' },
  // fb_only WITH outreach_draft — shows the "✓ Draft ready" badge + the
  // auto-generated Facebook DM in conversations.
  { name: 'Tanya Burke',     phone: '',               email: '',                  service_type: 'drain_cleaning',  lead_source: 'prospecting_agent', status: 'new_lead',           address: '88 Hillcrest Dr',  city: 'Northwood', notes: 'Solo plumber on Facebook, no website, no phone in listing. FB DM drafted by agent.', days_ago: 2, lifecycle_stage: 'fb_only' },

  // Last month — 12 leads, mostly completed
  { name: 'Rob Kensington',  phone: '(555) 226-0023', email: 'rkens@email.com',   service_type: 'drain_cleaning',   lead_source: 'google_search',     status: 'completed', estimate_amount: 285,  final_revenue: 285,  address: '17 Elm St',       city: 'Westfield', notes: 'Main line cleared',                       days_ago: 22, lifecycle_stage: 'enriched' },
  { name: 'Sandra Okafor',   phone: '(555) 227-3356', email: 'sandrao@email.com', service_type: 'leak_repair',      lead_source: 'facebook',          status: 'completed', estimate_amount: 420,  final_revenue: 420,  address: '234 Park Dr',     city: 'Downtown',  notes: 'Slab leak in laundry room — repaired', days_ago: 24, lifecycle_stage: 'fb_only' },
  { name: 'Colin Reeves',    phone: '(555) 228-8811', email: 'creeves@email.com', service_type: 'toilet_repair',    lead_source: 'referral_customer', status: 'completed', estimate_amount: 295,  final_revenue: 295,  address: '71 Hickory Pl',   city: 'Northwood', notes: 'Flange replacement',                      days_ago: 26, lifecycle_stage: 'enriched' },
  { name: 'Megan Lau',       phone: '(555) 229-4422', email: 'mlau@email.com',    service_type: 'fixture_install', lead_source: 'google_ads',        status: 'completed', estimate_amount: 540,  final_revenue: 540,  address: '318 Juniper',     city: 'Eastside',  notes: 'New kitchen faucet + disposal',           days_ago: 28, lifecycle_stage: 'fb_only' },
  { name: 'Devon Price',     phone: '(555) 230-7733', email: 'dprice@email.com',  service_type: 'water_heater',     lead_source: 'google_search',     status: 'completed', estimate_amount: 1750, final_revenue: 1750, address: '46 Redwood Rd',   city: 'Westfield', notes: 'Standard tank replacement',               days_ago: 30, lifecycle_stage: 'enriched' },
  { name: 'Hana Yamamoto',   phone: '(555) 231-9900', email: 'hanay@email.com',   service_type: 'drain_cleaning',   lead_source: 'instagram',         status: 'completed', estimate_amount: 275,  final_revenue: 275,  address: '89 Ash Ct',       city: 'Downtown',  notes: 'Shower drain + bath',                     days_ago: 32, lifecycle_stage: 'fb_only' },
  { name: 'Chris Patel',     phone: '(555) 232-1134', email: 'cpatel@email.com',  service_type: 'leak_repair',      lead_source: 'repeat_customer',   status: 'completed', estimate_amount: 195,  final_revenue: 195,  address: '502 Willow Way',  city: 'Downtown',  notes: 'Small supply line replacement',           days_ago: 34 },
  { name: 'Olivia Tran',     phone: '(555) 233-6678', email: 'otran@email.com',   service_type: 'gas_line',         lead_source: 'referral_realtor',  status: 'completed', estimate_amount: 820,  final_revenue: 820,  address: '27 Sycamore Ln',  city: 'Eastside',  notes: 'Gas line to new patio grill',             days_ago: 36 },
  { name: 'Frank Delaney',   phone: '(555) 234-2244', email: 'fdel@email.com',    service_type: 'toilet_repair',    lead_source: 'google_search',     status: 'lost',      estimate_amount: 450,                        address: '315 Beechwood',   city: 'Northwood', notes: 'Went with cheaper handyman',              days_ago: 40 },
  { name: 'Alex Johansson',  phone: '(555) 235-5577', email: 'ajohan@email.com',  service_type: 'repipe',           lead_source: 'homeadvisor',       status: 'lost',      estimate_amount: 4200,                       address: '110 Magnolia',    city: 'Westfield', notes: 'Budget tight this quarter — revisit in 6 mo', days_ago: 42 },
  { name: 'Wendy Harper',    phone: '(555) 236-8800', email: 'wharper@email.com', service_type: 'fixture_install', lead_source: 'facebook',          status: 'completed', estimate_amount: 380,  final_revenue: 380,  address: '628 Alder Rd',    city: 'Eastside',  notes: 'Dual-handle lav faucet + supply lines',   days_ago: 45 },
  { name: 'Benjamin Ortega', phone: '(555) 237-1122', email: 'bortega@email.com', service_type: 'drain_cleaning',   lead_source: 'word_of_mouth',     status: 'completed', estimate_amount: 310,  final_revenue: 310,  address: '455 Spruce',      city: 'Downtown',  notes: 'Slow bathroom sink',                      days_ago: 48 },

  // 2 months ago — 10 leads
  { name: 'Julia Ramsey',     phone: '(555) 238-4455', email: 'jramsey@email.com', service_type: 'water_heater',    lead_source: 'google_ads',       status: 'completed', estimate_amount: 1920, final_revenue: 1920, address: '89 Ivy St',       city: 'Downtown',  notes: 'Tankless conversion',                     days_ago: 62 },
  { name: 'Nolan Matthews',   phone: '(555) 239-7788', email: 'nmatt@email.com',   service_type: 'leak_repair',     lead_source: 'repeat_customer',  status: 'completed', estimate_amount: 340,  final_revenue: 340,  address: '17 Rowan Ct',     city: 'Westfield', notes: 'Angle stop replacement',                  days_ago: 64 },
  { name: 'Priya Kapoor',     phone: '(555) 240-1199', email: 'pkapoor@email.com', service_type: 'drain_cleaning',  lead_source: 'google_search',    status: 'completed', estimate_amount: 265,  final_revenue: 265,  address: '703 Olive Ln',    city: 'Northwood', notes: 'Kitchen + laundry drain',                 days_ago: 67 },
  { name: 'Diego Herrera',    phone: '(555) 241-3322', email: 'dherrera@email.com',service_type: 'gas_line',        lead_source: 'referral_realtor', status: 'completed', estimate_amount: 1150, final_revenue: 1150, address: '221 Fir Way',     city: 'Eastside',  notes: 'Range gas line conversion',               days_ago: 70 },
  { name: 'Beth Callahan',    phone: '(555) 242-5544', email: 'bcall@email.com',   service_type: 'fixture_install', lead_source: 'google_search',    status: 'completed', estimate_amount: 610,  final_revenue: 610,  address: '48 Hazel',        city: 'Westfield', notes: 'Dual-shower head + valve rebuild',        days_ago: 73 },
  { name: 'Vincent Park',     phone: '(555) 243-9900', email: 'vpark@email.com',   service_type: 'toilet_repair',   lead_source: 'facebook',         status: 'completed', estimate_amount: 320,  final_revenue: 320,  address: '912 Dogwood',     city: 'Downtown',  notes: 'Flange + fill valve',                     days_ago: 76 },
  { name: 'Tara Mbeki',       phone: '(555) 244-1122', email: 'tmbeki@email.com',  service_type: 'drain_cleaning',  lead_source: 'yard_sign',        status: 'completed', estimate_amount: 290,  final_revenue: 290,  address: '307 Chestnut',    city: 'Eastside',  notes: 'Main sewer line hydro-jet',               days_ago: 80 },
  { name: 'Evan Stokes',      phone: '(555) 245-4455', email: 'estokes@email.com', service_type: 'water_heater',    lead_source: 'google_ads',       status: 'completed', estimate_amount: 1680, final_revenue: 1680, address: '611 Larch Pl',    city: 'Downtown',  notes: '50-gal electric replacement',             days_ago: 84 },
  { name: 'Sophia Delacroix', phone: '(555) 246-7788', email: 'sdela@email.com',   service_type: 'leak_repair',     lead_source: 'referral_customer',status: 'completed', estimate_amount: 445,  final_revenue: 445,  address: '82 Linden',       city: 'Westfield', notes: 'Pinhole copper repair',                   days_ago: 87 },
  { name: 'Jordan Blake',     phone: '(555) 247-1000', email: 'jblake@email.com',  service_type: 'fixture_install', lead_source: 'google_search',    status: 'lost',      estimate_amount: 890,                        address: '156 Poplar Rd',   city: 'Northwood', notes: 'DIYing it themselves',                    days_ago: 90 },

  // ── REPEAT CUSTOMERS ── — same phone/email as earlier entries. The
  // /api/tenant/clients endpoint groups leads by phone so these collapse
  // into a single customer card showing a higher job count.
  // Sarah Mitchell (new_lead -> ends up with 3 jobs total: this + 2 below)
  { name: 'Sarah Mitchell',  phone: '(555) 260-3030', email: 'smitchell@email.com', service_type: 'drain_cleaning',  lead_source: 'repeat_customer', status: 'completed', estimate_amount: 320,  final_revenue: 320,  address: '712 Rosewood',        city: 'Westfield', notes: 'Kitchen sink — regular customer',      days_ago: 11 },
  { name: 'Sarah Mitchell',  phone: '(555) 260-3030', email: 'smitchell@email.com', service_type: 'water_heater',    lead_source: 'repeat_customer', status: 'completed', estimate_amount: 1890, final_revenue: 1890, address: '712 Rosewood',        city: 'Westfield', notes: 'Tankless conversion',                  days_ago: 95 },
  { name: 'Sarah Mitchell',  phone: '(555) 260-3030', email: 'smitchell@email.com', service_type: 'fixture_install', lead_source: 'google_search',   status: 'completed', estimate_amount: 510,  final_revenue: 510,  address: '712 Rosewood',        city: 'Westfield', notes: 'Master bath faucet + supply lines',    days_ago: 160 },
  // Colin Reeves (2 jobs total: original toilet_repair -26d + new faucet_install -120d)
  { name: 'Colin Reeves',    phone: '(555) 228-8811', email: 'creeves@email.com',   service_type: 'fixture_install', lead_source: 'repeat_customer', status: 'completed', estimate_amount: 425,  final_revenue: 425,  address: '71 Hickory Pl',       city: 'Northwood', notes: 'Kitchen faucet swap',                  days_ago: 120 },
  // Diego Herrera (2 jobs total: original gas_line -70d + new drain_cleaning -25d)
  { name: 'Diego Herrera',   phone: '(555) 241-3322', email: 'dherrera@email.com',  service_type: 'drain_cleaning',  lead_source: 'repeat_customer', status: 'completed', estimate_amount: 260,  final_revenue: 260,  address: '221 Fir Way',         city: 'Eastside',  notes: 'Basement drain — returning customer', days_ago: 25 },

  // Months -3 through -6 — spread out
  { name: 'Keisha Floyd',   phone: '(555) 248-2233', email: 'kfloyd@email.com', service_type: 'water_heater',     lead_source: 'google_search',     status: 'completed', estimate_amount: 1820, final_revenue: 1820, address: '19 Cypress',        city: 'Downtown',  notes: 'Tank replacement',                       days_ago: 105 },
  { name: 'Ian Calloway',   phone: '(555) 249-4455', email: 'ical@email.com',   service_type: 'drain_cleaning',   lead_source: 'facebook',          status: 'completed', estimate_amount: 250,  final_revenue: 250,  address: '340 Persimmon',     city: 'Eastside',  notes: 'Laundry drain',                          days_ago: 115 },
  { name: 'Monica Vega',    phone: '(555) 250-6677', email: 'mvega@email.com',  service_type: 'leak_repair',      lead_source: 'homeadvisor',       status: 'completed', estimate_amount: 380,  final_revenue: 380,  address: '627 Mulberry',      city: 'Westfield', notes: 'Outdoor hose bib repair',                days_ago: 125 },
  { name: 'Ashton Reilly',  phone: '(555) 251-8899', email: 'arelly@email.com', service_type: 'fixture_install',  lead_source: 'referral_realtor',  status: 'completed', estimate_amount: 720,  final_revenue: 720,  address: '55 Basswood',       city: 'Downtown',  notes: 'Pre-sale fixture refresh',               days_ago: 135 },
  { name: 'Lila Brooks',    phone: '(555) 252-1111', email: 'lbrooks@email.com',service_type: 'gas_line',         lead_source: 'google_ads',        status: 'completed', estimate_amount: 980,  final_revenue: 980,  address: '18 Redwood Ct',     city: 'Eastside',  notes: 'Gas log install + line',                 days_ago: 145 },
  { name: 'Saul Briggs',    phone: '(555) 253-3333', email: 'sbriggs@email.com',service_type: 'drain_cleaning',   lead_source: 'repeat_customer',   status: 'completed', estimate_amount: 310,  final_revenue: 310,  address: '402 Willow Creek',  city: 'Northwood', notes: 'Main line + camera inspection',          days_ago: 155 },
  { name: 'Nadia Walsh',    phone: '(555) 254-5555', email: 'nwalsh@email.com', service_type: 'toilet_repair',    lead_source: 'google_search',     status: 'completed', estimate_amount: 380,  final_revenue: 380,  address: '271 Ironwood',      city: 'Westfield', notes: 'Two-toilet fill valve + flapper',        days_ago: 165 },
  { name: 'Roman Petrov',   phone: '(555) 255-7777', email: 'rpetrov@email.com',service_type: 'water_heater',     lead_source: 'referral_customer', status: 'completed', estimate_amount: 1620, final_revenue: 1620, address: '89 Silverleaf',     city: 'Downtown',  notes: 'Straight swap tank',                     days_ago: 170 },
  { name: 'Harper Quinn',   phone: '(555) 256-9999', email: 'hquinn@email.com', service_type: 'fixture_install',  lead_source: 'facebook',          status: 'completed', estimate_amount: 460,  final_revenue: 460,  address: '512 Saplings Ln',   city: 'Eastside',  notes: 'Bath vanity + faucet',                   days_ago: 180 },
];

const REFERRAL_CONTACTS = [
  { name: 'Linda Chen',    email: 'linda@chenhomes.com',       phone: '(555) 111-2233', title: 'Realtor',          company: 'Chen Homes Realty',    contact_type: 'referral_partner', outreach_status: 'engaged' },
  { name: 'Mike Rawlings', email: 'mike@rawlinginsurance.com', phone: '(555) 222-3344', title: 'Insurance Agent',  company: 'Rawlings Insurance',    contact_type: 'referral_partner', outreach_status: 'engaged' },
  { name: 'Kara Bellamy',  email: 'kara@homepromanager.com',   phone: '(555) 333-4455', title: 'Property Manager', company: 'HomePro Management',    contact_type: 'referral_partner', outreach_status: 'new' },
];

// Content mix: 3 already posted (shown as history), 2 approved + scheduled
// (shown in queue), 3 in "draft" / pending approval (THE KEY state — this
// is what a prospect logs in and sees "needing their attention" in the
// approval queue. Each hook uses the formula Patrick described: cost of
// failure → cost of getting ahead of it → credible social proof.)
// Every draft has an explicit headline so the post cards don't fall back to
// "Untitled". Each also ships with an image_url that populates image_urls[]
// so the approval-queue cards show a real before/after-style thumbnail.
const CONTENT_DRAFTS = [
  // ── Recently posted (history) ──
  {
    platform: 'facebook',  status: 'posted',
    headline: 'Slab leak, fixed first pass',
    body: 'Fixed a slab leak in a Westfield laundry room today. Found it on the first pass — no guesswork, no unnecessary demo. Clean fix, dry floors, customer back to laundry. That\'s how we do it. 🔧\n\n#Plumbing #Westfield #ApexPlumbing',
    image_url: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=1080&q=80',
    days_ago: 23,
  },
  {
    platform: 'instagram', status: 'posted',
    headline: 'Galvanized shutoffs → quarter-turns',
    body: 'Before/After: Old galvanized shutoffs → new quarter-turn valves. Your angle stops should not be an adventure. If yours look like the before photo, it\'s time.\n\n#Plumbing #BeforeAfter #HomeMaintenance',
    image_url: 'https://images.unsplash.com/photo-1581092921461-eab62e97a780?w=1080&q=80',
    days_ago: 30,
  },
  {
    platform: 'facebook',  status: 'posted',
    headline: 'Megan L., Eastside — 5 star review',
    body: '⭐⭐⭐⭐⭐ "Apex was fast, clean, and fair on price. Will call them for everything going forward." — Megan L., Eastside\n\nThanks Megan! That\'s the kind of review that keeps us going.',
    days_ago: 34,
  },

  // ── Approved + scheduled (in queue) ──
  {
    platform: 'instagram', status: 'approved',
    headline: 'Water heater: $1,800 vs $1,200',
    body: 'Water heater fails on average every 8-12 years.\n\nThe repair bill when it goes unexpectedly: $1,800 average (tank + install + emergency labor).\n\nThe cost of replacing it on YOUR schedule: $1,200, done in 3 hours.\n\nWe swapped this unit in Westfield last week. Homeowner slept fine that night. 💧',
    // 2026-05-27: replaced 404 photo (1617781377265-7ed14f0d4e6a was deleted from Unsplash).
    image_url: 'https://images.unsplash.com/photo-1604762524889-3e2fcc145683?w=1080&q=80',
    scheduled_days_ahead: 2,
  },
  {
    platform: 'facebook',  status: 'approved',
    headline: 'Summer leak season same-day',
    body: 'Summer leak season is real. Sprinkler lines, hose bibs, and outdoor spigots all come out of a long winter looking a little rough. If yours is dripping, leaking, or just doesn\'t turn off all the way — we fix those same day.',
    scheduled_days_ahead: 5,
  },

  // ── Pending approval (DRAFT — the key "needs your attention" state) ──
  {
    platform: 'instagram', status: 'draft',
    headline: 'The expensive surprise in your house',
    body: 'Your water heater is the most expensive "surprise" in your house.\n\nAverage cost when it fails: $1,800 (tank + install + emergency labor).\nAverage cost when you plan it: $1,200.\n\nThe difference is 3 hours on a weekday vs a Saturday 2 AM panic.\n\nWe just replaced this unit for a Westfield homeowner — same day, same morning, done. 💧\n\n#Plumbing #WaterHeater #Apex',
    // 2026-05-27: replaced 404 photo (1617781377265-7ed14f0d4e6a was deleted from Unsplash).
    image_url: 'https://images.unsplash.com/photo-1611117775350-ac3950990985?w=1080&q=80',
  },
  {
    platform: 'facebook', status: 'draft',
    headline: 'Dripping faucet math: $35/year',
    body: 'Faucet repair we wrapped up yesterday — before and after. Dripped for 8 months before they called. Fixed in 45 minutes.\n\nHere\'s the math nobody tells you:\nA faucet dripping once per second wastes 5 gallons of water per day.\nThat\'s 1,825 gallons per year.\nAt $0.004/gal water + $0.015/gal sewer, that\'s $35/year gone — forever.\n\nFix cost: $180. Payback: 5 years. But really, you\'re buying back your sanity.',
    image_url: 'https://images.unsplash.com/photo-1542013936693-884638332954?w=1080&q=80',
  },
  {
    platform: 'instagram', status: 'draft',
    headline: '24/7 emergency drain calls',
    body: 'Main line backed up at 10 PM on a Wednesday? We answer 24/7.\n\nLast week\'s call: sewer backup at a duplex in Eastside. Cleared in 90 minutes. Both units back online before midnight.\n\nAvg emergency drain call: $385. Avg after-hours rate elsewhere: $600-$900. We don\'t play games.\n\n📞 Save our number — you\'ll use it eventually.',
    image_url: 'https://images.unsplash.com/photo-1607472586893-edb57bdc0e39?w=1080&q=80',
  },
];

const FINANCE_EXPENSES = [
  { category: 'Insurance',            amount: 485, description: 'General liability premium',                                 days_ago: 2,  recurring: true },
  { category: 'Fuel',                 amount: 287, description: 'Diesel + van fuel — this week',                              days_ago: 3 },
  { category: 'Software & SaaS',      amount: 89,  description: 'ServiceTitan / scheduling app',                              days_ago: 5,  recurring: true },
  { category: 'Supplies & Materials', amount: 420, description: 'Home Depot — fittings, solder, flux',                        days_ago: 6 },
  { category: 'Vehicle & Fuel',       amount: 165, description: 'Van oil change + tire rotation',                             days_ago: 14 },
  { category: 'Supplies & Materials', amount: 680, description: 'Ferguson — water heater + install kit',                      days_ago: 18 },
  { category: 'Insurance',            amount: 485, description: 'General liability premium',                                  days_ago: 32, recurring: true },
  { category: 'Fuel',                 amount: 310, description: 'Diesel + van fuel',                                          days_ago: 34 },
  { category: 'Supplies & Materials', amount: 510, description: 'Ferguson — repipe materials (PEX, fittings)',                days_ago: 38 },
  { category: 'Software & SaaS',      amount: 89,  description: 'ServiceTitan / scheduling app',                              days_ago: 40, recurring: true },
  { category: 'Marketing & Advertising', amount: 220, description: 'Google Ads — plumbing keywords',                          days_ago: 42 },
  { category: 'Insurance',            amount: 485, description: 'General liability premium',                                  days_ago: 62, recurring: true },
  { category: 'Fuel',                 amount: 295, description: 'Diesel + van fuel',                                          days_ago: 65 },
  { category: 'Supplies & Materials', amount: 380, description: 'Home Depot — fixtures and PVC',                              days_ago: 68 },
  { category: 'Marketing & Advertising', amount: 220, description: 'Google Ads — plumbing keywords',                          days_ago: 72 },
  { category: 'Software & SaaS',      amount: 89,  description: 'ServiceTitan / scheduling app',                              days_ago: 72, recurring: true },
  { category: 'Insurance',            amount: 485, description: 'General liability premium',                                  days_ago: 92, recurring: true },
  { category: 'Fuel',                 amount: 305, description: 'Diesel + van fuel',                                          days_ago: 95 },
  { category: 'Supplies & Materials', amount: 445, description: 'Ferguson — misc fittings and valves',                        days_ago: 98 },
  { category: 'Software & SaaS',      amount: 89,  description: 'ServiceTitan / scheduling app',                              days_ago: 105, recurring: true },
  { category: 'Insurance',            amount: 485, description: 'General liability premium',                                  days_ago: 122, recurring: true },
  { category: 'Fuel',                 amount: 280, description: 'Diesel + van fuel',                                          days_ago: 128 },
  { category: 'Vehicle & Fuel',       amount: 340, description: 'Van brakes + rear pads',                                     days_ago: 140 },
  { category: 'Software & SaaS',      amount: 89,  description: 'ServiceTitan / scheduling app',                              days_ago: 142, recurring: true },
  { category: 'Insurance',            amount: 485, description: 'General liability premium',                                  days_ago: 152, recurring: true },
  { category: 'Fuel',                 amount: 290, description: 'Diesel + van fuel',                                          days_ago: 158 },
  { category: 'Supplies & Materials', amount: 520, description: 'Ferguson — water heater + install kit',                      days_ago: 163 },
  { category: 'Software & SaaS',      amount: 89,  description: 'ServiceTitan / scheduling app',                              days_ago: 172, recurring: true },
];

const CREW = [
  { name: 'Sam Reilly',  role: 'Owner / Master Plumber', phone: '(555) 555-0100', daily_rate: 420 },
  { name: 'Jared Nolan', role: 'Apprentice',             phone: '(555) 555-0101', daily_rate: 180 },
];

// Debt records — typical liabilities a 1-2 person service shop carries.
// Shown in Reports → Debt with progress bars + "Mark Paid Off" actions.
const DEBTS = [
  { name: 'Ford Transit Van Loan',     original_amount: 38000, current_balance: 21500, monthly_payment: 620 },
  { name: 'Equipment Line (Ferguson)', original_amount: 12000, current_balance: 4800,  monthly_payment: 350 },
  { name: 'Chase Business Credit',     original_amount: 8500,  current_balance: 2150,  monthly_payment: 200 },
];

// Crew daily work logs — 2 crew members, working 4-5 days/week most weeks
// across the rolling 6-month window. Sam (owner) works ~22 days/mo, Jared
// ~18 days/mo. Enough variety to make the Employee Summary look real.
function generateCrewLogs(crewByName) {
  const logs = [];
  const samId = crewByName['Sam Reilly'];
  const jaredId = crewByName['Jared Nolan'];
  if (!samId && !jaredId) return logs;
  // Walk backwards from today, skip Sundays, give Sam ~M-F + half Saturdays
  // and Jared ~M-Th (apprentice on lighter schedule).
  for (let d = 1; d <= 180; d++) {
    const day = new Date(now - d * 86400000);
    const dow = day.getDay(); // 0=Sun..6=Sat
    const dateStr = day.toISOString().split('T')[0];
    if (samId && dow !== 0) {
      // Sam: M-F always, Sat 50% of weeks
      const worked = dow >= 1 && dow <= 5 ? true : Math.random() > 0.5;
      logs.push({ crew_member_id: samId, date: dateStr, worked });
    }
    if (jaredId && dow >= 1 && dow <= 4) {
      // Jared: M-Th. ~10% sick/personal days off.
      const worked = Math.random() > 0.1;
      logs.push({ crew_member_id: jaredId, date: dateStr, worked });
    }
  }
  return logs;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function deleteDemoTenant() {
  // Delete both the old Summit slug AND the new Apex slug if they exist
  for (const slug of ['demo-service-pro', 'demo-apex-plumbing', 'demo-oakline']) {
    const { data: existing } = await db.from('tenants').select('id').eq('slug', slug).maybeSingle();
    if (existing) {
      console.log(`  🧹 Deleting tenant '${slug}' (${existing.id})...`);
      await db.from('tenants').delete().eq('id', existing.id);
    }
  }
}

async function seed() {
  const reset = process.argv.includes('--reset');
  console.log(`\n🌱 Seeding Demo Tenant: ${BUSINESS_NAME}\n`);

  if (reset) await deleteDemoTenant();

  const { data: tenant, error: tenantErr } = await db
    .from('tenants')
    .upsert(DEMO_TENANT, { onConflict: 'slug' })
    .select()
    .single();

  if (tenantErr) { console.error('Tenant upsert failed:', tenantErr); process.exit(1); }
  const tid = tenant.id;
  console.log(`  ✓ Tenant ${tid}`);

  // Modules
  const MODULES = {
    lead_capture: true, speed_to_lead: true, missed_call: true, follow_up: true,
    review_request: true, referral_engine: true, referral_outreach: true,
    content_engine: true, publishing: true, prospecting: true, lead_scoring: true,
    branded_app: true, finance: true, digest: true,
  };
  await db.from('tenant_modules').upsert(
    Object.entries(MODULES).map(([module, enabled]) => ({ tenant_id: tid, module, enabled, config: {} })),
    { onConflict: 'tenant_id,module' },
  );

  // Config
  const config = {
    business_name: BUSINESS_NAME,
    phone: '(555) 555-PIPE',
    email: 'info@apexplumbing.co',
    service_area: 'Downtown, Eastside, Westfield, Northwood',
    review_url: 'https://g.page/apexplumbing/review',
    tier: 'growth',
    monthly_rate: 0, // service business, no subscription
    setup_fee: 0,
    setup_fee_paid: true,
  };
  await db.from('tenant_config').upsert(
    Object.entries(config).map(([key, value]) => ({
      tenant_id: tid, key,
      value: typeof value === 'string' ? JSON.stringify(value) : value,
    })),
    { onConflict: 'tenant_id,key' },
  );

  // Leads
  const leadRows = LEADS.map((l) => ({
    tenant_id: tid,
    name: l.name, phone: l.phone, email: l.email,
    service_type: l.service_type, lead_source: l.lead_source,
    status: l.status,
    lifecycle_stage: l.lifecycle_stage || null,
    estimate_amount: l.estimate_amount || null,
    final_revenue: l.final_revenue || null,
    address: l.address, city: l.city, notes: l.notes,
    date_of_inquiry: isoDaysAgo(l.days_ago),
    created_at: isoDaysAgo(l.days_ago),
    updated_at: isoDaysAgo(Math.max(0, l.days_ago - 1)),
  }));
  const { data: leads } = await db.from('leads').upsert(leadRows).select('id, name, status');
  console.log(`  ✓ ${leads?.length || 0} leads`);
  const leadByName = {};
  (leads || []).forEach((l) => { leadByName[l.name] = l.id; });

  // Contacts: ONE customer per unique phone across all completed/won leads.
  // When a customer has multiple leads (repeat business), we want a single
  // contact row pointing at their most recent lead, not N duplicates. The
  // /api/tenant/clients endpoint then groups all their leads by phone and
  // reports a lead_count > 1 on the Accounts screen.
  const customerByPhone = new Map();
  for (const l of LEADS) {
    if (!['completed', 'won'].includes(l.status)) continue;
    const phone = l.phone;
    if (!phone) continue;
    const prior = customerByPhone.get(phone);
    // Prefer the most recent lead (smallest days_ago) as the contact anchor
    if (!prior || (l.days_ago < prior.days_ago)) {
      customerByPhone.set(phone, l);
    }
  }
  const customerContacts = Array.from(customerByPhone.values()).map((l) => ({
    tenant_id: tid, lead_id: leadByName[l.name] || null,
    name: l.name, phone: l.phone, email: l.email,
    contact_type: 'customer',
    outreach_status: l.status === 'completed' ? 'completed' : 'active',
    is_primary_contact: true,
  }));
  const partnerContacts = REFERRAL_CONTACTS.map((c) => ({
    tenant_id: tid, name: c.name, email: c.email, phone: c.phone,
    title: c.title, company: c.company,
    contact_type: c.contact_type, outreach_status: c.outreach_status,
  }));
  const { data: contacts } = await db
    .from('contacts')
    .upsert([...customerContacts, ...partnerContacts])
    .select('id, name');
  console.log(`  ✓ ${contacts?.length || 0} contacts (${customerContacts.length} customers + ${partnerContacts.length} partners)`);

  // Jobs
  const jobRows = LEADS.filter((l) => l.status === 'completed').map((l) => ({
    tenant_id: tid,
    lead_id: leadByName[l.name] || null,
    status: 'completed',
    scheduled_date: dateDaysAgo(l.days_ago + 1),
    completed_date: dateDaysAgo(l.days_ago),
    description: `${(l.service_type || '').replace(/_/g, ' ')} — ${l.address}, ${l.city}`,
    revenue: l.final_revenue,
  }));
  const wonLead = LEADS.find((l) => l.status === 'won');
  if (wonLead) {
    jobRows.push({
      tenant_id: tid,
      lead_id: leadByName[wonLead.name] || null,
      status: 'scheduled',
      scheduled_date: dateDaysAgo(-3),
      description: `${wonLead.service_type.replace(/_/g, ' ')} — ${wonLead.address}, ${wonLead.city}`,
    });
  }
  const { data: jobs } = await db.from('jobs').upsert(jobRows).select('id');
  console.log(`  ✓ ${jobs?.length || 0} jobs`);

  // Content — include headline so cards don't fall back to "Untitled", and
  // image_urls[] so the approval-queue thumbnails render (Unsplash URLs are
  // long-lived CDN links).
  const contentRows = CONTENT_DRAFTS.map((c) => ({
    tenant_id: tid,
    platform: c.platform,
    status: c.status,
    headline: c.headline || null,
    body: c.body,
    image_urls: c.image_url ? [c.image_url] : [],
    posted_at: c.status === 'posted' && c.days_ago != null ? isoDaysAgo(c.days_ago) : null,
    scheduled_for: c.scheduled_days_ahead ? isoDaysAgo(-c.scheduled_days_ahead) : null,
    created_at: isoDaysAgo(c.days_ago != null ? c.days_ago : 1),
  }));
  const { data: content } = await db.from('content_drafts').upsert(contentRows).select('id');
  console.log(`  ✓ ${content?.length || 0} content drafts`);

  // Crew (2 people) — now seeded with daily work logs so Reports →
  // Employee Summary actually shows days/pay instead of empty state.
  const crewRows = CREW.map((c) => ({ tenant_id: tid, ...c, is_active: true }));
  const { data: crew } = await db.from('crew_members').upsert(crewRows).select('id, name');
  console.log(`  ✓ ${crew?.length || 0} crew members`);

  // Map crew name → id so the daily log generator can attribute work days.
  const crewByName = {};
  for (const c of crew || []) crewByName[c.name] = c.id;
  const crewLogRows = generateCrewLogs(crewByName).map((row) => ({ tenant_id: tid, ...row }));
  if (crewLogRows.length) {
    const { data: logs } = await db.from('crew_daily_log').upsert(crewLogRows).select('id');
    console.log(`  ✓ ${logs?.length || 0} crew daily logs`);
  }

  // Debt — 3 typical liabilities for a 1-2 person shop. Powers the
  // Reports → Debt modal with realistic progress bars and "Mark Paid Off"
  // demo actions.
  const debtRows = DEBTS.map((d) => ({ tenant_id: tid, ...d }));
  const { data: debts } = await db.from('debt_tracker').upsert(debtRows).select('id');
  console.log(`  ✓ ${debts?.length || 0} debt records`);

  // Finance — income from completed jobs + expense log
  const incomeRows = LEADS
    .filter((l) => l.status === 'completed' && l.final_revenue)
    .map((l) => ({
      tenant_id: tid,
      entry_type: 'income',
      category: 'Service Revenue',
      amount: l.final_revenue,
      description: `${l.name} — ${(l.service_type || '').replace(/_/g, ' ')}`,
      date: dateDaysAgo(l.days_ago),
      lead_id: leadByName[l.name] || null,
    }));
  const expenseRows = FINANCE_EXPENSES.map((e) => ({
    tenant_id: tid,
    entry_type: 'expense',
    category: e.category,
    amount: e.amount,
    description: e.description,
    date: dateDaysAgo(e.days_ago),
    recurring: !!e.recurring,
  }));
  const { data: finance } = await db
    .from('finance_entries')
    .upsert([...incomeRows, ...expenseRows])
    .select('id');
  console.log(`  ✓ ${finance?.length || 0} finance entries`);

  // Outreach draft — one pending approval for the first "Ready" lead (Dana Whitfield).
  // This lets the demo user see the outreach approval flow on the lead detail screen.
  const danaLeadId = leadByName['Dana Whitfield'];
  if (danaLeadId) {
    // Create a contact for Dana so sequence has a contact_id
    // Dana already exists as a contact from the customer seed above only if
    // she has status=completed/won. She's new_lead, so insert a prospect contact.
    let danaContactId = null;
    const { data: existingDana } = await db.from('contacts')
      .select('id').eq('tenant_id', tid).eq('phone', '(555) 220-4419').maybeSingle();
    if (existingDana) {
      danaContactId = existingDana.id;
    } else {
      const { data: danaContact } = await db.from('contacts').insert({
        tenant_id: tid,
        lead_id: danaLeadId,
        name: 'Dana Whitfield',
        email: 'danaw@email.com',
        phone: '(555) 220-4419',
        contact_type: 'prospect',
        outreach_status: 'new',
      }).select('id').single();
      danaContactId = danaContact?.id;
    }

    const { data: seq } = await db.from('outreach_sequences').insert({
      tenant_id: tid,
      lead_id: danaLeadId,
      contact_id: danaContactId,
      sequence_type: 'email',
      sequence_status: 'draft',
      message_subject: 'Quick question about your kitchen drain',
      message_body: `Hi Dana,\n\nThanks for reaching out about your kitchen sink backup. We've got availability this week and can usually clear a kitchen drain in under an hour.\n\nWould tomorrow afternoon work for a quick visit? We'll take a look, give you an honest assessment, and if it's straightforward we can knock it out on the spot.\n\nNo trip charge, no pressure.\n\nBest,\nSam Reilly\nApex Plumbing\n(555) 555-PIPE`,
      step_number: 1,
    }).select('id').single();

    if (seq) {
      await db.from('conversations').insert({
        tenant_id: tid,
        lead_id: danaLeadId,
        sequence_id: seq.id,
        channel: 'email',
        direction: 'outbound',
        status: 'draft',
        message_subject: 'Quick question about your kitchen drain',
        message_body: `Hi Dana,\n\nThanks for reaching out about your kitchen sink backup. We've got availability this week and can usually clear a kitchen drain in under an hour.\n\nWould tomorrow afternoon work for a quick visit? We'll take a look, give you an honest assessment, and if it's straightforward we can knock it out on the spot.\n\nNo trip charge, no pressure.\n\nBest,\nSam Reilly\nApex Plumbing\n(555) 555-PIPE`,
        metadata: {
          body_html: `<p>Hi Dana,</p><p>Thanks for reaching out about your kitchen sink backup. We've got availability this week and can usually clear a kitchen drain in under an hour.</p><p>Would tomorrow afternoon work for a quick visit? We'll take a look, give you an honest assessment, and if it's straightforward we can knock it out on the spot.</p><p>No trip charge, no pressure.</p><p>Best,<br>Sam Reilly<br>Apex Plumbing<br>(555) 555-PIPE</p>`,
        },
      });
      console.log('  ✓ 1 outreach draft (Dana Whitfield — pending approval)');
    }
  }

  // 2026-05-27: showcase facebook-prospecting agent output
  //
  // Jorge (text_message_sent) — SMS already fired, sitting awaiting reply.
  // Logged as a conversation row so the lead detail screen shows the
  // outbound SMS history.
  const jorgeLeadId = leadByName['Jorge Velasquez'];
  if (jorgeLeadId) {
    await db.from('conversations').insert({
      tenant_id: tid,
      lead_id: jorgeLeadId,
      channel: 'sms',
      direction: 'outbound',
      status: 'sent',
      message_body: "Hey Jorge — saw Velasquez Plumbing on Facebook. Quick question: do you have a branded website yet, and are you missing any calls when you're under a sink? Happy to walk you through what we'd set up — no pitch.",
      metadata: {
        agent: 'facebook-prospecting',
        phase: 'day0',
        external_id: 'demo-SM-jorge-day0',
      },
    });
    console.log('  ✓ Jorge Velasquez — Day-0 SMS sent (facebook-prospecting)');
  }

  // Tanya (fb_only with FB DM draft awaiting approval) — surfaces the
  // "Draft ready" badge on the new pipeline UI and demos the FB DM
  // copy the agent generated.
  const tanyaLeadId = leadByName['Tanya Burke'];
  if (tanyaLeadId) {
    await db.from('conversations').insert({
      tenant_id: tid,
      lead_id: tanyaLeadId,
      channel: 'facebook_dm',
      direction: 'outbound',
      status: 'draft',
      message_body: "Hi Tanya — I noticed your plumbing page on Facebook and that you don't have a website yet. We help solo plumbers like you turn job photos into a clean booking page plus auto-text every missed call so you stop losing leads when you're under a sink. Open to a 10-minute look?",
      metadata: {
        agent: 'facebook-prospecting',
        phase: 'day0',
        draft_status: 'awaiting_approval',
        facebook_url: 'https://www.facebook.com/TanyaBurkePlumbing',
        generated_at: new Date().toISOString(),
      },
    });
    console.log('  ✓ Tanya Burke — FB DM draft (facebook-prospecting, awaiting approval)');
  }

  const revenue = incomeRows.reduce((s, r) => s + (r.amount || 0), 0);
  const expenses = expenseRows.reduce((s, r) => s + (r.amount || 0), 0);

  console.log('\n─────────────────────────────────────────');
  console.log(`📊 ${BUSINESS_NAME} — Demo Tenant Seeded`);
  console.log('─────────────────────────────────────────');
  console.log(`  Tenant ID:      ${tid}`);
  console.log(`  Slug:           ${DEMO_SLUG}`);
  console.log(`  Vertical:       home_services`);
  console.log(`  is_demo:        true`);
  console.log(`  Owner email:    ${OWNER_EMAIL}`);
  console.log(`  6-Month totals: $${revenue.toLocaleString()} revenue / $${expenses.toLocaleString()} expenses`);
  console.log('─────────────────────────────────────────');
  console.log('\n✅ Next: node scripts/create-demo-user.js\n');
}

seed().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
