/**
 * Growth OS Config Resolution
 * Layered config: platform defaults → vertical preset → tenant_config → module config
 */

const defaults = require('../config/defaults');

// Cache presets in memory
const presetCache = {};

/**
 * Load a vertical preset
 */
function loadPreset(vertical) {
  if (presetCache[vertical]) return presetCache[vertical];
  try {
    const preset = require(`../config/presets/${vertical}`);
    presetCache[vertical] = preset;
    return preset;
  } catch (e) {
    return null;
  }
}

/**
 * Get a config value for a tenant, with layered fallback
 * @param {Object} tenant - Resolved tenant object
 * @param {string} key - Config key
 * @param {*} fallback - Final fallback if nothing found
 * @returns {*} Config value
 */
function getConfig(tenant, key, fallback = undefined) {
  // Layer 1: Tenant config (highest priority)
  if (tenant.config && tenant.config[key] !== undefined) {
    const val = tenant.config[key];
    // tenant_config stores values as strings — try to parse JSON arrays/objects
    if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
      try { return JSON.parse(val); } catch (_) { /* not valid JSON, return as string */ }
    }
    return val;
  }

  // Layer 2: Vertical preset
  const preset = loadPreset(tenant.vertical);
  if (preset && preset.config && preset.config[key] !== undefined) {
    return preset.config[key];
  }

  // Layer 3: Platform defaults
  if (defaults[key] !== undefined) {
    return defaults[key];
  }

  return fallback;
}

/**
 * Get SMS template for a tenant
 */
function getSmsTemplate(tenant, templateKey) {
  const templates = getConfig(tenant, 'sms_templates', {});
  return templates[templateKey] || null;
}

/**
 * Get the full preset for a vertical
 */
function getPreset(vertical) {
  return loadPreset(vertical);
}

module.exports = { getConfig, getSmsTemplate, getPreset, loadPreset };
