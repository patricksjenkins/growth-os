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

// Update crew member
router.put('/:id', validateId(), async (req, res) => {
  try {
    const { data, error } = await db
      .from('crew_members')
      .update(req.body)
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
