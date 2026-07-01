/**
 * Shared cold-outreach email signature builder.
 *
 * Single source of truth for the 3-line signature block so the worker
 * (draft creation) and the API (send-time) produce identical output:
 *
 *   Patrick Jenkins
 *   Founder, First Gen Automate
 *   (404) 496-7983 · firstgenautomate.com
 *
 * The phone/website come from tenant config, so refreshing the signature
 * at SEND time guarantees the current number ships — even on drafts that
 * were written before a number change. This is the permanent fix for
 * "the phone number is baked into old drafts".
 *
 * The strip logic recognizes an OLD signature structurally (a contact line
 * is "phone + website joined by ·"), not by exact string match — so a draft
 * carrying a stale phone number still gets its signature swapped cleanly
 * instead of doubled.
 */

const { getConfig } = require('./config');
const { resolveIdentity, signatureLinesFor } = require('./tenant-email-identity');

const PHONE_RE = /\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/;

/**
 * Build the plain-text signature lines for a tenant.
 *
 * Delegates to the tenant identity resolver so a NON-platform tenant NEVER gets
 * FGA signature lines (P0 cross-tenant bleed fix). Platform (FGA) tenant still
 * gets the FGA signature. Missing tenant fields are simply omitted (fewer
 * lines) — never backfilled with FGA.
 *
 * @param {Object} tenant — resolved tenant (must have .config)
 * @returns {string[]} the signature lines (no blank lines)
 */
function signatureLines(tenant) {
  return signatureLinesFor(resolveIdentity(tenant));
}

/** Plain-text signature block (newline-joined). */
function buildSignatureBlock(tenant) {
  return signatureLines(tenant).join('\n');
}

/**
 * Is this single line part of a signature? True when it exactly matches a
 * current sig line, OR it looks like a contact line (phone/website/·) even
 * if the digits differ from current config (stale-number drafts).
 */
function isSignatureLine(line, tenant, lines) {
  const t = (line || '').trim();
  if (!t) return true; // blank line — safe to drop while trimming
  if (lines.some((s) => s.trim() === t)) return true;
  const website = resolveIdentity(tenant).signature.website || getConfig(tenant, 'sender_website', null);
  const hasSep = t.includes(' · ');
  const hasPhone = PHONE_RE.test(t);
  const hasSite = website && t.toLowerCase().includes(String(website).toLowerCase());
  return (hasSep && (hasPhone || hasSite)) || (hasPhone && hasSite);
}

/**
 * Strip any trailing signature the body already ends with (full or partial,
 * current or stale) plus trailing blank lines, so we never double-append.
 */
function stripTrailingSignature(text, tenant, lines) {
  if (!text) return text || '';
  const out = text.trimEnd().split('\n');
  while (out.length > 0 && isSignatureLine(out[out.length - 1], tenant, lines)) {
    out.pop();
  }
  return out.join('\n');
}

/**
 * Apply a fresh signature to plain-text body: strip whatever sig it ends
 * with, then append the current-config block.
 */
function applyPlainSignature(bodyPlain, tenant) {
  const lines = signatureLines(tenant);
  const stripped = stripTrailingSignature(bodyPlain, tenant, lines);
  return `${stripped}\n\n${lines.join('\n')}`;
}

/**
 * Apply a fresh signature to an HTML body: remove trailing <p> blocks that
 * hold only signature content (handles both "one <p> per line" and a single
 * "<p>name<br>title<br>contact</p>" block), then append a styled sig.
 */
function applyHtmlSignature(bodyHtml, tenant) {
  const lines = signatureLines(tenant);
  let html = (bodyHtml || '').trimEnd();
  // Last <p>…</p> with no nested closing tag, anchored to end of string.
  const lastP = /<p[^>]*>((?:(?!<\/p>)[\s\S])*)<\/p>\s*$/i;
  // Peel up to 5 trailing signature-only paragraphs.
  for (let i = 0; i < 5; i++) {
    const m = html.match(lastP);
    if (!m) break;
    const innerLines = m[1]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const sigOnly = innerLines.length > 0
      && innerLines.every((il) => isSignatureLine(il, tenant, lines));
    if (!sigOnly) break;
    html = html.slice(0, m.index).trimEnd();
  }
  const htmlSig = `<p style="margin-top:24px;color:#374151;font-size:14px;line-height:1.5;">${lines.join('<br>')}</p>`;
  return html + htmlSig;
}

module.exports = {
  signatureLines,
  buildSignatureBlock,
  isSignatureLine,
  stripTrailingSignature,
  applyPlainSignature,
  applyHtmlSignature,
};
