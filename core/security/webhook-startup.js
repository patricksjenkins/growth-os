'use strict';

const { assessWebhookReadiness } = require('./webhook-readiness');

/**
 * Reduce the full readiness report to the fields safe and useful at startup.
 * Credential values are never present in the assessment, and this additional
 * projection intentionally omits accepted configuration source details.
 */
function sanitizeWebhookReadiness(report) {
  return {
    schema_version: report.schema_version,
    strict_enforcement_enabled: report.strict_enforcement_enabled,
    verification_ready: report.verification_ready,
    readiness_status: report.readiness_status,
    startup: {
      allowed: report.startup.allowed,
      decision: report.startup.decision,
      reason_code: report.startup.reason_code,
      blocking_providers: [...report.startup.blocking_providers],
    },
    summary: { ...report.summary },
    providers: report.providers.map((provider) => ({
      id: provider.id,
      lifecycle: provider.lifecycle,
      exposure: provider.exposure,
      required: provider.required,
      configured: provider.configured,
      verification_status: provider.verification_status,
      missing_requirements: [...provider.missing_requirements],
    })),
  };
}

class WebhookStartupReadinessError extends Error {
  constructor(readiness) {
    const providers = readiness.startup.blocking_providers.join(', ') || 'unknown';
    super(`Webhook verification readiness blocked startup (${providers})`);
    this.name = 'WebhookStartupReadinessError';
    this.code = readiness.startup.reason_code;
    this.readiness = readiness;
  }
}

/**
 * Assess and log webhook verification readiness before the HTTP listener opens.
 *
 * This performs no network or database access. Strictness remains controlled
 * by FGA_OS_STRICT_WEBHOOK_VERIFICATION through assessWebhookReadiness and
 * therefore defaults off.
 */
function enforceWebhookStartupReadiness({
  logger,
  ...assessmentOptions
} = {}) {
  const report = assessWebhookReadiness(assessmentOptions);
  const readiness = sanitizeWebhookReadiness(report);
  const level = readiness.verification_ready ? 'info' : 'warn';

  if (logger && typeof logger[level] === 'function') {
    logger[level]('Webhook verification readiness', readiness);
  }

  if (!readiness.startup.allowed) {
    throw new WebhookStartupReadinessError(readiness);
  }

  return readiness;
}

module.exports = {
  WebhookStartupReadinessError,
  enforceWebhookStartupReadiness,
  sanitizeWebhookReadiness,
};
