/**
 * Hook library (file-based).
 *
 * A strong hook is the difference between a scroll-stop and a scroll-past. The
 * planner is required to commit to one strong hook per post; this library gives
 * it (and the concept generator) a bank of proven hook PATTERNS by type to draw
 * from or riff on — NOT canned copy to paste verbatim. Reuse the IDEA, write
 * fresh words.
 *
 * Guardrails still apply downstream: no banned two-clause echo headlines, no
 * overpromise/booking/guaranteed-revenue, no fear-DOMINANT framing (a pain hook
 * should open the door to the FGA outcome, not just twist the knife).
 */

const HOOKS = {
  pain: [
    'That missed call was probably a lead.',
    'Your voicemail is not a sales process.',
    'The lead did not disappear — they called someone else.',
    'You are not losing leads because you do not care.',
    'Most lost leads do not look lost. They look like missed calls.',
    'The quote went out. The follow-up never did.',
  ],
  contrarian: [
    'You do not need more AI tools.',
    'Another dashboard will not fix your follow-up problem.',
    'The problem is not effort. It is capacity.',
    'You do not need another login you never use.',
  ],
  micro_business: [
    'When the owner is on the job, who answers the phone?',
    'In a 3-person business, there is no extra admin team.',
    'Small teams need systems that run while they work.',
    'The owner is the salesperson, the dispatcher, and the admin.',
  ],
  product: [
    'The call comes in. The AI answers. The details are captured.',
    'Your AI Voice Receptionist does not need a lunch break.',
    'A lead should not have to call twice.',
    'No more mystery voicemails with half the information missing.',
  ],
  managed_ai: [
    'AI tools are easy to buy. Harder to run.',
    'We set it up. We manage it. You stay in control.',
    'Managed AI beats another login you never open.',
    'You need the system set up for you — not another thing to learn.',
  ],
};

const TYPES = Object.keys(HOOKS);

function all() { return HOOKS; }

/** A few hooks across types, biased to the requested type if given. */
function pickHooks({ type, count = 6 } = {}) {
  const pool = [];
  if (type && HOOKS[type]) pool.push(...HOOKS[type]);
  for (const t of TYPES) if (t !== type) pool.push(...HOOKS[t]);
  return pool.slice(0, count);
}

/** Compact block grouping hooks by type for injection into a prompt. */
function promptBlock() {
  return TYPES.map((t) => `${t.toUpperCase().replace('_', ' ')}:\n` + HOOKS[t].map((h) => `  - ${h}`).join('\n')).join('\n');
}

module.exports = { HOOKS, TYPES, all, pickHooks, promptBlock };
