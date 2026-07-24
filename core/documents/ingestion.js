'use strict';

const crypto = require('node:crypto');
const {
  buildStoragePath,
  citation,
  validateUpload,
} = require('./control');
const { evaluateDocumentAccess } = require('./access');

const DOCUMENT_BUCKET = 'fga-documents';
const INGESTION_PROVIDER = 'supabase_storage';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizedDigest(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function providerAdapterContract(provider = INGESTION_PROVIDER) {
  return Object.freeze({
    provider,
    bucket: provider === INGESTION_PROVIDER ? DOCUMENT_BUCKET : null,
    configured: false,
    dispatchEnabled: false,
    supportedOperations: Object.freeze([]),
    activationRequirement:
      provider === INGESTION_PROVIDER
        ? 'Enable an exact tenant ingestion control after storage verification'
        : 'No provider adapter is configured',
  });
}

function fingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function findDuplicate({ tenantId, documentId, sha256, existingVersions = [] }) {
  const digest = normalizedDigest(sha256);
  const candidates = existingVersions
    .filter(version =>
      version &&
      version.tenant_id === tenantId &&
      normalizedDigest(version.sha256) === digest
    )
    .sort((left, right) => {
      const leftSameDocument = left.document_id === documentId ? 0 : 1;
      const rightSameDocument = right.document_id === documentId ? 0 : 1;
      if (leftSameDocument !== rightSameDocument) {
        return leftSameDocument - rightSameDocument;
      }
      return Number(right.version_number || 0) - Number(left.version_number || 0);
    });
  const duplicate = candidates[0];
  if (!duplicate) return null;
  return {
    disposition:
      duplicate.document_id === documentId
        ? 'duplicate_same_document'
        : 'duplicate_same_tenant',
    matchedVersionId: duplicate.id || null,
  };
}

function planIngestion({
  tenantId,
  documentId,
  versionNumber,
  filename,
  mimeType,
  byteSize,
  sha256,
  provider = INGESTION_PROVIDER,
  providerDispatchEnabled = false,
  existingVersions = [],
} = {}) {
  const errors = [];
  if (!UUID_RE.test(String(tenantId || ''))) errors.push('invalid_tenant_id');
  if (!UUID_RE.test(String(documentId || ''))) errors.push('invalid_document_id');
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    errors.push('invalid_version_number');
  }
  if (provider !== INGESTION_PROVIDER) errors.push('provider_not_configured');
  if (providerDispatchEnabled !== false) errors.push('provider_dispatch_forbidden');
  const upload = validateUpload({ mimeType, byteSize, sha256: normalizedDigest(sha256) });
  errors.push(...upload.errors);
  if (errors.length) {
    return { accepted: false, errors: [...new Set(errors)] };
  }

  const duplicate = findDuplicate({
    tenantId,
    documentId,
    sha256,
    existingVersions,
  });
  const storagePath = buildStoragePath({
    tenantId,
    documentId,
    versionNumber,
    filename,
  });
  const disposition = duplicate?.disposition || 'accepted';
  const request = {
    tenant_id: tenantId,
    document_id: documentId,
    version_number: versionNumber,
    provider,
    storage_bucket: DOCUMENT_BUCKET,
    storage_path: storagePath,
    original_filename: storagePath.split('/').at(-1),
    mime_type: mimeType,
    byte_size: byteSize,
    sha256: normalizedDigest(sha256),
  };

  return {
    accepted: true,
    errors: [],
    disposition,
    matchedVersionId: duplicate?.matchedVersionId || null,
    createsVersion: disposition === 'accepted',
    providerDispatch: false,
    request,
    requestFingerprint: fingerprint(request),
  };
}

function planRetrieval({
  actor,
  documents = [],
  versions = [],
  chunks = [],
  grants = [],
  query,
  limit = 20,
} = {}) {
  const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (normalizedQuery.length < 2 || normalizedQuery.length > 200) {
    return { allowed: false, errors: ['invalid_query'], results: [] };
  }
  if (!actor?.tenantId) {
    return { allowed: false, errors: ['tenant_identity_required'], results: [] };
  }
  if (!['user', 'agent'].includes(actor.type)) {
    return { allowed: false, errors: ['invalid_actor_type'], results: [] };
  }
  if (actor.type === 'user' && actor.membershipVerified !== true) {
    return { allowed: false, errors: ['tenant_membership_not_verified'], results: [] };
  }
  const boundedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 20, 50));
  const tenantGrants = grants.filter(grant => grant?.tenant_id === actor.tenantId);
  const documentById = new Map();
  for (const document of documents) {
    if (document?.tenant_id !== actor.tenantId) continue;
    const decision = evaluateDocumentAccess({
      actor,
      document,
      grants: tenantGrants,
      permission: 'read',
    });
    if (decision.allowed) documentById.set(document.id, document);
  }
  const readyVersions = new Map();
  for (const version of versions) {
    const document = documentById.get(version?.document_id);
    if (
      !document ||
      version.tenant_id !== actor.tenantId ||
      version.version_number !== document.current_version_number ||
      version.ingestion_status !== 'ready' ||
      version.malware_scan_status !== 'clean' ||
      version.extracted_text_status !== 'ready'
    ) continue;
    readyVersions.set(version.id, version);
  }

  const results = [];
  for (const chunk of chunks) {
    const version = readyVersions.get(chunk?.version_id);
    const document = documentById.get(chunk?.document_id);
    if (
      !version ||
      !document ||
      chunk.tenant_id !== actor.tenantId ||
      !String(chunk.content || '').toLowerCase().includes(normalizedQuery)
    ) continue;
    results.push({
      document_id: document.id,
      title: document.title,
      excerpt: String(chunk.content).slice(0, 600),
      citation: citation({
        documentId: document.id,
        versionNumber: version.version_number,
        chunkIndex: chunk.chunk_index,
        pageNumber: chunk.page_number,
        sectionLabel: chunk.section_label,
      }),
    });
    if (results.length === boundedLimit) break;
  }
  return { allowed: true, errors: [], results };
}

module.exports = {
  DOCUMENT_BUCKET,
  INGESTION_PROVIDER,
  findDuplicate,
  planIngestion,
  planRetrieval,
  providerAdapterContract,
};
