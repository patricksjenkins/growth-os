'use strict';

/**
 * ONE definition of "where does this lead's email live".
 *
 * WHY (Codex 2026-07-26, round 5)
 * The drafter accepted an address stored on either the lead OR one of its
 * contact rows. The send gate validated `lead.email` and nothing else. So a
 * lead whose only address sat on a contact got a Claude-written draft that
 * could never be sent — the draft looked healthy, the gate said `valid_email`
 * failed, and the two stages each reported doing their job correctly.
 *
 * That is the same shape as every other defect in this pipeline: two filters
 * over the same pool that disagree. The fix is not to patch the gate to match
 * the drafter; it is to remove the possibility of them differing, by having a
 * single resolver both sides call.
 *
 * Nothing here relaxes a guardrail: an address must still exist and still be
 * validated by the gate. It only makes "has an address" mean the same thing in
 * both places.
 */

/** Batched: which of these lead ids have at least one contact with an email? */
async function leadIdsWithContactEmail(db, tenantId, leadIds) {
  const found = new Set();
  const ids = (leadIds || []).filter(Boolean);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from('contacts')
      .select('lead_id')
      .eq('tenant_id', tenantId)
      .in('lead_id', ids.slice(i, i + 200))
      .not('email', 'is', null);
    if (error) throw new Error(`contact_email_inventory_failed:${error.message}`);
    for (const row of data || []) found.add(row.lead_id);
  }
  return found;
}

/**
 * Resolve the address a first-touch email to this lead will ACTUALLY go to.
 *
 * Order mirrors the sender (core/outreach-send.js): the sequence's own contact
 * row is authoritative, because that is the record the send reads. Falling back
 * to the lead's address and then to any contact keeps a lead that genuinely has
 * an address from being discarded.
 *
 * THREE definitions existed before this:
 *   drafter — lead.email OR any contact email
 *   gate    — lead.email only
 *   sender  — the sequence's contact email only, no fallback
 * so a lead could pass the gate and fail the send ('no_email'), or fail the
 * gate while being perfectly sendable. All three now call this.
 *
 * @param {object} [sequence] the draft being evaluated/sent, if known
 * @returns {Promise<{email: string|null, source: 'sequence_contact'|'lead'|'contact'|null}>}
 */
async function resolveRecipientEmail(db, tenantId, lead, sequence = null) {
  if (sequence?.contact_id) {
    /*
     * TENANT- AND LEAD-SCOPED, deliberately.
     *
     * Looking a contact up by primary key alone trusts that the id on the
     * sequence belongs to this tenant. Nothing enforced that: the service-role
     * key is not bound by RLS, so a wrong or tampered contact_id would resolve
     * to another tenant's contact and address a cold FGA pitch to their
     * customer. No such event was observed — this is closing the hole, not
     * cleaning one up. Fail closed: if it does not match tenant AND lead, we
     * do not use it. (Codex 2026-07-26, round 6.)
     */
    let q = db.from('contacts')
      .select('email').eq('id', sequence.contact_id).eq('tenant_id', tenantId);
    if (lead?.id) q = q.eq('lead_id', lead.id);
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`sequence_contact_lookup_failed:${error.message}`);
    if (data?.email) return { email: data.email, source: 'sequence_contact' };
  }
  if (lead?.email) return { email: lead.email, source: 'lead' };
  if (!lead?.id) return { email: null, source: null };

  const { data, error } = await db.from('contacts')
    .select('email, is_primary_contact')
    .eq('tenant_id', tenantId)
    .eq('lead_id', lead.id)
    .not('email', 'is', null)
    .order('is_primary_contact', { ascending: false })
    .limit(5);
  if (error) throw new Error(`lead_contact_lookup_failed:${error.message}`);
  const hit = (data || []).find((c) => c.email);
  return hit ? { email: hit.email, source: 'contact' } : { email: null, source: null };
}

module.exports = { resolveRecipientEmail, leadIdsWithContactEmail };
