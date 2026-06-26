'use strict';

/**
 * Minimal chainable Supabase-style query stub for unit tests.
 * `handler(ops)` receives { table, filters[], single, op, row } and returns
 * either an array of rows, or a number (treated as an exact count for
 * head:true count queries).
 */
function makeDb(handler) {
  function builder(table) {
    const ops = { table, filters: [], single: false, op: 'select', row: null };
    const b = {
      select() { return b; },
      eq(c, v) { ops.filters.push(['eq', c, v]); return b; },
      in(c, v) { ops.filters.push(['in', c, v]); return b; },
      or(s) { ops.filters.push(['or', s]); return b; },
      gte(c, v) { ops.filters.push(['gte', c, v]); return b; },
      lte(c, v) { ops.filters.push(['lte', c, v]); return b; },
      is(c, v) { ops.filters.push(['is', c, v]); return b; },
      not(c, o, v) { ops.filters.push(['not', c, o, v]); return b; },
      ilike(c, v) { ops.filters.push(['ilike', c, v]); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { ops.single = true; return b; },
      upsert(row) { ops.op = 'upsert'; ops.row = row; return b; },
      insert(row) { ops.op = 'insert'; ops.row = row; return b; },
      delete() { ops.op = 'delete'; return b; },
      then(resolve, reject) {
        try {
          const r = handler(ops);
          if (typeof r === 'number') return resolve({ data: ops.single ? null : [], count: r, error: null });
          const rows = r || [];
          return resolve({ data: ops.single ? (rows[0] ?? null) : rows, count: rows.length, error: null });
        } catch (e) { return reject ? reject(e) : resolve({ data: null, error: e }); }
      },
    };
    return b;
  }
  return { from: (t) => builder(t) };
}

/** Did this query include eq(col, val)? */
function hasEq(ops, col, val) {
  return ops.filters.some((f) => f[0] === 'eq' && f[1] === col && (val === undefined || f[2] === val));
}
function hasFilterType(ops, type) {
  return ops.filters.some((f) => f[0] === type);
}

module.exports = { makeDb, hasEq, hasFilterType };
