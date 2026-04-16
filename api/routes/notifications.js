/**
 * Growth OS — Notifications Routes
 * Device registration for push notifications.
 */

const express = require('express');
const router = express.Router();
const { registerDevice, deactivateDevice, sendPushToTenant } = require('../../integrations/push');

/**
 * POST /api/notifications/register-device
 * Body: { token, platform, device_name }
 * Scoped to current tenant via tenantMiddleware.
 */
router.post('/register-device', async (req, res) => {
  try {
    const { token, platform, device_name } = req.body || {};
    if (!token) {
      return res.status(400).json({ success: false, error: 'token is required' });
    }

    const device = await registerDevice({
      tenantId: req.tenantId,
      userId: req.userId || null,
      token,
      platform: platform || 'ios',
      deviceName: device_name || null,
    });

    res.json({ success: true, device_id: device.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/notifications/unregister-device
 * Body: { token }
 * Used on logout.
 */
router.post('/unregister-device', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ success: false, error: 'token is required' });
    }
    await deactivateDevice(token);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/notifications/test
 * Sends a test push to all active devices for the current tenant.
 * Useful for verifying setup end-to-end.
 */
router.post('/test', async (req, res) => {
  try {
    const result = await sendPushToTenant(req.tenantId, {
      title: 'Test notification',
      body: req.body?.message || 'Push notifications are working.',
      data: { type: 'test' },
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
