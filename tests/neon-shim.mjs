// Stand-in for @neondatabase/serverless neon() — same tagged-template + transaction API,
// executed against the in-memory PGlite in globalThis.__PGLITE__. Tests only — never deployed.
const db = () => globalThis.__PGLITE__;
globalThis.__QUERY_COUNT__ = 0;
// Like the real driver, a query embedded in another query is inlined as SQL
// (its parameters renumbered), not sent as a value.
function build(strings, values, out = { text: '', params: [] }) {
  strings.forEach((str, i) => {
    out.text += str;
    if (i >= values.length) return;
    const v = values[i];
    if (v && v.__t) build(v.__t.strings, v.__t.values, out);
    else { out.params.push(v); out.text += '$' + out.params.length; }
  });
  return out;
}
function makeQuery(strings, values) {
  let p, q;
  const query = () => (q ??= build(strings, values));
  const run = () => (p ??= (globalThis.__QUERY_COUNT__++, db().query(query().text, query().params).then((r) => r.rows)));
  return { __t: { strings, values }, get __q() { return query(); }, then: (a, b) => run().then(a, b), catch: (b) => run().catch(b) };
}
export function neon() {
  const sql = (strings, ...values) => makeQuery(strings, values);
  sql.transaction = async (queries, opts = {}) => {
    globalThis.__QUERY_COUNT__++; // one HTTP round trip for the whole transaction
    return db().transaction(async (tx) => {
      if (opts.readOnly) await tx.query('SET TRANSACTION READ ONLY');
      const out = [];
      for (const q of queries) out.push((await tx.query(q.__q.text, q.__q.params)).rows);
      return out;
    });
  };
  return sql;
}
