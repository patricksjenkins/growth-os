/**
 * Growth OS Error Classes
 */

class GrowthOSError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
  }
}

class TenantNotFoundError extends GrowthOSError {
  constructor(identifier) {
    super(`Tenant not found: ${identifier}`, 404);
  }
}

class ModuleDisabledError extends GrowthOSError {
  constructor(moduleName) {
    super(`Module '${moduleName}' is not enabled for this tenant`, 403);
  }
}

class ConfigMissingError extends GrowthOSError {
  constructor(key) {
    super(`Required config key missing: ${key}`, 500);
  }
}

class IntegrationError extends GrowthOSError {
  constructor(service, message) {
    super(`Integration error (${service}): ${message}`, 502);
  }
}

class IdempotencyError extends GrowthOSError {
  constructor(key) {
    super(`Action already performed: ${key}`, 409);
  }
}

module.exports = {
  GrowthOSError,
  TenantNotFoundError,
  ModuleDisabledError,
  ConfigMissingError,
  IntegrationError,
  IdempotencyError
};
