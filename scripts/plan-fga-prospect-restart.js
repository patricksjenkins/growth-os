#!/usr/bin/env node
'use strict';

/**
 * Produce a privacy-safe, FGA-only restart manifest. Default mode is read-only
 * and prints aggregate counts. --write-manifest persists decisions after
 * migration 106, but does not change leads, enrollments, campaigns, jobs, or
 * send any message.
 */
require('dotenv').config();

const { getServiceClient } = require('../db/client');
const { FGA_TENANT_ID } = require('../core/config');
const {
  buildFgaRestartManifest,
  persistFgaRestartManifest,
} = require('../core/growth/restart-manifest');

const WRITE_MANIFEST = process.argv.includes('--write-manifest');
const confirmation = process.argv.find((arg) => arg.startsWith('--confirm-tenant='))?.split('=')[1];

async function main() {
  if (WRITE_MANIFEST && confirmation !== FGA_TENANT_ID) {
    throw new Error('Exact FGA tenant confirmation is required to write the manifest');
  }
  const db = getServiceClient();
  const { decisions, summary } = await buildFgaRestartManifest(db);
  console.log(JSON.stringify(summary, null, 2));
  if (!WRITE_MANIFEST) return;
  const persisted = await persistFgaRestartManifest(db, {
    decisions,
    summary,
    status: 'validated',
    createdBy: 'codex',
  });
  console.log(JSON.stringify({
    manifest_written: true,
    batch_id: persisted.batch.id,
    candidate_count: persisted.candidateCount,
  }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
