/**
 * Visual-type library (file-based).
 *
 * A `visual_type` is the SEMANTIC job of a post's image — what it must SHOW —
 * independent of the renderer/format that draws it. The planner picks one so
 * the visual explains the idea before the caption is read, instead of defaulting
 * to a text-on-background "quote card."
 *
 * Each entry maps to: the renderer family that draws it (a product_visuals.js
 * SVG renderer, a Gemini scene, or a text/decoration card), preferred base
 * format ids, and explicit "must SHOW" guidance injected into prompts.
 *
 * `textCard: true` marks the text-heavy types (founder_pov, stat_visual) whose
 * share is capped — most posts should SHOW product/pain/outcome, not words.
 */

const VISUAL_TYPES = [
  {
    id: 'product_workflow',
    label: 'Product workflow',
    renderer: 'product_visuals',     // workflow_diagram / call_screen / lead_card
    formats: [8, 9],
    show: 'The FGA system working as a sequence: call comes in → AI Voice Receptionist answers → caller details captured → owner gets the summary → follow-up task created → Command Center updated. Polished product-UI style, not a text slide.',
    textCard: false,
  },
  {
    id: 'pain_scenario',
    label: 'Pain scenario',
    renderer: 'gemini_scene',
    formats: [6, 7],
    show: 'A real micro-business pain moment — owner on a job site (under a sink, on a ladder, in a truck) while the phone rings, a missed-call overlay, voicemail piling up. Realistic documentary photography. The image alone should communicate "a lead is calling and you can\'t answer."',
    textCard: false,
  },
  {
    id: 'before_after',
    label: 'Before / after',
    renderer: 'product_visuals',     // split / two-panel
    formats: [4, 5],
    show: 'A clear split or two-panel contrast. BEFORE: missed call, scattered notes, forgotten follow-up, no visibility. AFTER: AI answered, lead captured, owner notified, follow-up organized, Command Center updated. Progression must read at a glance.',
    textCard: false,
  },
  {
    id: 'command_center',
    label: 'Command Center',
    renderer: 'product_visuals',     // command_center card
    formats: [8, 9],
    show: 'A stylized product card from the Command Center: a new captured lead, a follow-up task, a review request queued, an activity timeline. Looks like a clean mini product screenshot, never a plain text card.',
    textCard: false,
  },
  {
    id: 'service_business',
    label: 'Service business',
    renderer: 'gemini_scene',
    formats: [6, 7, 8],
    show: 'A grounded scene from FGA\'s actual customers — tree service, HVAC, plumber, electrician, cleaner, landscaper, mobile detailer, salon/barber. Real trade imagery (tools, trucks, the work), not generic office stock.',
    textCard: false,
  },
  {
    id: 'carousel_story',
    label: 'Carousel story',
    renderer: 'mixed',               // progression across slides
    formats: [6, 7, 8, 9],
    show: 'A multi-slide story with PROGRESSION (not repeated quote cards): e.g. phone rings on the job → goes to voicemail → they call the next business → FGA answers and captures details → you get the summary, you stay in control.',
    textCard: false,
  },
  {
    id: 'founder_pov',
    label: 'Founder POV',
    renderer: 'text_card',           // quote/founder card (decoration-backed)
    formats: [2],
    show: 'A founder-voice line attributed to Patrick, on a clean editorial card with a real visual hook (quote frame / accent), not a flat centered-text slide.',
    textCard: true,
  },
  {
    id: 'stat_visual',
    label: 'Stat visual',
    renderer: 'text_card',           // big-number stat card
    formats: [3],
    show: 'A single sourced statistic rendered as a bold number in a framed visual with the cited source. Use sparingly (stat-led cap).',
    textCard: true,
  },
];

const BY_ID = Object.fromEntries(VISUAL_TYPES.map((v) => [v.id, v]));

function all() { return VISUAL_TYPES.slice(); }
function getById(id) { return BY_ID[id] || null; }
function ids() { return VISUAL_TYPES.map((v) => v.id); }

/** Renderer family for a visual_type id (defaults to text_card if unknown). */
function rendererFor(id) { return (BY_ID[id] && BY_ID[id].renderer) || 'text_card'; }

/** Is this a text-heavy (quote/stat) type whose share should be capped? */
function isTextCard(id) { return !!(BY_ID[id] && BY_ID[id].textCard); }

/** Compact block listing the visual types for injection into a prompt. */
function promptBlock() {
  return VISUAL_TYPES.map((v) => `- ${v.id}: ${v.show}`).join('\n');
}

module.exports = { VISUAL_TYPES, all, getById, ids, rendererFor, isTextCard, promptBlock };
