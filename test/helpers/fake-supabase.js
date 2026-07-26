'use strict';

/**
 * A Supabase test double you can EXECUTE code against.
 *
 * WHY THIS EXISTS
 * Codex, 2026-07-26 (round 3): "11 of the 12 newly added tests merely search
 * source code for phrases. Only nested classification is behaviorally executed,
 * which is why the fee ReferenceError, retry loss, Finance Head crash, and
 * API/UI break all passed."
 *
 * That is the correct diagnosis. A test that greps for `feeError` finds the
 * string whether or not the variable is in scope. A test that CALLS the
 * function gets `ReferenceError: feeError is not defined` — which is exactly
 * what production got, on every real payment, while the suite stayed green.
 *
 * So: no more asserting on source text. The finance handlers all take their
 * client as an argument, which makes them directly callable — this supplies a
 * client whose every response is programmable, including failures.
 *
 * Deliberately NOT a Promise-returning builder: the real Supabase builder is a
 * thenable with no `.catch()`, and code that assumes otherwise has broken
 * production here before (see reference_supabase_builder_catch). The double
 * reproduces that shape so the mistake fails in tests too.
 */

function fakeSupabase(spec = {}) {
  const calls = [];
  const tables = spec.tables || {};

  function resolve(state) {
    const handler = tables[state.table];
    if (!handler) {
      throw new Error(
        `fake-supabase: no stub for table "${state.table}" (op=${state.op}). `
        + 'Add one to the spec — an unstubbed table means the test does not '
        + 'actually know what the code under test is reading.',
      );
    }
    const fn = handler[state.op];
    if (typeof fn !== 'function') {
      if (fn === undefined) throw new Error(`fake-supabase: table "${state.table}" has no "${state.op}" stub`);
      return fn;
    }
    return fn(state, calls);
  }

  function builder(table, op, payload) {
    const state = { table, op, payload, filters: [], single: null };
    calls.push(state);
    const b = {
      select(cols) { state.columns = cols; return b; },
      eq(k, v) { state.filters.push(['eq', k, v]); return b; },
      neq(k, v) { state.filters.push(['neq', k, v]); return b; },
      gte(k, v) { state.filters.push(['gte', k, v]); return b; },
      lte(k, v) { state.filters.push(['lte', k, v]); return b; },
      in(k, v) { state.filters.push(['in', k, v]); return b; },
      is(k, v) { state.filters.push(['is', k, v]); return b; },
      not(k, o, v) { state.filters.push(['not', k, v, o]); return b; },
      filter(k, o, v) { state.filters.push([o, k, v]); return b; },
      order(k, o) { state.order = [k, o]; return b; },
      limit(n) { state.limit = n; return b; },
      maybeSingle() { state.single = 'maybe'; return b; },
      single() { state.single = 'one'; return b; },
      // Thenable, NOT a Promise: no .catch, exactly like the real builder.
      then(onOk, onErr) {
        let out;
        try {
          out = resolve(state);
        } catch (err) {
          return Promise.reject(err).then(onOk, onErr);
        }
        return Promise.resolve(out).then(onOk, onErr);
      },
    };
    return b;
  }

  return {
    calls,
    from(table) {
      return {
        select(cols) { return builder(table, 'select', null).select(cols); },
        insert(row) { return builder(table, 'insert', row); },
        update(row) { return builder(table, 'update', row); },
        upsert(row) { return builder(table, 'upsert', row); },
        delete() { return builder(table, 'delete', null); },
      };
    },
    async rpc(name, args) {
      const state = { table: `rpc:${name}`, op: 'rpc', payload: args, filters: [] };
      calls.push(state);
      const fn = (spec.rpc || {})[name];
      if (!fn) return { data: null, error: null };
      return fn(args, calls);
    },
    /** Every write attempted against a table, in order. */
    writes(table) {
      return calls.filter((c) => c.table === table && ['insert', 'update', 'upsert'].includes(c.op));
    },
    rpcCalls(name) {
      return calls.filter((c) => c.table === `rpc:${name}`);
    },
  };
}

/** Install a stub `stripe` module so lazy `require('stripe')` calls resolve to it. */
function stubStripeModule(impl) {
  const path = require.resolve('stripe');
  const previous = require.cache[path];
  require.cache[path] = { id: path, filename: path, loaded: true, exports: () => impl };
  return function restore() {
    if (previous) require.cache[path] = previous;
    else delete require.cache[path];
  };
}

module.exports = { fakeSupabase, stubStripeModule };
