/**
 * First Gen Automate — email shells
 *
 * Two render tiers, chosen by audience temperature:
 *
 *  1. renderOutreachEmail() — the DESIGNED HYBRID for cold/warm prospects
 *     (initial outreach + every drip touch). Mostly text on white so it lands
 *     in the Primary tab from a young domain: a text wordmark header (no
 *     images at all), the personal prose body, ONE pure-CSS button CTA that
 *     opens the site, an optional offer card for coupon touches, and a footer
 *     that closes with the brand tagline + unsubscribe. The email's job is to
 *     get the click; the landing page does the visual selling.
 *
 *  2. renderBrandEmail() — the FULL VISUAL shell for customers and warm
 *     signups (lifecycle emails): logo, navy hero, optional product image,
 *     big CTA. Zero deliverability concern there.
 *
 * Brand rules baked in: exact tagline closing line, no em dashes, "deployed"
 * not "installed", nothing here overpromises (shells add no product claims).
 */

const SITE = 'https://www.firstgenautomate.com';
const NAVY = '#132A4A';
const GREEN = '#22C55E';
const GREEN_DARK = '#16A34A';
const INK2 = '#334155';
const MUTED = '#64748b';
const FAINT = '#94a3b8';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TAGLINE = 'Automate the Overhead, Focus on the Work.';

/** Append UTM parameters to a URL (keeps existing query params intact). */
function withUtm(url, { source = 'email', medium = 'email', campaign, content } = {}) {
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', source);
    u.searchParams.set('utm_medium', medium);
    if (campaign) u.searchParams.set('utm_campaign', campaign);
    if (content) u.searchParams.set('utm_content', content);
    return u.toString();
  } catch {
    return url;
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Hidden preview line shown next to the subject in the inbox list. */
function preheaderHtml(text) {
  if (!text) return '';
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(text)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`;
}

/** Derive a preheader from body HTML (first ~110 chars of visible text). */
function preheaderFromHtml(html, max = 110) {
  const text = String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}...` : text;
}

/** One pure-CSS button (no images, renders as a padded link in old Outlook). */
function buttonHtml({ label, url }, { size = 'md' } = {}) {
  const pad = size === 'lg' ? '14px 32px' : '12px 26px';
  const fs = size === 'lg' ? 16 : 15;
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px auto 6px;">
      <tr><td align="center" bgcolor="${GREEN_DARK}" style="border-radius:8px;">
        <a href="${url}" target="_blank"
           style="display:inline-block;padding:${pad};font-family:${FONT};font-size:${fs}px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;background-color:${GREEN_DARK};">
          ${escapeHtml(label)}
        </a>
      </td></tr>
    </table>`;
}

/** Dashed offer card for coupon touches: the code stays visible as a fallback. */
function offerCardHtml({ code, expires, headline }) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 4px;">
      <tr><td style="border:2px dashed ${GREEN};border-radius:10px;background-color:#f0fdf4;padding:18px 20px;text-align:center;">
        <div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${GREEN_DARK};">${escapeHtml(headline || 'Your first month free')}</div>
        <div style="font-family:${FONT};font-size:24px;font-weight:800;letter-spacing:1px;color:${NAVY};margin-top:6px;">${escapeHtml(code)}</div>
        ${expires ? `<div style="font-family:${FONT};font-size:12px;color:${MUTED};margin-top:6px;">Code expires ${escapeHtml(expires)}</div>` : ''}
      </td></tr>
    </table>`;
}

/**
 * Designed hybrid shell for outreach + drip. Text wordmark, prose body,
 * one button, optional offer card, tagline footer, unsubscribe when given.
 * `postalAddress` prints in the footer (CAN-SPAM for cold/bulk sends).
 */
function renderOutreachEmail({ bodyHtml, cta, offer, unsubscribeUrl, postalAddress, preheader } = {}) {
  const pre = preheader || preheaderFromHtml(bodyHtml);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f4f5f7;">
${preheaderHtml(pre)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f5f7;">
<tr><td align="center" style="padding:28px 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
    <tr><td style="padding:0 6px 14px;">
      <span style="font-family:${FONT};font-size:15px;font-weight:800;letter-spacing:0.3px;color:${NAVY};">First Gen Automate</span>
      <span style="display:inline-block;width:7px;height:7px;border-radius:2px;background-color:${GREEN};margin-left:6px;"></span>
    </td></tr>
    <tr><td style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:30px 32px;">
      <div style="font-family:${FONT};font-size:15px;line-height:1.65;color:${INK2};">
        ${bodyHtml || ''}
      </div>
      ${offer ? offerCardHtml(offer) : ''}
      ${cta ? buttonHtml(cta) : ''}
    </td></tr>
    <tr><td style="padding:18px 6px 0;text-align:center;">
      <div style="font-family:${FONT};font-size:12px;font-weight:600;color:${MUTED};">${TAGLINE}</div>
      <div style="font-family:${FONT};font-size:11px;color:${FAINT};margin-top:8px;">
        First Gen Automate LLC &middot; <a href="${SITE}" style="color:${FAINT};">firstgenautomate.com</a>
        ${postalAddress ? `<br>${escapeHtml(postalAddress)}` : ''}
        ${unsubscribeUrl ? `<br><a href="${unsubscribeUrl}" style="color:${FAINT};">Unsubscribe</a> and I'll stop immediately.` : ''}
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/**
 * Full visual shell for customers/warm signups: logo, navy hero, optional
 * product image, big CTA, tagline footer.
 */
function renderBrandEmail({ heroTitle, heroSub, bodyHtml, cta, imageUrl, imageAlt, preheader, footerNote } = {}) {
  const pre = preheader || heroSub || preheaderFromHtml(bodyHtml);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f4f5f7;">
${preheaderHtml(pre)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f5f7;">
<tr><td align="center" style="padding:28px 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
    <tr><td style="background-color:${NAVY};border-radius:14px 14px 0 0;padding:30px 36px 26px;text-align:center;">
      <img src="${SITE}/icon-192.png" width="44" height="44" alt="First Gen Automate" style="border-radius:10px;display:inline-block;">
      <div style="font-family:${FONT};font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${GREEN};margin-top:14px;">First Gen Automate</div>
      ${heroTitle ? `<div style="font-family:${FONT};font-size:26px;line-height:1.25;font-weight:800;color:#ffffff;margin-top:10px;">${escapeHtml(heroTitle)}</div>` : ''}
      ${heroSub ? `<div style="font-family:${FONT};font-size:15px;line-height:1.5;color:#cbd5e1;margin-top:10px;">${escapeHtml(heroSub)}</div>` : ''}
    </td></tr>
    <tr><td style="background-color:#ffffff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:32px 36px;">
      ${imageUrl ? `<img src="${imageUrl}" width="528" alt="${escapeHtml(imageAlt || 'First Gen Automate')}" style="width:100%;max-width:528px;border-radius:10px;border:1px solid #e2e8f0;margin:0 0 22px;">` : ''}
      <div style="font-family:${FONT};font-size:15px;line-height:1.65;color:${INK2};">
        ${bodyHtml || ''}
      </div>
      ${cta ? buttonHtml(cta, { size: 'lg' }) : ''}
    </td></tr>
    <tr><td style="padding:18px 6px 0;text-align:center;">
      <div style="font-family:${FONT};font-size:12px;font-weight:600;color:${MUTED};">${TAGLINE}</div>
      <div style="font-family:${FONT};font-size:11px;color:${FAINT};margin-top:8px;">
        First Gen Automate LLC &middot; <a href="${SITE}" style="color:${FAINT};">firstgenautomate.com</a>
        ${footerNote ? `<br>${footerNote}` : ''}
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

module.exports = {
  SITE,
  TAGLINE,
  withUtm,
  preheaderFromHtml,
  renderOutreachEmail,
  renderBrandEmail,
};
