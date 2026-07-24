'use strict';

const path = require('node:path');

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const TRANSITIONS = Object.freeze({
  draft: new Set(['in_review', 'retired']),
  in_review: new Set(['draft', 'approved', 'retired']),
  approved: new Set(['in_review', 'published', 'retired']),
  published: new Set(['in_review', 'retired']),
  retired: new Set([]),
});

function safeFilename(filename) {
  const base = path.basename(String(filename || 'document'))
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
  return base || 'document';
}

function buildStoragePath({ tenantId, documentId, versionNumber, filename }) {
  if (!tenantId || !documentId || !Number.isInteger(versionNumber) || versionNumber < 1) {
    throw new Error('tenantId, documentId, and positive versionNumber are required');
  }
  return `${tenantId}/${documentId}/${versionNumber}/${safeFilename(filename)}`;
}

function validateUpload({ mimeType, byteSize, sha256 }) {
  const errors = [];
  if (!ALLOWED_MIME_TYPES.has(mimeType)) errors.push('unsupported_mime_type');
  if (!Number.isInteger(byteSize) || byteSize < 0 || byteSize > MAX_FILE_BYTES) {
    errors.push('invalid_file_size');
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    errors.push('invalid_sha256');
  }
  return { valid: errors.length === 0, errors };
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.has(to));
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags
    .filter(tag => typeof tag === 'string')
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean)
    .map(tag => tag.slice(0, 50))
  )].slice(0, 25);
}

function citation({ documentId, versionNumber, chunkIndex, pageNumber, sectionLabel }) {
  if (!documentId || !Number.isInteger(versionNumber) || !Number.isInteger(chunkIndex)) {
    throw new Error('documentId, versionNumber, and chunkIndex are required');
  }
  return {
    document_id: documentId,
    version_number: versionNumber,
    chunk_index: chunkIndex,
    page_number: Number.isInteger(pageNumber) ? pageNumber : null,
    section_label: typeof sectionLabel === 'string' ? sectionLabel.slice(0, 200) : null,
    anchor: `document:${documentId}:v${versionNumber}:chunk:${chunkIndex}`,
  };
}

module.exports = {
  ALLOWED_MIME_TYPES,
  MAX_FILE_BYTES,
  TRANSITIONS,
  buildStoragePath,
  canTransition,
  citation,
  normalizeTags,
  safeFilename,
  validateUpload,
};
