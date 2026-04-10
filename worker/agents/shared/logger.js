/**
 * Simple Logger Module
 * Provides formatted, colored logging for agents
 */

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m'
};

/**
 * Format timestamp as HH:MM:SS
 * @returns {string} Formatted timestamp
 */
function getTimestamp() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes()
  ).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

/**
 * Create a logger instance for an agent
 * @param {string} agentName - Name of the agent
 * @returns {Object} Logger object with info, success, warn, error methods
 */
function createLogger(agentName) {
  return {
    /**
     * Log info message
     * @param {string} message - Message to log
     * @param {any} data - Optional data to include
     */
    info(message, data = '') {
      const timestamp = getTimestamp();
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      console.log(
        `${colors.gray}[${timestamp}]${colors.reset} ${colors.blue}ℹ ${agentName}${colors.reset} ${message}${dataStr}`
      );
    },

    /**
     * Log success message
     * @param {string} message - Message to log
     * @param {any} data - Optional data to include
     */
    success(message, data = '') {
      const timestamp = getTimestamp();
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      console.log(
        `${colors.gray}[${timestamp}]${colors.reset} ${colors.green}✓ ${agentName}${colors.reset} ${message}${dataStr}`
      );
    },

    /**
     * Log warning message
     * @param {string} message - Message to log
     * @param {any} data - Optional data to include
     */
    warn(message, data = '') {
      const timestamp = getTimestamp();
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      console.warn(
        `${colors.gray}[${timestamp}]${colors.reset} ${colors.yellow}⚠ ${agentName}${colors.reset} ${message}${dataStr}`
      );
    },

    /**
     * Log error message
     * @param {string} message - Message to log
     * @param {Error} error - Error object or message
     */
    error(message, error = '') {
      const timestamp = getTimestamp();
      const errorStr = error instanceof Error ? error.message : String(error);
      console.error(
        `${colors.gray}[${timestamp}]${colors.reset} ${colors.red}✗ ${agentName}${colors.reset} ${message}${
          errorStr ? `: ${errorStr}` : ''
        }`
      );
    }
  };
}

module.exports = {
  createLogger,
  colors
};
