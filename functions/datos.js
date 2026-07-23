// Cerebro de lectura de la PWA: sirve desde D1 la "foto" JSON precalculada por Apps Script
// (~100 ms desde la red de Cloudflare vs ~4 s del Apps Script en vivo). Misma seguridad que la
// API: la clave es SHA-256(token) — solo con TU token ves TU foto. Si no hay foto (o está vieja),
// 204 y la app cae al Apps Script de siempre. Nunca es fuente de verdad: es un acelerador.
const SIN = { 'Cache-Control': 'no-store' };

async function hashToken(token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const token = String(u.searchParams.get('token') || '').trim();
  const c = String(u.searchParams.get('c') || '').trim().toLowerCase();
  // [a-z0-9:] y no solo [a-z] (22/07/2026): las fotos de REPORTES usan claves compuestas
  // "reportepng:<slug>:<o|m>" — con el regex viejo se rechazaban antes de mirar D1.
  if (!token || !/^[a-z0-9:]+$/.test(c)) return new Response(null, { status: 204, headers: SIN });

  const clave = (await hashToken(token)) + ':' + c;
  const row = await env.DB.prepare('SELECT json, actualizado FROM snapshots WHERE clave = ?1').bind(clave).first();
  // Foto ausente o de hace más de 30 h (los jobs la refrescan 2 veces/día): que la app use Apps
  // Script en vivo — así un job caído jamás congela datos viejos en pantalla.
  if (!row || !row.json || Date.now() - Number(row.actualizado || 0) > 30 * 3600 * 1000) {
    return new Response(null, { status: 204, headers: SIN });
  }
  return new Response(row.json, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Snapshot': String(row.actualizado) }
  });
}

// Auto-invalidación tras una escritura F2: la app borra SUS fotos (las del hash de su token) para
// no verse a sí misma con datos de antes del cambio. Borrar solo obliga al fallback (Apps Script
// en vivo, siempre correcto) — por eso alcanza con conocer el token, sin secreto de servidor.
export async function onRequestDelete({ request, env }) {
  const u = new URL(request.url);
  const token = String(u.searchParams.get('token') || '').trim();
  if (!token) return new Response(null, { status: 204, headers: SIN });
  const hash = await hashToken(token);
  await env.DB.prepare("DELETE FROM snapshots WHERE clave LIKE ?1 || ':%'").bind(hash).run();
  return new Response(null, { status: 204, headers: SIN });
}
