'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MAX_FILE_BYTES } = require('./control');

const SOURCE_TYPES = Object.freeze({
  '.csv': 'text/csv',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xlsx':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

const EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.next',
  'build',
  'client',
  'clients',
  'credentials',
  'customer',
  'customers',
  'dist',
  'finance',
  'legal',
  'node_modules',
  'private',
  'receipt',
  'receipts',
  'secrets',
]);

const SENSITIVE_FILENAME =
  /(^|[._-])(?:credentials?|private[-_]?key|service[-_]?account|secrets?|tokens?)([._-]|$)/i;

function pathDigest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function fileDigest(filename) {
  const bytes = await fs.readFile(filename);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizedSegments(relativePath) {
  return String(relativePath)
    .split(path.sep)
    .filter(Boolean)
    .map(segment => segment.toLowerCase());
}

function exclusionReason(relativePath) {
  const segments = normalizedSegments(relativePath);
  if (segments.some(segment => EXCLUDED_SEGMENTS.has(segment))) {
    return 'sensitive_or_build_directory';
  }
  if (segments.some(segment => segment.startsWith('.'))) {
    return 'hidden_path';
  }
  if (SENSITIVE_FILENAME.test(path.basename(relativePath))) {
    return 'sensitive_filename';
  }
  return null;
}

async function walk(root, current = root) {
  const results = [];
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath);
    const excluded = exclusionReason(relativePath);
    if (excluded) {
      results.push({
        kind: entry.isDirectory() ? 'directory' : 'file',
        relativePath,
        excluded,
      });
      continue;
    }
    if (entry.isSymbolicLink()) {
      results.push({
        kind: 'file',
        relativePath,
        excluded: 'symbolic_link',
      });
      continue;
    }
    if (entry.isDirectory()) {
      results.push(...await walk(root, absolutePath));
      continue;
    }
    if (entry.isFile()) {
      results.push({
        kind: 'file',
        relativePath,
        absolutePath,
        excluded: null,
      });
    }
  }
  return results;
}

async function scanRoot({ root, alias }) {
  const canonicalRoot = await fs.realpath(root);
  const candidates = await walk(canonicalRoot);
  const entries = [];
  const exclusions = {};

  for (const candidate of candidates) {
    if (candidate.excluded) {
      exclusions[candidate.excluded] =
        (exclusions[candidate.excluded] || 0) + 1;
      continue;
    }
    const extension = path.extname(candidate.relativePath).toLowerCase();
    const mimeType = SOURCE_TYPES[extension];
    if (!mimeType) {
      exclusions.unsupported_type = (exclusions.unsupported_type || 0) + 1;
      continue;
    }
    const stats = await fs.stat(candidate.absolutePath);
    if (!Number.isInteger(stats.size) || stats.size > MAX_FILE_BYTES) {
      exclusions.invalid_file_size =
        (exclusions.invalid_file_size || 0) + 1;
      continue;
    }
    const digest = await fileDigest(candidate.absolutePath);
    entries.push({
      source_alias: alias,
      source_ref: `local:${alias}:${pathDigest(candidate.relativePath)}`,
      relative_path: candidate.relativePath,
      original_filename: path.basename(candidate.relativePath),
      mime_type: mimeType,
      byte_size: stats.size,
      sha256: digest,
      modified_at: stats.mtime.toISOString(),
      malware_scan_status: 'not_scanned',
      extraction_status: 'not_started',
      ingestion_ready: false,
    });
  }

  return {
    root: {
      alias,
      source_type: 'local_or_synced_folder',
      path_fingerprint: pathDigest(canonicalRoot),
    },
    entries,
    exclusions,
  };
}

function duplicateSummary(entries) {
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.sha256, (counts.get(entry.sha256) || 0) + 1);
  }
  const groups = [...counts.values()].filter(count => count > 1);
  return {
    duplicate_group_count: groups.length,
    duplicate_file_count: groups.reduce((total, count) => total + count, 0),
  };
}

async function createLocalSourceManifest({ roots = [] } = {}) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error('at least one source root is required');
  }
  const scans = [];
  for (const [index, source] of roots.entries()) {
    if (!source?.root) throw new Error('source root is required');
    scans.push(await scanRoot({
      root: source.root,
      alias: String(source.alias || `source-${index + 1}`)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .slice(0, 50),
    }));
  }
  const entries = scans.flatMap(scan => scan.entries);
  const exclusions = {};
  for (const scan of scans) {
    for (const [reason, count] of Object.entries(scan.exclusions)) {
      exclusions[reason] = (exclusions[reason] || 0) + count;
    }
  }
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    provider_dispatch_enabled: false,
    contains_customer_content: false,
    roots: scans.map(scan => scan.root),
    entries,
    summary: {
      source_count: scans.length,
      eligible_file_count: entries.length,
      eligible_byte_count: entries.reduce(
        (total, entry) => total + entry.byte_size,
        0,
      ),
      excluded_count: Object.values(exclusions)
        .reduce((total, count) => total + count, 0),
      exclusions,
      ...duplicateSummary(entries),
      malware_clean_count: 0,
      extraction_ready_count: 0,
      ingestion_ready_count: 0,
    },
  };
}

function publicManifestSummary(manifest) {
  return {
    schema_version: manifest.schema_version,
    generated_at: manifest.generated_at,
    provider_dispatch_enabled: false,
    roots: manifest.roots,
    summary: manifest.summary,
  };
}

module.exports = {
  EXCLUDED_SEGMENTS,
  SOURCE_TYPES,
  createLocalSourceManifest,
  exclusionReason,
  publicManifestSummary,
};
