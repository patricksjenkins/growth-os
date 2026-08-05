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

function wrapWords(value, maxChars = 28, maxLines = 4) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[.\s]+$/, '')}…`;
  return kept;
}

function multiline(x, y, value, { size = 58, lineHeight = 1.12, maxChars = 28, maxLines = 4, weight = 750, fill = C.midnight, anchor = 'start' } = {}) {
  return wrapWords(value, maxChars, maxLines)
    .map((line, i) => text(x, y + i * size * lineHeight, line, { size, weight, fill, anchor }))
    .join('');
}

function brandRail(width, y, light = false) {
  const ink = light ? '#FFFFFF' : C.midnight;
  return [
    `<rect x="0" y="${y}" width="${width}" height="4" fill="${C.signalGreen}"/>`,
    text(96, y + 54, 'FIRST GEN AUTOMATE', { size: 24, weight: 750, fill: ink, spacing: 3 }),
    text(width - 96, y + 54, 'FIELD NOTES', { size: 22, weight: 650, fill: light ? '#B9C8D8' : C.slate, anchor: 'end', spacing: 2 }),
  ].join('');
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

// An editorial story layout for post hooks and one-liners. The old fallback
// was centered white text on a navy rectangle. This communicates an actual
// sequence and keeps the headline inside a designed information hierarchy.
function storyBoard(width, height, brand, data = {}) {
  const r = contentRect(width, height);
  const els = [bg(width, height, '#F4F0E8')];
  els.push(`<path d="M0 ${height * 0.68} C ${width * 0.25} ${height * 0.60}, ${width * 0.72} ${height * 0.78}, ${width} ${height * 0.66} L ${width} ${height} L0 ${height}Z" fill="#E4EBE6"/>`);
  els.push(brandRail(width, 0));
  els.push(text(r.x, r.y + 105, data.kicker || 'THE HANDOFF', { size: 24, weight: 750, fill: '#16834A', spacing: 3 }));
  els.push(multiline(r.x, r.y + 182, data.headline || 'Every lead should have a next step.', { size: 58, maxChars: 29, maxLines: 3 }));

  const steps = Array.isArray(data.steps) && data.steps.filter(Boolean).length >= 3
    ? data.steps.filter(Boolean).slice(0, 4)
    : ['A lead reaches out', 'The call gets answered', 'The details get captured', 'The owner gets the next step'];
  const panelY = r.y + 410;
  const panelH = Math.min(r.h - 450, 650);
  els.push(rrect(r.x, panelY, r.w, panelH, 30, '#FFFFFF', 'stroke="#D9D4CA" stroke-width="2"'));
  steps.forEach((step, i) => {
    const rowH = panelH / steps.length;
    const cy = panelY + rowH * i + rowH / 2;
    const active = i === steps.length - 1;
    if (i > 0) els.push(`<line x1="${r.x + 34}" y1="${panelY + rowH * i}" x2="${r.x + r.w - 34}" y2="${panelY + rowH * i}" stroke="#E9E4DB" stroke-width="2"/>`);
    els.push(`<circle cx="${r.x + 68}" cy="${cy}" r="25" fill="${active ? C.signalGreen : '#E5E9E5'}"/>`);
    els.push(text(r.x + 68, cy + 10, String(i + 1), { size: 27, weight: 800, fill: active ? '#FFFFFF' : C.midnight, anchor: 'middle' }));
    els.push(text(r.x + 118, cy + 10, step, { size: 30, weight: 680, fill: C.midnight }));
    els.push(text(r.x + r.w - 38, cy + 9, active ? 'READY' : 'CAPTURED', { size: 18, weight: 750, fill: active ? '#16834A' : '#82909E', anchor: 'end', spacing: 2 }));
  });
  els.push(text(r.x, height - 70, data.footer || 'AUTOMATE THE OVERHEAD. FOCUS ON THE WORK.', { size: 20, weight: 700, fill: C.midnight, spacing: 1.5 }));
  return { svg: svgWrap(width, height, els), boxes: [{ kind: 'text', x: r.x, y: r.y, w: r.w, h: r.h }] };
}

function missedCall(width, height, brand, data = {}) {
  const r = contentRect(width, height);
  const els = [bg(width, height, C.midnight), brandRail(width, 0, true)];
  els.push(`<circle cx="${width * 0.84}" cy="${height * 0.20}" r="${width * 0.30}" fill="#1D3A5A" opacity="0.72"/>`);
  els.push(text(r.x, r.y + 100, data.kicker || 'WHEN YOU CANNOT PICK UP', { size: 23, weight: 750, fill: C.signalGreen, spacing: 2.5 }));
  els.push(multiline(r.x, r.y + 176, data.headline || 'The next call still gets answered.', { size: 56, maxChars: 28, maxLines: 3, fill: '#FFFFFF' }));

  const phoneX = r.x + 76, phoneY = r.y + 430, phoneW = r.w - 152, phoneH = 520;
  els.push(rrect(phoneX, phoneY, phoneW, phoneH, 42, '#09182C', 'stroke="#3C5878" stroke-width="3"'));
  els.push(`<circle cx="${width / 2}" cy="${phoneY + 112}" r="56" fill="#173557" stroke="${C.signalGreen}" stroke-width="3"/>`);
  els.push(text(width / 2, phoneY + 132, '☎', { size: 62, weight: 500, fill: '#FFFFFF', anchor: 'middle' }));
  els.push(text(width / 2, phoneY + 218, 'NEW CUSTOMER CALL', { size: 25, weight: 750, fill: '#AFC0D0', anchor: 'middle', spacing: 2 }));
  els.push(text(width / 2, phoneY + 270, data.caller || 'Service inquiry', { size: 38, weight: 750, fill: '#FFFFFF', anchor: 'middle' }));
  els.push(rrect(phoneX + 62, phoneY + 330, phoneW - 124, 92, 22, '#173557'));
  els.push(`<circle cx="${phoneX + 104}" cy="${phoneY + 376}" r="10" fill="${C.signalGreen}"/>`);
  els.push(text(phoneX + 132, phoneY + 386, 'AI Receptionist is answering', { size: 28, weight: 650, fill: '#FFFFFF' }));
  els.push(text(width / 2, phoneY + 474, 'Name  ·  Need  ·  Urgency  ·  Next step', { size: 24, weight: 550, fill: '#9FB3C8', anchor: 'middle' }));
  els.push(text(r.x, height - 70, 'YOU STAY WITH THE CUSTOMER IN FRONT OF YOU.', { size: 21, weight: 700, fill: '#FFFFFF', spacing: 1.4 }));
  return { svg: svgWrap(width, height, els), boxes: [{ kind: 'text', x: r.x, y: r.y, w: r.w, h: r.h }] };
}

function beforeAfter(width, height, brand, data = {}) {
  const r = contentRect(width, height);
  const els = [bg(width, height, '#F4F0E8'), brandRail(width, 0)];
  els.push(text(r.x, r.y + 98, data.kicker || 'BEFORE / AFTER', { size: 24, weight: 750, fill: '#16834A', spacing: 3 }));
  els.push(multiline(r.x, r.y + 170, data.headline || 'From missed moments to managed follow-up.', { size: 54, maxChars: 31, maxLines: 3 }));
  const gap = 24, panelY = r.y + 410, panelW = (r.w - gap) / 2, panelH = 650;
  const columns = [
    { x: r.x, title: 'WITHOUT A SYSTEM', fill: '#E8DDD3', accent: '#B83A42', rows: ['Missed call', 'Loose note', 'Follow-up forgotten'] },
    { x: r.x + panelW + gap, title: 'WITH FGA', fill: '#E1ECE4', accent: '#169A49', rows: ['Call answered', 'Lead captured', 'Next step ready'] },
  ];
  columns.forEach((col) => {
    els.push(rrect(col.x, panelY, panelW, panelH, 28, col.fill));
    els.push(text(col.x + 28, panelY + 58, col.title, { size: 19, weight: 800, fill: col.accent, spacing: 1.5 }));
    col.rows.forEach((row, i) => {
      const y = panelY + 145 + i * 145;
      els.push(`<circle cx="${col.x + 50}" cy="${y}" r="18" fill="${i === 2 && col.accent === '#169A49' ? C.signalGreen : '#FFFFFF'}" stroke="${col.accent}" stroke-width="3"/>`);
      els.push(text(col.x + 82, y + 9, row, { size: 26, weight: 700, fill: C.midnight }));
      if (i < 2) els.push(`<line x1="${col.x + 50}" y1="${y + 22}" x2="${col.x + 50}" y2="${y + 122}" stroke="${col.accent}" stroke-width="3" opacity="0.35"/>`);
    });
  });
  return { svg: svgWrap(width, height, els), boxes: [{ kind: 'text', x: r.x, y: r.y, w: r.w, h: r.h }] };
}

function editorialStatement(width, height, brand, data = {}) {
  const r = contentRect(width, height);
  const els = [bg(width, height, '#F4F0E8'), brandRail(width, 0)];
  els.push(`<rect x="0" y="${height * 0.70}" width="${width}" height="${height * 0.30}" fill="${C.midnight}"/>`);
  els.push(`<rect x="${r.x}" y="${r.y + 112}" width="10" height="420" rx="5" fill="${C.signalGreen}"/>`);
  els.push(text(r.x + 42, r.y + 94, data.kicker || 'A FOUNDER NOTE', { size: 24, weight: 750, fill: '#16834A', spacing: 3 }));
  els.push(multiline(r.x + 42, r.y + 190, data.headline || 'A better system protects the work that matters.', { size: 66, maxChars: 24, maxLines: 5 }));
  els.push(text(r.x, height * 0.70 + 105, 'THE OPERATING PRINCIPLE', { size: 21, weight: 750, fill: C.signalGreen, spacing: 2 }));
  els.push(multiline(r.x, height * 0.70 + 178, data.subtext || 'Build the handoff once. Stop relying on memory.', { size: 34, maxChars: 43, maxLines: 2, fill: '#FFFFFF', weight: 650 }));
  return { svg: svgWrap(width, height, els), boxes: [{ kind: 'text', x: r.x, y: r.y, w: r.w, h: r.h }] };
}

function metricEditorial(width, height, brand, data = {}) {
  const r = contentRect(width, height);
  const els = [bg(width, height, '#F4F0E8'), brandRail(width, 0)];
  const metric = data.headline || '78%';
  els.push(text(r.x, r.y + 100, data.kicker || 'THE NUMBER TO KNOW', { size: 24, weight: 750, fill: '#16834A', spacing: 3 }));
  els.push(`<circle cx="${width / 2}" cy="${height * 0.43}" r="${width * 0.30}" fill="#E1ECE4" stroke="${C.signalGreen}" stroke-width="8"/>`);
  els.push(text(width / 2, height * 0.46, metric, { size: metric.length > 7 ? 112 : 150, weight: 800, fill: C.midnight, anchor: 'middle' }));
  els.push(multiline(width / 2, height * 0.73, data.subtext || data.body || 'One number. One operational decision.', { size: 38, maxChars: 35, maxLines: 3, fill: C.midnight, anchor: 'middle', weight: 650 }));
  els.push(text(width / 2, height - 68, data.source || 'SOURCE NOTED IN CAPTION', { size: 19, weight: 700, fill: C.slate, anchor: 'middle', spacing: 2 }));
  return { svg: svgWrap(width, height, els), boxes: [{ kind: 'text', x: r.x, y: r.y, w: r.w, h: r.h }] };
}

function svgWrap(width, height, els) {
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${els.join('')}</svg>`;
}

const RENDERERS = {
  call_screen: callScreen,
  lead_card: leadCard,
  command_center: commandCenter,
  workflow_diagram: workflowDiagram,
  story_board: storyBoard,
  missed_call: missedCall,
  before_after: beforeAfter,
  editorial_statement: editorialStatement,
  metric_editorial: metricEditorial,
};

const VISUAL_TYPE_RENDERERS = {
  product_workflow: 'story_board',
  pain_scenario: 'missed_call',
  before_after: 'before_after',
  command_center: 'command_center',
  carousel_story: 'story_board',
  founder_pov: 'editorial_statement',
  stat_visual: 'metric_editorial',
};

/** Names of the product visuals this module can render. */
function names() { return Object.keys(RENDERERS); }
function has(name) { return !!RENDERERS[name]; }

function resolveForVisualType(visualType, { formatId } = {}) {
  if (has(visualType)) return visualType;
  if (visualType && VISUAL_TYPE_RENDERERS[visualType]) return VISUAL_TYPE_RENDERERS[visualType];
  // The two single-card formats must never fall back to an undifferentiated
  // blue rectangle when the planner omitted visual_type.
  if (Number(formatId) === 1) return 'editorial_statement';
  if (Number(formatId) === 2) return 'editorial_statement';
  if (Number(formatId) === 3) return 'metric_editorial';
  return null;
}

/** Render a product visual → { svg, boxes }. Throws if the name is unknown. */
function renderProductVisual(name, { width = 1080, height = 1350, data = {} } = {}) {
  const fn = RENDERERS[name];
  if (!fn) throw new Error(`unknown product visual: ${name}`);
  return fn(width, height, FGA_BRAND, data || {});
}

module.exports = { renderProductVisual, names, has, resolveForVisualType };
