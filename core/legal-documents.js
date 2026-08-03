'use strict';

/**
 * The documents a customer accepts, and which version of each.
 *
 * WHY THIS IS SERVER-SIDE (2026-08-03)
 * This list used to live in the wizard component, and the browser posted
 * `agreement_versions` as part of the step data. The API accepted any nonempty
 * object. So the record of WHAT a customer agreed to was whatever their
 * browser said they agreed to.
 *
 * That is the same class of mistake as taking the acceptance timestamp from
 * the client, which was already fixed: consent evidence has to be witnessed by
 * the party relying on it. A signature we hold against "Service Agreement 1.0"
 * is only worth something if we are the ones who recorded that it was 1.0.
 *
 * So the server stamps the versions from this file and ignores what the client
 * claims, and the wizard renders this same list through onboarding-state —
 * one source of truth, so the customer cannot be shown one version and
 * recorded as accepting another.
 *
 * WHEN A DOCUMENT CHANGES: bump its version here. Existing acceptances keep
 * the version they were recorded with, which is the point — that is the
 * evidence of what that particular customer agreed to.
 */

const LEGAL_DOCUMENTS = Object.freeze([
  { name: 'Service Agreement',    url: '/legal/service-agreement.pdf',        required: true,  version: '1.0' },
  { name: 'Scope of Work',        url: '/legal/scope-of-work.pdf',            required: true,  version: '1.0' },
  { name: 'Acceptable Use Policy', url: '/legal/acceptable-use-policy.pdf',   required: true,  version: '1.0' },
  { name: 'Privacy Policy',       url: '/privacy',                            required: true,  version: '2026-04-11' },
  { name: 'Terms of Service',     url: '/terms',                              required: true,  version: '2026-04-11' },
  {
    name: 'Data Processing Agreement (for regulated industries)',
    url: '/legal/data-processing-agreement.pdf',
    required: false,
    version: '1.0',
  },
].map(Object.freeze));

/** The versions to RECORD against an acceptance. Required documents only. */
function currentVersions() {
  return LEGAL_DOCUMENTS
    .filter((d) => d.required)
    .reduce((acc, d) => ({ ...acc, [d.name]: d.version }), {});
}

/** Every document the wizard should display, required or not. */
function documentsForDisplay() {
  return LEGAL_DOCUMENTS.map((d) => ({ ...d }));
}

module.exports = { LEGAL_DOCUMENTS, currentVersions, documentsForDisplay };
