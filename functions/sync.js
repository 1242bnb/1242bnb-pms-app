import { json } from './_push.js';

// Recibe de Apps Script (sincronizarSnapshots en api.js del CRM) el lote de "fotos" JSON
// precalculadas y las guarda en D1 (tabla snapshots). Protegida por el secreto compartido
// SYNC_SECRET (mismo patrón que SEND_SECRET del push). La app NUNCA llama acá.
export async function onRequestPost({ request, env }) {
  let d;
  try { d = await request.json(); } catch (e) { return json({ ok: false, error: 'json' }, 400); }
  if (!env.SYNC_SECRET || d.secret !== env.SYNC_SECRET) return json({ ok: false, error: 'secret' }, 403);

  // [a-z0-9:] tras el hash (22/07/2026): las fotos de REPORTES llegan como <hash>:reportepng:<slug>:<o|m>.
  // Con el regex viejo se DESCARTABAN acá en silencio (guardados contaba de menos y nadie veía por qué).
  const items = (Array.isArray(d.items) ? d.items : [])
    .filter(it => it && typeof it.clave === 'string' && /^[0-9a-f]{16}:[a-z0-9:]+$/.test(it.clave) && typeof it.json === 'string')
    .slice(0, 200);
  if (!items.length) return json({ ok: true, guardados: 0 });

  const ahora = Date.now();
  const stmt = env.DB.prepare(
    'INSERT INTO snapshots (clave, json, actualizado) VALUES (?1, ?2, ?3) ' +
    'ON CONFLICT(clave) DO UPDATE SET json = excluded.json, actualizado = excluded.actualizado'
  );
  await env.DB.batch(items.map(it => stmt.bind(it.clave, it.json, ahora)));
  return json({ ok: true, guardados: items.length });
}
