// Cerebro de lectura de la PWA. Dos carriles:
//  1) Supabase EN VIVO (solo para c=unidades, 26/07/2026): Postgres real, siempre fresco, sin
//     depender de la foto de 2×/día. Requiere SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (secrets).
//  2) D1 (foto JSON precalculada por Apps Script, ~100 ms) para TODO lo demás — sin cambios.
// Si el carril Supabase falla por lo que sea (Supabase caído, dato raro, credencial no resuelta),
// cae al carril D1 de siempre, y si tampoco hay foto, 204 y la app usa el Apps Script en vivo.
// Nunca es fuente de verdad: es un acelerador. Nunca debe poder romper la app.
const SIN = { 'Cache-Control': 'no-store' };
const MESES_LARGO = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const MESES_CORTO = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

async function hashToken(token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Carril Supabase (solo c=unidades) — espejo de _apiUnidades_/_apiEstadoUnidad_/
// _apiPerfUnidad_ en api.js del CRM. Ver docs/migracion-supabase en el repo del CRM.
// ---------------------------------------------------------------------------

// Hora de Ecuador (UTC-5 fijo, sin horario de verano). Cloudflare Workers corre en UTC;
// sin este corrimiento "hoy" queda mal desde ~19:00 hora Ecuador en adelante.
function hoyEcuador() {
  const ahora = new Date(Date.now() - 5 * 3600 * 1000);
  return new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate()));
}

// "YYYY-MM-DD" (columna `date` de Postgres) -> Date a medianoche UTC, mismo marco que hoyEcuador().
function fechaUTC(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

// Escapa valores para un filtro in.(...) de PostgREST. Los códigos de unidad reales solo
// llevan letras/dígitos/espacio (nunca coma/comillas) — basta comillar+codificar el espacio.
function pgListaUnidades(codigos) {
  return codigos.map(c => (/\s/.test(c) ? `"${c.replace(/ /g, '%20')}"` : c)).join(',');
}

async function supaFetch(env, tabla, query) {
  const url = `${env.SUPABASE_URL}/rest/v1/${tabla}?${query}`;
  const r = await fetch(url, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!r.ok) throw new Error(`Supabase ${tabla} ${r.status}: ${await r.text()}`);
  return r.json();
}

// Espejo exacto de _apiEstadoUnidad_ (api.js:1254 del CRM).
function estadoUnidad(reservas, hoy0) {
  const out = { estado: 'libre', huesped: '', hasta: '', proximaLlegada: '', proximoHuesped: '', saleHoy: '', llegaHoy: '' };
  let mejorProx = null;
  for (const r of reservas) {
    const ci = fechaUTC(r.fecha_inicio), co = fechaUTC(r.fecha_fin);
    if (!ci || !co) continue;
    const nombre = r.huesped || '';
    if (ci.getTime() <= hoy0.getTime() && hoy0.getTime() < co.getTime()) {
      out.estado = (co.getTime() - hoy0.getTime() === 86400000) ? 'checkout_manana' : 'ocupada';
      out.huesped = nombre; out.hasta = r.fecha_fin;
      if (co.getTime() === hoy0.getTime()) out.estado = 'checkout_hoy';
    }
    if (co.getTime() === hoy0.getTime()) {
      out.estado = 'checkout_hoy';
      out.huesped = out.huesped || nombre;
      out.hasta = out.hasta || r.fecha_fin;
      out.saleHoy = out.saleHoy || nombre;
    }
    if (ci.getTime() === hoy0.getTime()) { out.estado = 'llegada_hoy'; out.proximaLlegada = r.fecha_inicio; out.proximoHuesped = nombre; out.llegaHoy = nombre; }
    if (ci.getTime() > hoy0.getTime() && (!mejorProx || ci.getTime() < mejorProx.getTime())) {
      mejorProx = ci; out.proximaLlegada = r.fecha_inicio; out.proximoHuesped = nombre;
    }
  }
  return out;
}

// Espejo exacto de _apiPerfUnidad_ (api.js:2137 del CRM).
function perfUnidad(reservas, hoy0, profundasMes) {
  const N = 3;
  const mesIdx = hoy0.getUTCMonth(), anioAct = hoy0.getUTCFullYear();
  const buckets = {}, orden = [];
  for (let k = N - 1; k >= 0; k--) {
    const dm = new Date(Date.UTC(anioAct, mesIdx - k, 1));
    const key = dm.getUTCFullYear() + '-' + dm.getUTCMonth();
    buckets[key] = { label: MESES_CORTO[dm.getUTCMonth()], reservas: 0, ingreso: 0, noches: 0, cinco: 0 };
    orden.push(key);
  }
  let ref12Monto = 0, ref12Noches = 0, limpMTD = 0;
  const desde12 = new Date(Date.UTC(anioAct, mesIdx - 12, hoy0.getUTCDate()));
  const mesIni = new Date(Date.UTC(anioAct, mesIdx, 1));
  for (const r of reservas) {
    const ci = fechaUTC(r.fecha_inicio), co = fechaUTC(r.fecha_fin);
    const monto = Number(r.ingresos_brutos) || 0;
    if (ci && co && monto > 0) {
      const kIn = ci.getUTCFullYear() + '-' + ci.getUTCMonth();
      if (buckets[kIn]) { buckets[kIn].reservas++; buckets[kIn].ingreso += monto; }
      const dd = new Date(ci.getTime()); let g = 0;
      while (dd.getTime() < co.getTime() && g < 400) {
        const kN = dd.getUTCFullYear() + '-' + dd.getUTCMonth();
        if (buckets[kN]) buckets[kN].noches++;
        dd.setUTCDate(dd.getUTCDate() + 1); g++;
      }
      if (ci.getTime() >= desde12.getTime() && ci.getTime() <= hoy0.getTime()) {
        const n12 = Math.round((co.getTime() - ci.getTime()) / 86400000);
        if (n12 > 0) { ref12Monto += monto; ref12Noches += n12; }
      }
    }
    if (co && r.codigo_confirmacion && co.getTime() >= mesIni.getTime() && co.getTime() <= hoy0.getTime()) limpMTD++;
    if (r.fecha_resena && r.estrellas != null) {
      const fr = fechaUTC(r.fecha_resena);
      const est = Number(r.estrellas);
      if (fr && !isNaN(est) && est >= 5) {
        const kR = fr.getUTCFullYear() + '-' + fr.getUTCMonth();
        if (buckets[kR]) buckets[kR].cinco++;
      }
    }
  }
  const adr12 = ref12Noches > 0 ? Math.round(ref12Monto / ref12Noches) : 0;
  const serie = orden.map(key => {
    const b = buckets[key];
    return { label: b.label, reservas: b.reservas, adr: b.noches > 0 ? Math.round(b.ingreso / b.noches) : 0, cinco: b.cinco };
  });
  const last = serie[serie.length - 1];
  return {
    mes: MESES_LARGO[mesIdx], reservasMes: last.reservas, adrMes: last.adr || adr12, adr12,
    cincoMes: last.cinco, profundasMes: profundasMes || 0, limpiezasMes: limpMTD, serie,
  };
}

// token -> {hoy, unidades:[...]} igual que _apiUnidades_, o null si no se pudo resolver
// (login no encontrado, sin config de Supabase, etc.) — null SIEMPRE cae al carril D1.
async function resolverUnidadesDesdeSupabase(token, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const digitos = String(token || '').replace(/\D/g, '');
  if (digitos.length < 4) return null;
  const end4 = digitos.slice(-4);

  const personas = await supaFetch(env, 'equipo', `cedula_end4=eq.${end4}&activo=eq.true&select=id,rol,es_directivo`);
  if (personas.length !== 1) return null; // 0 o colisión de 4 dígitos -> nadie entra por acá (igual que _apiAuthPorId_)
  const persona = personas[0];

  const asignaciones = await supaFetch(env, 'equipo_unidad', `persona_id=eq.${persona.id}&select=unidad`);
  const codigos = asignaciones.map(a => a.unidad);
  if (!codigos.length) return null;

  const puedeVerCifras = persona.rol === 'ceo' || persona.es_directivo === true;
  const hoy0 = hoyEcuador();
  const inicioVentana = new Date(Date.UTC(hoy0.getUTCFullYear(), hoy0.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
  const mesIniIso = new Date(Date.UTC(hoy0.getUTCFullYear(), hoy0.getUTCMonth(), 1)).toISOString();
  const lista = pgListaUnidades(codigos);

  const [unidadesRows, reservasRows, fichasRows, limpiezaRows] = await Promise.all([
    supaFetch(env, 'unidades', `codigo=in.(${lista})&select=codigo,foto_url,bot_activo,en_reportes`),
    supaFetch(env, 'reservas', `unidad=in.(${lista})&cancelada=eq.false&fecha_fin=gte.${inicioVentana}&select=unidad,huesped,fecha_inicio,fecha_fin,ingresos_brutos,codigo_confirmacion,estrellas,fecha_resena`),
    supaFetch(env, 'fichas_unidad', `unidad=in.(${lista})&select=unidad,foto`),
    supaFetch(env, 'limpieza_profunda', `unidad=in.(${lista})&fecha_registro=gte.${encodeURIComponent(mesIniIso)}&estado=not.in.(VISITA,RECHAZADA)&select=unidad`),
  ]);

  const fotoPorUnidad = {};
  fichasRows.forEach(f => { fotoPorUnidad[f.unidad] = f.foto; });
  const profundasPorUnidad = {};
  limpiezaRows.forEach(r => { profundasPorUnidad[r.unidad] = (profundasPorUnidad[r.unidad] || 0) + 1; });

  const unidades = unidadesRows.map(u => {
    const reservasU = reservasRows.filter(r => r.unidad === u.codigo);
    const e = estadoUnidad(reservasU, hoy0);
    return {
      unidad: u.codigo, ...e,
      foto: fotoPorUnidad[u.codigo] || u.foto_url || '',
      botActivo: !!u.bot_activo, enReportes: !!u.en_reportes,
      perf: puedeVerCifras ? perfUnidad(reservasU, hoy0, profundasPorUnidad[u.codigo] || 0) : null,
    };
  });

  return { hoy: hoy0.toISOString().slice(0, 10), unidades };
}

// ---------------------------------------------------------------------------

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const token = String(u.searchParams.get('token') || '').trim();
  const c = String(u.searchParams.get('c') || '').trim().toLowerCase();
  // [a-z0-9:] y no solo [a-z] (22/07/2026): las fotos de REPORTES usan claves compuestas
  // "reportepng:<slug>:<o|m>" — con el regex viejo se rechazaban antes de mirar D1.
  if (!token || !/^[a-z0-9:]+$/.test(c)) return new Response(null, { status: 204, headers: SIN });

  if (c === 'unidades') {
    try {
      const payload = await resolverUnidadesDesdeSupabase(token, env);
      if (payload) {
        return new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Fuente': 'supabase' }
        });
      }
    } catch (e) {
      // Cualquier falla acá (Supabase caído, dato raro, lo que sea) cae al carril D1 de abajo.
      // Nunca debe romper la app: peor caso, se comporta exactamente como hoy.
    }
  }

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
