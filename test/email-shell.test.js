'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { withUtm, preheaderFromHtml, renderOutreachEmail, renderBrandEmail, TAGLINE } = require('../core/email-shell');

test('withUtm appends params and keeps existing query intact', () => {
  const url = withUtm('https://www.firstgenautomate.com/pricing?promo=FGA-X1', { campaign: 'drip', content: 'day30' });
  assert.ok(url.includes('promo=FGA-X1'));
  assert.ok(url.includes('utm_source=email'));
  assert.ok(url.includes('utm_campaign=drip'));
  assert.ok(url.includes('utm_content=day30'));
});

test('withUtm returns input unchanged on invalid URL', () => {
  assert.strictEqual(withUtm('not-a-url', { campaign: 'x' }), 'not-a-url');
});

test('preheaderFromHtml strips tags and truncates on a word boundary', () => {
  const p = preheaderFromHtml('<p>Hi John, quick note about the calls your business misses while you are on a job site every single day of the week.</p>');
  assert.ok(!p.includes('<'));
  assert.ok(p.length <= 113);
});

test('outreach shell: centered logo heading, body, single CTA, tagline, unsubscribe', () => {
  const html = renderOutreachEmail({
    bodyHtml: '<p>Hi John.</p>',
    cta: { label: 'See how it works', url: 'https://www.firstgenautomate.com/how-it-works' },
    unsubscribeUrl: 'https://api.example.com/api/drip/unsubscribe?x=1',
  });
  assert.ok(html.includes('<p>Hi John.</p>'));
  assert.ok(html.includes('See how it works'));
  assert.ok(html.includes(TAGLINE));
  assert.ok(html.includes('/api/drip/unsubscribe'));
  // One compact brand image is the complete visual header. Body and CTA stay
  // image-free so the outreach message remains restrained and readable.
  assert.strictEqual((html.match(/<img/gi) || []).length, 1);
  assert.ok(html.includes('src="https://www.firstgenautomate.com/icon-192.png"'));
  assert.ok(html.includes('alt="First Gen Automate"'));
  assert.ok(/<td align="center"[^>]*>[\s\S]*icon-192[.]png/.test(html));
  assert.ok(html.includes('text-transform:uppercase'));
  // No em dashes anywhere in shell chrome (brand rule).
  assert.ok(!html.includes('—') && !html.includes('–'));
});

test('outreach shell: offer card renders code + expiry', () => {
  const html = renderOutreachEmail({
    bodyHtml: '<p>Offer</p>',
    offer: { code: 'FGA-ABC123', expires: 'September 1, 2026' },
    cta: { label: 'Claim your free month', url: 'https://www.firstgenautomate.com/pricing?promo=FGA-ABC123' },
  });
  assert.ok(html.includes('FGA-ABC123'));
  assert.ok(html.includes('September 1, 2026'));
});

test('outreach shell omits unsubscribe block when no URL given', () => {
  const html = renderOutreachEmail({ bodyHtml: '<p>x</p>' });
  assert.ok(!html.includes('Unsubscribe'));
});

test('brand shell: logo, hero, image, CTA, tagline', () => {
  const html = renderBrandEmail({
    heroTitle: 'Your system is being deployed',
    heroSub: 'Here is what happens next.',
    bodyHtml: '<p>Welcome aboard.</p>',
    imageUrl: 'https://www.firstgenautomate.com/og-image.png',
    cta: { label: 'Open your Command Center', url: 'https://www.firstgenautomate.com/portal' },
  });
  assert.ok(html.includes('icon-192.png'));
  assert.ok(html.includes('Your system is being deployed'));
  assert.ok(html.includes('og-image.png'));
  assert.ok(html.includes('Open your Command Center'));
  assert.ok(html.includes(TAGLINE));
});

test('shells escape hero/CTA text but pass bodyHtml through', () => {
  const html = renderBrandEmail({ heroTitle: 'A <b>bold</b> claim', bodyHtml: '<p><strong>kept</strong></p>' });
  assert.ok(html.includes('A &lt;b&gt;bold&lt;/b&gt; claim'));
  assert.ok(html.includes('<strong>kept</strong>'));
});
