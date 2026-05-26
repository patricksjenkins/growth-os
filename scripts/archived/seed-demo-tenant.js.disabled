/**
 * Growth OS — Seed Demo Tenant with Realistic Mock Data
 *
 * Creates a fictional tree service company ("Oakline Tree Co") as a demo tenant
 * with realistic leads, jobs, content, messages, and finance data.
 *
 * Usage:
 *   node scripts/seed-demo-tenant.js          # Create fresh demo tenant
 *   node scripts/seed-demo-tenant.js --reset   # Delete and recreate demo tenant
 */

require('dotenv').config();
const { db } = require('../db/client');

const DEMO_SLUG = 'demo-oakline';
const DEMO_TENANT = {
  name: 'Oakline Tree Co',
  slug: DEMO_SLUG,
  vertical: 'tree_service',
  status: 'active',
  owner_email: 'demo@firstgenautomate.com',
};

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const LEADS = [
  { name: 'Sarah Mitchell', phone: '(555) 234-8901', email: 'sarah.m@email.com', service_type: 'tree_removal', lead_source: 'google_search', status: 'completed', estimate_amount: 2800, final_revenue: 2800, address: '142 Magnolia Dr', city: 'Midtown', notes: 'Large oak in backyard, near fence line', days_ago: 21 },
  { name: 'James Cooper', phone: '(555) 345-2190', email: 'jcooper@email.com', service_type: 'tree_trimming', lead_source: 'referral_customer', status: 'completed', estimate_amount: 950, final_revenue: 950, address: '88 Elm Street', city: 'Westside', notes: 'Annual trim — 3 oaks in front yard', days_ago: 18 },
  { name: 'Maria Gonzalez', phone: '(555) 456-7832', email: 'maria.g@email.com', service_type: 'stump_grinding', lead_source: 'facebook', status: 'completed', estimate_amount: 450, final_revenue: 450, address: '2201 Cedar Ln', city: 'Northpark', notes: '2 stumps from previous removal', days_ago: 14 },
  { name: 'David Park', phone: '(555) 567-1234', email: 'dpark@email.com', service_type: 'storm_cleanup', lead_source: 'missed_call', status: 'completed', estimate_amount: 1600, final_revenue: 1800, address: '55 Willow Ct', city: 'Eastdale', notes: 'Storm damage — downed limbs on driveway and roof', days_ago: 10 },
  { name: 'Rachel Kim', phone: '(555) 678-9012', email: 'rkim@email.com', service_type: 'tree_removal', lead_source: 'google_ads', status: 'won', estimate_amount: 3200, address: '310 Birch Ave', city: 'Midtown', notes: 'Dead pine leaning toward house — urgent', days_ago: 7 },
  { name: 'Tom Bradley', phone: '(555) 789-3456', email: 'tbradley@email.com', service_type: 'tree_trimming', lead_source: 'referral_realtor', status: 'estimate_given', estimate_amount: 1100, address: '72 Oakwood Blvd', city: 'Lakeside', notes: 'Pre-sale cleanup, realtor referral from Linda Chen', days_ago: 5 },
  { name: 'Nicole Adams', phone: '(555) 890-4567', email: 'nadams@email.com', service_type: 'lot_clearing', lead_source: 'homeadvisor', status: 'estimate_scheduled', address: '1400 Pine Ridge Rd', city: 'Westside', notes: 'New construction lot, about 0.5 acres', days_ago: 3 },
  { name: 'Kevin Torres', phone: '(555) 901-5678', email: 'ktorres@email.com', service_type: 'emergency_removal', lead_source: 'google_search', status: 'contacted', address: '99 Sycamore St', city: 'Eastdale', notes: 'Tree fell on fence during last night\'s storm', days_ago: 2 },
  { name: 'Lisa Chen', phone: '(555) 012-6789', email: 'lchen@email.com', service_type: 'pruning', lead_source: 'instagram', status: 'new_lead', address: '425 Maple Way', city: 'Northpark', notes: 'Fruit trees need seasonal pruning', days_ago: 1 },
  { name: 'Robert Wilson', phone: '(555) 123-7890', email: 'rwilson@email.com', service_type: 'tree_removal', lead_source: 'word_of_mouth', status: 'new_lead', address: '18 Cherry Hill Dr', city: 'Lakeside', notes: '', days_ago: 0 },
  { name: 'Amanda Price', phone: '(555) 234-5678', email: 'aprice@email.com', service_type: 'tree_trimming', lead_source: 'yard_sign', status: 'new_lead', address: '600 Aspen Ct', city: 'Midtown', notes: 'Saw our yard sign at the Mitchell job', days_ago: 0 },
  { name: 'Greg Hoffman', phone: '(555) 345-6789', email: 'ghoffman@email.com', service_type: 'stump_grinding', lead_source: 'repeat_customer', status: 'contacted', estimate_amount: 300, address: '77 Spruce Ln', city: 'Westside', notes: 'Previous customer — 1 stump in backyard', days_ago: 1 },
];

const REFERRAL_CONTACTS = [
  { name: 'Linda Chen', email: 'linda@chenhomes.com', phone: '(555) 111-2233', title: 'Realtor', company: 'Chen Homes Realty', contact_type: 'referral_partner', outreach_status: 'engaged', drip_stage: 3 },
  { name: 'Mike Rawlings', email: 'mike@statefarmagent.com', phone: '(555) 222-3344', title: 'Insurance Agent', company: 'State Farm — Rawlings Agency', contact_type: 'referral_partner', outreach_status: 'engaged', drip_stage: 2 },
  { name: 'Carlos Vega', email: 'carlos@vegascape.com', phone: '(555) 333-4455', title: 'Owner', company: 'Vega Landscaping', contact_type: 'referral_partner', outreach_status: 'new', drip_stage: 1 },
];

const CONTENT_DRAFTS = [
  { content_type: 'post', platform: 'facebook', status: 'published', headline: 'Before & After: Magnolia Drive', body: 'Just wrapped up a full oak removal on Magnolia Dr. The homeowner couldn\'t believe the difference — their backyard went from dark and overgrown to wide open. Clean cuts, clean yard. That\'s the Oakline way. 🌳\n\n#TreeRemoval #Midtown #OaklineTreeCo #BeforeAndAfter', hashtags: ['TreeRemoval', 'Midtown', 'OaklineTreeCo'], days_ago: 20 },
  { content_type: 'post', platform: 'instagram', status: 'published', headline: 'Storm Season Ready', body: 'When the storm hits, we\'re the first call. Last week\'s cleanup on Willow Ct — downed limbs off the driveway and roof in under 4 hours. No waiting, no wondering. Just results. 💪\n\n#StormCleanup #EmergencyTreeService #OaklineTreeCo', hashtags: ['StormCleanup', 'EmergencyTreeService', 'OaklineTreeCo'], days_ago: 9 },
  { content_type: 'post', platform: 'facebook', status: 'published', headline: '5-Star Review from James C.', body: '"Oakline trimmed three oaks in my front yard. Professional, fast, and they cleaned up everything. My yard looks amazing." — James C., Westside\n\nThank you, James! Reviews like this keep us going. ⭐⭐⭐⭐⭐', hashtags: ['CustomerReview', '5Stars', 'OaklineTreeCo'], days_ago: 15 },
  { content_type: 'post', platform: 'instagram', status: 'approved', headline: 'Spring Pruning Season', body: 'Spring is here and your fruit trees are waking up. Now\'s the time to prune — healthy cuts mean a better harvest and a stronger tree. Call us before the growth gets ahead of you. 🌸\n\n#TreePruning #SpringMaintenance #OaklineTreeCo', hashtags: ['TreePruning', 'SpringMaintenance'], scheduled_for_days: 2 },
  { content_type: 'post', platform: 'facebook', status: 'approved', headline: 'Lot Clearing Done Right', body: 'New build on Pine Ridge? We clear the lot so your contractor can break ground. Half-acre lots, dense brush, standing timber — we handle it all. One call, one crew, done. 🏗️\n\n#LotClearing #NewConstruction #OaklineTreeCo', hashtags: ['LotClearing', 'NewConstruction'], scheduled_for_days: 5 },
  { content_type: 'post', platform: 'instagram', status: 'pending', headline: 'Emergency After Hours', body: 'Tree on your fence? Limb on your car? We answer emergency calls 24/7. Last night\'s storm kept us busy — but every customer got same-day service. That\'s the commitment. ⚡\n\n#EmergencyTreeService #247 #OaklineTreeCo', hashtags: ['EmergencyTreeService', '247'], scheduled_for_days: null },
  { content_type: 'post', platform: 'facebook', status: 'pending', headline: 'Stump Grinding: Before & After', body: 'Two stumps gone on Cedar Lane. Maria went from tripping hazards to a clean, flat yard in under an hour. Stump grinding starts at $200. No stump too big, no yard too small.\n\n#StumpGrinding #Northpark #OaklineTreeCo', hashtags: ['StumpGrinding', 'Northpark'], scheduled_for_days: null },
];

const CREW = [
  { name: 'Derek Oakley', role: 'Crew Lead', daily_rate: 250, phone: '(555) 600-1001', status: 'active' },
  { name: 'Marcus Webb', role: 'Climber', daily_rate: 200, phone: '(555) 600-1002', status: 'active' },
  { name: 'Tyler Grant', role: 'Ground Crew', daily_rate: 160, phone: '(555) 600-1003', status: 'active' },
  { name: 'Javier Reyes', role: 'Ground Crew', daily_rate: 160, phone: '(555) 600-1004', status: 'active' },
];

const FINANCE_ENTRIES = [
  // Income from completed jobs
  { entry_type: 'income', category: 'Tree Removal', amount: 2800, description: 'Sarah Mitchell — Oak removal, Magnolia Dr', days_ago: 20 },
  { entry_type: 'income', category: 'Tree Trimming', amount: 950, description: 'James Cooper — 3 oak trim, Elm Street', days_ago: 17 },
  { entry_type: 'income', category: 'Stump Grinding', amount: 450, description: 'Maria Gonzalez — 2 stump grind, Cedar Ln', days_ago: 13 },
  { entry_type: 'income', category: 'Storm Cleanup', amount: 1800, description: 'David Park — Storm damage, Willow Ct', days_ago: 9 },
  // Expenses
  { entry_type: 'expense', category: 'Fuel', amount: 340, description: 'Diesel — truck and chipper', days_ago: 7 },
  { entry_type: 'expense', category: 'Equipment', amount: 189, description: 'Chain replacement + bar oil', days_ago: 12 },
  { entry_type: 'expense', category: 'Insurance', amount: 875, description: 'Monthly liability premium', days_ago: 1 },
  { entry_type: 'expense', category: 'Labor', amount: 3080, description: 'Weekly crew payroll', days_ago: 7 },
  { entry_type: 'expense', category: 'Advertising', amount: 250, description: 'Google Ads — tree service keywords', days_ago: 14 },
  { entry_type: 'expense', category: 'Vehicle_Maintenance', amount: 420, description: 'Chipper blade sharpening + oil change', days_ago: 18 },
];

// ---------------------------------------------------------------------------
// Seeding Logic
// ---------------------------------------------------------------------------

async function deleteDemoTenant() {
  const { data: existing } = await db
    .from('tenants')
    .select('id')
    .eq('slug', DEMO_SLUG)
    .single();

  if (existing) {
    console.log(`  Deleting existing demo tenant (${existing.id})...`);
    await db.from('tenants').delete().eq('id', existing.id);
    console.log('  ✓ Deleted');
  }
}

async function seedDemo() {
  const reset = process.argv.includes('--reset');
  console.log('\n🌱 Seeding Demo Tenant: Oakline Tree Co\n');

  if (reset) await deleteDemoTenant();

  // 1. Create tenant via seed-tenant logic
  const preset = require('../config/presets/tree-service');

  const { data: tenant, error: tenantErr } = await db
    .from('tenants')
    .upsert(DEMO_TENANT, { onConflict: 'slug' })
    .select()
    .single();

  if (tenantErr) { console.error('Failed to create tenant:', tenantErr); process.exit(1); }
  const tid = tenant.id;
  console.log(`  ✓ Tenant created: ${tid}`);

  // 2. Seed modules from preset
  const moduleRows = Object.entries(preset.modules).map(([module, enabled]) => ({
    tenant_id: tid, module, enabled, config: {}
  }));
  await db.from('tenant_modules').upsert(moduleRows, { onConflict: 'tenant_id,module' });
  console.log(`  ✓ ${moduleRows.length} modules seeded`);

  // 3. Seed config from preset + demo overrides
  const demoConfig = {
    ...preset.config,
    business_name: 'Oakline Tree Co',
    phone: '(555) 555-TREE',
    email: 'info@oaklinetree.com',
    service_area: 'Midtown, Westside, Northpark, Eastdale, Lakeside',
    review_url: 'https://g.page/oaklinetree/review',
    brand_colors: { primary: '#2E7D32', secondary: '#FFA726' },
  };

  const configRows = Object.entries(demoConfig).map(([key, value]) => ({
    tenant_id: tid, key, value: typeof value === 'string' ? JSON.stringify(value) : value
  }));
  await db.from('tenant_config').upsert(configRows, { onConflict: 'tenant_id,key' });
  console.log(`  ✓ ${configRows.length} config keys seeded`);

  // 4. Seed leads
  const now = new Date();
  const leadInserts = LEADS.map(l => ({
    tenant_id: tid,
    name: l.name, phone: l.phone, email: l.email,
    service_type: l.service_type, lead_source: l.lead_source,
    status: l.status, estimate_amount: l.estimate_amount || null,
    final_revenue: l.final_revenue || null,
    address: l.address, city: l.city, notes: l.notes,
    date_of_inquiry: new Date(now - l.days_ago * 86400000).toISOString(),
    created_at: new Date(now - l.days_ago * 86400000).toISOString(),
  }));

  const { data: leads, error: leadErr } = await db
    .from('leads')
    .upsert(leadInserts)
    .select('id, name, status');
  if (leadErr) { console.error('Lead seed error:', leadErr); }
  else console.log(`  ✓ ${leads.length} leads seeded`);

  // Build lead ID lookup
  const leadMap = {};
  if (leads) leads.forEach(l => { leadMap[l.name] = l.id; });

  // 5. Seed contacts (customers from completed leads + referral partners)
  const customerContacts = LEADS
    .filter(l => ['completed', 'won'].includes(l.status))
    .map(l => ({
      tenant_id: tid, lead_id: leadMap[l.name] || null,
      name: l.name, email: l.email, phone: l.phone,
      contact_type: 'customer', outreach_status: 'completed',
    }));

  const referralContacts = REFERRAL_CONTACTS.map(c => ({
    tenant_id: tid, name: c.name, email: c.email, phone: c.phone,
    title: c.title, company: c.company,
    contact_type: c.contact_type, outreach_status: c.outreach_status,
    drip_stage: c.drip_stage,
  }));

  const { data: contacts, error: contactErr } = await db
    .from('contacts')
    .upsert([...customerContacts, ...referralContacts])
    .select('id, name');
  if (contactErr) console.error('Contact seed error:', contactErr);
  else console.log(`  ✓ ${contacts.length} contacts seeded`);

  // 6. Seed jobs (from completed leads)
  const completedLeads = LEADS.filter(l => l.status === 'completed');
  const jobInserts = completedLeads.map(l => ({
    tenant_id: tid,
    lead_id: leadMap[l.name] || null,
    status: 'completed',
    scheduled_date: new Date(now - (l.days_ago + 1) * 86400000).toISOString().split('T')[0],
    completed_date: new Date(now - l.days_ago * 86400000).toISOString().split('T')[0],
    description: `${l.service_type.replace(/_/g, ' ')} — ${l.address}, ${l.city}`,
    revenue: l.final_revenue,
  }));

  // Add a scheduled upcoming job
  jobInserts.push({
    tenant_id: tid,
    lead_id: leadMap['Rachel Kim'] || null,
    status: 'scheduled',
    scheduled_date: new Date(now + 3 * 86400000).toISOString().split('T')[0],
    description: 'tree removal — 310 Birch Ave, Midtown (dead pine, leaning toward house)',
  });

  const { data: jobs, error: jobErr } = await db.from('jobs').upsert(jobInserts).select('id');
  if (jobErr) console.error('Job seed error:', jobErr);
  else console.log(`  ✓ ${jobs.length} jobs seeded`);

  // 7. Seed content drafts
  const contentInserts = CONTENT_DRAFTS.map(c => ({
    tenant_id: tid,
    content_type: c.content_type, platform: c.platform,
    status: c.status, headline: c.headline, body: c.body,
    hashtags: c.hashtags,
    posted_at: c.days_ago ? new Date(now - c.days_ago * 86400000).toISOString() : null,
    scheduled_for: c.scheduled_for_days ? new Date(now + c.scheduled_for_days * 86400000).toISOString() : null,
    created_at: new Date(now - (c.days_ago || 1) * 86400000).toISOString(),
  }));

  const { data: content, error: contentErr } = await db.from('content_drafts').upsert(contentInserts).select('id');
  if (contentErr) console.error('Content seed error:', contentErr);
  else console.log(`  ✓ ${content.length} content drafts seeded`);

  // 8. Seed messages (SMS samples)
  const contactMap = {};
  if (contacts) contacts.forEach(c => { contactMap[c.name] = c.id; });

  const messageInserts = [
    // Speed-to-lead
    { contact_name: 'Lisa Chen', channel: 'sms', direction: 'outbound', body: 'Hey Lisa! This is Jake from Oakline Tree Co. Got your request about pruning. When\'s a good time to come take a look?', status: 'delivered', days_ago: 1 },
    { contact_name: 'Robert Wilson', channel: 'sms', direction: 'outbound', body: 'Hey Robert! This is Jake from Oakline Tree Co. Got your request about tree removal. When\'s a good time to come take a look?', status: 'delivered', days_ago: 0 },
    // Missed call text-back
    { contact_name: 'David Park', channel: 'sms', direction: 'outbound', body: 'Hi, this is Oakline Tree Co. Sorry we missed your call! How can we help? You can text us back here or call again anytime.', status: 'delivered', days_ago: 10 },
    { contact_name: 'David Park', channel: 'sms', direction: 'inbound', body: 'Hi — a tree came down on my driveway during the storm. Can someone come look at it today?', status: 'received', days_ago: 10 },
    // Review request
    { contact_name: 'James Cooper', channel: 'sms', direction: 'outbound', body: 'Hi James! Thanks for choosing Oakline Tree Co! If you were happy with the work, a Google review would mean the world: https://g.page/oaklinetree/review', status: 'delivered', days_ago: 16 },
    { contact_name: 'Sarah Mitchell', channel: 'sms', direction: 'outbound', body: 'Hi Sarah! Thanks for choosing Oakline Tree Co! If you were happy with the work, a Google review would mean the world: https://g.page/oaklinetree/review', status: 'delivered', days_ago: 19 },
    // Follow-up
    { contact_name: 'Tom Bradley', channel: 'sms', direction: 'outbound', body: 'Hi Tom, just following up on the estimate we gave you for tree trimming. Any questions I can answer?', status: 'delivered', days_ago: 3 },
    // Referral
    { contact_name: 'Sarah Mitchell', channel: 'sms', direction: 'outbound', body: 'Hey Sarah! If you know anyone who needs tree work, we offer a $100 referral bonus. Just have them mention your name!', status: 'delivered', days_ago: 18 },
  ];

  const msgRows = messageInserts
    .filter(m => contactMap[m.contact_name])
    .map(m => ({
      tenant_id: tid,
      contact_id: contactMap[m.contact_name],
      channel: m.channel, direction: m.direction,
      body: m.body, status: m.status,
      sent_at: new Date(now - m.days_ago * 86400000).toISOString(),
    }));

  const { data: messages, error: msgErr } = await db.from('messages').upsert(msgRows).select('id');
  if (msgErr) console.error('Message seed error:', msgErr);
  else console.log(`  ✓ ${messages.length} messages seeded`);

  // 9. Seed crew
  const crewInserts = CREW.map(c => ({ tenant_id: tid, ...c }));
  const { data: crew, error: crewErr } = await db.from('crew_members').upsert(crewInserts).select('id');
  if (crewErr) console.error('Crew seed error:', crewErr);
  else console.log(`  ✓ ${crew.length} crew members seeded`);

  // 10. Seed finance entries
  const financeInserts = FINANCE_ENTRIES.map((f, i) => ({
    tenant_id: tid,
    entry_type: f.entry_type, category: f.category,
    amount: f.amount, description: f.description,
    date: new Date(now - f.days_ago * 86400000).toISOString().split('T')[0],
    lead_id: f.entry_type === 'income' ? leads?.[i] ?.id || null : null,
  }));

  const { data: finance, error: finErr } = await db.from('finance_entries').upsert(financeInserts).select('id');
  if (finErr) console.error('Finance seed error:', finErr);
  else console.log(`  ✓ ${finance.length} finance entries seeded`);

  // Summary
  console.log('\n─────────────────────────────────────────');
  console.log('📊 Demo Tenant Summary: Oakline Tree Co');
  console.log('─────────────────────────────────────────');
  console.log(`  Tenant ID:    ${tid}`);
  console.log(`  Slug:         ${DEMO_SLUG}`);
  console.log(`  Vertical:     tree_service`);
  console.log(`  Leads:        ${leads?.length || 0} (3 new, 2 contacted, 1 est scheduled, 1 est given, 1 won, 4 completed)`);
  console.log(`  Contacts:     ${contacts?.length || 0} (${customerContacts.length} customers + ${referralContacts.length} referral partners)`);
  console.log(`  Jobs:         ${jobs?.length || 0} (${completedLeads.length} completed + 1 scheduled)`);
  console.log(`  Content:      ${content?.length || 0} (3 published, 2 approved, 2 pending)`);
  console.log(`  Messages:     ${messages?.length || 0} (SMS: speed-to-lead, follow-up, review, referral)`);
  console.log(`  Crew:         ${crew?.length || 0}`);
  console.log(`  Finance:      ${finance?.length || 0} (${FINANCE_ENTRIES.filter(f => f.entry_type === 'income').length} income + ${FINANCE_ENTRIES.filter(f => f.entry_type === 'expense').length} expenses)`);
  console.log('─────────────────────────────────────────');
  console.log('\n✅ Demo tenant ready for demos!\n');
}

seedDemo()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
