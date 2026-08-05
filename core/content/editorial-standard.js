'use strict';

/**
 * FGA social editorial standard.
 *
 * This module is deliberately model-independent. The writer and editor can
 * change over time; weak copy must still be stopped before image generation.
 */

const EDITORIAL_VERSION = 'fga-editorial-v1';

const FGA_EDITORIAL_STANDARD = `
FGA EDITORIAL STANDARD (${EDITORIAL_VERSION}):
- Make one useful point per post. Do not stretch one sentence across a carousel.
- Slides are designed objects, not documents. No paragraph belongs on an image.
- Headlines use sentence case, 3-8 words, and no more than 64 characters.
- A non-hook slide may use one supporting sentence of 16 words or fewer.
- Photo and carousel hook slides have no body copy. A single-card stat or founder note may use one short supporting line. CTA slides use 10 supporting words or fewer.
- Prefer a labeled workflow, comparison, call screen, lead card, or concrete scene over explanatory prose.
- A carousel must progress: scene/problem -> mechanism -> result or next step. Each slide must add new information.
- Never manufacture a Patrick quote, founder anecdote, customer result, testimonial, statistic, timeframe, or product capability.
- An approved founder perspective may inform the point of view. Do not attribute generated wording to Patrick.
- A CTA is optional. Never ask people to comment or DM a keyword. Never use engagement bait.
- "Link in bio" is not a useful ending. A slide whose role is CTA may instead be a practical conclusion with no action request.
- Do not repeat the website in body copy when the design already carries the website.
- The caption adds context that is not on the slides. It does not transcribe the carousel.
- Write like an experienced operator: restrained, specific, useful, and comfortable leaving space.
- Reject marketing formulas and symmetrical slogans such as "Your day changed. The sequence didn't," "Every lead. Every week," and "This isn't an X problem. It's a Y problem."
`.trim();

const ENGAGEMENT_BAIT = [
  /\b(?:dm|message)\s+(?:me\s+)?["'“”]?[a-z0-9_-]+["'“”]?\b/i,
  /\bcomment\s+(?:the\s+word\s+)?["'“”]?[a-z0-9_-]+["'“”]?\b/i,
  /\btype\s+["'“”]?[a-z0-9_-]+["'“”]?\s+(?:below|in the comments)\b/i,
  /\blink in (?:the )?bio\b/i,
];

const FAKE_ATTRIBUTION = [
  /\bas patrick\b/i,
  /\bpatrick\s+(?:says|said|puts it|believes|thinks)\b/i,
  /(?:^|\n)\s*[-—]\s*patrick\b/i,
  /\bpatrick at first gen automate\b/i,
];

const FORMULAIC_COPY = [
  /\byour day changed\b/i,
  /\bsame (?:sequence|timing|system|process)[,.]?\s+every\b/i,
  /\bevery [a-z]+[.!]\s+every [a-z]+\b/i,
  /\bthis (?:is not|isn't) (?:an? )?[^.!?]{1,35} problem[.!]\s+it(?:'s| is) (?:an? )?[^.!?]{1,35} problem\b/i,
  /\bhere(?:'s| is) what .{0,45} looks like\b/i,
  /\bkeep (?:it|your business) running\b/i,
  /\bfollow-?up that never happened\b/i,
  /\b(?:isn't|aren't|is not|are not) (?:an? )?[^.!?]{1,35} problem\b/i,
  /\bfollow-?up.{0,30}\b(?:monday|tuesday|wednesday|thursday|friday)\b.{0,80}\b(?:didn't|did not|went out)\b/i,
  /\b(?:monday|tuesday|wednesday|thursday|friday)(?:'s)?\b.{0,45}\bfollow-?up\b.{0,100}\b(?:monday|tuesday|wednesday|thursday|friday)(?:'s)?\b.{0,25}\b(?:didn't|did not)\b/i,
  /\bno manual (?:tracking|work|follow-?up|required|needed)\b/i,
];

function words(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function nestedStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(nestedStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(nestedStrings);
  return [];
}

function allDraftText(draft) {
  const parts = [draft?.caption, draft?.post_theme, draft?.headline];
  for (const slide of (draft?.slides || [])) {
    parts.push(slide.headline, slide.subtext, slide.body);
    if (Array.isArray(slide.bullets)) parts.push(slide.bullets.join(' '));
    parts.push(...nestedStrings(slide.visual_data));
  }
  return parts.map(cleanText).filter(Boolean).join('\n');
}

function titleCaseRatio(value) {
  const significant = words(value).filter((word) => /[a-z]/i.test(word));
  if (significant.length < 5) return 0;
  const titled = significant.filter((word) => /^[A-Z][a-z]/.test(word)).length;
  return titled / significant.length;
}

function tokenSet(value) {
  return new Set(cleanText(value).toLowerCase().match(/[a-z]{3,}/g) || []);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Validate final on-image copy. Returns every reason instead of one opaque score. */
function validateDraftCopy(draft, { formatTemplate } = {}) {
  const violations = [];
  const slides = Array.isArray(draft?.slides) ? draft.slides : [];
  const expected = Number(formatTemplate?.slideCount);

  if (!slides.length) violations.push('missing_slides');
  if (Number.isFinite(expected) && slides.length !== expected) {
    violations.push(`slide_count:${slides.length}/${expected}`);
  }

  slides.forEach((slide, index) => {
    const number = index + 1;
    const templateSlide = formatTemplate?.slides?.[index] || {};
    const role = String(slide.role || templateSlide.role || '').toLowerCase();
    const headline = cleanText(slide.headline);
    const body = cleanText(slide.body);
    const subtext = cleanText(slide.subtext);
    const headlineWords = words(headline).length;
    const bodyWords = words(body).length;
    const subtextWords = words(subtext).length;
    const bulletWords = (slide.bullets || []).reduce((sum, item) => sum + words(item).length, 0);
    const visualWords = nestedStrings(slide.visual_data).reduce((sum, item) => sum + words(item).length, 0);
    const totalWords = headlineWords + bodyWords + subtextWords + bulletWords + visualWords;

    if (!headline) violations.push(`slide_${number}:missing_headline`);
    if (headlineWords > 10 || headline.length > 72) violations.push(`slide_${number}:headline_too_long`);
    if (titleCaseRatio(headline) >= 0.7) violations.push(`slide_${number}:title_case_headline`);
    const hookIsHeadlineOnly = role === 'hook'
      && templateSlide?.textLayout?.body == null
      && templateSlide?.textLayout?.subtitle == null;
    if (hookIsHeadlineOnly && (bodyWords || subtextWords)) violations.push(`slide_${number}:hook_has_body`);
    if (bodyWords > 16) violations.push(`slide_${number}:body_over_16_words`);
    if (subtextWords > 12) violations.push(`slide_${number}:subtext_over_12_words`);
    if (role === 'cta' && bodyWords + subtextWords > 10) violations.push(`slide_${number}:cta_copy_over_10_words`);
    if (totalWords > 30) violations.push(`slide_${number}:on_image_copy_over_30_words`);
    if ((slide.bullets || []).length > 4) violations.push(`slide_${number}:too_many_bullets`);
    if ((slide.bullets || []).some((item) => words(item).length > 6)) violations.push(`slide_${number}:bullet_over_6_words`);
    const visualSteps = Array.isArray(slide.visual_data?.steps) ? slide.visual_data.steps : [];
    if (visualSteps.length > 4) violations.push(`slide_${number}:too_many_visual_steps`);
    if (visualSteps.some((item) => words(item).length > 6)) violations.push(`slide_${number}:visual_step_over_6_words`);
    if (/#\w+/.test([headline, body, subtext].join(' '))) violations.push(`slide_${number}:hashtag_on_image`);
    if (/\b(?:https?:\/\/|www\.|firstgenautomate\.com)\b/i.test([headline, body, subtext].join(' '))) violations.push(`slide_${number}:website_on_image`);
  });

  const fullText = allDraftText(draft);
  if (ENGAGEMENT_BAIT.some((pattern) => pattern.test(fullText))) violations.push('engagement_bait');
  if (FAKE_ATTRIBUTION.some((pattern) => pattern.test(fullText))) violations.push('unapproved_founder_attribution');
  if (FORMULAIC_COPY.some((pattern) => pattern.test(fullText))) violations.push('formulaic_marketing_copy');

  for (let i = 0; i < slides.length; i += 1) {
    for (let j = i + 1; j < slides.length; j += 1) {
      const a = tokenSet(`${slides[i].headline || ''} ${slides[i].body || ''}`);
      const b = tokenSet(`${slides[j].headline || ''} ${slides[j].body || ''}`);
      if (a.size >= 4 && b.size >= 4 && jaccard(a, b) >= 0.6) {
        violations.push(`slides_${i + 1}_${j + 1}:repetitive_copy`);
      }
    }
  }

  return {
    ok: violations.length === 0,
    version: EDITORIAL_VERSION,
    violations: [...new Set(violations)],
    metrics: {
      slide_count: slides.length,
      total_on_image_words: slides.reduce((sum, slide) => sum
        + words(slide.headline).length + words(slide.body).length
        + words(slide.subtext).length
        + (slide.bullets || []).reduce((n, item) => n + words(item).length, 0)
        + nestedStrings(slide.visual_data).reduce((n, item) => n + words(item).length, 0), 0),
      caption_words: words(draft?.caption).length,
    },
  };
}

function validateCaptionCopy(caption, { maxWords = 220 } = {}) {
  const text = cleanText(caption);
  const violations = [];
  if (!text) violations.push('empty_caption');
  if (words(text).length > maxWords) violations.push(`caption_over_${maxWords}_words`);
  if (ENGAGEMENT_BAIT.some((pattern) => pattern.test(text))) violations.push('engagement_bait');
  if (FAKE_ATTRIBUTION.some((pattern) => pattern.test(text))) violations.push('unapproved_founder_attribution');
  if (FORMULAIC_COPY.some((pattern) => pattern.test(text))) violations.push('formulaic_marketing_copy');
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

function buildEditorialReviewPrompt(draft, { formatTemplate, concept, sourceBrief, initialViolations = [] } = {}) {
  const roles = (formatTemplate?.slides || []).map((slide, index) => `${index + 1}:${slide.role}`).join(', ');
  return `Rewrite this draft into publishable Instagram/Facebook copy. Return the SAME JSON shape, including all slide_number and role fields. Return finished copy, not notes.

FORMAT: ${formatTemplate?.name || 'social post'}
SLIDE ROLES: ${roles || 'preserve the supplied roles'}
APPROVED CONCEPT: ${concept ? JSON.stringify({
    objective: concept.objective,
    audience_problem: concept.audience_problem,
    fga_pov: concept.fga_pov,
    angle: concept.angle,
    evidence_kind: concept.evidence_kind,
    evidence_ref: concept.evidence_ref,
  }) : 'none'}
SOURCE BRIEF / OWNER DIRECTION: ${sourceBrief || 'none'}
FIRST-PASS VIOLATIONS: ${initialViolations.length ? initialViolations.join(', ') : 'none detected; perform a taste and clarity edit anyway'}

${FGA_EDITORIAL_STANDARD}

EDITOR'S JOB:
1. Choose the single strongest useful point. Delete anything that merely repeats it. If the draft's core angle is a generic calendar vignette or productivity slogan, replace it with the verified workflow mechanism instead of polishing the gimmick.
2. Make each carousel slide perform a different job and add new information.
3. Move explanation off the image and into a concise caption when needed.
4. Keep only claims supported by the supplied concept/evidence. Never create a quote.
5. Preserve structured visual_data, but make its labels specific and concise.
6. Keep hashtags as a separate array with 0-4 plain strings.
7. Add "editorial_review": { "version": "${EDITORIAL_VERSION}", "approved": true, "summary": "short description of the edit" }.
8. A slide labeled role="cta" does not require a CTA. When there is no natural next step, make it a useful conclusion and leave body/subtext empty. Never write "link in bio."

GOOD CAROUSEL ARCHITECTURE: slide 1 names a concrete operating problem; slide 2 SHOWS the actual handoff as short labeled steps; slide 3 states the practical implication or ends cleanly. Do not make three slogan slides about the same point.

DRAFT JSON:
${JSON.stringify(draft, null, 2)}`;
}

module.exports = {
  EDITORIAL_VERSION,
  FGA_EDITORIAL_STANDARD,
  validateDraftCopy,
  validateCaptionCopy,
  buildEditorialReviewPrompt,
};
