/**
 * Growth OS Module System
 * Feature flags and module-aware middleware
 */

/**
 * Check if a module is enabled for a tenant
 * @param {Object} tenant - Resolved tenant object (from core/tenant.js)
 * @param {string} moduleName - Module identifier
 * @returns {boolean}
 */
function isModuleEnabled(tenant, moduleName) {
  if (!tenant || !tenant.modules) return false;
  return tenant.modules[moduleName]?.enabled === true;
}

/**
 * Get module-specific config for a tenant
 * @param {Object} tenant - Resolved tenant object
 * @param {string} moduleName - Module identifier
 * @returns {Object} Module config or empty object
 */
function getModuleConfig(tenant, moduleName) {
  if (!tenant || !tenant.modules) return {};
  const mod = tenant.modules[moduleName];
  if (!mod) return {};
  const { enabled, module, ...config } = mod;
  return config;
}

/**
 * Express middleware that blocks requests if module is disabled
 * @param {string} moduleName - Module identifier
 * @returns {Function} Express middleware
 */
function requireModule(moduleName) {
  return (req, res, next) => {
    if (!req.tenant || !isModuleEnabled(req.tenant, moduleName)) {
      return res.status(403).json({
        error: `Module '${moduleName}' is not enabled for this tenant`
      });
    }
    next();
  };
}

module.exports = { isModuleEnabled, getModuleConfig, requireModule };
