'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  planIngestion,
  planRetrieval,
  providerAdapterContract,
} = require('../core/documents/ingestion');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const DOCUMENT_A = '20000000-0000-4000-8000-000000000001';
const DOCUMENT_A2 = '20000000-0000-4000-8000-000000000002';
const DOCUMENT_B = '20000000-0000-4000-8000-000000000004';

test('provider adapter contract is explicitly disabled and performs no operations', () => {
  assert.deepEqual(providerAdapterContract(), {
    provider: 'supabase_storage',
    bucket: 'fga-documents',
    configured: false,
    dispatchEnabled: false,
    supportedOperations: [],
    activationRequirement:
      'Enable an exact tenant ingestion control after storage verification',
  });
  assert.equal(providerAdapterContract('google_drive').configured, false);
  assert.equal(providerAdapterContract('google_drive').bucket, null);
});

test('ingestion plans a tenant-prefixed pending version without provider dispatch', () => {
  const result = planIngestion({
    tenantId: TENANT_A,
    documentId: DOCUMENT_A,
    versionNumber: 1,
    filename: '../Operating Procedure.pdf',
    mimeType: 'application/pdf',
    byteSize: 100,
    sha256: 'a'.repeat(64),
  });
  assert.equal(result.accepted, true);
  assert.equal(result.disposition, 'accepted');
  assert.equal(result.createsVersion, true);
  assert.equal(result.providerDispatch, false);
  assert.equal(
    result.request.storage_path,
    `${TENANT_A}/${DOCUMENT_A}/1/Operating-Procedure.pdf`
  );
  assert.match(result.requestFingerprint, /^[a-f0-9]{64}$/);
});

test('duplicate detection is tenant-scoped and prefers the same document', () => {
  const versions = [
    {
      id: 'version-other-tenant',
      tenant_id: TENANT_B,
      document_id: DOCUMENT_B,
      version_number: 9,
      sha256: 'b'.repeat(64),
    },
    {
      id: 'version-same-tenant',
      tenant_id: TENANT_A,
      document_id: DOCUMENT_A2,
      version_number: 2,
      sha256: 'b'.repeat(64),
    },
    {
      id: 'version-same-document',
      tenant_id: TENANT_A,
      document_id: DOCUMENT_A,
      version_number: 1,
      sha256: 'b'.repeat(64),
    },
  ];
  const result = planIngestion({
    tenantId: TENANT_A,
    documentId: DOCUMENT_A,
    versionNumber: 2,
    filename: 'procedure.pdf',
    mimeType: 'application/pdf',
    byteSize: 100,
    sha256: 'b'.repeat(64),
    existingVersions: versions,
  });
  assert.equal(result.disposition, 'duplicate_same_document');
  assert.equal(result.matchedVersionId, 'version-same-document');
  assert.equal(result.createsVersion, false);
});

test('ingestion fails closed for unknown providers and attempted provider dispatch', () => {
  assert.deepEqual(planIngestion({
    tenantId: TENANT_A,
    documentId: DOCUMENT_A,
    versionNumber: 1,
    filename: 'procedure.pdf',
    mimeType: 'application/pdf',
    byteSize: 100,
    sha256: 'c'.repeat(64),
    provider: 'google_drive',
    providerDispatchEnabled: true,
  }).errors, ['provider_not_configured', 'provider_dispatch_forbidden']);
});

test('agent retrieval requires an exact tenant document grant and emits citations', () => {
  const documents = [
    {
      id: DOCUMENT_A,
      tenant_id: TENANT_A,
      title: 'Synthetic operating procedure',
      classification: 'restricted',
      current_version_number: 1,
    },
    {
      id: DOCUMENT_B,
      tenant_id: TENANT_B,
      title: 'Other tenant procedure',
      classification: 'public',
      current_version_number: 1,
    },
  ];
  const versions = [
    {
      id: 'version-a',
      tenant_id: TENANT_A,
      document_id: DOCUMENT_A,
      version_number: 1,
      ingestion_status: 'ready',
      malware_scan_status: 'clean',
      extracted_text_status: 'ready',
    },
    {
      id: 'version-b',
      tenant_id: TENANT_B,
      document_id: DOCUMENT_B,
      version_number: 1,
      ingestion_status: 'ready',
      malware_scan_status: 'clean',
      extracted_text_status: 'ready',
    },
  ];
  const chunks = [
    {
      tenant_id: TENANT_A,
      document_id: DOCUMENT_A,
      version_id: 'version-a',
      chunk_index: 0,
      content: 'Escalation requires an immutable evidence receipt.',
      page_number: 2,
      section_label: 'Escalation',
    },
    {
      tenant_id: TENANT_B,
      document_id: DOCUMENT_B,
      version_id: 'version-b',
      chunk_index: 0,
      content: 'Escalation details from another tenant.',
    },
  ];
  const actor = { type: 'agent', id: 'reliability-head', tenantId: TENANT_A };

  assert.deepEqual(planRetrieval({
    actor,
    documents,
    versions,
    chunks,
    query: 'escalation',
  }).results, []);

  const retrieval = planRetrieval({
    actor,
    documents,
    versions,
    chunks,
    grants: [{
      tenant_id: TENANT_A,
      document_id: DOCUMENT_A,
      principal_type: 'agent',
      principal_id: 'reliability-head',
      permissions: ['read'],
    }],
    query: 'escalation',
  });
  assert.equal(retrieval.results.length, 1);
  assert.equal(retrieval.results[0].document_id, DOCUMENT_A);
  assert.equal(retrieval.results[0].citation.anchor, `document:${DOCUMENT_A}:v1:chunk:0`);
  assert.doesNotMatch(JSON.stringify(retrieval), /Other tenant/);
});

test('retrieval excludes unverified versions even when document access is allowed', () => {
  const result = planRetrieval({
    actor: {
      type: 'user',
      id: 'owner-a',
      tenantId: TENANT_A,
      role: 'owner',
      membershipVerified: true,
    },
    documents: [{
      id: DOCUMENT_A,
      tenant_id: TENANT_A,
      title: 'Synthetic brochure',
      classification: 'client',
      current_version_number: 1,
    }],
    versions: [{
      id: 'version-a',
      tenant_id: TENANT_A,
      document_id: DOCUMENT_A,
      version_number: 1,
      ingestion_status: 'pending',
      malware_scan_status: 'pending',
      extracted_text_status: 'pending',
    }],
    chunks: [{
      tenant_id: TENANT_A,
      document_id: DOCUMENT_A,
      version_id: 'version-a',
      chunk_index: 0,
      content: 'Unverified brochure content',
    }],
    query: 'brochure',
  });
  assert.deepEqual(result.results, []);
});

test('pure retrieval refuses unverified user membership and wrong-tenant grants', () => {
  const document = {
    id: DOCUMENT_A,
    tenant_id: TENANT_A,
    title: 'Synthetic restricted evidence',
    classification: 'restricted',
    current_version_number: 1,
  };
  assert.deepEqual(planRetrieval({
    actor: { type: 'user', id: 'owner-a', tenantId: TENANT_A, role: 'owner' },
    documents: [document],
    query: 'evidence',
  }), {
    allowed: false,
    errors: ['tenant_membership_not_verified'],
    results: [],
  });
  const wrongTenantGrant = planRetrieval({
    actor: { type: 'agent', id: 'reliability-head', tenantId: TENANT_A },
    documents: [document],
    versions: [{
      id: 'version-a',
      tenant_id: TENANT_A,
      document_id: DOCUMENT_A,
      version_number: 1,
      ingestion_status: 'ready',
      malware_scan_status: 'clean',
      extracted_text_status: 'ready',
    }],
    chunks: [{
      tenant_id: TENANT_A,
      document_id: DOCUMENT_A,
      version_id: 'version-a',
      chunk_index: 0,
      content: 'Synthetic evidence',
    }],
    grants: [{
      tenant_id: TENANT_B,
      document_id: DOCUMENT_A,
      principal_type: 'agent',
      principal_id: 'reliability-head',
      permissions: ['read'],
    }],
    query: 'evidence',
  });
  assert.deepEqual(wrongTenantGrant.results, []);
});

test('migration and rollback retain default-off, immutable, tenant-safe boundaries', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '080_document_ingestion_retrieval.sql'),
    'utf8'
  );
  assert.match(migration, /enabled\s+boolean NOT NULL DEFAULT false/i);
  assert.match(migration, /provider_dispatch_enabled\s+boolean NOT NULL DEFAULT false/i);
  assert.match(migration, /CHECK \(provider_dispatch_enabled = false\)/i);
  assert.match(migration, /document_ingestion_requires_service_role/i);
  assert.match(migration, /document_retrieval_requires_service_role/i);
  assert.match(migration, /candidate\.tenant_id = p_tenant_id/i);
  assert.match(migration, /public\.can_retrieve_document_for_actor/i);
  assert.match(migration, /document_version_content_is_immutable/i);
  assert.match(migration, /document_citation_evidence_is_immutable/i);
  assert.match(migration, /document_chunk_citation_anchor_invalid/i);
  assert.doesNotMatch(migration, /storage\.objects\s*\(/i);
  assert.doesNotMatch(migration, /google_drive|box\.com|drive\.google/i);

  const rollback = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'rollbacks', '080_document_ingestion_retrieval_rollback.sql'),
    'utf8'
  );
  assert.match(rollback, /intentionally preserves/i);
  assert.doesNotMatch(rollback, /DROP TABLE/i);
});
