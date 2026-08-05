'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeScore } = require('../../core/content/visual-scorer');

test('visual scorer caps a branded quote card that is still only words', () => {
  const score = normalizeScore({
    overall: 4,
    categories: { explains_idea: 4, more_than_words: 2, shows_pain_product_outcome: 2 },
  });
  assert.strictEqual(score, 2);
});

test('visual scorer preserves a strong product-led visual', () => {
  const score = normalizeScore({
    overall: 5,
    categories: { explains_idea: 5, more_than_words: 5, shows_pain_product_outcome: 5 },
  });
  assert.strictEqual(score, 5);
});

test('visual scorer caps clipped or overcrowded output', () => {
  assert.strictEqual(normalizeScore({ overall: 5, categories: {}, clipping: true }), 2);
  assert.strictEqual(normalizeScore({ overall: 4, categories: {}, overcrowded: true }), 2);
});
