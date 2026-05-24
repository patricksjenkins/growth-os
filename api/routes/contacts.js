/**
 * Growth OS — Contact Routes
 */

const express = require('express');
const router = express.Router();
const contactsDb = require('../../db/queries/contacts');
const { validateBody, validateId } = require('../middleware/validate');

// V1 hardening (2026-05-24): clamp limit so a malicious caller can't ask
// for a million rows. Applied to every /list endpoint that accepts ?limit.
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
function clampLimit(raw, def = DEFAULT_LIST_LIMIT) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, MAX_LIST_LIMIT);
}

// List contacts
router.get('/', async (req, res) => {
  try {
    const contacts = await contactsDb.getContacts(req.tenantId, {
      contact_type: req.query.type,
      outreach_status: req.query.outreach_status,
      lead_id: req.query.lead_id,
      limit: clampLimit(req.query.limit)
    });
    res.json({ success: true, contacts, count: contacts.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single contact
router.get('/:id', validateId(), async (req, res) => {
  try {
    const contact = await contactsDb.getContact(req.tenantId, req.params.id);
    if (!contact) return res.status(404).json({ success: false, error: 'Contact not found' });
    res.json({ success: true, contact });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create contact
router.post('/', validateBody({ name: 'string' }), async (req, res) => {
  try {
    const contact = await contactsDb.createContact(req.tenantId, req.body);
    res.status(201).json({ success: true, contact });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update contact
router.put('/:id', validateId(), async (req, res) => {
  try {
    const contact = await contactsDb.updateContact(req.tenantId, req.params.id, req.body);
    if (!contact) return res.status(404).json({ success: false, error: 'Contact not found' });
    res.json({ success: true, contact });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
