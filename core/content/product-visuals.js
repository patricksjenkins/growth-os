/**
 * Product-visual renderers — polished, stylized FGA product-UI mockups built as
 * pure SVG (rasterized by Sharp in image-generation.js). These are the visuals
 * that SHOW the system working instead of putting words on a card:
 *   - call_screen       : an incoming call → AI Voice Receptionist answering
 *   - lead_card         : a captured lead (name / service / urgency / sent)
 *   - command_center    : a stylized Command Center dashboard card
 *   - workflow_diagram  : call → AI answers → captured → owner notified → CC
 *
 * Stylized (not real screenshots), so they never expose customer data and are
 * honest "illustrative UI." Everything is laid out INSIDE the safe area by
 * construction, and each renderer returns its content bounding box so the
 * safe-area validator can confirm it.
 *
 * Each renderer: (width, height, brand, data) → { svg, boxes }.
 */

const { FGA_BRAND } = require('../brand');
const safeArea = require('./safe-area');

const FONT = FGA_BRAND.fonts.uiStack;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function rrect(x, y, w, h, r, fill, extra = '') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${fill}" ${extra}/>`;
}
function text(x, y, s, { size = 32, weight = 600, fill = '#fff', anchor = 'start', spacing = 0 } = {}) {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-weight="${weight}" font-size="${size}" fill="${fill}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(s)}</text>`;
}
function bg(width, height, fill) {
  return `<rect x="0" y="0" width="${width}" height="${height}" fill="${fill}"/>`;
}

// The content rectangle every renderer stays within (preferred safe margins).
function contentRect(width, height) {
  const cv = (width === 1080 && height === 1080) ? safeArea.getCanvas('ig_square')
    : (width === 1200) ? safeArea.getCanvas('fb_feed')
      : safeArea.getCanvas('ig_portrait');
  const sb = safeArea.safeBox(cv, true);
  return { x: sb.left, y: sb.top, w: sb.right - sb.left, h: sb.bottom - sb.top };
}

const C = FGA_BRAND.colors;

function callScreen(width, height, brand, data = {}) {
  const r = contentRect(width, height);
  const cx = width / 2;
  const els = [bg(width, height, C.midnight)];
  // Card
  const cardY = r.y + r.h * 0.06, cardH = r.h * 0.82;
  els.push(rrect(r.x, cardY, r.w, cardH, 36, '#0E2038', 'stroke="#1E3A5F" stroke-width="2"'));
  els.push(text(cx, cardY + 70, 'INCOMING CALL', { size: 26, weight: 700, fill: C.signalGreen, anchor: 'middle', spacing: 4 }));
  // Avatar circle + phone glyph
  const avY = cardY + cardH * 0.30;
  els.push(`<circle cx="${cx}" cy="${avY}" r="${Math.floor(width * 0.10)}" fill="#13294B" stroke="${C.signalGreen}" stroke-width="3"/>`);
  els.push(text(cx, avY + 18, '☎', { size: Math.floor(width * 0.10), weight: 400, fill: '#fff', anchor: 'middle' }));
  els.push(text(cx, avY + cardH * 0.20, esc(data.caller || 'New caller'), { size: 44, weight: 700, fill: '#fff', anchor: 'middle' }));
  els.push(text(cx, avY + cardH * 0.20 + 48, esc(data.number || '(404) 555-0142'), { size: 30, weight: 500, fill: '#9FB3C8', anchor: 'middle' }));
  // Answering status
  const statY = cardY + cardH * 0.74;
  els.push(`<circle cx="${r.x + r.w * 0.18}" cy="${statY - 10}" r="9" fill="${C.signalGreen}"/>`);
  els.push(text(r.x + r.w * 0.18 + 22, statY, 'AI Voice Receptionist answering…', { size: 28, weight: 600, fill: '#fff' }));
  // Capturing chip
  els.push(rrect(r.x + r.w * 0.10, statY + 28, r.w * 0.80, 64, 16, '#13294B'));
  els.push(text(cx, statY + 28 + 41, 'Capturing  ·  name  ·  service  ·  urgency', { size: 24, weight: 500, fill: '#C8A24B', anchor: 'middle' }));
  return { svg: svgWrap(width, height, els), boxes: [{ kind: 'text', x: r.x, y: cardY, w: r.w, h: cardH }] };
}

function leadCard(width, height, brand, data = {}) {
  const r = contentRect(width, height);
  const els = [bg(width, height, C.lightGray)];
  const cardY = r.y + r.h * 0.10, cardH = r.h * 0.72;
  els.push(rrect(r.x, cardY, r.w, cardH, 32, '#FFFFFF', 'stroke="#E2E8F0" stroke-width="2"'));
  // Header
  els.push(`<circle cx="${r.x + 56}" cy="${cardY + 64}" r="22" fill="${C.signalGreen}"/>`);
  els.push(text(r.x + 47, cardY + 73, '✓', { size: 30, weight: 800, fill: '#fff' }));
  els.push(text(r.x + 92, cardY + 74, 'Lead captured', { size: 34, weight: 700, fill: C.midnight }));
  els.push(text(r.x + r.w - 28, cardY + 70, 'just now', { size: 24, weight: 500, fill: C.slate, anchor: 'end' }));
  // Rows
  const rows = [
    ['Name', data.name || 'Maria R.'],
    ['Service', data.service || 'Kitchen sink leak'],
    ['Urgency', data.urgency || 'Same day'],
    ['Phone', data.number || '(404) 555-0142'],
  ];
  let ry = cardY + 140;
  for (const [k, v] of rows) {
    els.push(text(r.x + 40, ry, k, { size: 26, weight: 600, fill: C.slate }));
    els.push(text(r.x + r.w - 40, ry, v, { size: 30, weight: 700, fill: C.midnight, anchor: 'end' }));
    els.push(`<line x1="${r.x + 40}" y1="${ry + 26}" x2="${r.x + r.w - 40}" y2="${ry + 26}" stroke="#EDF1F6" stroke-width="2"/>`);
    ry += 92;
  }
  // Footer
  els.push(rrect(r.x, cardY + cardH + 24, r.w, 70, 16, C.midnight));
  els.push(text(width / 2, cardY + cardH + 24 + 45, 'Sent to owner to follow up', { size: 28, weight: 600, fill: '#fff', anchor: 'middle' }));
  return { svg: svgWrap(width, height, els), boxes: [{ kind: 'text', x: r.x, y: cardY, w: r.w, h: cardH + 94 }] };
}

function commandCenter(width, height, brand, data = {}) {
  const r = contentRect(width, height);
  const els = [bg(width, height, C.lightGray)];
  const cardY = r.y + r.h * 0.06, cardH = r.h * 0.86;
  els.push(rrect(r.x, cardY, r.w, cardH, 32, '#FFFFFF', 'stroke="#E2E8F0" stroke-width="2"'));
  // Header bar
  els.push(rrect(r.x, cardY, r.w, 92, 32, C.midnight));
  els.push(rrect(r.x, cardY + 46, r.w, 46, 0, C.midnight));
  els.push(text(r.x + 36, cardY + 58, 'Command Center', { size: 34, weight: 700, fill: '#fff' }));
  for (let i = 0; i < 3; i++) els.push(`<circle cx="${r.x + r.w - 40 - i * 34}" cy="${cardY + 46}" r="8" fill="#3B5B86"/>`);
  // Stat tiles
  const stats = [['New leads', data.leads || '4'], ['Follow-ups', data.followups || '3'], ['Reviews', data.reviews || '2']];
  const tileW = (r.w - 72 - 40) / 3;
  stats.forEach(([k, v], i) => {
    const tx = r.x + 36 + i * (tileW + 20);
    els.push(rrect(tx, cardY + 120, tileW, 120, 18, '#F6F9FC'));
    els.push(text(tx + tileW / 2, cardY + 195, v, { size: 56, weight: 800, fill: C.midnight, anchor: 'middle' }));
    els.push(text(tx + tileW / 2, cardY + 225, k, { size: 22, weight: 600, fill: C.slate, anchor: 'middle' }));
  });
  // Rows: new lead, follow-up task, activity
  const rows = [
    [C.signalGreen, 'New lead', data.name || 'Maria R. · kitchen sink leak'],
    ['#C8A24B', 'Follow-up task', 'Call back this afternoon'],
    [C.slate, 'Review request', 'Queued for the Johnson job'],
  ];
  let ry = cardY + 290;
  for (const [dot, k, v] of rows) {
    els.push(rrect(r.x + 36, ry, r.w - 72, 96, 18, '#F6F9FC'));
    els.push(`<circle cx="${r.x + 70}" cy="${ry + 48}" r="10" fill="${dot}"/>`);
    els.push(text(r.x + 96, ry + 40, k, { size: 24, weight: 700, fill: C.midnight }));
    els.push(text(r.x + 96, ry + 72, v, { size: 24, weight: 500, fill: C.slate }));
    ry += 112;
  }
  return { svg: svgWrap(width, height, els), boxes: [{ kind: 'text', x: r.x, y: cardY, w: r.w, h: cardH }] };
}

function workflowDiagram(width, height, brand, data = {}) {
  const r = contentRect(width, height);
  const els = [bg(width, height, C.midnight)];
  els.push(text(width / 2, r.y + 50, 'HOW IT WORKS', { size: 26, weight: 700, fill: C.signalGreen, anchor: 'middle', spacing: 4 }));
  const steps = data.steps || ['A lead calls', 'The AI answers', 'Details captured', 'Owner notified', 'Command Center updated'];
  const top = r.y + 110;
  const stepH = (r.h - 140) / steps.length;
  const nodeX = r.x + 56;
  // connector
  els.push(`<line x1="${nodeX}" y1="${top + stepH * 0.5}" x2="${nodeX}" y2="${top + stepH * (steps.length - 0.5)}" stroke="#2A4straight" stroke-width="4"/>`.replace('#2A4straight', '#27406A'));
  steps.forEach((s, i) => {
    const cy = top + stepH * (i + 0.5);
    els.push(rrect(r.x + 110, cy - stepH * 0.34, r.w - 120, stepH * 0.68, 20, '#0E2038', 'stroke="#1E3A5F" stroke-width="2"'));
    els.push(`<circle cx="${nodeX}" cy="${cy}" r="30" fill="${C.signalGreen}"/>`);
    els.push(text(nodeX, cy + 12, String(i + 1), { size: 34, weight: 800, fill: C.midnight, anchor: 'middle' }));
    els.push(text(r.x + 150, cy + 12, s, { size: 34, weight: 700, fill: '#fff' }));
  });
  return { svg: svgWrap(width, height, els), boxes: [{ kind: 'text', x: r.x, y: top, w: r.w, h: r.h - 110 }] };
}

function svgWrap(width, height, els) {
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${els.join('')}</svg>`;
}

const RENDERERS = {
  call_screen: callScreen,
  lead_card: leadCard,
  command_center: commandCenter,
  workflow_diagram: workflowDiagram,
};

/** Names of the product visuals this module can render. */
function names() { return Object.keys(RENDERERS); }
function has(name) { return !!RENDERERS[name]; }

/** Render a product visual → { svg, boxes }. Throws if the name is unknown. */
function renderProductVisual(name, { width = 1080, height = 1350, data = {} } = {}) {
  const fn = RENDERERS[name];
  if (!fn) throw new Error(`unknown product visual: ${name}`);
  return fn(width, height, FGA_BRAND, data || {});
}

module.exports = { renderProductVisual, names, has };
