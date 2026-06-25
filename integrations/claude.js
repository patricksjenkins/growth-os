/**
 * Growth OS — Claude AI Integration
 *
 * All Claude calls flow through this module. Per-tenant cost protection
 * is enforced here so individual agents don't have to remember:
 *
 *   1. Before every call: usage-caps.checkUsageOrThrow(tenant, 'claude_spend_cents')
 *      — throws if the tenant is already at their monthly spend cap.
 *   2. After every call: estimate spend (token usage × model price) and
 *      increment tenant_usage.claude_spend_cents + tokens.
 *
 * Callers MUST pass `tenant` (object with id + tier) for the protection
 * to kick in. Passing only tenantSlug (legacy) logs but doesn't cap —
 * that's a backward-compat hatch for the small handful of code paths
 * that don't have the full tenant object handy (e.g. dev test calls).
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { createLogger } = require('../core/logger');
const { withRetry } = require('./_retry');
// AI safety guard (monitor-only by default; never blocks unless an
// enforcement flag is explicitly enabled). Loaded defensively so a problem in
// the safety layer can never take down provider calls.
let guard = { beforeCall: async () => ({ allow: true }), afterCall: async () => {} };
try { guard = require('../core/ai-safety/guard'); } catch (_) { /* safety layer optional */ }
// Agent attribution fallback — when a call site doesn't pass agentName/tenant,
// inherit it from the running agent's context (set by the job processor).
let getAgentContext = () => ({});
try { ({ getAgentContext } = require('../core/agent-context')); } catch (_) { /* optional */ }
const {
  checkUsageOrThrow,
  incrementUsage,
  notifyOwnerCapReached,
  estimateClaudeSpendCents,
  UsageCapExceededError,
} = require('../core/usage-caps');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const SONNET_MODEL = 'claude-sonnet-4-6';
const HAIKU_MODEL  = 'claude-haiku-4-5-20251001';

// Global pace gate (2026-06-09). EVERY Claude call funnels through
// callClaude, so this is the one place to cap how fast we START requests
// platform-wide. Why it exists: a one-shot bulk enqueue (e.g. an outreach
// backfill of 100+ leads landing in agent_jobs at the same instant) fires
// 100+ Sonnet drafts almost simultaneously. Once Anthropic starts 429ing,
// withRetry + askClaudeJSON's own retry loop multiply each draft into many
// calls — that's how a 104-lead backfill produced ~847 rate-limit hits.
// Spacing call STARTS keeps us under Anthropic's requests-per-minute ceiling
// no matter how many jobs land at once. Steady-state impact is ~0 (the gate
// only delays when calls actually queue). Tunable via CLAUDE_MIN_CALL_INTERVAL_MS.
const MIN_CALL_INTERVAL_MS = Number(process.env.CLAUDE_MIN_CALL_INTERVAL_MS || 1200);
let _gateChain = Promise.resolve();
let _lastCallStart = 0;
function _sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function _paceGate() {
  // Serialize the "when did the last call start" bookkeeping behind a
  // single promise chain so concurrent callers space out cleanly. The
  // first call (or any call after a quiet period) waits ~0ms.
  _gateChain = _gateChain.then(async () => {
    const wait = Math.max(0, _lastCallStart + MIN_CALL_INTERVAL_MS - Date.now());
    if (wait > 0) await _sleep(wait);
    _lastCallStart = Date.now();
  });
  return _gateChain;
}

// V1 hardening (2026-05-24): wrap every Anthropic call in withRetry so a
// transient 429/503 doesn't kill the parent agent job. Anthropic's SDK
// surfaces status codes via err.status, which the retry helper picks up
// for 408/429/5xx. The Retry-After header is also honored when present.
async function callClaude(params, label, meta = {}) {
  const callMeta = { provider: 'anthropic', model: params.model, operationType: meta.operationType || label, ...meta };

  // AI safety guard — monitor-only by default. beforeCall returns allow:true
  // unless an enforcement flag is explicitly enabled AND a switch is open.
  const decision = await guard.beforeCall(callMeta);
  if (decision && decision.allow === false) {
    const e = new Error(`ai_safety_blocked: ${decision.reason || 'switch_open'}`);
    e.code = 'AI_SAFETY_BLOCKED';
    throw e;
  }

  await _paceGate();

  let attempt = 1;
  try {
    // Stream the request and reconstruct the final Message (same shape as
    // .create()). Why: long generations (e.g. prospecting's ~4k-token JSON
    // extraction runs ~55s) sent as a single non-streamed response get cut
    // off by intermediate idle/response timeouts on the egress path, which
    // surfaces as "Invalid response body ... Premature close" and kills the
    // job (it isn't a retryable HTTP status, so nothing recovered it).
    // Streaming keeps bytes flowing continuously, so no timeout fires; the
    // result and token usage are identical. (Regressed ~2026-06-19 as model
    // latency crept past the timeout threshold — prospecting failed daily.)
    const response = await withRetry(() => client.messages.stream(params).finalMessage(), {
      attempts: 3,
      onRetry: (err, n, delayMs) => {
        attempt = n + 1; // next attempt number
        const status = err.status ?? err.response?.status ?? '?';
        console.warn(`[claude:${label}] retry ${n} in ${delayMs}ms (status=${status}): ${err.message}`);
        // Count the failed attempt toward usage totals (Phase 9). Fire-and-forget.
        guard.afterCall({ ...callMeta, attempt: n }, { outcome: 'failed', error: `retry_${status}` }).catch(() => {});
      },
    });
    // Record the successful (final) attempt with token usage. Fire-and-forget
    // so usage tracking never adds latency to the call path.
    guard.afterCall({ ...callMeta, attempt }, { usage: response.usage, outcome: 'success' }).catch(() => {});
    return response;
  } catch (err) {
    guard.afterCall({ ...callMeta, attempt }, { outcome: 'failed', error: err.message }).catch(() => {});
    throw err;
  }
}

/**
 * Internal: enforce the spend cap before a Claude call.
 * Throws UsageCapExceededError if over.
 * No-op (with warning) if tenant object missing (legacy callers).
 */
async function _enforceClaudeCap(tenant, log) {
  if (!tenant || !tenant.id) {
    // Legacy code path — log but don't block.
    return;
  }
  try {
    await checkUsageOrThrow(tenant, 'claude_spend_cents', 0);
  } catch (err) {
    if (err instanceof UsageCapExceededError) {
      log.warn(`Claude spend cap hit for tenant ${tenant.id} (${err.used}c/${err.cap}c) — skipping call`);
      notifyOwnerCapReached(tenant.id, 'claude_spend_cents', err.used, err.cap);
    }
    throw err;
  }
}

/**
 * Internal: record token usage + estimated spend after a successful call.
 */
async function _recordClaudeUsage(tenant, model, usage, log) {
  if (!tenant || !tenant.id || !usage) return;
  const inTok = Number(usage.input_tokens || 0);
  const outTok = Number(usage.output_tokens || 0);
  const cents = estimateClaudeSpendCents(model, inTok, outTok);
  // Fire-and-forget — usage tracking should never block the response.
  Promise.allSettled([
    incrementUsage(tenant.id, 'claude_input_tokens', inTok),
    incrementUsage(tenant.id, 'claude_output_tokens', outTok),
    incrementUsage(tenant.id, 'claude_spend_cents', cents),
  ]).catch(() => {});
}

/**
 * Internal: build the AI-safety metadata object from caller options.
 * All fields optional — callers that don't pass attribution still work; the
 * call is simply logged as `untracked` in monitor mode (never rejected in
 * Release 1).
 */
function _safetyMeta(options = {}, operationType) {
  const ctx = getAgentContext();
  return {
    tenantId: options.tenant?.id || options.tenantId || ctx.tenantId || null,
    agentName: options.agentName || ctx.agentName || null,
    jobId: options.jobId || null,
    leadId: options.leadId || null,
    campaignId: options.campaignId || null,
    campaignStage: options.campaignStage || null,
    operationType: options.operationType || operationType || null,
    initiatedBy: options.initiatedBy || null,
    isAutomated: options.isAutomated !== false,
    requestSource: options.requestSource || null,
    jobType: options.jobType || options.agentName || null,
  };
}

/**
 * Ask Claude Sonnet and get text response.
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {Object} options
 * @param {Object} [options.tenant] - resolved tenant for spend-cap enforcement
 * @param {string} [options.tenantSlug] - legacy fallback for logging
 */
async function askClaude(systemPrompt, userMessage, options = {}) {
  const { maxTokens = 2048, temperature = 0.7, tenant, tenantSlug } = options;
  const log = createLogger('claude', tenant?.slug || tenantSlug);

  await _enforceClaudeCap(tenant, log);

  try {
    const response = await callClaude({
      model: SONNET_MODEL,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    }, 'askClaude', _safetyMeta(options, 'askClaude'));

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    log.info(`Tokens: ${response.usage?.input_tokens}in/${response.usage?.output_tokens}out`);
    await _recordClaudeUsage(tenant, SONNET_MODEL, response.usage, log);
    return text;
  } catch (error) {
    if (error instanceof UsageCapExceededError) throw error;
    log.error('API call failed', error);
    throw error;
  }
}

/**
 * Ask Claude and parse JSON response with retry logic
 */
async function askClaudeJSON(systemPrompt, userMessage, options = {}) {
  const { maxTokens = 2048, retries = 2 } = options;
  let lastError;
  let currentSystem = systemPrompt;
  let currentUser = userMessage;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = await askClaude(currentSystem, currentUser, {
        // Forward the FULL options so AI-safety attribution (agentName,
        // jobId, leadId, campaign*, etc.) propagates through the JSON wrapper.
        ...options,
        maxTokens,
        temperature: 0,
        operationType: options.operationType || 'askClaudeJSON',
      });

      // Try to extract JSON
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in response');

      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      // Don't retry on cap exceeded — it's not transient
      if (error instanceof UsageCapExceededError) throw error;
      lastError = error;
      if (attempt < retries) {
        currentUser = `${userMessage}\n\nPlease respond with ONLY a valid JSON object, no additional text.`;
        currentSystem = `${systemPrompt}\n\nIMPORTANT: Always respond with valid JSON only.`;
      }
    }
  }

  throw lastError;
}

/**
 * Ask Claude Haiku (faster, cheaper — for classification, simple tasks)
 */
async function claudeHaiku(systemPrompt, userMessage, options = {}) {
  const { tenant, tenantSlug } = options;
  const log = createLogger('claude-haiku', tenant?.slug || tenantSlug);

  await _enforceClaudeCap(tenant, log);

  try {
    const response = await callClaude({
      model: HAIKU_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    }, 'askClaudeHaiku', _safetyMeta(options, 'askClaudeHaiku'));

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    await _recordClaudeUsage(tenant, HAIKU_MODEL, response.usage, log);
    return text;
  } catch (error) {
    if (error instanceof UsageCapExceededError) throw error;
    log.error('Haiku call failed', error);
    throw error;
  }
}

/**
 * Send Claude an image + prompt and parse a JSON response.
 * Used by the Phase 4 receipt-OCR endpoint to extract vendor/amount/date/category
 * from a receipt photo. Vision input is a base64-encoded image string.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt - the text instruction to accompany the image
 * @param {string} imageBase64 - the base64 image data WITHOUT the data: prefix
 * @param {string} mediaType - e.g. 'image/jpeg', 'image/png', 'image/heic'
 * @param {Object} options
 */
async function askClaudeWithImageJSON(systemPrompt, userPrompt, imageBase64, mediaType, options = {}) {
  const { maxTokens = 1024, tenant, tenantSlug } = options;
  const log = createLogger('claude-vision', tenant?.slug || tenantSlug);

  await _enforceClaudeCap(tenant, log);

  try {
    const response = await callClaude({
      model: SONNET_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageBase64 },
          },
          { type: 'text', text: userPrompt },
        ],
      }],
    }, 'askClaudeWithImageJSON', _safetyMeta(options, 'askClaudeWithImageJSON'));

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    await _recordClaudeUsage(tenant, SONNET_MODEL, response.usage, log);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude vision response did not contain a JSON object');
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    if (error instanceof UsageCapExceededError) throw error;
    log.error('Vision call failed', error);
    throw error;
  }
}

module.exports = { askClaude, askClaudeJSON, claudeHaiku, askClaudeWithImageJSON, callClaude };
