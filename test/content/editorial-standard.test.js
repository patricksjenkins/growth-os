'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  EDITORIAL_VERSION,
  FGA_EDITORIAL_STANDARD,
  validateDraftCopy,
  validateCaptionCopy,
  buildEditorialReviewPrompt,
} = require('../../core/content/editorial-standard');

const format = {
  name: 'The Three-Beat',
  slideCount: 3,
  slides: [{ role: 'hook' }, { role: 'insight' }, { role: 'cta' }],
};

function cleanDraft() {
  return {
    caption: 'A missed call needs a clear handoff. FGA captures the request and keeps the follow-up visible for the owner.',
    hashtags: ['servicebusiness'],
    slides: [
      { role: 'hook', headline: 'The call reached voicemail', body: '', subtext: '', bullets: [] },
      { role: 'insight', headline: 'Capture the request', body: 'The caller shares the job details before your team follows up.', subtext: '', bullets: [] },
      { role: 'cta', headline: 'See the whole handoff', body: 'One place for calls and follow-up.', subtext: '', bullets: [] },
    ],
  };
}

test('editorial standard accepts concise progressive carousel copy', () => {
  const review = validateDraftCopy(cleanDraft(), { formatTemplate: format });
  assert.strictEqual(review.ok, true, review.violations.join(', '));
  assert.strictEqual(review.version, EDITORIAL_VERSION);
});

test('editorial standard rejects paragraph slides from the reported output', () => {
  const draft = cleanDraft();
  draft.slides[1].body = 'Monday you sent the follow-up. Thursday you had three jobs stack up and it never happened. That is not a discipline problem, it is a structure problem. Here is what a consistent sequence looks like for every lead regardless of how your week went.';
  const review = validateDraftCopy(draft, { formatTemplate: format });
  assert.strictEqual(review.ok, false);
  assert.ok(review.violations.includes('slide_2:body_over_16_words'));
  assert.ok(review.violations.includes('slide_2:on_image_copy_over_30_words'));
});

test('editorial standard rejects keyword engagement bait and fake founder attribution', () => {
  const draft = cleanDraft();
  draft.slides[2].body = 'As Patrick at First Gen Automate puts it, consistency wins.';
  draft.caption += ' DM me CONSISTENT and I will show you the setup.';
  const review = validateDraftCopy(draft, { formatTemplate: format });
  assert.ok(review.violations.includes('engagement_bait'));
  assert.ok(review.violations.includes('unapproved_founder_attribution'));
});

test('editorial standard rejects formulaic title-case slogans', () => {
  const draft = cleanDraft();
  draft.slides[1].headline = 'Your Day Changed. The Sequence Did Not.';
  const review = validateDraftCopy(draft, { formatTemplate: format });
  assert.ok(review.violations.includes('slide_2:title_case_headline'));
  assert.ok(review.violations.includes('formulaic_marketing_copy'));
});

test('editorial standard rejects a polished version of the same weekday gimmick', () => {
  const draft = cleanDraft();
  draft.caption = 'A busy week is the exact moment follow-up breaks down. Same timing, every lead, no manual tracking required.';
  draft.slides[0].headline = "Monday's follow-up went out.";
  draft.slides[1].headline = "Thursday's didn't.";
  draft.slides[2].headline = 'See the setup at firstgenautomate.com';
  const review = validateDraftCopy(draft, { formatTemplate: format });
  assert.ok(review.violations.includes('formulaic_marketing_copy'));
  assert.ok(review.violations.includes('slide_3:website_on_image'));
});

test('editorial review prompt requests a rewrite with the same shape', () => {
  const prompt = buildEditorialReviewPrompt(cleanDraft(), {
    formatTemplate: format,
    initialViolations: ['engagement_bait'],
  });
  assert.ok(prompt.includes(FGA_EDITORIAL_STANDARD));
  assert.ok(prompt.includes('engagement_bait'));
  assert.ok(prompt.includes('Return the SAME JSON shape'));
});

test('caption gate prevents distribution from reintroducing keyword bait', () => {
  assert.strictEqual(validateCaptionCopy('The request enters one visible queue.').ok, true);
  const review = validateCaptionCopy('DM me VOICE and I will send the setup.');
  assert.strictEqual(review.ok, false);
  assert.ok(review.violations.includes('engagement_bait'));
});

test('editorial standard scans renderer visual_data, not only headline fields', () => {
  const draft = cleanDraft();
  draft.slides[1].visual_data = {
    kicker: 'AUTOMATED SEQUENCE',
    steps: ['Lead comes in', 'Text goes out', 'This visual step contains far too many words to render cleanly'],
  };
  draft.slides[2].visual_data = { steps: ['DM me CONSISTENT'] };
  const review = validateDraftCopy(draft, { formatTemplate: format });
  assert.ok(review.violations.includes('slide_2:visual_step_over_6_words'));
  assert.ok(review.violations.includes('engagement_bait'));
});
