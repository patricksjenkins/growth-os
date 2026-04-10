/**
 * OpenAI API Module
 * Provides GPT integration for analysis and processing
 */

const OpenAI = require('openai');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Ask GPT-4o a question and get text response
 * @param {string} systemPrompt - System prompt/instructions
 * @param {string} userMessage - User message
 * @param {Object} options - Additional options
 * @param {number} options.maxTokens - Maximum tokens in response (default: 2048)
 * @param {number} options.temperature - Temperature for creativity (default: 0.7)
 * @returns {Promise<string>} Response text
 */
async function askGPT(systemPrompt, userMessage, options = {}) {
  try {
    const { maxTokens = 2048, temperature = 0.7 } = options;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: maxTokens,
      temperature: temperature,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: userMessage
        }
      ]
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error calling GPT-4o:', error.message);
    throw error;
  }
}

/**
 * Ask GPT-4o a question expecting JSON response
 * Uses response_format json_object for guaranteed JSON
 * @param {string} systemPrompt - System prompt/instructions
 * @param {string} userMessage - User message
 * @param {Object} options - Additional options
 * @param {number} options.maxTokens - Maximum tokens in response (default: 2048)
 * @returns {Promise<Object>} Parsed JSON response
 */
async function askGPTJSON(systemPrompt, userMessage, options = {}) {
  try {
    const { maxTokens = 2048 } = options;

    // Ensure system prompt mentions JSON requirement
    const enhancedSystemPrompt = `${systemPrompt}\n\nYou must respond with a valid JSON object only.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: maxTokens,
      temperature: 0, // Deterministic for JSON
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: enhancedSystemPrompt
        },
        {
          role: 'user',
          content: userMessage
        }
      ]
    });

    const content = response.choices[0].message.content;
    return JSON.parse(content);
  } catch (error) {
    console.error('Error calling GPT-4o with JSON format:', error.message);
    throw error;
  }
}

/**
 * Ask GPT-4o mini a question (faster, cheaper)
 * @param {string} systemPrompt - System prompt/instructions
 * @param {string} userMessage - User message
 * @returns {Promise<string>} Response text
 */
async function askGPTMini(systemPrompt, userMessage) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 1024,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: userMessage
        }
      ]
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error calling GPT-4o mini:', error.message);
    throw error;
  }
}

module.exports = {
  openai,
  askGPT,
  askGPTJSON,
  askGPTMini
};
