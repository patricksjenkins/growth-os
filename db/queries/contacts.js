/**
 * Contact Queries
 */

const { db } = require('../client');

/**
 * Get contacts with optional filters
 */
async function getContacts(tenantId, filters = {}) {
  let query = db
    .from('contacts')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (filters.contact_type) query = query.eq('contact_type', filters.contact_type);
  if (filters.outreach_status) query = query.eq('outreach_status', filters.outreach_status);
  if (filters.lead_id) query = query.eq('lead_id', filters.lead_id);
  if (filters.limit) query = query.limit(filters.limit);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Get single contact
 */
async function getContact(tenantId, contactId) {
  const { data, error } = await db
    .from('contacts')
    .select('*, lead:leads(*), campaigns:outreach_campaigns(*), messages(*)')
    .eq('tenant_id', tenantId)
    .eq('id', contactId)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Create a contact
 */
async function createContact(tenantId, data) {
  const { data: contact, error } = await db
    .from('contacts')
    .insert({
      tenant_id: tenantId,
      lead_id: data.lead_id || null,
      name: data.name,
      email: data.email,
      phone: data.phone,
      title: data.title,
      company: data.company,
      contact_type: data.contact_type || 'customer',
      notes: data.notes,
      metadata: data.metadata || {}
    })
    .select()
    .single();
  if (error) throw error;
  return contact;
}

// V1 hardening (2026-05-24): explicit column allowlist defense at the DB
// query layer. Belt-and-suspenders pattern with the route-layer pickUpdatable
// (e.g. crew.js/finance.js) — even if a future route handler forgets to
// filter, this layer drops disallowed keys before the UPDATE SET clause.
// Protects against tenant_id swap, id rebinding, created_at backdating.
const CONTACT_UPDATABLE = [
  'name', 'email', 'phone', 'company_name', 'role', 'contact_type',
  'outreach_status', 'lead_id', 'notes', 'metadata', 'is_primary_contact',
  'drip_stage', 'last_contacted_at', 'contact_status',
];

function pickContactUpdates(updates) {
  if (!updates || typeof updates !== 'object') return {};
  const out = {};
  for (const key of CONTACT_UPDATABLE) {
    if (updates[key] !== undefined) out[key] = updates[key];
  }
  return out;
}

/**
 * Update a contact
 */
async function updateContact(tenantId, contactId, updates) {
  const safe = pickContactUpdates(updates);
  const { data, error } = await db
    .from('contacts')
    .update({ ...safe, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', contactId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Find contact by email (for webhook matching)
 */
async function findContactByEmail(tenantId, email) {
  const { data, error } = await db
    .from('contacts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('email', email)
    .single();
  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
  return data;
}

/**
 * Find contact by phone (for SMS matching)
 */
async function findContactByPhone(tenantId, phone) {
  const { data, error } = await db
    .from('contacts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('phone', phone)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/**
 * Get contacts ready for outreach (for drip agent)
 */
async function getActiveOutreachContacts(tenantId) {
  const { data, error } = await db
    .from('contacts')
    .select('*, campaigns:outreach_campaigns(*)')
    .eq('tenant_id', tenantId)
    .eq('outreach_status', 'active')
    .order('last_contacted_at', { ascending: true, nullsFirst: true });
  if (error) throw error;
  return data || [];
}

module.exports = {
  getContacts,
  getContact,
  createContact,
  updateContact,
  findContactByEmail,
  findContactByPhone,
  getActiveOutreachContacts
};
