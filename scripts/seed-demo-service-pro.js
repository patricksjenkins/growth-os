/**
 * Growth OS — Demo Tenant: Service Pro (public demo)
 *
 * Seeds a realistic home-services (plumbing) 1–2 person shop named
 * "Summit Plumbing Co" with 6 rolling months of data. This is the tenant
 * behind demo@firstgenautomate.com, linked in sales collateral and served
 * to Apple reviewers during App Store submission.
 *
 * Usage:
 *   node scripts/seed-demo-service-pro.js           # create/upsert
 *   node scripts/seed-demo-service-pro.js --reset   # wipe + recreate
 *
 * Safety:
 *   - tenant.is_demo = true. The integration layer (twilio/buffer/stripe/email)
 *     checks this flag and short-circuits real sends, so any button a
 *     prospect taps appears to work without triggering real side effects.
 *   - A weekly cron (demo-reset) re-runs this script to refresh date-sensitive
 *     fields so the demo always looks "current" (jobs from last week, etc.).
 */

require('dotenv').config();
const { db } = require('../db/client');

const DEMO_SLUG = 'demo-service-pro';
const BUSINESS_NAME = 'Summit Plumbing Co';
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
    // logo_url intentionally null — the app falls back to the FGA default
    // so prospects see a familiar placeholder rather than a fake logo.
  },
};

// ---------------------------------------------------------------------------
// Helper: offset a "days ago" value to produce an ISO timestamp.
// ---------------------------------------------------------------------------
const now = new Date();
const daysAgo = (n) => new Date(now - n * 86400000);
const isoDaysAgo = (n) => daysAgo(n).toISOString();
const dateDaysAgo = (n) => daysAgo(n).toISOString().split('T')[0];

// ---------------------------------------------------------------------------
// Seed data — 6 rolling months of a 1–2 person plumbing shop.
// The date-sensitive `days_ago` offsets mean running this script again always
// produces a "recent-looking" dataset (last job was yesterday, etc.).
// ---------------------------------------------------------------------------

const LEADS = [
  // ─── Month -0 (current month) — 6 leads, active pipeline ───
  { name: 'Dana Whitfield', phone: '(555) 220-4419', email: 'danaw@email.com', service_type: 'drain_cleaning',     lead_source: 'google_search',   status: 'new_lead',            address: '412 Birch St',         city: 'Eastside',   notes: 'Kitchen sink backup since yesterday',                                                                    days_ago: 0 },
  { name: 'Marcus Ruiz',    phone: '(555) 221-8832', email: 'mruiz@email.com', service_type: 'water_heater',       lead_source: 'facebook',        status: 'new_lead',            address: '88 Maple Ave',          city: 'Downtown',   notes: '10-year-old tank, wants estimate for tankless replacement',                                               days_ago: 1 },
  { name: 'Priya Desai',    phone: '(555) 222-1156', email: 'priyad@email.com',service_type: 'leak_repair',        lead_source: 'missed_call',     status: 'contacted',           address: '23 Cedar Ln',           city: 'Westfield',  notes: 'Small leak under master bath sink — has bucket catching it',                                            days_ago: 2 },
  { name: 'Greg Morrow',    phone: '(555) 223-9447', email: 'gmorrow@email.com',service_type: 'repipe',            lead_source: 'referral_customer',status: 'estimate_scheduled',   estimate_amount: null,       address: '507 Oak Park',          city: 'Northwood',  notes: 'Old galvanized pipes — whole house repipe estimate Wed',                                                days_ago: 3 },
  { name: 'Aisha Brown',    phone: '(555) 224-2288', email: 'abrown@email.com',service_type: 'toilet_repair',      lead_source: 'google_ads',      status: 'estimate_given',      estimate_amount: 340,        address: '14 Pine Ct',            city: 'Eastside',   notes: 'Running toilet, wax seal likely. Gave $340 estimate.',                                                  days_ago: 4 },
  { name: 'Tyler Jensen',   phone: '(555) 225-5591', email: 'tjensen@email.com',service_type: 'water_heater',      lead_source: 'yard_sign',       status: 'won',                estimate_amount: 1850,       address: '902 Willow Way',        city: 'Downtown',   notes: 'Going with tankless install — scheduled for next week',                                                 days_ago: 5 },

  // ─── Month -1 (3–6 weeks ago) — 12 leads, 8 completed ───
  { name: 'Rob Kensington',  phone: '(555) 226-0023', email: 'rkens@email.com', service_type: 'drain_cleaning',  lead_source: 'google_search',    status: 'completed', estimate_amount: 285,   final_revenue: 285,   address: '17 Elm St',            city: 'Westfield',  notes: 'Main line cleared',                           days_ago: 22 },
  { name: 'Sandra Okafor',   phone: '(555) 227-3356', email: 'sandrao@email.com',service_type: 'leak_repair',   lead_source: 'facebook',         status: 'completed', estimate_amount: 420,   final_revenue: 420,   address: '234 Park Dr',          city: 'Downtown',   notes: 'Slab leak in laundry room — repaired',       days_ago: 24 },
  { name: 'Colin Reeves',    phone: '(555) 228-8811', email: 'creeves@email.com',service_type: 'toilet_repair', lead_source: 'referral_customer',status: 'completed', estimate_amount: 295,   final_revenue: 295,   address: '71 Hickory Pl',        city: 'Northwood',  notes: 'Flange replacement',                          days_ago: 26 },
  { name: 'Megan Lau',       phone: '(555) 229-4422', email: 'mlau@email.com',  service_type: 'fixture_install',lead_source: 'google_ads',       status: 'completed', estimate_amount: 540,   final_revenue: 540,   address: '318 Juniper',          city: 'Eastside',   notes: 'New kitchen faucet + disposal',               days_ago: 28 },
  { name: 'Devon Price',     phone: '(555) 230-7733', email: 'dprice@email.com',service_type: 'water_heater',   lead_source: 'google_search',    status: 'completed', estimate_amount: 1750,  final_revenue: 1750,  address: '46 Redwood Rd',        city: 'Westfield',  notes: 'Standard tank replacement',                   days_ago: 30 },
  { name: 'Hana Yamamoto',   phone: '(555) 231-9900', email: 'hanay@email.com', service_type: 'drain_cleaning', lead_source: 'instagram',        status: 'completed', estimate_amount: 275,   final_revenue: 275,   address: '89 Ash Ct',            city: 'Downtown',   notes: 'Shower drain + bath',                         days_ago: 32 },
  { name: 'Chris Patel',     phone: '(555) 232-1134', email: 'cpatel@email.com',service_type: 'leak_repair',    lead_source: 'repeat_customer',  status: 'completed', estimate_amount: 195,   final_revenue: 195,   address: '502 Willow Way',       city: 'Downtown',   notes: 'Small supply line replacement under kitchen', days_ago: 34 },
  { name: 'Olivia Tran',     phone: '(555) 233-6678', email: 'otran@email.com', service_type: 'gas_line',       lead_source: 'referral_realtor', status: 'completed', estimate_amount: 820,   final_revenue: 820,   address: '27 Sycamore Ln',       city: 'Eastside',   notes: 'Gas line to new patio grill',                 days_ago: 36 },
  { name: 'Frank Delaney',   phone: '(555) 234-2244', email: 'fdel@email.com',  service_type: 'toilet_repair',  lead_source: 'google_search',    status: 'lost',      estimate_amount: 450,   address: '315 Beechwood',        city: 'Northwood',  notes: 'Went with cheaper handyman',                  days_ago: 40 },
  { name: 'Alex Johansson',  phone: '(555) 235-5577', email: 'ajohan@email.com',service_type: 'repipe',         lead_source: 'homeadvisor',      status: 'lost',      estimate_amount: 4200,  address: '110 Magnolia',         city: 'Westfield',  notes: 'Budget too tight this quarter — revisit in 6 mo', days_ago: 42 },
  { name: 'Wendy Harper',    phone: '(555) 236-8800', email: 'wharper@email.com',service_type: 'fixture_install',lead_source: 'facebook',         status: 'completed', estimate_amount: 380,   final_revenue: 380,   address: '628 Alder Rd',         city: 'Eastside',   notes: 'Dual-handle lav faucet + supply lines',       days_ago: 45 },
  { name: 'Benjamin Ortega', phone: '(555) 237-1122', email: 'bortega@email.com',service_type: 'drain_cleaning',lead_source: 'word_of_mouth',    status: 'completed', estimate_amount: 310,   final_revenue: 310,   address: '455 Spruce',           city: 'Downtown',   notes: 'Slow bathroom sink',                          days_ago: 48 },

  // ─── Month -2 (60–90 days ago) — 10 leads, mostly completed ───
  { name: 'Julia Ramsey',    phone: '(555) 238-4455', email: 'jramsey@email.com',service_type: 'water_heater',   lead_source: 'google_ads',       status: 'completed', estimate_amount: 1920,  final_revenue: 1920,  address: '89 Ivy St',            city: 'Downtown',   notes: 'Tankless conversion',                         days_ago: 62 },
  { name: 'Nolan Matthews',  phone: '(555) 239-7788', email: 'nmatt@email.com', service_type: 'leak_repair',    lead_source: 'repeat_customer',  status: 'completed', estimate_amount: 340,   final_revenue: 340,   address: '17 Rowan Ct',          city: 'Westfield',  notes: 'Angle stop replacement',                      days_ago: 64 },
  { name: 'Priya Kapoor',    phone: '(555) 240-1199', email: 'pkapoor@email.com',service_type: 'drain_cleaning',lead_source: 'google_search',    status: 'completed', estimate_amount: 265,   final_revenue: 265,   address: '703 Olive Ln',         city: 'Northwood',  notes: 'Kitchen + laundry drain',                     days_ago: 67 },
  { name: 'Diego Herrera',   phone: '(555) 241-3322', email: 'dherrera@email.com',service_type: 'gas_line',     lead_source: 'referral_realtor', status: 'completed', estimate_amount: 1150,  final_revenue: 1150,  address: '221 Fir Way',          city: 'Eastside',   notes: 'Range gas line conversion for new stove',     days_ago: 70 },
  { name: 'Beth Callahan',   phone: '(555) 242-5544', email: 'bcall@email.com', service_type: 'fixture_install',lead_source: 'google_search',    status: 'completed', estimate_amount: 610,   final_revenue: 610,   address: '48 Hazel',             city: 'Westfield',  notes: 'Dual-shower head + valve rebuild',            days_ago: 73 },
  { name: 'Vincent Park',    phone: '(555) 243-9900', email: 'vpark@email.com', service_type: 'toilet_repair',  lead_source: 'facebook',         status: 'completed', estimate_amount: 320,   final_revenue: 320,   address: '912 Dogwood',          city: 'Downtown',   notes: 'Flange + fill valve',                         days_ago: 76 },
  { name: 'Tara Mbeki',      phone: '(555) 244-1122', email: 'tmbeki@email.com',service_type: 'drain_cleaning', lead_source: 'yard_sign',        status: 'completed', estimate_amount: 290,   final_revenue: 290,   address: '307 Chestnut',         city: 'Eastside',   notes: 'Main sewer line hydro-jet',                   days_ago: 80 },
  { name: 'Evan Stokes',     phone: '(555) 245-4455', email: 'estokes@email.com',service_type: 'water_heater',  lead_source: 'google_ads',       status: 'completed', estimate_amount: 1680,  final_revenue: 1680,  address: '611 Larch Pl',         city: 'Downtown',   notes: '50-gal electric replacement',                 days_ago: 84 },
  { name: 'Sophia Delacroix',phone: '(555) 246-7788', email: 'sdela@email.com', service_type: 'leak_repair',    lead_source: 'referral_customer',status: 'completed', estimate_amount: 445,   final_revenue: 445,   address: '82 Linden',            city: 'Westfield',  notes: 'Pinhole copper repair in wall',               days_ago: 87 },
  { name: 'Jordan Blake',    phone: '(555) 247-1000', email: 'jblake@email.com',service_type: 'fixture_install',lead_source: 'google_search',    status: 'lost',      estimate_amount: 890,   address: '156 Poplar Rd',        city: 'Northwood',  notes: 'DIYing it themselves',                        days_ago: 90 },

  // ─── Months -3 through -6 (aggregate activity) — 10 leads spread over 120 days ───
  { name: 'Keisha Floyd',    phone: '(555) 248-2233', email: 'kfloyd@email.com', service_type: 'water_heater',  lead_source: 'google_search',    status: 'completed', estimate_amount: 1820,  final_revenue: 1820,  address: '19 Cypress',           city: 'Downtown',   notes: 'Tank replacement',                            days_ago: 105 },
  { name: 'Ian Calloway',    phone: '(555) 249-4455', email: 'ical@email.com',   service_type: 'drain_cleaning',lead_source: 'facebook',         status: 'completed', estimate_amount: 250,   final_revenue: 250,   address: '340 Persimmon',        city: 'Eastside',   notes: 'Laundry drain',                               days_ago: 115 },
  { name: 'Monica Vega',     phone: '(555) 250-6677', email: 'mvega@email.com',  service_type: 'leak_repair',   lead_source: 'homeadvisor',      status: 'completed', estimate_amount: 380,   final_revenue: 380,   address: '627 Mulberry',         city: 'Westfield',  notes: 'Outdoor hose bib repair',                     days_ago: 125 },
  { name: 'Ashton Reilly',   phone: '(555) 251-8899', email: 'arelly@email.com', service_type: 'fixture_install',lead_source: 'referral_realtor',status: 'completed', estimate_amount: 720,   final_revenue: 720,   address: '55 Basswood',          city: 'Downtown',   notes: 'Pre-sale fixture refresh',                    days_ago: 135 },
  { name: 'Lila Brooks',     phone: '(555) 252-1111', email: 'lbrooks@email.com',service_type: 'gas_line',      lead_source: 'google_ads',       status: 'completed', estimate_amount: 980,   final_revenue: 980,   address: '18 Redwood Ct',        city: 'Eastside',   notes: 'Gas log install + line',                      days_ago: 145 },
  { name: 'Saul Briggs',     phone: '(555) 253-3333', email: 'sbriggs@email.com',service_type: 'drain_cleaning',lead_source: 'repeat_customer',  status: 'completed', estimate_amount: 310,   final_revenue: 310,   address: '402 Willow Creek',     city: 'Northwood',  notes: 'Main line + camera inspection',               days_ago: 155 },
  { name: 'Nadia Walsh',     phone: '(555) 254-5555', email: 'nwalsh@email.com', service_type: 'toilet_repair', lead_source: 'google_search',    status: 'completed', estimate_amount: 380,   final_revenue: 380,   address: '271 Ironwood',         city: 'Westfield',  notes: 'Two-toilet fill valve + flapper',             days_ago: 165 },
  { name: 'Roman Petrov',    phone: '(555) 255-7777', email: 'rpetrov@email.com',service_type: 'water_heater',  lead_source: 'referral_customer',status: 'completed', estimate_amount: 1620,  final_revenue: 1620,  address: '89 Silverleaf',        city: 'Downtown',   notes: 'Straight swap tank',                          days_ago: 170 },
  { name: 'Harper Quinn',    phone: '(555) 256-9999', email: 'hquinn@email.com', service_type: 'fixture_install',lead_source: 'facebook',        status: 'completed', estimate_amount: 460,   final_revenue: 460,   address: '512 Saplings Ln',      city: 'Eastside',   notes: 'Bath vanity + faucet',                        days_ago: 180 },
  { name: 'Owen Abernathy',  phone: '(555) 257-1313', email: 'oabern@email.com', service_type: 'leak_repair',   lead_source: 'google_search',    status: 'completed', estimate_amount: 290,   final_revenue: 290,   address: '38 Hollyberry',        city: 'Downtown',   notes: 'Kitchen supply line',                         days_ago: 185 },
];

const REFERRAL_CONTACTS = [
  { name: 'Linda Chen',    email: 'linda@chenhomes.com',   phone: '(555) 111-2233', title: 'Realtor',         company: 'Chen Homes Realty',       contact_type: 'referral_partner', outreach_status: 'engaged', drip_stage: 3 },
  { name: 'Mike Rawlings', email: 'mike@rawlinginsurance.com',phone:'(555) 222-3344',title:'Insurance Agent', company: 'Rawlings Insurance',      contact_type: 'referral_partner', outreach_status: 'engaged', drip_stage: 2 },
  { name: 'Kara Bellamy',  email: 'kara@homepromanager.com',phone: '(555) 333-4455', title: 'Property Manager',company: 'HomePro Management',     contact_type: 'referral_partner', outreach_status: 'new',      drip_stage: 1 },
];

const CONTENT_DRAFTS = [
  // Recently posted
  { platform: 'facebook',  status: 'posted',   body: 'Fixed a slab leak in a Westfield laundry room today. Found it on the first pass — no guesswork, no unnecessary demo. Clean fix, dry floors, customer back to laundry. That\'s how we do it. 🔧 #Plumbing #Westfield #SummitPlumbing',                                                                       days_ago: 23 },
  { platform: 'instagram', status: 'posted',   body: 'Before/After: Old galvanized shutoffs → new quarter-turn valves. Your angle stops should not be an adventure. If yours look like the before photo, it\'s time. 📸                                                    \n\n#Plumbing #WaterHeater #BeforeAfter',                                           days_ago: 30 },
  { platform: 'facebook',  status: 'posted',   body: '⭐⭐⭐⭐⭐ "Summit was fast, clean, and fair on price. Will call them for everything going forward." — Megan L., Eastside\n\nThanks Megan! That\'s the kind of review that keeps us going.',                                                                                                                days_ago: 34 },
  // Approved & scheduled
  { platform: 'instagram', status: 'approved', body: 'Tankless water heaters: worth it? Three questions to ask yourself before you commit. (1) How often are you running out of hot water? (2) How\'s your gas supply? (3) What\'s your 10-year plan? DM us for a straight answer.',                                                                           scheduled_days_ahead: 2 },
  { platform: 'facebook',  status: 'approved', body: 'Summer leak season is real. Sprinkler lines, hose bibs, and outdoor spigots all come out of a long winter looking a little rough. If yours is dripping, leaking, or just doesn\'t turn off all the way — we fix those same day.',                                                                      scheduled_days_ahead: 5 },
  // Pending approval (these are what a prospect logging in sees in the approval queue)
  { platform: 'instagram', status: 'draft',    body: 'Main line backed up at 10pm on a Wednesday? We answer 24/7. Last week\'s emergency call: sewer backup at a duplex, cleared in 90 minutes. Nobody wants that problem — but when you have it, you want the right crew.',                                                                                  },
  { platform: 'facebook',  status: 'draft',    body: 'Whole-house repipe on Oak Park this week. Old galvanized → new PEX. Higher pressure, cleaner water, one less thing to worry about for the next 40 years.',                                                                                                                                              },
];

const FINANCE_EXPENSES = [
  // Recurring monthly overhead (last 6 months)
  { category: 'Insurance',       amount: 485, description: 'General liability premium',                                             days_ago: 2,   recurring: true },
  { category: 'Fuel',            amount: 287, description: 'Diesel + van fuel — week of ' + dateDaysAgo(0),                          days_ago: 3  },
  { category: 'Software & SaaS', amount: 89,  description: 'ServiceTitan / scheduling app',                                         days_ago: 5,   recurring: true },
  { category: 'Supplies & Materials', amount: 420, description: 'Home Depot — fittings, solder, flux',                              days_ago: 6  },
  { category: 'Vehicle & Fuel',  amount: 165, description: 'Van oil change + tire rotation',                                        days_ago: 14 },
  { category: 'Supplies & Materials', amount: 680, description: 'Ferguson — water heater + install kit',                            days_ago: 18 },
  { category: 'Insurance',       amount: 485, description: 'General liability premium',                                             days_ago: 32,  recurring: true },
  { category: 'Fuel',            amount: 310, description: 'Diesel + van fuel',                                                     days_ago: 34 },
  { category: 'Supplies & Materials', amount: 510, description: 'Ferguson — repipe materials (PEX, fittings)',                      days_ago: 38 },
  { category: 'Software & SaaS', amount: 89,  description: 'ServiceTitan / scheduling app',                                         days_ago: 40,  recurring: true },
  { category: 'Marketing & Advertising', amount: 220, description: 'Google Ads — plumbing keywords',                                days_ago: 42 },
  { category: 'Insurance',       amount: 485, description: 'General liability premium',                                             days_ago: 62,  recurring: true },
  { category: 'Fuel',            amount: 295, description: 'Diesel + van fuel',                                                     days_ago: 65 },
  { category: 'Supplies & Materials', amount: 380, description: 'Home Depot — fixtures and PVC',                                    days_ago: 68 },
  { category: 'Marketing & Advertising', amount: 220, description: 'Google Ads — plumbing keywords',                                days_ago: 72 },
  { category: 'Software & SaaS', amount: 89,  description: 'ServiceTitan / scheduling app',                                         days_ago: 72,  recurring: true },
  { category: 'Insurance',       amount: 485, description: 'General liability premium',                                             days_ago: 92,  recurring: true },
  { category: 'Fuel',            amount: 305, description: 'Diesel + van fuel',                                                     days_ago: 95 },
  { category: 'Supplies & Materials', amount: 445, description: 'Ferguson — misc fittings and valves',                              days_ago: 98 },
  { category: 'Software & SaaS', amount: 89,  description: 'ServiceTitan / scheduling app',                                         days_ago: 105, recurring: true },
  { category: 'Insurance',       amount: 485, description: 'General liability premium',                                             days_ago: 122, recurring: true },
  { category: 'Fuel',            amount: 280, description: 'Diesel + van fuel',                                                     days_ago: 128 },
  { category: 'Vehicle & Fuel',  amount: 340, description: 'Van brakes + rear pads',                                                days_ago: 140 },
  { category: 'Software & SaaS', amount: 89,  description: 'ServiceTitan / scheduling app',                                         days_ago: 142, recurring: true },
  { category: 'Insurance',       amount: 485, description: 'General liability premium',                                             days_ago: 152, recurring: true },
  { category: 'Fuel',            amount: 290, description: 'Diesel + van fuel',                                                     days_ago: 158 },
  { category: 'Supplies & Materials', amount: 520, description: 'Ferguson — water heater + install kit',                            days_ago: 163 },
  { category: 'Software & SaaS', amount: 89,  description: 'ServiceTitan / scheduling app',                                         days_ago: 172, recurring: true },
];

// Owner + one helper — matches Patrick's target of 1–2 person shops.
const CREW = [
  { name: 'Sam Reilly',  role: 'Owner / Master Plumber',   phone: '(555) 555-0100', daily_rate: 420 },
  { name: 'Jared Nolan', role: 'Apprentice',               phone: '(555) 555-0101', daily_rate: 180 },
];

// ---------------------------------------------------------------------------
// Seed orchestration
// ---------------------------------------------------------------------------

async function deleteDemoTenant() {
  const { data: existing } = await db.from('tenants').select('id').eq('slug', DEMO_SLUG).maybeSingle();
  if (existing) {
    console.log(`  🧹 Deleting existing demo tenant ${existing.id}...`);
    await db.from('tenants').delete().eq('id', existing.id);
    console.log('     ✓ Deleted');
  }
}

async function seed() {
  const reset = process.argv.includes('--reset');
  console.log(`\n🌱 Seeding Demo Tenant: ${BUSINESS_NAME}\n`);

  if (reset) await deleteDemoTenant();

  // 1. Tenant
  const { data: tenant, error: tenantErr } = await db
    .from('tenants')
    .upsert(DEMO_TENANT, { onConflict: 'slug' })
    .select()
    .single();

  if (tenantErr) { console.error('Tenant create failed:', tenantErr); process.exit(1); }
  const tid = tenant.id;
  console.log(`  ✓ Tenant ${tid}`);

  // 2. Modules — enable the home-services set
  const MODULES = {
    lead_capture: true, speed_to_lead: true, missed_call: true,
    follow_up: true, review_request: true, referral_engine: true,
    referral_outreach: true, content_engine: true, publishing: true,
    prospecting: true, lead_scoring: true, branded_app: true,
    finance: true, digest: true,
  };
  const moduleRows = Object.entries(MODULES).map(([module, enabled]) => ({
    tenant_id: tid, module, enabled, config: {},
  }));
  await db.from('tenant_modules').upsert(moduleRows, { onConflict: 'tenant_id,module' });
  console.log(`  ✓ ${moduleRows.length} modules`);

  // 3. Tenant config (business info used by agents + UI)
  const config = {
    business_name: BUSINESS_NAME,
    phone: '(555) 555-PIPE',
    email: 'info@summitplumbing.co',
    service_area: 'Downtown, Eastside, Westfield, Northwood',
    review_url: 'https://g.page/summitplumbing/review',
    target_industries: ['Plumbing'],
    target_states: ['GA'],
  };
  const configRows = Object.entries(config).map(([key, value]) => ({
    tenant_id: tid, key, value: typeof value === 'string' ? JSON.stringify(value) : value,
  }));
  await db.from('tenant_config').upsert(configRows, { onConflict: 'tenant_id,key' });
  console.log(`  ✓ ${configRows.length} config keys`);

  // 4. Leads
  const leadRows = LEADS.map((l) => ({
    tenant_id: tid,
    name: l.name, phone: l.phone, email: l.email,
    service_type: l.service_type, lead_source: l.lead_source,
    status: l.status,
    estimate_amount: l.estimate_amount || null,
    final_revenue: l.final_revenue || null,
    address: l.address, city: l.city, notes: l.notes,
    date_of_inquiry: isoDaysAgo(l.days_ago),
    created_at: isoDaysAgo(l.days_ago),
    updated_at: isoDaysAgo(Math.max(0, l.days_ago - 1)),
  }));
  const { data: leads, error: leadErr } = await db.from('leads').upsert(leadRows).select('id, name, status');
  if (leadErr) { console.error('Lead seed error:', leadErr); }
  console.log(`  ✓ ${leads?.length || 0} leads`);

  const leadByName = {};
  (leads || []).forEach((l) => { leadByName[l.name] = l.id; });

  // 5. Contacts: customer per completed/won lead + referral partners
  const customerContacts = LEADS
    .filter((l) => ['completed', 'won'].includes(l.status))
    .map((l) => ({
      tenant_id: tid, lead_id: leadByName[l.name] || null,
      name: l.name, phone: l.phone, email: l.email,
      contact_type: 'customer',
      outreach_status: l.status === 'completed' ? 'completed' : 'active',
      is_primary_contact: true,
    }));
  const partnerContacts = REFERRAL_CONTACTS.map((c) => ({
    tenant_id: tid,
    name: c.name, email: c.email, phone: c.phone,
    title: c.title, company: c.company,
    contact_type: c.contact_type, outreach_status: c.outreach_status,
    drip_stage: c.drip_stage,
  }));
  const { data: contacts, error: contactErr } = await db
    .from('contacts').upsert([...customerContacts, ...partnerContacts]).select('id, name');
  if (contactErr) console.error('Contact seed error:', contactErr);
  console.log(`  ✓ ${contacts?.length || 0} contacts`);

  // 6. Jobs — one per completed lead, plus the upcoming won job
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
      scheduled_date: dateDaysAgo(-3), // 3 days from now
      description: `${wonLead.service_type.replace(/_/g, ' ')} — ${wonLead.address}, ${wonLead.city}`,
    });
  }
  const { data: jobs, error: jobErr } = await db.from('jobs').upsert(jobRows).select('id');
  if (jobErr) console.error('Job seed error:', jobErr);
  console.log(`  ✓ ${jobs?.length || 0} jobs`);

  // 7. Content drafts
  const contentRows = CONTENT_DRAFTS.map((c) => ({
    tenant_id: tid,
    platform: c.platform,
    status: c.status,
    body: c.body,
    posted_at: c.status === 'posted' && c.days_ago != null ? isoDaysAgo(c.days_ago) : null,
    scheduled_for: c.scheduled_days_ahead ? isoDaysAgo(-c.scheduled_days_ahead) : null,
    created_at: isoDaysAgo(c.days_ago != null ? c.days_ago : 1),
  }));
  const { data: content, error: contentErr } = await db.from('content_drafts').upsert(contentRows).select('id');
  if (contentErr) console.error('Content seed error:', contentErr);
  console.log(`  ✓ ${content?.length || 0} content drafts`);

  // 8. Crew (2 people — owner + helper)
  const crewRows = CREW.map((c) => ({ tenant_id: tid, ...c, is_active: true }));
  const { data: crew, error: crewErr } = await db.from('crew_members').upsert(crewRows).select('id');
  if (crewErr) console.error('Crew seed error:', crewErr);
  console.log(`  ✓ ${crew?.length || 0} crew members`);

  // 9. Finance — income entries from completed leads + expense log
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
  const { data: finance, error: finErr } = await db
    .from('finance_entries').upsert([...incomeRows, ...expenseRows]).select('id');
  if (finErr) console.error('Finance seed error:', finErr);
  console.log(`  ✓ ${finance?.length || 0} finance entries (${incomeRows.length} income + ${expenseRows.length} expenses)`);

  // Summary
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
  console.log(`  Leads:          ${leads?.length || 0}   (6-month rolling window)`);
  console.log(`  Contacts:       ${contacts?.length || 0}`);
  console.log(`  Jobs:           ${jobs?.length || 0}`);
  console.log(`  Content drafts: ${content?.length || 0}`);
  console.log(`  Crew:           ${crew?.length || 0}`);
  console.log(`  Finance:        ${finance?.length || 0}  (Revenue $${revenue.toLocaleString()} / Expenses $${expenses.toLocaleString()})`);
  console.log('─────────────────────────────────────────');
  console.log('\n✅ Ready. Next step: create Supabase user via scripts/create-demo-user.js\n');
}

seed().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
