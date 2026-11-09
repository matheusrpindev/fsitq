// Firebase falso em memória (só o que o módulo usa)
(function () {
  const store = {}; const ouvintes = {};
  let seq = 0;
  const novoId = () => 'id' + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);
  const SENT = { __ts: true };
  const ts = () => { const ms = Date.now() + seq; return { toMillis: () => ms }; };
  const resolver = (v) => {
    if (v === SENT) return ts();
    if (Array.isArray(v)) return v.map(resolver);
    if (v && typeof v === 'object' && !v.toMillis) { const o = {}; for (const k in v) o[k] = resolver(v[k]); return o; }
    return v;
  };
  const clonar = (v) => (v && typeof v === 'object' && !v.toMillis) ? (Array.isArray(v) ? v.map(clonar) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clonar(x)]))) : v;
  const col = (n) => (store[n] = store[n] || new Map());
  const avisar = (n) => setTimeout(() => (ouvintes[n] || []).forEach(f => f(snap(n))), 0);
  const snap = (n) => ({ docs: [...col(n)].map(([id, d]) => ({ id, data: () => clonar(d) })) });
  function docRef(n, id) {
    id = id || novoId();
    return {
      id,
      set(d) { col(n).set(id, resolver(d)); avisar(n); return Promise.resolve(); },
      update(d) { if (!col(n).has(id)) return Promise.reject(new Error('nao existe ' + id)); col(n).set(id, { ...col(n).get(id), ...resolver(d) }); avisar(n); return Promise.resolve(); },
      delete() { col(n).delete(id); avisar(n); return Promise.resolve(); }
    };
  }
  const db = {
    collection(n) {
      return {
        doc: (id) => docRef(n, id),
        add: (d) => { const r = docRef(n); return r.set(d).then(() => r); },
        onSnapshot(ok) { (ouvintes[n] = ouvintes[n] || []).push(ok); setTimeout(() => ok(snap(n)), 5); return () => {}; }
      };
    },
    batch() {
      const ops = [];
      return {
        set: (r, d) => ops.push(() => r.set(d)),
        update: (r, d) => ops.push(() => r.update(d)),
        delete: (r) => ops.push(() => r.delete()),
        commit: async () => { window.__escritas = (window.__escritas || 0) + ops.length; for (const o of ops) await o(); }
      };
    }
  };
  window.firebase = { firestore: { FieldValue: { serverTimestamp: () => SENT } } };
  window.__db = db; window.__store = store;
})();
