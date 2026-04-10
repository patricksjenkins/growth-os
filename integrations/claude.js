/**
 * Growth OS — Claude AI Integration
 * Ported from WellMor agents/shared/claude.js
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { createLogger } = require('../core/logger');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Ask Claude Sonnet and get text response
 */
async function askClaude(systemPrompt, userMessage, options = {}) {
  const { maxTokens = 2048, temperature = 0.7 } = options;
  const log = createLogger('claude', options.tenantSlug);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
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
    return text;
  } catch (error) {
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
        tenantSlug: options.tenantSlug
      });

      // Try to extract JSON
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in response');

      return JSON.parse(jsonMatch[0]);
    } catch (error) {
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
  const log = createLogger('claude-haiku', options.tenantSlug);

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

    return response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  } catch (error) {
    log.error('Haiku call failed', error);
    throw error;
  }
}

module.exports = { askClaude, askClaudeJSON, claudeHaiku };
