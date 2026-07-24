'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createLocalSourceManifest,
  exclusionReason,
  publicManifestSummary,
} = require('../core/documents/local-source-manifest');

test('sensitive, customer, hidden, build, and credential paths are excluded', () => {
  for (const candidate of [
    'node_modules/pkg/readme.md',
    'clients/acme/proposal.pdf',
    'customer/file.pdf',
    '.env',
    'legal/contract.pdf',
    'service-account-credentials.json',
  ]) {
    assert.ok(exclusionReason(candidate));
  }
  assert.equal(exclusionReason('brochures/roofing-overview.pdf'), null);
});

test('manifest hashes eligible files, detects duplicates, and cannot claim readiness', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fga-documents-'));
  await fs.mkdir(path.join(root, 'brochures'));
  await fs.mkdir(path.join(root, 'clients'));
  await fs.writeFile(path.join(root, 'brochures', 'one.pdf'), 'same');
  await fs.writeFile(path.join(root, 'brochures', 'two.pdf'), 'same');
  await fs.writeFile(path.join(root, 'clients', 'private.pdf'), 'secret');
  await fs.writeFile(path.join(root, 'notes.exe'), 'unsupported');

  const manifest = await createLocalSourceManifest({
    roots: [{ root, alias: 'corporate' }],
  });
  assert.equal(manifest.entries.length, 2);
  assert.equal(manifest.summary.duplicate_group_count, 1);
  assert.equal(manifest.summary.duplicate_file_count, 2);
  assert.equal(manifest.summary.ingestion_ready_count, 0);
  assert.ok(manifest.entries.every(entry =>
    entry.ingestion_ready === false
    && entry.malware_scan_status === 'not_scanned'
  ));
  assert.ok(manifest.entries.every(entry =>
    entry.source_ref.startsWith('local:corporate:')
  ));

  const publicSummary = publicManifestSummary(manifest);
  assert.equal(publicSummary.entries, undefined);
  assert.doesNotMatch(JSON.stringify(publicSummary), /one\.pdf|private\.pdf/);
});

test('source traversal never follows symbolic links', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fga-documents-link-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fga-outside-'));
  await fs.writeFile(path.join(outside, 'outside.pdf'), 'outside');
  await fs.symlink(outside, path.join(root, 'linked'));

  const manifest = await createLocalSourceManifest({
    roots: [{ root, alias: 'corporate' }],
  });
  assert.equal(manifest.entries.length, 0);
  assert.equal(manifest.summary.exclusions.symbolic_link, 1);
});
