/**
 * Growth OS — Request Validation Middleware
 * Validates request bodies against simple schemas
 */

/**
 * Validate request body has required fields
 * @param {Object} schema - { field: 'string' | 'number' | 'email' | 'phone' | 'uuid' | 'optional' }
 */
function validateBody(schema) {
  return (req, res, next) => {
    const errors = [];

    for (const [field, rule] of Object.entries(schema)) {
      const value = req.body[field];

      if (rule === 'optional') continue;

      if (value === undefined || value === null || value === '') {
        errors.push(`${field} is required`);
        continue;
      }

      if (rule === 'string' && typeof value !== 'string') {
        errors.push(`${field} must be a string`);
      }

      if (rule === 'number' && typeof value !== 'number' && isNaN(Number(value))) {
        errors.push(`${field} must be a number`);
      }

      if (rule === 'email' && typeof value === 'string' && !value.includes('@')) {
        errors.push(`${field} must be a valid email`);
      }

      if (rule === 'phone' && typeof value === 'string' && !/^\+?\d{7,15}$/.test(value.replace(/[\s()-]/g, ''))) {
        errors.push(`${field} must be a valid phone number`);
      }

      if (rule === 'uuid' && typeof value === 'string' &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        errors.push(`${field} must be a valid UUID`);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    next();
  };
}

/**
 * Validate UUID param
 */
function validateId(paramName = 'id') {
  return (req, res, next) => {
    const value = req.params[paramName];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      return res.status(400).json({ success: false, error: `Invalid ${paramName}` });
    }
    next();
  };
}

module.exports = { validateBody, validateId };
