'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildStoragePath,
  canTransition,
  citation,
  normalizeTags,
  validateUpload,
} = require('../core/documents/control');

test('private storage paths always begin with the immutable tenant UUID', () => {
  assert.equal(
    buildStoragePath({
      tenantId: 'tenant-a',
      documentId: 'document-b',
      versionNumber: 3,
      filename: '../../Sales Brochure (final).pdf',
    }),
    'tenant-a/document-b/3/Sales-Brochure-final-.pdf'
  );
});

test('document lifecycle cannot publish an unreviewed draft or revive a retired record', () => {
  assert.equal(canTransition('draft', 'published'), false);
  assert.equal(canTransition('draft', 'in_review'), true);
  assert.equal(canTransition('in_review', 'approved'), true);
  assert.equal(canTransition('approved', 'published'), true);
  assert.equal(canTransition('retired', 'draft'), false);
});

test('upload validation rejects unsupported, oversized, or unverifiable content', () => {
  assert.deepEqual(validateUpload({
    mimeType: 'application/pdf',
    byteSize: 100,
    sha256: 'a'.repeat(64),
  }), { valid: true, errors: [] });

  const invalid = validateUpload({
    mimeType: 'text/html',
    byteSize: 30 * 1024 * 1024,
    sha256: 'not-a-hash',
  });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.errors, [
    'unsupported_mime_type',
    'invalid_file_size',
    'invalid_sha256',
  ]);
});

test('tags are normalized and retrieval citations are version-specific', () => {
  assert.deepEqual(normalizeTags([' Sales ', 'sales', 'Brochure']), ['sales', 'brochure']);
  assert.deepEqual(citation({
    documentId: 'doc-1',
    versionNumber: 2,
    chunkIndex: 4,
    pageNumber: 7,
    sectionLabel: 'Pricing policy',
  }), {
    document_id: 'doc-1',
    version_number: 2,
    chunk_index: 4,
    page_number: 7,
    section_label: 'Pricing policy',
    anchor: 'document:doc-1:v2:chunk:4',
  });
});

test('document migration creates private storage and app-metadata RLS with checks', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '069_document_control.sql'),
    'utf8'
  );
  assert.match(sql, /VALUES \(\s*'fga-documents',\s*'fga-documents',\s*false,/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /auth\.jwt\(\)->'app_metadata'->>'tenant_id'/);
  assert.match(sql, /auth\.jwt\(\)->''app_metadata''->>''role''/);
  assert.match(sql, /FOR SELECT TO authenticated/i);
  assert.doesNotMatch(sql, /FOR (INSERT|UPDATE|DELETE|ALL) TO authenticated/i);
  assert.match(sql, /storage\.foldername\(name\)/);
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/i);
  assert.doesNotMatch(sql, /DO UPDATE SET public/i);
  assert.match(sql, /allowed_mime_types/i);
  assert.match(sql, /CHECK \(storage_bucket = 'fga-documents'\)/i);
  assert.match(sql, /storage_path LIKE[\s\S]{0,180}tenant_id::text/i);
  assert.doesNotMatch(sql, /DROP POLICY/i);
  assert.match(sql, /FOREIGN KEY \(document_id, tenant_id\)/);
  assert.match(sql, /FOREIGN KEY \(version_id, tenant_id\)/);
  assert.match(sql, /refusing to weaken document isolation/i);
});

test('document rollback refuses wrong-order or data-bearing destruction', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'rollbacks', '069_document_control_rollback.sql'),
    'utf8'
  );
  assert.match(sql, /rollback 070 before 069/i);
  assert.match(sql, /document data exists/i);
  assert.doesNotMatch(sql, /DROP TABLE[\s\S]{0,80}CASCADE/i);
});
