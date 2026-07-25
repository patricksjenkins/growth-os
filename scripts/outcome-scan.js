#!/usr/bin/env node
'use strict';

/**
 * Outcome scan — classify every agent's real production history.
 *
 * Read-only. No sends, no writes, no paid APIs. This is the report that
 * replaces "N runs, 100% completed" with "did anything actually happen".
 *
 * Usage:  node scripts/outcome-scan.js [days] [--json]
 */

const { getServiceClient } = require('../db/client');
const { classifyRun, classifyAgentHistory, VERDICTS } = require('../core/autonomous-os/output-expectations');

const DEMO_TENANT = '7f0e9284-81d0-4377-a5fc-9a381ec56376';

async function scan({ days = 30 } = {}) {
  const db = getServiceClient();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // PAGINATED on purpose. `.limit(20000)` does NOT defeat PostgREST's
  // server-side max-rows setting — the first version of this scan asked for
  // 20,000 rows, silently received exactly 1,000, and reported a confident
  // verdict on 11% of the window. That is the same truncation class the
  // dashboard audits were built to catch, so the scanner must page explicitly
  // and assert it reached the end.
  const PAGE = 1000;
  const data = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await db
      .from('agent_jobs')
      .select('agent_name, tenant_id, status, result, error, created_at')
      .gte('created_at', since)
      .neq('tenant_id', DEMO_TENANT)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`agent_jobs read failed: ${error.message}`);
    data.push(...(page || []));
    if (!page || page.length < PAGE) break;
    if (from > 200000) throw new Error('pagination runaway guard tripped');
  }

  const byAgent = new Map();
  for (const row of data || []) {
    if (!byAgent.has(row.agent_name)) byAgent.set(row.agent_name, []);
    byAgent.get(row.agent_name).push(row);
  }

  const agents = [];
  for (const [name, runs] of byAgent) {
    const hist = classifyAgentHistory(runs);
    const perRun = runs.map((r) => classifyRun(r).verdict);
    const tally = {};
    for (const v of perRun) tally[v] = (tally[v] || 0) + 1;
    agents.push({
      agent: name,
      runs: runs.length,
      health: hist.health,
      productive: tally[VERDICTS.PRODUCTIVE] || 0,
      idle_correct: tally[VERDICTS.IDLE_CORRECT] || 0,
      skipped_for_cause: tally[VERDICTS.SKIPPED_FOR_CAUSE] || 0,
      failed_to_act: tally[VERDICTS.FAILED_TO_ACT] || 0,
      unverifiable: tally[VERDICTS.UNVERIFIABLE] || 0,
      errors: tally[VERDICTS.ERROR] || 0,
      consecutive_bad: hist.consecutive_bad,
      reason: hist.reason,
      last_run: runs[0]?.created_at || null,
    });
  }

  agents.sort((a, b) => {
    const rank = { down: 0, degraded: 1, idle_ok: 2, healthy: 3 };
    return (rank[a.health] - rank[b.health]) || (b.runs - a.runs);
  });

  const summary = {
    window_days: days,
    total_jobs: (data || []).length,
    agents_observed: agents.length,
    down: agents.filter((a) => a.health === 'down').length,
    degraded: agents.filter((a) => a.health === 'degraded').length,
    idle_ok: agents.filter((a) => a.health === 'idle_ok').length,
    healthy: agents.filter((a) => a.health === 'healthy').length,
    jobs_productive: agents.reduce((n, a) => n + a.productive, 0),
    jobs_correctly_idle: agents.reduce((n, a) => n + a.idle_correct + a.skipped_for_cause, 0),
    jobs_wrongly_idle: agents.reduce((n, a) => n + a.unverifiable + a.failed_to_act, 0),
    scanned_at: new Date().toISOString(),
  };
  return { summary, agents };
}

if (require.main === module) {
  const days = Number(process.argv.find((a) => /^\d+$/.test(a))) || 30;
  const asJson = process.argv.includes('--json');
  scan({ days })
    .then(({ summary, agents }) => {
      if (asJson) { console.log(JSON.stringify({ summary, agents }, null, 2)); return; }
      console.log(`\nOUTCOME SCAN · ${days}d · ${summary.total_jobs} non-demo jobs · ${summary.agents_observed} agents\n`);
      console.log(`  DOWN ${summary.down}   degraded ${summary.degraded}   idle_ok ${summary.idle_ok}   healthy ${summary.healthy}`);
      console.log(`  jobs: ${summary.jobs_productive} productive · ${summary.jobs_correctly_idle} correctly idle · ${summary.jobs_wrongly_idle} WRONGLY idle\n`);
      const pad = (s, n) => String(s).padEnd(n);
      console.log(`  ${pad('AGENT', 30)}${pad('HEALTH', 10)}${pad('RUNS', 6)}${pad('PROD', 6)}${pad('IDLE', 6)}${pad('FAIL', 6)}${pad('UNVER', 6)}REASON`);
      for (const a of agents) {
        const flag = a.health === 'down' ? '!!' : a.health === 'degraded' ? ' *' : '  ';
        console.log(`${flag}${pad(a.agent, 30)}${pad(a.health, 10)}${pad(a.runs, 6)}${pad(a.productive, 6)}${pad(a.idle_correct + a.skipped_for_cause, 6)}${pad(a.failed_to_act, 6)}${pad(a.unverifiable, 6)}${a.reason}`);
      }
      console.log('');
    })
    .catch((err) => { console.error(`outcome-scan failed: ${err.message}`); process.exit(1); });
}

module.exports = { scan };
