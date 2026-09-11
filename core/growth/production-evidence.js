'use strict';

const { isUndeliverableAddress } = require('../../integrations/email');

function truthy(value) {
  return value === true || String(value || '').toLowerCase() === 'true';
}

/**
 * Test and fixture leads may exist in the production tenant so UI and webhook
 * paths can be exercised. They remain useful evidence of software behavior,
 * but can never count as business outcomes or relationship moments.
 */
function isSyntheticGrowthLead(lead = {}) {
  const metadata = lead.metadata || {};
  if (truthy(metadata.synthetic) || truthy(metadata.is_test) || truthy(metadata.test_fixture)) return true;
  if (['test', 'synthetic', 'fixture'].includes(String(lead.lead_source || '').toLowerCase())) return true;
  return Boolean(lead.email && isUndeliverableAddress(lead.email));
}

module.exports = { isSyntheticGrowthLead };
