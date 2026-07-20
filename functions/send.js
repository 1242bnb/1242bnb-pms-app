import { enviarPush, norm, json } from './_push.js';

// Envía una notificación a uno o varios usuarios (por nombre). Protegido por SEND_SECRET.
// Lo llama el CRM (Apps Script) cuando ocurre un evento. Borra suscripciones muertas (404/410).
export async function onRequestPost({ request, env }) {
  let d;
  try { d = await request.json(); } catch (e) { return json({ ok: false, error: 'json' }, 400); }
  if (d.secret !== env.SEND_SECRET) return json({ ok: false, error: 'auth' }, 403);
  const destinos = (Array.isArray(d.to) ? d.to : [d.to]).map(norm).filter(Boolean);
  if (!destinos.length) return json({ ok: false, error: 'params' }, 400);
  const mensaje = JSON.stringify({
    title: String(d.title || '1242BNB'), body: String(d.body || ''),
    url: String(d.url || '/'), tag: String(d.tag || '')
  });
  let enviados = 0, borrados = 0, fallos = 0;
  for (const nombre of destinos) {
    const list = await env.SUBS.list({ prefix: 'sub:' + nombre + ':' });
    for (const k of list.keys) {
      const raw = await env.SUBS.get(k.name);
      if (!raw) continue;
      try {
        const resp = await enviarPush(JSON.parse(raw), mensaje, env);
        if (resp.status === 404 || resp.status === 410) { await env.SUBS.delete(k.name); borrados++; }
        else if (resp.ok || resp.status === 201) enviados++;
        else fallos++;
      } catch (e) { fallos++; }
    }
  }
  return json({ ok: true, enviados, borrados, fallos });
}
