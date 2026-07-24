'use strict';

/**
 * Pure command planner for the shadow-only billing attribution ledger.
 *
 * This module performs no database or provider I/O. It deliberately accepts
 * provider object references, not raw webhook payloads, customer names, email
 * addresses, or payment credentials. The returned arguments are suitable for
 * the service-role-only RPCs introduced by migration 079.
 */

const crypto = require('node:crypto');
const { parseMinorUnits } = require('./canonical-calculation');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const PROVIDER_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const IDENTITY_SCOPES = new Set(['tenant', 'customer']);
const IDENTITY_OBJECT_TYPES = new Set(['tenant', 'customer', 'subscription']);
const RECONCILIATION_STATES = new Set(['pending', 'matched', 'exception']);
const FORBIDDEN_INPUT_KEYS = new Set([
  'rawPayload',
  'payload',
  'customerEmail',
  'customerName',
  'paymentMethod',
  'token',
  'secret',
]);

class BillingAttributionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BillingAttributionError';
    this.code = code;
  }
}

function requiredString(value, code, label, minimum = 1, maximum = 200) {
  const normalized = String(value || '').trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new BillingAttributionError(code, `${label} has an invalid length`);
  }
  return normalized;
}

function uuid(value, code, label) {
  const normalized = requiredString(value, code, label, 36, 36).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new BillingAttributionError(code, `${label} must be a UUID`);
  }
  return normalized;
}

function optionalUuid(value, code, label) {
  if (value === null || value === undefined || value === '') return null;
  return uuid(value, code, label);
}

function code(value, errorCode, label) {
  const normalized = requiredString(value, errorCode, label, 2, 40).toLowerCase();
  if (!CODE_PATTERN.test(normalized)) {
    throw new BillingAttributionError(errorCode, `${label} must be a lower-case code`);
  }
  return normalized;
}

function providerReference(value, errorCode, label) {
  const normalized = requiredString(value, errorCode, label, 2, 255);
  if (!PROVIDER_REF_PATTERN.test(normalized)) {
    throw new BillingAttributionError(
      errorCode,
      `${label} must be an opaque provider reference without whitespace or PII`,
    );
  }
  return normalized;
}

function timestamp(value, errorCode, label) {
  const normalized = requiredString(value, errorCode, label, 20, 40);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new BillingAttributionError(errorCode, `${label} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function date(value, errorCode, label) {
  const normalized = requiredString(value, errorCode, label, 10, 10);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)
      || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new BillingAttributionError(errorCode, `${label} must be an ISO date`);
  }
  return normalized;
}

function digest(value, errorCode, label) {
  const normalized = requiredString(value, errorCode, label, 64, 64).toLowerCase();
  if (!FINGERPRINT_PATTERN.test(normalized)) {
    throw new BillingAttributionError(errorCode, `${label} must be a sha256 digest`);
  }
  return normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function normalizeActor(input) {
  const actorType = code(input.actorType, 'ACTOR_TYPE_INVALID', 'actorType');
  if (!['service', 'system'].includes(actorType)) {
    throw new BillingAttributionError(
      'ACTOR_TYPE_INVALID',
      'shadow billing commands require a service or system actor',
    );
  }
  if (actorType === 'system'
      && input.actorId !== null
      && input.actorId !== undefined
      && input.actorId !== '') {
    throw new BillingAttributionError(
      'SYSTEM_ACTOR_ID_FORBIDDEN',
      'system actor must not claim a mutable actor id',
    );
  }
  const actorId = actorType === 'system'
    ? null
    : requiredString(input.actorId, 'ACTOR_ID_REQUIRED', 'actorId', 2, 160);
  return { actorType, actorId };
}

function normalizeCommon(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BillingAttributionError('COMMAND_REQUIRED', 'command input is required');
  }
  for (const key of FORBIDDEN_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new BillingAttributionError(
        'FORBIDDEN_SENSITIVE_INPUT',
        `billing attribution commands must not contain ${key}`,
      );
    }
  }
  const tenantId = uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId');
  const provider = code(input.provider, 'PROVIDER_INVALID', 'provider');
  const providerAccountRef = providerReference(
    input.providerAccountRef,
    'PROVIDER_ACCOUNT_REF_INVALID',
    'providerAccountRef',
  );
  const idempotencyKey = requiredString(
    input.idempotencyKey,
    'IDEMPOTENCY_KEY_INVALID',
    'idempotencyKey',
    8,
    200,
  );
  const evidenceDigest = digest(
    input.evidenceDigest,
    'EVIDENCE_DIGEST_INVALID',
    'evidenceDigest',
  );
  const evidenceObservedAt = timestamp(
    input.evidenceObservedAt,
    'EVIDENCE_TIME_INVALID',
    'evidenceObservedAt',
  );
  return {
    tenantId,
    provider,
    providerAccountRef,
    idempotencyKey,
    evidenceDigest,
    evidenceObservedAt,
    ...normalizeActor(input),
  };
}

function planBillingIdentityRegistration(input = {}) {
  const common = normalizeCommon(input);
  const scopeType = code(input.scopeType, 'SCOPE_TYPE_INVALID', 'scopeType');
  const providerObjectType = code(
    input.providerObjectType,
    'PROVIDER_OBJECT_TYPE_INVALID',
    'providerObjectType',
  );
  if (!IDENTITY_SCOPES.has(scopeType)
      || !IDENTITY_OBJECT_TYPES.has(providerObjectType)) {
    throw new BillingAttributionError(
      'IDENTITY_SCOPE_INVALID',
      'identity scope and provider object type are not supported',
    );
  }
  const customerId = optionalUuid(input.customerId, 'CUSTOMER_ID_INVALID', 'customerId');
  if ((scopeType === 'tenant') !== (customerId === null)) {
    throw new BillingAttributionError(
      'IDENTITY_CUSTOMER_SCOPE_MISMATCH',
      'tenant mappings cannot have a customer and customer mappings require one',
    );
  }
  if ((scopeType === 'tenant' && providerObjectType !== 'tenant')
      || (scopeType === 'customer' && providerObjectType === 'tenant')) {
    throw new BillingAttributionError(
      'IDENTITY_OBJECT_SCOPE_MISMATCH',
      'provider object type does not match identity scope',
    );
  }

  const semantic = {
    contractVersion: 1,
    ...common,
    scopeType,
    customerId,
    providerObjectType,
    providerObjectRef: providerReference(
      input.providerObjectRef,
      'PROVIDER_OBJECT_REF_INVALID',
      'providerObjectRef',
    ),
    evidenceType: code(input.evidenceType, 'EVIDENCE_TYPE_INVALID', 'evidenceType'),
    evidenceId: providerReference(input.evidenceId, 'EVIDENCE_ID_INVALID', 'evidenceId'),
  };

  return {
    rpc: 'billing_identity_register_rpc',
    args: {
      p_tenant_id: semantic.tenantId,
      p_scope_type: semantic.scopeType,
      p_customer_id: semantic.customerId,
      p_provider: semantic.provider,
      p_provider_account_ref: semantic.providerAccountRef,
      p_provider_object_type: semantic.providerObjectType,
      p_provider_object_ref: semantic.providerObjectRef,
      p_evidence_type: semantic.evidenceType,
      p_evidence_id: semantic.evidenceId,
      p_evidence_digest: semantic.evidenceDigest,
      p_evidence_observed_at: semantic.evidenceObservedAt,
      p_actor_type: semantic.actorType,
      p_actor_id: semantic.actorId,
      p_idempotency_key: semantic.idempotencyKey,
      p_request_fingerprint: fingerprint(semantic),
      p_feature_gate_enabled: false,
    },
  };
}

function optionalMinor(value, errorCode) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return parseMinorUnits(value);
  } catch {
    throw new BillingAttributionError(errorCode, 'reconciled amount must be exact minor units');
  }
}

function planFinanceAttribution(input = {}) {
  const common = normalizeCommon(input);
  const reconciliationStatus = code(
    input.reconciliationStatus,
    'RECONCILIATION_STATUS_INVALID',
    'reconciliationStatus',
  );
  if (!RECONCILIATION_STATES.has(reconciliationStatus)) {
    throw new BillingAttributionError(
      'RECONCILIATION_STATUS_INVALID',
      'reconciliation status is not supported',
    );
  }

  let revenueMinor;
  let costMinor;
  try {
    revenueMinor = parseMinorUnits(input.revenueMinor);
    costMinor = parseMinorUnits(input.costMinor);
  } catch {
    throw new BillingAttributionError(
      'ATTRIBUTION_AMOUNT_INVALID',
      'revenue and cost must be exact safe-integer minor units',
    );
  }
  const marginMinor = BigInt(revenueMinor) - BigInt(costMinor);
  if (marginMinor > BigInt(Number.MAX_SAFE_INTEGER)
      || marginMinor < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new BillingAttributionError(
      'ATTRIBUTION_MARGIN_OUT_OF_RANGE',
      'revenue minus cost exceeds the safe exact minor-unit range',
    );
  }
  const reconciledRevenueMinor = optionalMinor(
    input.reconciledRevenueMinor,
    'RECONCILED_REVENUE_INVALID',
  );
  const reconciledCostMinor = optionalMinor(
    input.reconciledCostMinor,
    'RECONCILED_COST_INVALID',
  );
  if (reconciliationStatus === 'pending'
      && (reconciledRevenueMinor !== null || reconciledCostMinor !== null)) {
    throw new BillingAttributionError(
      'PENDING_RECONCILIATION_HAS_TOTALS',
      'pending reconciliation cannot claim authoritative totals',
    );
  }
  if (reconciliationStatus === 'matched'
      && (reconciledRevenueMinor !== revenueMinor || reconciledCostMinor !== costMinor)) {
    throw new BillingAttributionError(
      'MATCHED_RECONCILIATION_DIFFERS',
      'matched reconciliation must agree exactly in minor units',
    );
  }
  if (reconciliationStatus === 'exception'
      && (
        reconciledRevenueMinor === null
        || reconciledCostMinor === null
        || (reconciledRevenueMinor === revenueMinor && reconciledCostMinor === costMinor)
      )) {
    throw new BillingAttributionError(
      'RECONCILIATION_EXCEPTION_UNPROVEN',
      'exception reconciliation requires an exact non-zero difference',
    );
  }

  const currency = requiredString(input.currency, 'CURRENCY_INVALID', 'currency', 3, 3)
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new BillingAttributionError('CURRENCY_INVALID', 'currency must be a three-letter code');
  }

  const semantic = {
    contractVersion: 1,
    ...common,
    customerId: uuid(input.customerId, 'CUSTOMER_ID_INVALID', 'customerId'),
    tenantMappingId: uuid(
      input.tenantMappingId,
      'TENANT_MAPPING_ID_INVALID',
      'tenantMappingId',
    ),
    customerMappingId: uuid(
      input.customerMappingId,
      'CUSTOMER_MAPPING_ID_INVALID',
      'customerMappingId',
    ),
    sourceEventType: code(
      input.sourceEventType,
      'SOURCE_EVENT_TYPE_INVALID',
      'sourceEventType',
    ),
    sourceEventId: providerReference(
      input.sourceEventId,
      'SOURCE_EVENT_ID_INVALID',
      'sourceEventId',
    ),
    occurredOn: date(input.occurredOn, 'OCCURRED_ON_INVALID', 'occurredOn'),
    currency,
    revenueMinor,
    costMinor,
    reconciliationStatus,
    reconciledRevenueMinor,
    reconciledCostMinor,
  };

  return {
    rpc: 'finance_attribution_record_rpc',
    args: {
      p_tenant_id: semantic.tenantId,
      p_customer_id: semantic.customerId,
      p_tenant_mapping_id: semantic.tenantMappingId,
      p_customer_mapping_id: semantic.customerMappingId,
      p_provider: semantic.provider,
      p_provider_account_ref: semantic.providerAccountRef,
      p_source_event_type: semantic.sourceEventType,
      p_source_event_id: semantic.sourceEventId,
      p_occurred_on: semantic.occurredOn,
      p_currency: semantic.currency,
      p_revenue_minor: semantic.revenueMinor,
      p_cost_minor: semantic.costMinor,
      p_reconciliation_status: semantic.reconciliationStatus,
      p_reconciled_revenue_minor: semantic.reconciledRevenueMinor,
      p_reconciled_cost_minor: semantic.reconciledCostMinor,
      p_evidence_digest: semantic.evidenceDigest,
      p_evidence_observed_at: semantic.evidenceObservedAt,
      p_actor_type: semantic.actorType,
      p_actor_id: semantic.actorId,
      p_idempotency_key: semantic.idempotencyKey,
      p_request_fingerprint: fingerprint(semantic),
      p_feature_gate_enabled: false,
    },
  };
}

module.exports = {
  BillingAttributionError,
  planBillingIdentityRegistration,
  planFinanceAttribution,
  _internal: { fingerprint, stableJson },
};
