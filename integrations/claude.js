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
    const response = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

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
        maxTokens,
        temperature: 0,
        tenant: options.tenant,
        tenantSlug: options.tenantSlug
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
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

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
    const response = await client.messages.create({
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
    });

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

module.exports = { askClaude, askClaudeJSON, claudeHaiku, askClaudeWithImageJSON };
