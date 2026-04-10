/**
 * Growth OS Logger
 * Structured, color-coded logging with tenant context
 */

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m'
};

function getTimestamp() {
  return new Date().toISOString();
}

/**
 * Create a logger instance for an agent/module
 * @param {string} name - Agent or module name
 * @param {string} [tenantSlug] - Tenant slug for context
 */
function createLogger(name, tenantSlug = 'platform') {
  const prefix = `${colors.gray}[${tenantSlug}]${colors.reset}`;

  return {
    info(message, data) {
      const ts = getTimestamp();
      const extra = data ? ` ${JSON.stringify(data)}` : '';
      console.log(`${colors.gray}${ts}${colors.reset} ${prefix} ${colors.blue}${name}${colors.reset} ${message}${extra}`);
    },

    success(message, data) {
      const ts = getTimestamp();
      const extra = data ? ` ${JSON.stringify(data)}` : '';
      console.log(`${colors.gray}${ts}${colors.reset} ${prefix} ${colors.green}✓ ${name}${colors.reset} ${message}${extra}`);
    },

    warn(message, data) {
      const ts = getTimestamp();
      const extra = data ? ` ${JSON.stringify(data)}` : '';
      console.warn(`${colors.gray}${ts}${colors.reset} ${prefix} ${colors.yellow}⚠ ${name}${colors.reset} ${message}${extra}`);
    },

    error(message, error) {
      const ts = getTimestamp();
      const errorStr = error instanceof Error ? error.message : (error ? String(error) : '');
      console.error(`${colors.gray}${ts}${colors.reset} ${prefix} ${colors.red}✗ ${name}${colors.reset} ${message}${errorStr ? `: ${errorStr}` : ''}`);
    }
  };
}

module.exports = { createLogger, colors };
