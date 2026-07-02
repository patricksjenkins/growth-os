const { test } = require('node:test');
const assert = require('node:assert');
const { stripAiTells, stripAiTellsFields, NO_DASH_PROMPT_RULE } = require('../core/text-style');

test('em dash used as a break becomes a comma', () => {
  assert.strictEqual(
    stripAiTells('We text every lead back — even on a job.'),
    'We text every lead back, even on a job.',
  );
});

test('em dash with no surrounding spaces becomes a comma', () => {
  assert.strictEqual(stripAiTells('Everything included—one price.'), 'Everything included, one price.');
});

test('number ranges keep a plain hyphen', () => {
  assert.strictEqual(stripAiTells('Live in 5 – 7 days, 1–10 people.'), 'Live in 5-7 days, 1-10 people.');
});

test('curly quotes become straight quotes', () => {
  assert.strictEqual(stripAiTells('It said “serious” and it’s true.'), 'It said "serious" and it\'s true.');
});

test('ellipsis character becomes three periods', () => {
  assert.strictEqual(stripAiTells('Well…'), 'Well...');
});

test('a leading break-dash bullet does not leave a stray comma', () => {
  assert.strictEqual(stripAiTells('— A point'), 'A point');
});

test('clean text is unchanged', () => {
  const s = 'No dashes here. Just commas, periods: and hyphens like follow-up.';
  assert.strictEqual(stripAiTells(s), s);
});

test('non-strings pass through untouched', () => {
  assert.strictEqual(stripAiTells(null), null);
  assert.strictEqual(stripAiTells(undefined), undefined);
  assert.strictEqual(stripAiTells(42), 42);
});

test('output never contains an em or en dash', () => {
  const inputs = ['a — b', 'c—d', 'e – f', 'ranges 2–4', 'plain text'];
  for (const i of inputs) assert.ok(!/[–—]/.test(stripAiTells(i)), `dash left in ${JSON.stringify(i)}`);
});

test('stripAiTellsFields only touches string copy fields', () => {
  const out = stripAiTellsFields({ subject: 'Hi — there', body: 'x—y', id: 7, meta: { a: 1 } });
  assert.strictEqual(out.subject, 'Hi, there');
  assert.strictEqual(out.body, 'x, y');
  assert.strictEqual(out.id, 7);
  assert.deepStrictEqual(out.meta, { a: 1 });
});

test('NO_DASH_PROMPT_RULE mentions em dashes', () => {
  assert.ok(/em dash/i.test(NO_DASH_PROMPT_RULE));
});
