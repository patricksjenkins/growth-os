'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

function decodeJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function trackedFiles(rootDir) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: rootDir,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
}

function scanTrackedFiles(rootDir = path.join(__dirname, '..')) {
  const findings = [];

  for (const relativePath of trackedFiles(rootDir)) {
    const filePath = path.join(rootDir, relativePath);
    let content;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
      content = fs.readFileSync(filePath, 'utf8');
      if (content.includes('\u0000')) continue;
    } catch {
      continue;
    }

    if (PRIVATE_KEY_PATTERN.test(content)) {
      findings.push({ file: relativePath, type: 'private_key' });
    }

    for (const token of content.match(JWT_PATTERN) || []) {
      const payload = decodeJwtPayload(token);
      if (payload?.role === 'service_role') {
        findings.push({ file: relativePath, type: 'supabase_service_role_jwt' });
      }
    }
  }

  return findings;
}

if (require.main === module) {
  const findings = scanTrackedFiles();
  if (findings.length) {
    for (const finding of findings) {
      console.error(`Secret scan failed: ${finding.type} in ${finding.file}`);
    }
    process.exit(1);
  }
  console.log('Secret scan passed: no tracked private keys or service-role JWTs found.');
}

module.exports = { decodeJwtPayload, scanTrackedFiles };
