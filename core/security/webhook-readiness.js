'use strict';

const { flags } = require('../autonomous-os/feature-flags');

const LIFECYCLES = Object.freeze({
  ACTIVE: 'active',
  LEGACY: 'legacy',
  RETIRED: 'retired',
  UNUSED: 'unused',
});

const PROVIDER_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'stripe',
    lifecycle: LIFECYCLES.ACTIVE,
    requirements: Object.freeze([
      Object.freeze({
        id: 'stripe_webhook_signing_secret',
        anyOf: Object.freeze([
          Object.freeze({ kind: 'env', name: 'STRIPE_WEBHOOK_SECRET' }),
        ]),
      }),
    ]),
  }),
  Object.freeze({
    id: 'telnyx',
    lifecycle: LIFECYCLES.ACTIVE,
    requirements: Object.freeze([
      Object.freeze({
        id: 'telnyx_ed25519_public_key',
        anyOf: Object.freeze([
          Object.freeze({ kind: 'env', name: 'TELNYX_PUBLIC_KEY' }),
        ]),
      }),
    ]),
  }),
  Object.freeze({
    id: 'resend',
    lifecycle: LIFECYCLES.ACTIVE,
    requirements: Object.freeze([
      Object.freeze({
        id: 'resend_svix_signing_secret',
        anyOf: Object.freeze([
          Object.freeze({ kind: 'env', name: 'RESEND_WEBHOOK_SECRET' }),
        ]),
      }),
    ]),
  }),
  Object.freeze({
    id: 'calendly',
    lifecycle: LIFECYCLES.LEGACY,
    publiclyMounted: true,
    requirements: Object.freeze([
      Object.freeze({
        id: 'calendly_tenant_signing_secrets',
        anyOf: Object.freeze([
          Object.freeze({ kind: 'signal', name: 'calendly_tenant_signing_secrets' }),
        ]),
      }),
    ]),
  }),
  Object.freeze({
    id: 'vapi',
    lifecycle: LIFECYCLES.LEGACY,
    publiclyMounted: true,
    requirements: Object.freeze([
      Object.freeze({
        id: 'vapi_callback_verification_secret',
        anyOf: Object.freeze([
          Object.freeze({ kind: 'env', name: 'VAPI_HMAC_SECRET' }),
          Object.freeze({ kind: 'env', name: 'VAPI_SERVER_SECRET' }),
        ]),
      }),
    ]),
  }),
]);

const PROVIDER_IDS = new Set(PROVIDER_DEFINITIONS.map((provider) => provider.id));

function hasEnv(env, name) {
  const value = env && env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

function hasSignal(signals, name) {
  return Boolean(signals && signals[name] === true);
}

function sourceConfigured(source, env, signals) {
  if (source.kind === 'env') return hasEnv(env, source.name);
  if (source.kind === 'signal') return hasSignal(signals, source.name);
  return false;
}

function normalizeActiveProviders(activeProviders) {
  if (activeProviders == null) return new Set();
  if (!Array.isArray(activeProviders)) {
    throw new TypeError('activeProviders must be an array of provider ids');
  }

  const active = new Set();
  for (const rawId of activeProviders) {
    const id = typeof rawId === 'string' ? rawId.trim().toLowerCase() : '';
    if (!PROVIDER_IDS.has(id)) {
      throw new TypeError(`Unknown webhook provider id: ${id || '<invalid>'}`);
    }
    active.add(id);
  }
  return active;
}

function normalizeRouteExposure(routeExposure) {
  if (routeExposure == null) return {};
  if (typeof routeExposure !== 'object' || Array.isArray(routeExposure)) {
    throw new TypeError('routeExposure must be an object keyed by provider id');
  }
  const normalized = {};
  for (const [rawId, exposed] of Object.entries(routeExposure)) {
    const id = rawId.trim().toLowerCase();
    if (!PROVIDER_IDS.has(id)) {
      throw new TypeError(`Unknown webhook provider id: ${id || '<invalid>'}`);
    }
    if (typeof exposed !== 'boolean') {
      throw new TypeError(`Webhook route exposure must be boolean: ${id}`);
    }
    normalized[id] = exposed;
  }
  return normalized;
}

function publicRequirement(requirement, configuredSources, configured) {
  return {
    id: requirement.id,
    configured,
    accepted_config: requirement.anyOf.map((source) => ({
      source: source.kind,
      name: source.name,
      configured: configuredSources.has(`${source.kind}:${source.name}`),
    })),
  };
}

/**
 * Produce a value-safe webhook-verification readiness report.
 *
 * `signals` are boolean results from configuration that cannot be safely or
 * synchronously inspected here, such as per-tenant integration credentials.
 * The report emits only signal/env names and configured booleans. It never
 * copies a supplied environment or credential value into its result.
 *
 * Default-active providers cannot be downgraded through this helper.
 * `activeProviders` exists only to promote a legacy/retired/unused integration
 * when a deployment still receives callbacks from it.
 */
function assessWebhookReadiness({
  env = process.env,
  signals = {},
  activeProviders = [],
  routeExposure,
} = {}) {
  const promoted = normalizeActiveProviders(activeProviders);
  const exposure = normalizeRouteExposure(routeExposure);
  const strictEnforcement = flags.strictWebhookVerification();

  const providers = PROVIDER_DEFINITIONS.map((definition) => {
    const lifecycle = definition.lifecycle === LIFECYCLES.ACTIVE || promoted.has(definition.id)
      ? LIFECYCLES.ACTIVE
      : definition.lifecycle;
    const configuredSources = new Set();
    const requirements = definition.requirements.map((requirement) => {
      for (const source of requirement.anyOf) {
        if (sourceConfigured(source, env, signals)) {
          configuredSources.add(`${source.kind}:${source.name}`);
        }
      }
      const configured = requirement.anyOf.some((source) =>
        configuredSources.has(`${source.kind}:${source.name}`));
      return publicRequirement(requirement, configuredSources, configured);
    });
    const configured = requirements.every((requirement) => requirement.configured);
    const publiclyMounted = Object.hasOwn(exposure, definition.id)
      ? exposure[definition.id]
      : definition.publiclyMounted === true;
    // A legacy or retired provider with a public route remains part of the
    // attack surface until the route is unmounted. Labels never downgrade a
    // mounted callback's verification requirement.
    const required = lifecycle === LIFECYCLES.ACTIVE || publiclyMounted;
    const verificationStatus = required
      ? (configured ? 'ready' : 'missing_required_config')
      : (configured ? 'configured_inactive' : 'not_required');

    return {
      id: definition.id,
      lifecycle,
      exposure: publiclyMounted
        ? 'public_route'
        : (definition.publiclyMounted === true ? 'isolated_route' : 'integration_only'),
      required,
      configured,
      verification_status: verificationStatus,
      blocks_startup: strictEnforcement && required && !configured,
      requirements,
      missing_requirements: requirements
        .filter((requirement) => !requirement.configured)
        .map((requirement) => requirement.id),
    };
  });

  const active = providers.filter((provider) => provider.required);
  const blocking = active.filter((provider) => !provider.configured);
  const verificationReady = blocking.length === 0;
  const startupAllowed = !strictEnforcement || verificationReady;

  return {
    schema_version: 1,
    strict_enforcement_enabled: strictEnforcement,
    verification_ready: verificationReady,
    readiness_status: verificationReady ? 'ready' : 'degraded',
    startup: {
      allowed: startupAllowed,
      decision: startupAllowed
        ? (verificationReady ? 'allow' : 'allow_observe_only')
        : 'block',
      reason_code: verificationReady
        ? 'required_webhook_verification_configured'
        : (
          strictEnforcement
            ? 'strict_webhook_verification_missing_config'
            : 'webhook_verification_missing_config_enforcement_disabled'
        ),
      blocking_providers: startupAllowed ? [] : blocking.map((provider) => provider.id),
    },
    summary: {
      provider_count: providers.length,
      active_count: active.length,
      ready_active_count: active.length - blocking.length,
      missing_active_count: blocking.length,
      inactive_count: providers.length - active.length,
    },
    providers,
  };
}

function decideWebhookStartup(options) {
  return assessWebhookReadiness(options).startup;
}

module.exports = {
  LIFECYCLES,
  PROVIDER_DEFINITIONS,
  assessWebhookReadiness,
  decideWebhookStartup,
};
