'use strict';
/*
 * The transport is the thin layer that moves ONE encrypted blob to and from the
 * store. The default talks to the owner's own bearer-gated Cloudflare Worker
 * (the gads-proxy pattern generalised); the Worker fronts their own R2 bucket.
 *
 * It's a tiny interface — { get, put, del } — on purpose, so tests can inject an
 * in-memory or on-disk transport and exercise the whole push/pull/scrub cycle
 * with no network. The Worker only ever sees ciphertext, so it is a dumb
 * authenticated blob store; all crypto happens client-side (crypto.cjs).
 */

// Build the HTTP transport for a given Worker URL + bearer token.
// Uses global fetch (Node 18+ / Electron both have it).
function httpTransport({ workerUrl, token }) {
  if (!workerUrl) throw new Error('vault: no Worker URL configured (run `vault setup`)');
  if (!token) throw new Error('vault: no vault token configured (run `vault setup`)');
  const base = workerUrl.replace(/\/+$/, '');
  const auth = { Authorization: `Bearer ${token}` };

  function urlFor(object) {
    return `${base}/${encodeURIComponent(object)}`;
  }

  return {
    // -> Buffer, or null if the object doesn't exist yet (404).
    async get(object) {
      const r = await fetch(urlFor(object), { headers: auth });
      if (r.status === 404) return null;
      if (r.status === 401 || r.status === 403) {
        throw new Error('vault: the Worker rejected the token (401/403) — check or rotate your vault token');
      }
      if (!r.ok) throw new Error(`vault: fetch failed (${r.status})`);
      const ab = await r.arrayBuffer();
      return Buffer.from(ab);
    },
    async put(object, buffer) {
      const r = await fetch(urlFor(object), {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/octet-stream' },
        body: buffer,
      });
      if (r.status === 401 || r.status === 403) {
        throw new Error('vault: the Worker rejected the token (401/403) — check or rotate your vault token');
      }
      if (!r.ok) throw new Error(`vault: upload failed (${r.status})`);
      return true;
    },
    async del(object) {
      const r = await fetch(urlFor(object), { method: 'DELETE', headers: auth });
      if (!r.ok && r.status !== 404) throw new Error(`vault: delete failed (${r.status})`);
      return true;
    },
  };
}

// In-memory transport — used by tests and by a dry `vault setup` self-check.
function memoryTransport(store = new Map()) {
  return {
    _store: store,
    async get(object) { return store.has(object) ? Buffer.from(store.get(object)) : null; },
    async put(object, buffer) { store.set(object, Buffer.from(buffer)); return true; },
    async del(object) { store.delete(object); return true; },
  };
}

module.exports = { httpTransport, memoryTransport };
