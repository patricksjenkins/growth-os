/**
 * Growth OS — Crew Member Routes
 */

const express = require('express');
const router = express.Router();
const { db } = require('../../db/client');
const { validateBody, validateId } = require('../middleware/validate');

// List crew members
router.get('/', async (req, res) => {
  try {
    let query = db
      .from('crew_members')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('name');

    if (req.query.status) query = query.eq('status', req.query.status);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, crew: data, count: data.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create crew member
router.post('/', validateBody({ name: 'string' }), async (req, res) => {
  try {
    const { data, error } = await db
      .from('crew_members')
      .insert({
        tenant_id: req.tenantId,
        name: req.body.name,
        role: req.body.role,
        daily_rate: req.body.daily_rate,
        phone: req.body.phone,
        status: 'active'
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ success: true, member: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update crew member.
//
// V1 hardening (2026-05-24): explicit column allowlist on the SET clause.
// Previously `.update(req.body)` let a malicious caller change `tenant_id`,
// transferring the row to another tenant despite the WHERE clause being
// scoped correctly. See codebase-audit-v1.html § crew.js for the writeup.
const CREW_UPDATABLE = ['name', 'role', 'daily_rate', 'phone', 'status'];

router.put('/:id', validateId(), async (req, res) => {
  try {
    const updates = {};
    for (const key of CREW_UPDATABLE) {
      if (req.body && req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No editable fields supplied' });
    }

    const { data, error } = await db
      .from('crew_members')
      .update(updates)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Member not found' });
    res.json({ success: true, member: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
