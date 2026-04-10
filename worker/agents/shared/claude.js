/**
 * Anthropic Claude API Module
 * Provides Claude integration for intelligent analysis and processing
 */

const dotenv = require('dotenv');
dotenv.config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');

// Initialize Anthropic client
const claude = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Track token usage across requests
let totalTokensUsed = {
  input: 0,
  output: 0
};

/**
 * Ask Claude Sonnet a question and get text response
 * @param {string} systemPrompt - System prompt/instructions
 * @param {string} userMessage - User message
 * @param {Object} options - Additional options
 * @param {number} options.maxTokens - Maximum tokens in response (default: 2048)
 * @param {number} options.temperature - Temperature for creativity (default: 0.7)
 * @returns {Promise<string>} Response text
 */
async function askClaude(systemPrompt, userMessage, options = {}) {
  try {
    const { maxTokens = 2048, temperature = 0.7 } = options;

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      temperature: temperature,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userMessage
        }
      ]
    });

    // Track token usage
    if (response.usage) {
      totalTokensUsed.input += response.usage.input_tokens;
      totalTokensUsed.output += response.usage.output_tokens;
    }

    // Extract text from response
    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return text;
  } catch (error) {
    console.error('Error calling Claude:', error.message);
    throw error;
  }
}

/**
 * Ask Claude Sonnet a question expecting JSON response
 * Includes retry logic for malformed JSON
 * @param {string} systemPrompt - System prompt/instructions
 * @param {string} userMessage - User message
 * @param {Object} options - Additional options
 * @param {number} options.maxTokens - Maximum tokens in response (default: 2048)
 * @param {number} options.retries - Number of retries on JSON parse failure (default: 2)
 * @returns {Promise<Object>} Parsed JSON response
 */
async function askClaudeJSON(systemPrompt, userMessage, options = {}) {
  const { maxTokens = 2048, retries = 2 } = options;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = await askClaude(systemPrompt, userMessage, {
        maxTokens,
        temperature: 0 // Deterministic for JSON extraction
      });

      // Try to extract JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON object found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return parsed;
    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        // Retry with a more explicit prompt
        const retryPrompt = `${userMessage}\n\nPlease respond with ONLY a valid JSON object, no additional text.`;
        const updatedSystemPrompt = `${systemPrompt}\n\nIMPORTANT: Always respond with valid JSON only.`;

        // Continue to next iteration
        userMessage = retryPrompt;
        systemPrompt = updatedSystemPrompt;
      }
    }
  }

  console.error('Failed to parse JSON after retries:', lastError.message);
  throw lastError;
}

/**
 * Ask Claude Haiku a question (faster, cheaper)
 * @param {string} systemPrompt - System prompt/instructions
 * @param {string} userMessage - User message
 * @returns {Promise<string>} Response text
 */
async function claudeHaiku(systemPrompt, userMessage) {
  try {
    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userMessage
        }
      ]
    });

    // Track token usage
    if (response.usage) {
      totalTokensUsed.input += response.usage.input_tokens;
      totalTokensUsed.output += response.usage.output_tokens;
    }

    return response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  } catch (error) {
    console.error('Error calling Claude Haiku:', error.message);
    throw error;
  }
}

/**
 * Get current token usage stats
 * @returns {Object} Total tokens used
 */
function getTokenUsage() {
  return {
    ...totalTokensUsed,
    total: totalTokensUsed.input + totalTokensUsed.output
  };
}

/**
 * Reset token usage counter
 */
function resetTokenUsage() {
  totalTokensUsed = {
    input: 0,
    output: 0
  };
}

module.exports = {
  claude,
  askClaude,
  askClaudeJSON,
  claudeHaiku,
  getTokenUsage,
  resetTokenUsage
};
