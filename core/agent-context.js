/**
 * Agent execution context (AsyncLocalStorage).
 *
 * The job processor runs every agent inside a context carrying { agentName,
 * tenantId }. The provider wrappers (integrations/claude.js, gemini.js, sora.js)
 * read this as a FALLBACK when a call site didn't explicitly pass attribution —
 * so AI usage events get tagged with the right agent + tenant without editing
 * every call site, and the Usage & Costs "By Agent" breakdown stops collapsing
 * everything into "Unattributed".
 *
 * Pure attribution only — this does NOT enable spend caps (those still require
 * the full tenant object passed explicitly to askClaude).
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function runWithAgentContext(ctx, fn) {
  return als.run(ctx || {}, fn);
}

function getAgentContext() {
  return als.getStore() || {};
}

module.exports = { runWithAgentContext, getAgentContext };
