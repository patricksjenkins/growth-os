/**
 * Minimal in-memory Supabase-style client for AI-safety unit tests.
 * Supports exactly the query shapes the safety modules use:
 *   from(t).insert(rows[.select(cols)][.single()])
 *   from(t).select(cols, {count, head}).eq/gte/lte/in/order/limit[.single/.maybeSingle]
 *   from(t).update(patch).eq(...)[.select().single()]
 *
 * Backed by a shared `store` object so multiple "client" instances (simulating
 * two Railway workers) read/write the SAME data — proving DB-backed counters
 * are shared across processes and survive a simulated restart.
 */

'use strict';
const crypto = require('crypto');

class QB {
  constructor(store, table) {
    this.store = store; this.table = table;
    this._op = null; this._rows = null; this._patch = null;
    this._filters = []; this._count = false; this._head = false;
    this._limit = null; this._selectCols = null;
  }
  _tableRows() { return (this.store[this.table] = this.store[this.table] || []); }
  insert(rows) { this._op = 'insert'; this._rows = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this._op = 'update'; this._patch = patch; return this; }
  select(cols, opts) {
    if (!this._op) this._op = 'select';
    this._selectCols = cols;
    if (opts && opts.count) this._count = true;
    if (opts && opts.head) this._head = true;
    return this;
  }
  eq(col, val) { this._filters.push((r) => r[col] === val); return this; }
  gte(col, val) { this._filters.push((r) => r[col] >= val); return this; }
  lte(col, val) { this._filters.push((r) => r[col] <= val); return this; }
  in(col, vals) { this._filters.push((r) => vals.includes(r[col])); return this; }
  or() { return this; }
  order() { return this; }
  limit(n) { this._limit = n; return this; }
  single() { this._single = true; return this._resolve(); }
  maybeSingle() { this._maybe = true; return this._resolve(); }
  then(onF, onR) { return this._resolve().then(onF, onR); }

  async _resolve() {
    const rows = this._tableRows();
    if (this._op === 'insert') {
      const inserted = this._rows.map((r) => ({ id: r.id || crypto.randomUUID(), created_at: r.created_at || new Date().toISOString(), ...r }));
      rows.push(...inserted);
      if (this._single) return { data: inserted[0], error: null };
      return { data: inserted, error: null };
    }
    let filtered = rows.filter((r) => this._filters.every((f) => f(r)));
    if (this._op === 'update') {
      filtered.forEach((r) => Object.assign(r, this._patch));
      if (this._single) return { data: filtered[0] || null, error: filtered[0] ? null : { message: 'no rows' } };
      return { data: filtered, error: null };
    }
    // select
    if (this._head && this._count) return { data: null, count: filtered.length, error: null };
    if (this._limit) filtered = filtered.slice(0, this._limit);
    if (this._single) return { data: filtered[0] || null, error: filtered.length ? null : { message: 'no rows' } };
    if (this._maybe) return { data: filtered[0] || null, error: null };
    return { data: filtered, count: this._count ? filtered.length : undefined, error: null };
  }
}

function makeClient(store) {
  return { from: (table) => new QB(store, table) };
}

module.exports = { makeClient };
