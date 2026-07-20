import { b64uEnc, norm, json } from './_push.js';

// Guarda la suscripción push de un dispositivo, indexada por el NOMBRE del usuario.
// Same-origin desde la PWA: sin CORS. Una persona puede tener varios dispositivos.
export async function onRequestPost({ request, env }) {
  let d;
  try { d = await request.json(); } catch (e) { return json({ ok: false, error: 'json' }, 400); }
  const nombre = norm(d.nombre);
  const sub = d.subscription;
  if (!nombre || !sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return json({ ok: false, error: 'params' }, 400);
  }
  const hash = b64uEnc(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint))).slice(0, 16);
  await env.SUBS.put('sub:' + nombre + ':' + hash,
    JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys, nombre: String(d.nombre), ts: Date.now() }));
  return json({ ok: true });
}
