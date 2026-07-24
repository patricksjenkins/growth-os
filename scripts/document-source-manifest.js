#!/usr/bin/env node

'use strict';

const {
  createLocalSourceManifest,
  publicManifestSummary,
} = require('../core/documents/local-source-manifest');

const DEFAULT_ROOTS = Object.freeze([
  {
    alias: 'sales-collateral',
    root: '/Users/patrickjenkins/Desktop/FGA/docs/sales',
  },
  {
    alias: 'marketing-collateral',
    root: '/Users/patrickjenkins/Desktop/FGA/company/marketing',
  },
]);

async function main() {
  const manifest = await createLocalSourceManifest({ roots: DEFAULT_ROOTS });
  process.stdout.write(`${JSON.stringify(publicManifestSummary(manifest), null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({
      success: false,
      error_code: error.code || error.name || 'document_manifest_failed',
    })}\n`);
    process.exit(1);
  });
}

module.exports = { DEFAULT_ROOTS };
