#!/usr/bin/env node

/**
 * One-off: generate Google Ads display creatives via Gemini.
 *
 * Goal: produce 5 image variants for the first FGA Google Ads campaign
 * targeting tree-service business owners. Each saved to
 * ~/Desktop/fga-google-ad-images/ as PNG.
 *
 *   1) Square — tree worker scene with "Missed Call" on phone (literal text)
 *   2) Square — same scene with notification icon only (no text)
 *   3) Horizontal — tree worker scene with "Missed Call" text
 *   4) Horizontal — same scene with notification icon only
 *   5) Square — product-only fallback (phone on workbench, no person)
 *
 * Why 5 variants:
 *   - Gemini still mis-renders text 30-40% of the time. The icon-only
 *     versions guarantee at least one usable creative if text variants
 *     come out garbled.
 *   - Two formats (square + horizontal) cover both Google Ads slots.
 *
 * Run from the growth-os directory:
 *   node scripts/gen-google-ads-images.js
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { generateImage } = require('../integrations/gemini');

const OUTPUT_DIR = path.join(process.env.HOME, 'Desktop', 'fga-google-ad-images');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Shared style language across all prompts. Keeping this consistent across
// variants means the set looks like a cohesive campaign, not 5 random images.
const STYLE = `Cinematic documentary photograph, golden hour late afternoon natural sunlight, shot on Canon EOS R5 with 35mm lens, shallow depth of field. Photorealistic, premium and trustworthy aesthetic. Warm color palette: amber and gold sunlight, deep forest greens of foliage, occasional accents of deep navy (#1B2A4A) and signal green (#22C55E) from a phone screen. No additional text overlays, no logos, no watermarks anywhere in the frame.`;

// The shared "scene" for variants 1-4: REAL professional tree work
// happening in the background — bucket lift extended into the tree
// with an operator in the bucket cutting a limb, and a rope man on
// the ground in a high-vis safety vest controlling the falling limb.
// In the foreground, an unanswered phone on the truck tailgate. The
// composition tells the story: the crew is mid-job, the phone is
// ringing, the lead is being LOST.
//
// The prompt is opinionated about realism because tree service owners
// (our buyers) will instantly clock fake-looking arrangements like a
// guy harnessed in branches with a chainsaw. Pro setups use bucket
// trucks or aerial lifts.
const TREE_SCENE = `Setting: front yard of a residential American home with a large mature oak tree being worked on by a professional tree service crew at golden hour. A YELLOW BUCKET LIFT (a compact yellow tracked aerial work platform similar to a spider lift) is positioned in the yard, with its articulated boom arm extended up and into the upper branches of the oak tree. In the bucket basket at the top of the boom, a professional tree worker wearing an orange high-visibility safety helmet and harness is operating a chainsaw — the chainsaw blade is entering the wood of a thick limb, sawdust is falling through the air, and the limb is STILL FULLY ATTACHED to the tree trunk (mid-cut, not yet severed). On the ground below the tree, a SECOND tree worker — the "rope man" — wearing a bright orange high-visibility safety vest and helmet, stands on the lawn holding a thick rigging rope. The rope runs at a clear visible angle FROM HIS HANDS at ground level, UP through the air, AND IS TIED AROUND THE LIMB being cut by the bucket operator. The rope is slightly taut, ready to control the limb's fall when severed. CRITICAL: the rope is tied to THE LIMB BEING CUT — NOT to the bucket, NOT to the boom arm, NOT to the trunk. The bucket itself has no ropes attached to it. Wood chips and previously-cut sections of log are scattered on the lawn from earlier cuts. Both tree workers are SMALL in the frame, mid-distance, with NO FACIAL DETAIL visible — they are working figures, not portraits.`;

const prompts = [
  {
    name: '01-square-tree-text',
    aspect: '1:1 square',
    prompt: `${TREE_SCENE} The phone screen displays a SINGLE clean iOS-style notification card with ONLY the words "Missed Call" in bold black text at the top of the card, and below in smaller grey text "now". The notification card is clean, white, with a small red badge dot indicating an unanswered call. ABSOLUTELY NO chat bubbles, NO reply text, NO auto-response visible — the call has been missed and nothing has been done about it. ${STYLE} Square 1:1 aspect ratio. The phone in the foreground is in sharp focus; the tree work scene in the background is softly blurred but the bucket lift and ground worker are clearly visible.`,
  },
  {
    name: '02-square-tree-icon',
    aspect: '1:1 square',
    prompt: `${TREE_SCENE} The phone screen displays a clean minimal notification interface: a single red circular badge with a white phone icon indicating a missed call, and a soft red glow. NO TEXT visible on the phone screen — pure iconography only. The viewer instantly understands: a call has been missed. ${STYLE} Square 1:1 aspect ratio. The phone in the foreground is in sharp focus; the tree work scene in the background is softly blurred but the bucket lift and ground worker are clearly visible.`,
  },
  {
    name: '03-horizontal-tailgate-wide',
    aspect: '1.91:1 horizontal landscape',
    prompt: `Wide horizontal cinematic photograph at golden hour. Camera angle: low, looking across the open tailgate of a rugged work pickup truck parked at the edge of a residential job site. The weathered, slightly scuffed metal-and-wood tailgate stretches across the bottom half of the frame. On the tailgate, arranged like a tree worker just stepped away from a job: a NEATLY COILED bright orange climbing rope (correctly coiled, not tangled), a yellow canvas chainsaw chaps or tool bag, several scattered hand tools (an adjustable wrench, a screwdriver) on the right side. In the center foreground of the frame, a modern dark smartphone rests face-up on the tailgate's wooden bed, screen lit up displaying a single clean iOS-style notification card with the bold black text "Missed Call" and a small red badge dot. Soft golden afternoon sunlight streams in from the upper left, creating warm highlights on the metal and casting the soft shadows. The background, soft and out of focus, suggests a green leafy residential yard or treed area — no people, no workers visible, no complex action. NO ROPE TANGLES, NO COMPLEX RIGGING. The story is told by the gear + the missed call + the absence of the worker who just stepped away. ${STYLE} Wide horizontal landscape 1.91:1 aspect ratio. Phone in sharp focus, gear in middle-focus, background blurred.`,
  },
  {
    name: '04-horizontal-stump-rope-coil',
    aspect: '1.91:1 horizontal landscape',
    prompt: `Wide horizontal cinematic photograph at golden hour, tree service job site. Camera angle: low and close to the ground, looking across a freshly-cut tree stump in the immediate foreground (left third of frame). The stump's wood grain and pale freshly-cut surface is visible, showing it was just sawed. On TOP of the flat cut stump surface, a modern dark smartphone rests face-up, screen lit up displaying a clean minimal notification: a red circular badge with a white phone icon and soft red glow, indicating a missed call. NO TEXT on the phone screen. Behind the stump, casually placed on the grass: a NEATLY COILED bright orange climbing rope (correctly coiled, sitting on the ground), and an orange tree-service safety helmet sitting on its side. In the wider background, soft and blurred: a residential yard with green leafy trees, golden light filtering through. NO PEOPLE visible, NO complex rope rigging, NO cut limb in mid-air. Just gear + phone + nature. ${STYLE} Wide horizontal landscape 1.91:1 aspect ratio. Phone and stump in sharp focus, gear in middle-focus, background blurred.`,
  },
  // -----------------------------------------------------------------
  // Vertical #2: Dog Grooming
  // Pro-grade detail: stainless steel raised tub (NOT a home bathtub),
  // sprayer hose with metal nozzle, groomer in apron, towels folded,
  // clippers/brushes/scissors arranged on counter. A dog groomer
  // watching the ad will instantly clock if the scene shows "person
  // bathing pet in kitchen sink" — it has to look like a real salon.
  // -----------------------------------------------------------------
  {
    name: '06-square-grooming-text',
    aspect: '1:1 square',
    prompt: `Setting: interior of a professional dog grooming salon at golden hour, with soft natural daylight streaming in from a large window. In the mid-distance background, a large stainless steel raised grooming tub stands at countertop height. A medium-sized fluffy golden doodle dog stands in the tub being washed — soap suds visible on its coat, a clear plastic shower hose with a metal sprayer nozzle in use, water droplets in the air. The professional groomer is partially visible from the side/behind, wearing a clean black or grey grooming apron over a t-shirt — only their hand on the sprayer and one shoulder visible, NO FACIAL DETAIL. The dog is calm. Neatly folded white towels stacked on a side counter, professional grooming clippers, brushes, and scissors arranged on the counter. Light wood cabinetry and stainless steel surfaces give a clean professional salon feel. In the IMMEDIATE FOREGROUND (sharp focus, bottom of frame), a modern dark smartphone rests face-up on a clean wooden countertop next to a pair of professional grooming scissors and a metal slicker brush. The phone screen displays a single clean iOS-style notification card with ONLY the bold black text "Missed Call" at the top and "now" below in smaller grey text. Small red badge dot. ABSOLUTELY NO chat bubbles, NO reply text. ${STYLE} Square 1:1 aspect ratio. The phone in foreground is in sharp focus; the grooming scene in background is softly blurred but the dog and groomer's apron are clearly visible.`,
  },
  {
    name: '07-square-grooming-icon',
    aspect: '1:1 square',
    prompt: `Setting: interior of a professional dog grooming salon at golden hour, with soft natural daylight streaming in from a large window. In the mid-distance background, a large stainless steel raised grooming tub. A medium-sized fluffy golden doodle dog stands in the tub being washed — soap suds visible on its coat, a clear plastic shower hose with metal sprayer nozzle in use. The professional groomer wears a clean black grooming apron, partially visible from behind, only their hand on the sprayer and shoulder visible, NO FACIAL DETAIL. Neatly folded white towels nearby, professional grooming brushes and scissors on the counter. Light wood cabinetry and stainless steel surfaces. In the IMMEDIATE FOREGROUND (sharp focus, bottom of frame), a modern dark smartphone rests face-up on a clean wooden countertop. The phone screen displays a clean minimal notification: a single red circular badge with a white phone icon and a soft red glow indicating a missed call. NO TEXT on the phone screen — pure iconography. ${STYLE} Square 1:1 aspect ratio. The phone in foreground is in sharp focus; the grooming scene in background is softly blurred but the dog and groomer's apron are clearly visible.`,
  },
  {
    name: '08-horizontal-grooming-wide',
    aspect: '1.91:1 horizontal landscape',
    prompt: `Wide horizontal cinematic photograph at golden hour. Interior of a professional dog grooming salon. The composition: in the immediate foreground (sharp focus, occupying the bottom-center of the frame), a modern dark smartphone rests face-up on a clean wooden countertop. The phone displays a single clean iOS-style notification with the bold black text "Missed Call" and "now" below, plus a small red badge dot. NO chat bubbles, NO reply text. Around the phone on the countertop: a pair of professional grooming scissors, a sleek metal slicker brush, neatly folded white towels. In the mid-distance background of the wider horizontal frame: a stainless steel raised grooming tub with a medium-sized fluffy golden doodle dog standing in it being washed — soap suds visible on its coat, a clear plastic shower hose sprayer in use, water droplets in the air. The professional groomer is partially visible from behind/side, wearing a clean grooming apron, only their hand on the sprayer and shoulder visible, NO FACIAL DETAIL. Soft natural daylight from a window. Clean professional salon environment with light wood cabinetry and stainless steel surfaces. ${STYLE} Wide horizontal landscape 1.91:1 aspect ratio. The phone and countertop items in sharp focus, the dog and groomer in soft focus background.`,
  },
  // -----------------------------------------------------------------
  // Vertical #3: Plumbing
  // Pro-grade detail: basin wrench is the under-sink tool (not a
  // hammer or screwdriver), Teflon tape is white, a real plumber wears
  // sturdy boots + uniform shirt + work pants. Drip bucket is small.
  // Plumber's face is HIDDEN (under the sink) so we sidestep AI face
  // issues entirely.
  // -----------------------------------------------------------------
  {
    name: '09-horizontal-plumber-faucet',
    aspect: '1.91:1 horizontal landscape',
    prompt: `Wide horizontal cinematic photograph. Interior of a clean modern residential kitchen with light wood cabinetry and a white quartz countertop with a stainless steel undermount sink. Warm soft afternoon sunlight streams in from a window above the sink. A professional plumber stands at the sink, viewed FROM THE SIDE/BACK (3/4 rear angle) — we see his back, his broad shoulders in a clean navy blue work uniform shirt with the sleeves rolled to the elbows, his work pants, his sturdy brown leather work boots planted on the kitchen floor, and the back of his head wearing a navy ball cap. NO FACE visible (the cap brim and the angle hide it). His arms are raised in front of him with both hands working on a brand-new brushed nickel kitchen faucet that rises from the counter — one hand steadies the faucet body, the other holds a curved basin wrench tightening a connection nut. Stance is natural and balanced — both feet on the floor, leaning slightly forward over the sink. On the counter next to him: a small open red metal toolbox with visible tools (an adjustable pipe wrench, a pair of channel-lock pliers), a roll of white Teflon plumber's tape, the brushed nickel faucet's packaging or box pushed to the side, and a small flashlight. In the IMMEDIATE FOREGROUND (RIGHT third of frame, sharp focus, on the kitchen counter or island closer to the camera), a modern dark smartphone rests face-up. The phone screen displays a single clean iOS-style notification card with ONLY the bold black text "Missed Call" at the top and "now" below in smaller grey text. Small red badge dot. ABSOLUTELY NO chat bubbles, NO reply text. ${STYLE} Wide horizontal landscape 1.91:1 aspect ratio. Phone in sharp focus, plumber in middle focus, kitchen softly blurred in background. Warm professional real-job-site feel — like watching a real install in progress.`,
  },
  // -----------------------------------------------------------------
  // 9:16 vertical — required for Google Performance Max coverage
  // (and reusable for IG Stories / Reels if we ever want them).
  // Use the proven #5 product-only formula: phone + tree-service gear
  // on a worn surface, warm golden hour, no people, no complex action.
  // -----------------------------------------------------------------
  {
    name: '10-vertical-tree-gear',
    aspect: '9:16 portrait vertical',
    prompt: `Tall vertical 9:16 portrait photograph at golden hour, professional product photography style. Composition: top half of the frame shows the open tailgate of a rugged work pickup truck with neatly arranged tree-service gear visible — a neatly coiled bright orange climbing rope, a yellow canvas tool bag, a few wrenches scattered to the side. Soft blurred green leafy forest visible beyond the tailgate. Warm golden afternoon sunlight streams in from the upper left, creating warm highlights on the metal and casting soft shadows. Bottom half of the frame: a modern dark smartphone resting face-up on the wooden tailgate bed. The phone screen displays a single clean iOS-style notification card with the bold black text "Missed Call" at the top and "now" below in smaller grey text. Small red badge dot. ABSOLUTELY NO chat bubbles, NO reply text, NO people in the frame. ${STYLE} Tall vertical 9:16 portrait aspect ratio. Phone in sharp focus, gear in middle focus, background blurred.`,
  },
  {
    name: '11-vertical-grooming-gear',
    aspect: '9:16 portrait vertical',
    prompt: `Tall vertical 9:16 portrait photograph. Interior of a professional dog grooming salon at golden hour, with warm soft natural daylight from a window. Composition: top half of the frame shows a clean light-wood salon countertop with grooming gear neatly arranged — a pair of stainless steel professional grooming scissors, a sleek metal slicker brush, a small stack of neatly folded white towels. In the soft blurred upper background, the corner of a stainless steel raised grooming tub and a wooden cabinet are visible. Bottom half of the frame: a modern dark smartphone resting face-up on the wooden countertop in the immediate foreground. The phone screen displays a single clean iOS-style notification card with the bold black text "Missed Call" at the top and "now" below in smaller grey text. Small red badge dot. ABSOLUTELY NO chat bubbles, NO reply text, NO people in the frame, NO dog in the frame. ${STYLE} Tall vertical 9:16 portrait aspect ratio. Phone in sharp focus, gear in middle focus, background blurred.`,
  },
  {
    name: '05-square-product-only',
    aspect: '1:1 square',
    prompt: `Premium product photograph. A modern dark smartphone rests face-up on the open tailgate of a rugged work pickup truck, the truck bed visible with worn metal and a coil of climbing rope and a folded yellow chainsaw chaps in the background. Warm late afternoon sunlight streams in from the left side, creating soft golden highlights. The phone screen displays a SINGLE clean iOS-style notification card with ONLY the bold black text "Missed Call" and "now" below it, plus a small red badge dot. ABSOLUTELY NO chat bubbles or replies. The viewer instantly feels the pain: a job is happening, a call came in, nobody answered. ${STYLE} Square 1:1 aspect ratio. Phone is in sharp focus, the surrounding truck bed objects are slightly out of focus.`,
  },
];

async function genOne({ name, aspect, prompt }) {
  const t0 = Date.now();
  try {
    console.log(`[${name}] start (${aspect})`);
    const buf = await generateImage(prompt);
    const outPath = path.join(OUTPUT_DIR, `${name}.png`);
    fs.writeFileSync(outPath, buf);
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[${name}] ✓ saved in ${seconds}s → ${outPath}`);
    return { name, ok: true, path: outPath };
  } catch (err) {
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[${name}] ✗ failed after ${seconds}s: ${err.message}`);
    return { name, ok: false, error: err.message };
  }
}

(async () => {
  // CLI arg: optional comma-separated list of prompt names to run.
  // Example: node gen-google-ads-images.js 03,04
  // Defaults to all when omitted.
  const onlyArg = process.argv[2];
  const allowList = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null;
  const toRun = allowList
    ? prompts.filter((p) => Array.from(allowList).some((tag) => p.name.startsWith(tag)))
    : prompts;

  console.log(`Generating ${toRun.length} Google Ads images in parallel...`);
  console.log(`Output: ${OUTPUT_DIR}\n`);
  const results = await Promise.all(toRun.map(genOne));
  console.log('\n--- Summary ---');
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  console.log(`Success: ${ok.length}/${prompts.length}`);
  if (failed.length) {
    console.log('Failed:');
    failed.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
  }
  console.log(`\nReview images in: ${OUTPUT_DIR}`);
})();
