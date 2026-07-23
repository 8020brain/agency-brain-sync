/*
 * Agency Brain vault Worker.
 *
 * A dumb, bearer-gated blob store in front of an R2 bucket. It ONLY ever sees
 * ciphertext — the brain encrypts every bundle client-side before upload, and
 * decrypts client-side after download, so this Worker never handles plaintext
 * or the encryption key. It exists purely to add an authenticated access layer
 * (login/revoke) in front of R2, the way the gads-proxy does for Google Ads.
 *
 * This file is deployed to the AGENCY'S OWN Cloudflare account. The bearer token
 * and the bucket are theirs. Nothing here is secret (no token is hardcoded — it
 * comes from the VAULT_TOKEN secret), so it is safe to ship in a public repo.
 *
 *   GET    /<object>   -> 200 blob | 404
 *   PUT    /<object>   -> 200 (stores the request body)
 *   DELETE /<object>   -> 200
 *
 * Bindings (see wrangler.toml.example):
 *   BUCKET        R2 bucket binding
 *   VAULT_TOKEN   secret; the bearer token the brain sends
 */

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authed(request, env) {
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || !env.VAULT_TOKEN) return false;
  return timingSafeEqual(m[1], env.VAULT_TOKEN);
}

export default {
  async fetch(request, env) {
    if (!authed(request, env)) {
      return new Response('unauthorized', { status: 401 });
    }
    const url = new URL(request.url);
    const object = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (!object) return new Response('missing object key', { status: 400 });

    switch (request.method) {
      case 'GET': {
        const obj = await env.BUCKET.get(object);
        if (!obj) return new Response('not found', { status: 404 });
        return new Response(obj.body, {
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }
      case 'PUT': {
        await env.BUCKET.put(object, request.body);
        return new Response('ok', { status: 200 });
      }
      case 'DELETE': {
        await env.BUCKET.delete(object);
        return new Response('ok', { status: 200 });
      }
      default:
        return new Response('method not allowed', { status: 405 });
    }
  },
};
