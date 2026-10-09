/** Wraps a D1 binding to count executed statements (each statement in a batch counts once). */
export function countingD1(db: D1Database): { db: D1Database; queries: () => number } {
  let n = 0;
  const counted = new WeakMap<object, D1PreparedStatement>();

  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (prop === "run" || prop === "all" || prop === "first" || prop === "raw") {
          return (...args: unknown[]) => {
            n++;
            return (target as any)[prop](...args);
          };
        }
        const value = (target as any)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    counted.set(proxy, stmt);
    return proxy;
  };

  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          n += stmts.length;
          return target.batch(stmts.map((s) => counted.get(s) ?? s));
        };
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, queries: () => n };
}
