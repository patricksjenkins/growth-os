/**
 * Founder Perspective Library (file-based, approved).
 *
 * Founder-led content is ~15-25% of the rolling mix. It reflects Patrick's
 * real, approved perspective as the founder of First Gen Automate — NOT
 * fabricated personal stories, customer outcomes, or invented quotes. The
 * planner may only draw from this curated list; when no specific founder
 * story fits, it writes a general founder perspective attributed to
 * "Patrick, First Gen Automate".
 *
 * Each entry is a defensible point of view grounded in the FGA positioning
 * (managed AI for micro businesses; automate the overhead, focus on the work;
 * done-for-you, not another empty tool). Sources: the FGA brand brief +
 * approved sample directions.
 */

const FOUNDER_PERSPECTIVES = [
  {
    id: 'fewer-things-to-manage',
    theme: 'less-overhead',
    perspective: 'Most micro-business owners do not need another app. They need fewer things to manage.',
    context: 'On why FGA bundles the work instead of selling more software.',
  },
  {
    id: 'not-an-expert',
    theme: 'managed-ai',
    perspective: 'I built FGA around one idea: owners should not have to become automation experts to benefit from automation.',
    context: 'On the managed-service model.',
  },
  {
    id: 'who-owns-the-task',
    theme: 'operational-blind-spot',
    perspective: 'The most expensive task in a five-person business is often the one nobody clearly owns.',
    context: 'On the hidden cost of work that depends on memory.',
  },
  {
    id: 'done-not-launched',
    theme: 'ongoing-management',
    perspective: 'Automation is not done when the workflow launches. It is done when the owner no longer has to babysit it.',
    context: 'On why FGA monitors and maintains the system after go-live.',
  },
  {
    id: 'software-vs-system',
    theme: 'managed-vs-software',
    perspective: 'Software hands you a dashboard and wishes you luck. A managed system does the work and shows you it happened.',
    context: 'On the difference between a tool and a managed service.',
  },
  {
    id: 'small-teams-feel-overhead',
    theme: 'micro-business',
    perspective: 'A big company can hide a broken process behind a department. A three-person shop feels every gap the same week it happens.',
    context: 'On why small teams feel overhead more intensely.',
  },
  {
    id: 'overhead-not-the-work',
    theme: 'focus-on-the-work',
    perspective: 'Owners did not start their business to answer messages and chase follow-ups. The overhead is the part worth handing off.',
    context: 'On the core promise: automate the overhead, focus on the work.',
  },
  {
    id: 'connected-not-isolated',
    theme: 'connected-modules',
    perspective: 'Five disconnected tools is not a system. The value shows up when one workflow hands off cleanly to the next.',
    context: 'On modules working together as an operating system.',
  },
  {
    id: 'consistency-beats-bursts',
    theme: 'operational-consistency',
    perspective: 'A small business does not lose to a lack of effort. It loses to inconsistency — the follow-up that happened in March but not in April.',
    context: 'On why consistency is the real differentiator.',
  },
  {
    id: 'configured-for-you',
    theme: 'done-for-you',
    perspective: 'The hard part was never the software. It was someone sitting down and configuring it for the way your business actually runs.',
    context: 'On done-for-you setup.',
  },
];

const ATTRIBUTION = 'Patrick, First Gen Automate';

function all() {
  return FOUNDER_PERSPECTIVES.slice();
}

function getById(id) {
  return FOUNDER_PERSPECTIVES.find((p) => p.id === id) || null;
}

/**
 * Pick a perspective not used in the recent set (by id), biased toward
 * variety of theme. Returns null only if the library is empty.
 */
function pickPerspective(recentIds = []) {
  const recent = new Set(recentIds || []);
  const fresh = FOUNDER_PERSPECTIVES.filter((p) => !recent.has(p.id));
  const pool = fresh.length ? fresh : FOUNDER_PERSPECTIVES;
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { FOUNDER_PERSPECTIVES, ATTRIBUTION, all, getById, pickPerspective };
