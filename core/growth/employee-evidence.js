'use strict';

const MIN_CONFIDENCE = 0.8;
const APPROVED_ESTIMATE_PROVIDERS = new Set(['apollo']);

function normalizedSource(value) {
  const source = String(value || '').trim();
  return source ? source.slice(0, 500) : null;
}

function normalizedUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return null;
  }
}

/**
 * Accept an exact employee count only when it is paired with durable source
 * evidence. Search extractors can also require the cited source to be one of
 * the URLs actually supplied to the model, which prevents an invented URL
 * from becoming autonomous-send authority.
 */
function acceptExactEmployeeEvidence({ count, source, confidence, allowedSourceUrls = null } = {}) {
  const parsedCount = Number(count);
  const parsedConfidence = Number(confidence);
  const parsedSource = normalizedSource(source);
  if (!Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount >= 10000) return null;
  if (!Number.isFinite(parsedConfidence) || parsedConfidence < MIN_CONFIDENCE) return null;
  if (!parsedSource) return null;

  if (Array.isArray(allowedSourceUrls)) {
    const cited = normalizedUrl(parsedSource);
    const allowed = new Set(allowedSourceUrls.map(normalizedUrl).filter(Boolean));
    if (!cited || !allowed.has(cited)) return null;
  }

  return { count: parsedCount, source: parsedSource, confidence: parsedConfidence };
}

/**
 * Provider-backed estimates are valid evidence, but they are not exact facts.
 * Keep that distinction durable so the UI and eligibility ledger never call
 * an estimate "exact". A matching organization domain is mandatory.
 */
function acceptProviderEmployeeEvidence({ count, source, confidence, provider, domainMatched } = {}) {
  const parsedCount = Number(count);
  const parsedConfidence = Number(confidence);
  const parsedSource = normalizedSource(source);
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!APPROVED_ESTIMATE_PROVIDERS.has(normalizedProvider)) return null;
  if (domainMatched !== true) return null;
  if (!Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount >= 10000) return null;
  if (!Number.isFinite(parsedConfidence) || parsedConfidence < MIN_CONFIDENCE) return null;
  if (!parsedSource || !parsedSource.startsWith(`${normalizedProvider}:organization:`)) return null;
  return {
    count: parsedCount,
    source: parsedSource,
    confidence: parsedConfidence,
    method: 'provider_estimate',
    provider: normalizedProvider,
    domain_match: true,
  };
}

function evidenceMatchesLead(lead = {}) {
  const count = Number(lead.employee_count_actual);
  const proof = lead.metadata && lead.metadata.employee_count_evidence;
  const accepted = proof?.method === 'provider_estimate'
    ? acceptProviderEmployeeEvidence({
        count: proof.count,
        source: proof.source,
        confidence: proof.confidence,
        provider: proof.provider,
        domainMatched: proof.domain_match,
      })
    : acceptExactEmployeeEvidence({
        count: proof && proof.count,
        source: proof && proof.source,
        confidence: proof && proof.confidence,
      });
  return accepted && accepted.count === count ? accepted : null;
}

module.exports = {
  MIN_CONFIDENCE,
  acceptExactEmployeeEvidence,
  acceptProviderEmployeeEvidence,
  evidenceMatchesLead,
};
