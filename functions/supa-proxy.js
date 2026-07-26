import { json } from './_push.js';

// Puente para las ESCRITURAS de sincronizarSupabase() (api.js del CRM) hacia Postgres.
// Por qué existe: Apps Script's UrlFetchApp SIEMPRE manda su propio User-Agent
// ("Mozilla/5.0 (compatible; Google-Apps-Script; ...)") sin importar qué headers se pasen —
// no se puede spoofear. Supabase bloquea la service_role key con "Forbidden use of secret
// API key in browser" en cuanto detecta "Mozilla" en el UA. Cloudflare Workers (este archivo)
// NO manda ese patrón, así que el mismo secreto SÍ funciona desde acá — igual que ya funciona
// en functions/datos.js (carril de LECTURA). Este archivo es el equivalente para ESCRITURA.
// Protegido por SYNC_SECRET (mismo secreto que sync.js, ya sembrado en Cloudflare y en
// Script Properties del CRM). La PWA nunca llama acá.
export async function onRequestPost({ request, env }) {
  let d;
  try { d = await request.json(); } catch (e) { return json({ error: 'json' }, 400); }
  if (!env.SYNC_SECRET || d.secret !== env.SYNC_SECRET) return json({ error: 'secret' }, 403);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'sin config Supabase' }, 500);

  const metodo = String(d.metodo || 'GET').toUpperCase();
  const ruta = String(d.ruta || '');
  if (!ruta) return json({ error: 'sin ruta' }, 400);

  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY };
  if (d.prefer) headers.Prefer = d.prefer;
  if (d.body !== undefined && d.body !== null) headers['Content-Type'] = 'application/json';

  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + ruta, {
    method: metodo,
    headers,
    body: (d.body !== undefined && d.body !== null) ? JSON.stringify(d.body) : undefined,
  });
  const texto = await r.text();
  return new Response(texto, { status: r.status, headers: { 'Content-Type': 'application/json' } });
}
