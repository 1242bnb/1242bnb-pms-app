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
// equipo / equipoporunidad — espejo de _apiEquipo_/_apiEquipoPorUnidad_ (api.js del CRM).
// SIMPLIFICADO tras el cambio de roles del 26/07/2026 (ver memoria del proyecto): ya no existe
// CoHost, así que "admin puro" = cualquier persona con rol='ceo' activa (antes había que excluir
// CoHost aparte). Rutas admin/ceo por unidad son las MISMAS constantes hardcodeadas que
// _adminDeUnidad/_ceoWhatsAppDeUnidad_ en whatsapp-huesped.js del CRM — si cambian allá, cambian acá.
// ---------------------------------------------------------------------------
const UNIDADES_LADO_ANDRES = ['2A', '4A', '6A'];
const UNIDADES_CEO_CHRISTIAN = ['5A', '7A'];
const WA_ANDRES = '593998225057', WA_XAVIER = '593964250105', WA_CHRISTIAN = '19294971240';
const NOMBRE_POR_WA = { [WA_ANDRES]: 'Andrés', [WA_XAVIER]: 'Xavier', [WA_CHRISTIAN]: 'Christian' };

function adminDeUnidad(u) { return UNIDADES_LADO_ANDRES.includes(u) ? WA_ANDRES : WA_XAVIER; }
function ceoDeUnidad(u) {
  if (UNIDADES_LADO_ANDRES.includes(u)) return WA_ANDRES;
  if (UNIDADES_CEO_CHRISTIAN.includes(u)) return WA_CHRISTIAN;
  return WA_XAVIER;
}
function nombrePorWa(wa) { return NOMBRE_POR_WA[wa] || wa; }

// Resuelve la persona autenticada (cedula end-4) SIN filtrar por rol — igual criterio que
// resolverUnidadesDesdeSupabase. null si no se pudo resolver (cae a D1/en vivo).
// `es_directivo` viaja en el select (26/07/2026) para que reporteglobal pueda aplicar el mismo
// criterio de "ve cifras" que _apiAuth_ sin una segunda ida a Supabase; los demás llamadores lo ignoran.
async function resolverPersonaEquipo(token, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const digitos = String(token || '').replace(/\D/g, '');
  if (digitos.length < 4) return null;
  const end4 = digitos.slice(-4);
  const personas = await supaFetch(env, 'equipo', `cedula_end4=eq.${end4}&activo=eq.true&select=id,rol,whatsapp,es_directivo`);
  return personas.length === 1 ? personas[0] : null;
}

// Unidades visibles de un admin (mismo criterio que _apiUnidadesDe_): todas las que él administra.
// Con solo 2 admins que se reparten TODAS las unidades sin solape (Andrés=2A/4A/6A, Xavier=el
// resto), alcanza con filtrar por adminDeUnidad — no hace falta la unión con equipo_unidad de CEO.
function unidadesDeAdmin(wa, todasLasUnidades) { return todasLasUnidades.filter(u => adminDeUnidad(u) === wa); }

async function resolverEquipoDesdeSupabase(token, env) {
  const persona = await resolverPersonaEquipo(token, env);
  if (!persona) return null;                                     // no resuelto -> cae a D1
  if (persona.rol !== 'ceo') return { error: 'Solo administradores', denegado: true }; // resuelto, sin permiso -> respuesta real, no fallback

  const [unidadesRows, limpiezaRows, asigRows] = await Promise.all([
    supaFetch(env, 'unidades', 'select=codigo'),
    supaFetch(env, 'equipo', `rol=eq.limpieza&activo=eq.true&select=id,nombre,whatsapp,tope_limpiezas,descanso_domingo,clave_sheet,cedula`),
    supaFetch(env, 'equipo_unidad', 'select=persona_id,unidad'),
  ]);
  const todas = unidadesRows.map(u => u.codigo);
  const mias = unidadesDeAdmin(persona.whatsapp, todas);
  const unidadesDePersona = {};
  asigRows.forEach(a => { (unidadesDePersona[a.persona_id] = unidadesDePersona[a.persona_id] || []).push(a.unidad); });

  const limpieza = limpiezaRows.map(p => {
    const suyas = unidadesDePersona[p.id] || [];
    const pendiente = suyas.length === 0;
    const comunes = pendiente ? [] : suyas.filter(u => mias.includes(u));
    return {
      clave: p.clave_sheet || '', nombre: p.nombre, unidades: suyas.join(', '),
      tope: String(p.tope_limpiezas || 3), whatsapp: p.whatsapp || '', cedula: p.cedula || '',
      mias: comunes, pendiente,
      descansaDomingo: p.descanso_domingo !== false,
    };
  }).filter(p => p.pendiente || p.mias.length);                  // mismo filtro T15 que _apiEquipo_

  return { cohosts: [], limpieza, unidades: todas };
}

async function resolverEquipoPorUnidadDesdeSupabase(token, env) {
  const persona = await resolverPersonaEquipo(token, env);
  if (!persona) return null;
  if (persona.rol !== 'ceo') return { error: 'Solo administradores', denegado: true };

  const [limpiezaRows, asigRows] = await Promise.all([
    supaFetch(env, 'equipo', `rol=eq.limpieza&activo=eq.true&select=id,nombre`),
    supaFetch(env, 'equipo_unidad', 'select=persona_id,unidad'),
  ]);
  const nombrePorPersonaId = {};
  limpiezaRows.forEach(p => { nombrePorPersonaId[p.id] = p.nombre; });
  const limpiezaPorUnidad = {};
  asigRows.forEach(a => {
    const nombre = nombrePorPersonaId[a.persona_id];
    if (!nombre) return;
    (limpiezaPorUnidad[a.unidad] = limpiezaPorUnidad[a.unidad] || []).push(nombre);
  });

  const todas = (await supaFetch(env, 'unidades', 'select=codigo')).map(u => u.codigo);
  const mias = unidadesDeAdmin(persona.whatsapp, todas);
  const unidades = mias.map(u => ({
    unidad: u,
    ceo: nombrePorWa(ceoDeUnidad(u)),
    admin: nombrePorWa(adminDeUnidad(u)),
    cohost: '',                                                   // no hay CoHost desde el 26/07/2026
    limpieza: (limpiezaPorUnidad[u] || []).join(', '),
  }));
  return { unidades };
}

// ---------------------------------------------------------------------------
// agenda — espejo de _apiAgenda_ (api.js). La agenda es GLOBAL (no filtra por unidades del que
// pide), así que solo hace falta confirmar que el token pertenece a alguien válido. Lee
// agenda_cache de HOY (empujada por generarImagenLimpieza_ en whatsapp-huesped.js, ~5-6 AM); si no
// hay fila de hoy, null -> cae al carril D1/Apps Script en vivo de siempre.
// ---------------------------------------------------------------------------
async function resolverAgendaDesdeSupabase(token, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const persona = await resolverPersonaEquipo(token, env);
  if (!persona) return null;
  const hoyIso = hoyEcuador().toISOString().slice(0, 10);
  const rows = await supaFetch(env, 'agenda_cache', `fecha=eq.${hoyIso}&select=payload,img_url,img_fecha`);
  if (!rows.length) return null;
  const row = rows[0];
  return { ...row.payload, img: row.img_url || '', imgFecha: row.img_fecha || '' };
}

// ---------------------------------------------------------------------------
// me — espejo de _apiMe_ (api.js). SIN favoritas (retiradas del todo el 26/07/2026, decisión del
// dueño — ya no existen en el backend Apps Script ni en la PWA). El rol compuesto 'ceo_admin' que
// la PWA espera NO es un valor del enum rol_persona de Supabase (admin|ceo|cohost|limpieza) — se
// reconstruye con la MISMA regla que _apiAuth_ (whatsapp-huesped.js): esAdmin = equipo.es_directivo,
// esCEO = rol==='ceo'.
// ---------------------------------------------------------------------------
async function resolverMeDesdeSupabase(token, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const digitos = String(token || '').replace(/\D/g, '');
  if (digitos.length < 4) return null;
  const end4 = digitos.slice(-4);
  const personas = await supaFetch(env, 'equipo',
    `cedula_end4=eq.${end4}&activo=eq.true&select=id,nombre,whatsapp,cedula,rol,es_directivo`);
  if (personas.length !== 1) return null;
  const p = personas[0];

  const esAdmin = p.es_directivo === true;
  const esCEO = p.rol === 'ceo';
  const esCoHost = p.rol === 'cohost';
  const rol = esCoHost ? 'cohost'
    : (esCEO && esAdmin) ? 'ceo_admin'
    : esCEO ? 'ceo'
    : esAdmin ? 'admin'
    : (p.rol === 'limpieza' ? 'limpieza' : 'sin_rol');

  const [asignaciones, configRows] = await Promise.all([
    supaFetch(env, 'equipo_unidad', `persona_id=eq.${p.id}&select=unidad`),
    supaFetch(env, 'config', 'select=clave,valor'),
  ]);
  const cfg = {}; configRows.forEach(r => { cfg[r.clave] = r.valor; });
  const bFO = (k) => (k in cfg) ? /^[s1ty]/i.test(String(cfg[k] || '')) : true;   // fail-open, igual que _apiMe_

  let nInv = parseInt(cfg['INVENTARIO_FRECUENCIA_DIAS'] || '', 10);
  if (isNaN(nInv)) {
    const meses = parseInt(cfg['INVENTARIO_FRECUENCIA_MESES'] || '', 10);
    nInv = (meses >= 1) ? meses * 30 : 0;
  }
  const hParse = (k, def) => { const h = parseInt(String(cfg[k] || '').replace(/[^\d]/g, ''), 10); return (h >= 0 && h <= 23) ? h : def; };

  return {
    nombre: p.nombre, rol, unidades: asignaciones.map(a => a.unidad),
    whatsapp: p.whatsapp || '', clave: p.cedula || '',
    veIngresos: !esCoHost && rol !== 'limpieza',
    manuales: {
      admin: cfg['MANUAL_ADMIN'] || 'https://www.1242bnb.com/admin',
      cohost: cfg['MANUAL_COHOST'] || 'https://www.1242bnb.com/cohost',
      limpieza: cfg['MANUAL_LIMPIEZA'] || 'https://www.1242bnb.com/limpieza',
    },
    invFrecuencia: (nInv === 30 || nInv === 45) ? nInv : 0,
    mensajeriaAuto: bFO('MENSAJERIA_AUTOMATICA'),
    msgCopiaAdmin: bFO('MSG_COPIA_ADMIN'),
    cohostGlobal: cfg['COHOST_ACTIVO'] ? /^[s1ty]/i.test(String(cfg['COHOST_ACTIVO'])) : false,
    horaCheckin: hParse('HORA_CHECKIN', 15),
    horaCheckout: hParse('HORA_CHECKOUT', 11),
  };
}

// ---------------------------------------------------------------------------
// reporteglobal — espejo de _apiReporteGlobal_ (api.js:2422 del CRM), que se apoya en
// _resumenMensualUnidad_ (reportes.js:2850) y revparPorFechas_ (reportes.js:3233). Es un cálculo
// FINANCIERO que ven los dueños: la aritmética se replica al centavo, incluidos los redondeos
// intermedios (el RevPAR se redondea POR DÍA antes de sumarse — así lo hace revparPorFechas_).
// Dos atribuciones DISTINTAS conviven acá y no hay que confundirlas:
//   · ingresos/reservas -> mes del CHECK-IN, monto entero, SIN prorratear.
//   · noches/RevPAR     -> noche por noche en [inicio, fin), prorrateando el monto entre TODAS las
//                          noches de la reserva (no solo las que caen en el mes).
//   · limpiezas         -> mes del CHECK-OUT (cada check-out = 1 limpieza), por eso va en su propia
//                          consulta: una reserva que cierra el día 1 no entra en la ventana de solape.
// Diferencias deliberadas vs el original, por datos que todavía no viven en Supabase:
//   · gastos = 0 y gastosPromedioUnidad = 0 (la hoja INVENTARIO no está migrada; no se falla por eso).
//   · superhost sale de unidades.superhost (boolean) -> 'SI'/'NO', el mismo string que hoy recibe la UI.
// ---------------------------------------------------------------------------
async function resolverReporteGlobalDesdeSupabase(token, env, anio, mes) {
  const persona = await resolverPersonaEquipo(token, env);
  if (!persona) return null;                                     // no resuelto -> cae a D1
  // Resuelto pero sin permiso -> respuesta real (no fallback), con el MISMO texto que api.js:2427.
  const DENEGADO = { error: 'No autorizado: solo el admin de la unidad o el CEO dueño', denegado: true };
  if (persona.rol !== 'ceo' && persona.es_directivo !== true) return DENEGADO;

  // Mes pedido (mes llega 1-12 humano). Mismo fallback que el original: año/mes de HOY si falta o no sirve.
  const hoy0 = hoyEcuador();
  const a = parseInt(anio, 10) || hoy0.getUTCFullYear();
  const mNum = parseInt(mes, 10);
  const m1 = (mNum >= 1 && mNum <= 12) ? mNum : hoy0.getUTCMonth() + 1;   // 1-12
  const m0 = m1 - 1;                                                       // 0-11 (índice de Date)
  const dias = new Date(Date.UTC(a, m1, 0)).getUTCDate();                  // día 0 del mes SIGUIENTE = último del pedido
  const mesIniIso = new Date(Date.UTC(a, m0, 1)).toISOString().slice(0, 10);
  const mesFinIso = new Date(Date.UTC(a, m1, 1)).toISOString().slice(0, 10);  // exclusivo

  // Permisos: DOS vías, igual que _puedePedirReporteUnidad_ (whatsapp-huesped.js:4482) — admin de la
  // unidad (unidadesDeAdmin) O CEO dueño (equipo_unidad de SU PROPIA persona_id, igual que
  // _unidadesDeCEO_). Sin la 2ª vía, un CEO dueño que no es uno de los 2 admins (ej. Christian con
  // 5A/7A, hallazgo de la revisión Fable del 26/07/2026) quedaría denegado en seco — a diferencia del
  // carril `unidades`, acá DENEGADO es respuesta final, no cae al respaldo D1.
  const unidadesRows = await supaFetch(env, 'unidades', 'select=codigo,superhost');
  const todasLasUnidades = unidadesRows.map(x => x.codigo);
  const porAdmin = unidadesDeAdmin(persona.whatsapp, todasLasUnidades);
  const propias = (persona.rol === 'ceo')
    ? (await supaFetch(env, 'equipo_unidad', `persona_id=eq.${persona.id}&select=unidad`)).map(a => a.unidad)
    : [];
  const mias = [...new Set([...porAdmin, ...propias])];
  if (!mias.length) return DENEGADO;                             // igual que el original con 0 unidades
  const superhostDe = {};
  unidadesRows.forEach(x => { superhostDe[x.codigo] = x.superhost === true; });
  const lista = pgListaUnidades(mias);

  // Una sola pasada por unidad no: una sola CONSULTA para todas las unidades permitidas.
  // 1) reservas que SOLAPAN el mes (para ingresos, reservas, noches y RevPAR).
  // 2) reservas que CIERRAN dentro del mes (limpiezas) — incluye las que terminan el día 1, que la
  //    ventana de solape deja fuera (fecha_fin=gt.<inicio>) y que igual cuentan como limpieza.
  const [reservasRows, checkoutRows, configRows] = await Promise.all([
    supaFetch(env, 'reservas',
      `unidad=in.(${lista})&cancelada=eq.false&fecha_fin=gt.${mesIniIso}&fecha_inicio=lt.${mesFinIso}&select=unidad,fecha_inicio,fecha_fin,ingresos_brutos`),
    supaFetch(env, 'reservas',
      `unidad=in.(${lista})&cancelada=eq.false&fecha_fin=gte.${mesIniIso}&fecha_fin=lt.${mesFinIso}&select=unidad,fecha_inicio,fecha_fin,ingresos_brutos`),
    supaFetch(env, 'config', 'select=clave,valor&clave=in.(UMBRAL_OCUPACION,UMBRAL_OCUPACION_AMBAR)'),
  ]);

  const acum = {};
  mias.forEach(u => { acum[u] = { ingresos: 0, reservas: 0, noches: 0, limpiezas: 0, rpDia: new Array(dias).fill(0) }; });
  const enElMes = (d) => d.getUTCFullYear() === a && d.getUTCMonth() === m0;

  for (const r of reservasRows) {
    const b = acum[r.unidad];
    if (!b) continue;
    const ci = fechaUTC(r.fecha_inicio), co = fechaUTC(r.fecha_fin);
    const monto = Number(r.ingresos_brutos) || 0;
    if (!ci || !co || monto <= 0) continue;                      // mismo guard de _resumenMensualUnidad_
    if (enElMes(ci)) { b.ingresos += monto; b.reservas++; }      // atribución al mes del check-in
    const nN = Math.round((co.getTime() - ci.getTime()) / 86400000);   // noches TOTALES de la reserva
    if (nN <= 0) continue;
    const ingNoche = monto / nN;                                 // prorrateo lineal (regla del CRM)
    const d = new Date(ci.getTime());
    for (let k = 0; k < nN && k < 400; k++) {                     // cap 400 = guard de _resumenMensualUnidad_
      if (enElMes(d)) { b.noches++; b.rpDia[d.getUTCDate() - 1] += ingNoche; }
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }

  // Limpiezas: 1 por check-out del mes, con el MISMO guard de fila válida (ci, co y monto > 0).
  for (const r of checkoutRows) {
    const b = acum[r.unidad];
    if (!b) continue;
    const ci = fechaUTC(r.fecha_inicio), co = fechaUTC(r.fecha_fin);
    const monto = Number(r.ingresos_brutos) || 0;
    if (!ci || !co || monto <= 0) continue;
    if (enElMes(co)) b.limpiezas++;
  }

  let totIng = 0, totIngPro = 0, totNoches = 0, totRes = 0, totLimp = 0;
  const filas = mias.map(u => {
    const b = acum[u];
    // revparPorFechas_ redondea CADA DÍA a 2 decimales y recién ahí _apiReporteGlobal_ suma la serie.
    const ingPro = b.rpDia.reduce((s, v) => s + (+v.toFixed(2)), 0);
    const ingresos = +b.ingresos.toFixed(2);                     // _resumenMensualUnidad_ ya devuelve redondeado
    totIng += ingresos; totIngPro += ingPro; totNoches += b.noches;
    totRes += b.reservas; totLimp += b.limpiezas;
    return {
      unidad: u,
      ingresos,
      ocupacion: +(b.noches / dias * 100).toFixed(1),
      revpar: +(ingPro / dias).toFixed(2),
      reservas: b.reservas,
      noches: b.noches,
      gastos: 0,                                                 // INVENTARIO aún no migrado
      superhost: superhostDe[u] ? 'SI' : 'NO',
    };
  });
  filas.sort((x, y) => y.ingresos - x.ingresos);
  const nU = filas.length || 1;

  // Umbrales del semáforo — mismo fallback que _umbralesOcupacion_ (api.js:5084). Hoy ambas claves
  // están vacías en producción, así que esto debe dar {rojo:40, ambar:55}.
  const cfg = {}; configRows.forEach(r => { cfg[r.clave] = r.valor; });
  let rojo = parseFloat(String(cfg['UMBRAL_OCUPACION'] || '').replace(',', '.'));
  if (!(rojo > 0 && rojo < 100)) rojo = 40;
  let ambar = parseFloat(String(cfg['UMBRAL_OCUPACION_AMBAR'] || '').replace(',', '.'));
  if (!(ambar > rojo && ambar < 100)) ambar = Math.min(rojo + 15, 99);

  return {
    anio: a, mes: m1, nUnidades: filas.length, unidades: filas,
    umbrales: { rojo, ambar },
    kpis: {
      ingresos: +totIng.toFixed(2),
      ocupacion: +(totNoches / (dias * nU) * 100).toFixed(1),    // ponderado: noches / noches disponibles
      revpar: +(totIngPro / (dias * nU)).toFixed(2),
      adr: totNoches > 0 ? +(totIng / totNoches).toFixed(2) : 0,
      reservas: totRes, noches: totNoches, limpiezas: totLimp,
      gastos: 0,
      gastosPromedioUnidad: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// tareasbot — espejo de _apiTareasBot_ + sus 4 helpers (_apiTareasSinWa_, _apiTareasPendientes_,
// _apiTareasHilos_, _apiNovedades_ — api.js del CRM, ver docs/migracion-supabase en ese repo).
// Backfill de datos (28/07/2026): docs/migracion-supabase/01-migracion-datos/02-backfill-tareasbot.js
// en crm-appsscript pobló msgs_bot/log_outbound/log_inbound/inventario/limpieza_domingo/
// edificio_claves con la ventana de 30 días previa al push en vivo (commit 333d82d).
//
// Ventana de reservas: fecha_fin >= hoy-35d y fecha_inicio <= hoy+35d (a diferencia del original,
// que relee la hoja COMPLETA de cada unidad). Cubre de sobra los 3 horizontes reales: hilos = 14
// días atrás, pendientes = 30 días adelante, novedades (reseñas) = 7 días atrás.
//
// Diferencias deliberadas frente al original, todas por datos que hoy no viven (completos) en
// Supabase — documentadas en el sitio donde importan, no escondidas:
//   1) novedades NO incluye "nueva reserva confirmada": no hay tabla equivalente a
//      RESERVAS_NOTIFICADAS en el esquema (fuera del alcance de la migración de hoy).
//   2) novedades NO incluye "confirmaciones del domingo": limpieza_domingo.registrado es boolean
//      en Postgres (el Sheet guardaba ahí el TIMESTAMP de cuándo se confirmó) — sin ese dato no se
//      puede aplicar la ventana de 7 días ni mostrar `ts`. Requeriría una columna
//      `registrado_en timestamptz` nueva; se prefirió omitir el tipo a inventar una fecha.
//   3) novedades "fotos de inventario" agrupa por unidad+quien+DÍA, no por HORA: inventario.fecha
//      es `date` en el esquema (no timestamptz), así que la hora de la subida no viaja a Supabase.
//   4) VERIFICADO EN VIVO (28/07/2026, comparación byte-a-byte contra la API de Apps Script real):
//      la tabla `config` de Supabase HOY solo tiene 3 filas (INVENTARIO_FRECUENCIA_MESES,
//      MENSAJERIA_AUTOMATICA, INVENTARIO_FRECUENCIA_DIAS) — le faltan TODAS las claves globales
//      MSG_<ETAPA> (MSG_PRE_CHECKIN, MSG_CHECKIN_HORA, MSG_CODIGO_ACCESO, MSG_SEGUIMIENTO_ESTADIA,
//      MSG_CHECKOUT, MSG_POST_CHECKOUT — todas en SI en la CONFIGURACION real). `etapaOnTareas` cae
//      entonces al default de MSG_ETAPAS_DEF_TAREAS (todas en NO salvo POST_CHECKIN) para esas
//      etapas, así que pendientes[] las marca "switch_off" cuando el bot en vivo las tiene
//      "programado". Comparación real (token=3892, 27/07/2026): 14 de 94 pendientes[] no aparecen
//      (todas CODIGO_ACCESO, ver punto 5) y ~40 más muestran switch_off en vez de programado por
//      esto. La tabla msg_switch_unidad (override POR unidad) también está vacía, pero es un efecto
//      secundario menor comparado con el de `config` — ninguna de las dos se migró todavía (fuera
//      del alcance de la tarea de hoy, que fue solo backfillear las 6 tablas de tareasbot). Es el
//      fallback CORRECTO dado el estado actual de los datos, no un bug de este resolver — en cuanto
//      se pueble `config` con las claves MSG_* (y opcionalmente msg_switch_unidad), este código las
//      respeta sin cambios.
//   5) fichas_unidad.edificio y .clave_unidad están NULL para las 12 unidades en Supabase HOY (esa
//      tabla se migró en el Bloque 1, no en esta tarea) — por eso `claveCompuestaTareas` devuelve
//      cadena vacía para todas y CODIGO_ACCESO nunca aparece como candidato en pendientes[] todavía,
//      aunque el bot en vivo SÍ tenga clave cargada vía CLAVE_1242_* + FICHA_UNIDAD.edificio="1242"
//      en el Sheet. Se necesita corregir esas dos columnas en fichas_unidad (no en esta tarea) para
//      que este resolver deje de divergir en ese punto.
// ---------------------------------------------------------------------------
const MSG_ETAPAS_DEF_TAREAS = {
  PRE_CHECKIN: false, CHECKIN_HORA: false, CODIGO_ACCESO: false,
  POST_CHECKIN: true,
  SEGUIMIENTO_ESTADIA: false, CHECKOUT: false, POST_CHECKOUT: false,
  DESCUENTO_5E: true, FAQ_HUESPED: true, RESENAS: true,
};
const PLANTILLA_TIPO_TAREAS = {
  pre_checkin: 'PRE_CHECKIN', checkin_hora: 'CHECKIN_HORA', codigo_acceso: 'CODIGO_ACCESO',
  post_checkin: 'POST_CHECKIN',
  seguimiento_estadia: 'SEGUIMIENTO', checkout_dia: 'CHECKOUT', post_checkout: 'POST_CHECKOUT',
  clave_actualizada: 'CLAVE_ACTUALIZADA', gracias_5estrellas: 'DESCUENTO_5E',
};

// Rango Unicode de "marcas diacríticas combinantes" (U+0300-U+036F) construido por código de
// carácter, NUNCA como texto literal en el archivo — la misma trampa que documenta migrate.js
// (crm-appsscript): el escape se termina guardando como el carácter ya combinado en este entorno.
const RANGO_DIACRITICOS_TAREAS = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');
function rptNormTareas(s) { return String(s || '').normalize('NFD').replace(RANGO_DIACRITICOS_TAREAS, '').trim().toUpperCase(); }
function isoDateTareas(d) { return d.toISOString().slice(0, 10); }
// 'yyyy-MM-dd HH:mm' Ecuador, desde un Date o un timestamptz ISO de Postgres (mismo formato que
// Utilities.formatDate(..., 'America/Guayaquil', 'yyyy-MM-dd HH:mm') en el original).
function fmtEcTareas(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return '';
  const e = new Date(d.getTime() - 5 * 3600000);
  return e.toISOString().slice(0, 16).replace('T', ' ');
}
function cfgBoolTareas(cfg, clave, def) { return (clave in cfg) ? /^[s1ty]/i.test(String(cfg[clave] || '')) : def; }
// Mismo criterio que MSG_TEST_UNIDADES (_msgUnidadEnPrueba_): vacía = producción = todas.
function unidadEnPruebaTareas(cfg, unidad) {
  const raw = String(cfg['MSG_TEST_UNIDADES'] || '').trim();
  if (!raw) return true;
  const objetivo = rptNormTareas(unidad);
  return raw.split(',').some(u => rptNormTareas(u) === objetivo);
}
// Espejo de _msgEtapaOn_: unidad (msg_switch_unidad) -> global (config) -> default de la tabla.
function etapaOnTareas(cfg, msgSwitchMap, claveConPrefijo, unidad) {
  const E = String(claveConPrefijo || '').trim().toUpperCase().replace(/^MSG_/, '');
  const overrideUnidad = msgSwitchMap[unidad + '|' + E];
  if (overrideUnidad === true || overrideUnidad === false) return overrideUnidad;
  const globalKey = 'MSG_' + E;
  if (globalKey in cfg) return /^[s1ty]/i.test(String(cfg[globalKey] || ''));
  return !!MSG_ETAPAS_DEF_TAREAS[E];
}
// Espejo de _horaEnTexto_ (whatsapp-huesped.js): devuelve el FRAGMENTO de texto que matchea (no un
// HH:MM normalizado) — así lo consume/muestra el original.
function horaEnTextoTareas(t) {
  const s = String(t || '');
  const m = s.match(/\b([01]?\d|2[0-3])\s*[:hH.]\s*([0-5]\d)\b/) ||
            s.match(/\b([01]?\d|2[0-3])\s+([0-5]\d)\b/) ||
            s.match(/\b(1[0-2]|0?[1-9])\s*(am|pm|a\.\s?m\.|p\.\s?m\.)\b/i) ||
            s.match(/\ba\s+las?\s+([01]?\d|2[0-3])\b/i);
  return m ? m[0].replace(/^a\s+las?\s*/i, '').trim() : '';
}
// Espejo de _claveCompuesta_ (whatsapp-huesped.js): CLAVES_TEXTO_<U> manda; si no, ficha.clave_unidad
// + puertas compartidas del edificio (edificio_claves); standalone (sin edificio) = solo la propia.
function claveCompuestaTareas(fichaU, edificioPorNombre, cfg, unidad) {
  const libre = String(cfg['CLAVES_TEXTO_' + unidad] || '').trim();
  if (libre) return libre.replace(/\s*\n+\s*/g, ' · ');
  const ficha = fichaU || {};
  const propia = String(ficha.clave_unidad || '').trim();
  const edif = String(ficha.edificio || '').trim();
  if (!edif) return propia;
  const ec = edificioPorNombre[edif] || {};
  const ext = String(ec.exterior || '').trim();
  const vid = String(ec.vidrio || '').trim();
  const par = String(ec.parqueadero || '').trim();
  const partes = [];
  if (ext) partes.push('Puerta de la calle (Schlage): ' + ext);
  if (vid) partes.push('Puerta de vidrio: ' + vid + ' + Ok');
  if (propia) partes.push('Puerta de tu unidad: ' + propia);
  if (par) partes.push('Parqueadero: ' + par);
  return partes.join(' · ');
}

// Espejo de _apiTareasSinWa_.
function tareasSinWhatsapp(lista, hoy0, fotoPorUnidad) {
  const out = [];
  lista.forEach(r => {
    if (r.wa || r.co.getTime() < hoy0.getTime()) return;
    if (r.ci.getTime() > hoy0.getTime() + 2 * 86400000) return;
    const pre = /^HM/i.test(r.codigo) ? r.codigo : (r.codigo ? 'reserva: ' + r.codigo : '');
    let linkWa = '', textoAirbnb = '';
    if (pre) {
      const nombre = r.huesped || 'huésped';
      linkWa = 'https://wa.me/593962307736?text=' + encodeURIComponent(pre + ' — Hola, soy ' + nombre + ' / Hi, I\'m ' + nombre);
      textoAirbnb = '¡Hola ' + nombre + '! Somos 1242BNB, tus anfitriones 😊 Para asistirte al instante por ' +
        'WhatsApp durante tu estadía (indicaciones de llegada, wifi, cualquier duda), toca este enlace y ' +
        'envía el mensaje que ya viene escrito:\n\n' + linkWa + '\n\n' +
        'Hi ' + nombre + '! We are 1242BNB, your hosts 😊 For instant WhatsApp assistance during your stay ' +
        '(arrival directions, wifi, any question), just tap the link above and send the pre-filled message. ' +
        '¡Gracias! / Thank you!';
    }
    out.push({ unidad: r.unidad, foto: fotoPorUnidad[r.unidad] || '', huesped: r.huesped, codigo: r.codigo, ci: isoDateTareas(r.ci), co: isoDateTareas(r.co), linkWa, textoAirbnb });
  });
  out.sort((a, b) => a.ci < b.ci ? -1 : 1);
  return out;
}

// Espejo de _apiTareasPendientes_ (réplica FIEL del motor de mensajeriaProactivaDiaria_, en SOLO
// LECTURA — ver comentario del original en api.js sobre por qué NO se factoriza).
function tareasPendientes(lista, enviados, hoy0, ctx) {
  const out = [];
  const DIA = 86400000, man0 = hoy0.getTime() + DIA, horizonte = hoy0.getTime() + 30 * DIA;
  const master = cfgBoolTareas(ctx.cfg, 'MENSAJERIA_AUTOMATICA', true);
  const unidadOkCache = {};
  function unidadOk(u) {
    if (unidadOkCache[u] === undefined) unidadOkCache[u] = !!ctx.botActivoPorUnidad[u] && unidadEnPruebaTareas(ctx.cfg, u);
    return unidadOkCache[u];
  }
  lista.forEach(r => {
    const ci0 = r.ci.getTime(), co0 = r.co.getTime();
    if (co0 + DIA < hoy0.getTime() || ci0 - DIA > horizonte) return;
    if (!unidadOk(r.unidad)) return;
    const direccion = (ctx.fichaPorUnidad[r.unidad] || {}).direccion || '';
    const tieneClave = !!ctx.clavePorUnidad[r.unidad];
    const codKey = r.codigo || (r.wa ? r.unidad + '_' + r.wa.slice(-9) : '');
    const cand = [['PRE_CHECKIN', 'MSG_PRE_CHECKIN', '6PM', ci0 - DIA]];
    if (!enviados[codKey + '|HORA_LLEGADA']) cand.push(['CHECKIN_HORA', 'MSG_CHECKIN_HORA', '6AM', ci0]);
    if (tieneClave) cand.push(['CODIGO_ACCESO', 'MSG_CODIGO_ACCESO', '6AM', ci0]);
    cand.push(['POST_CHECKIN', 'MSG_POST_CHECKIN', '3PM', ci0]);
    if (co0 > ci0 + DIA) cand.push(['SEGUIMIENTO', 'MSG_SEGUIMIENTO_ESTADIA', '6AM', ci0 + DIA]);
    cand.push(['CHECKOUT', 'MSG_CHECKOUT', '6AM', co0]);
    cand.push(['POST_CHECKOUT', 'MSG_POST_CHECKOUT', '6AM', co0 + DIA]);
    cand.forEach(c => {
      if (c[3] > horizonte) return;
      const ya = codKey ? enviados[codKey + '|' + c[0]] : null;
      if (c[3] < hoy0.getTime() && !ya) return;
      let estado;
      if (ya) estado = 'enviado';
      else if (!master) estado = 'switch_off';
      else if (!r.wa) estado = 'bloqueado_sin_numero';
      else if (c[0] === 'PRE_CHECKIN' && !direccion) estado = 'bloqueado_sin_direccion';
      else if (!etapaOnTareas(ctx.cfg, ctx.msgSwitchMap, c[1], r.unidad)) estado = 'switch_off';
      else estado = 'programado';
      const item = { fecha: isoDateTareas(new Date(c[3])), rama: c[2], tipo: c[0], unidad: r.unidad, huesped: r.huesped, codigo: r.codigo, estado };
      if (c[3] === hoy0.getTime()) item.dia = 'hoy';
      else if (c[3] === man0) item.dia = 'manana';
      if (ya) item.enviadoTs = fmtEcTareas(ya);
      out.push(item);
    });
  });
  out.sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0);
  return out;
}

// Espejo de _apiTareasHilos_ (unified inbox, ventana 14 días). Diferencia deliberada: log_outbound/
// log_inbound se consultan por FECHA (>= hoy-14d) en vez de "últimas 300 filas de la hoja completa"
// — estrictamente más correcto (una unidad muy activa no le come el cupo a las demás) y más simple.
function tareasHilos(R, enviados, hoy0, logOutRows, logInRows) {
  const lim = hoy0.getTime() - 14 * 86400000;
  function reservaDeNumero(num, tsMs) {
    const d9 = String(num || '').replace(/\D/g, '').slice(-9);
    if (!d9) return null;
    const cands = R.porNumero[d9] || [];
    let mejor = null, mejorDist = Infinity;
    for (const c of cands) {
      const a = c.ci.getTime() - 7 * 86400000, b = c.co.getTime() + 7 * 86400000;
      if (tsMs >= a && tsMs <= b) return c;
      const dist = Math.min(Math.abs(tsMs - a), Math.abs(tsMs - b));
      if (dist < mejorDist) { mejorDist = dist; mejor = c; }
    }
    return mejor;
  }
  const porReserva = {};
  function add(r, ts, dir, tipo, texto, de) {
    if (!r || !ts || isNaN(ts) || ts.getTime() < lim) return;
    const key = r.codigo || (r.unidad + '|' + r.wa);
    if (!porReserva[key]) porReserva[key] = { r, mensajes: [] };
    const m = { ts, dir, tipo, texto: texto || '' };
    if (de) m.de = de;
    porReserva[key].mensajes.push(m);
  }
  const yaEnLog = {};
  logOutRows.forEach(f => {
    const ts = new Date(f.fecha);
    if (isNaN(ts)) return;
    const r = reservaDeNumero(f.to, ts.getTime());
    if (!r) return;
    const esTpl = String(f.tipo || '').indexOf('PLANTILLA') === 0;
    const tipo = esTpl ? (PLANTILLA_TIPO_TAREAS[String(f.plantilla || '').toLowerCase()] || String(f.plantilla || '').toUpperCase())
      : (String(f.tipo || '') || 'TEXTO');
    add(r, ts, 'out', tipo, String(f.texto || ''), tipo === 'EQUIPO' ? String(f.plantilla || '') : '');
    yaEnLog[(r.codigo || r.unidad) + '|' + tipo + '|' + Math.round(ts.getTime() / 600000)] = true;
  });
  Object.keys(enviados).forEach(k => {
    const ts = enviados[k];
    if (!ts) return;
    const p = k.split('|'), codigo = p[0], tipo = p[1];
    if (tipo === 'CODIGO_PROMPT' || tipo === 'HORA_LLEGADA' || tipo.indexOf('ONBOARD') === 0) return;
    const r = R.porCodigo[codigo];
    if (!r) return;
    const slot = Math.round(ts.getTime() / 600000);
    let dup = false;
    for (let s = slot - 1; s <= slot + 1 && !dup; s++) dup = !!yaEnLog[(r.codigo || r.unidad) + '|' + tipo + '|' + s];
    if (!dup) add(r, ts, 'out', tipo, '');
  });
  // horasH (semáforo por hora) se calcula EN LA MISMA pasada de log_inbound — misma fuente que
  // _apiHorasHuesped_ del original, fusionada acá por eficiencia (evita una segunda consulta).
  const horasH = {};
  logInRows.forEach(f => {
    const ts = new Date(f.fecha);
    if (isNaN(ts)) return;
    const estado = String(f.estado || ''), cod = String(f.codigo || '').trim().toUpperCase();
    let r = null, tipo = '';
    const m = estado.match(/^HUESPED (FAQ|RELAY|HORA LLEGADA|HORA SALIDA)\s*\(/);
    if (m) {
      tipo = m[1].replace(' ', '_');
      r = (cod && R.porCodigo[cod]) || reservaDeNumero(f.numero, ts.getTime());
    } else if (/^(OK|ACTUALIZADO|YA EXISTIA)/.test(estado)) {
      tipo = 'WA_CAPTURADO';
      r = cod ? R.porCodigo[cod] : null;
    }
    if (r) add(r, ts, 'in', tipo, String(f.texto || ''));
    const mh = estado.match(/^HUESPED HORA (LLEGADA|SALIDA)/);
    if (mh) {
      const hVal = horaEnTextoTareas(String(f.texto || ''));
      if (hVal) {
        const tipoH = mh[1] === 'LLEGADA' ? 'llegada' : 'checkout';
        const numH = String(f.numero || '').replace(/\D/g, '').slice(-9);
        if (cod) horasH[cod + '|' + tipoH] = hVal;
        if (numH) horasH['N' + numH + '|' + tipoH] = hVal;
      }
    }
  });
  const hilos = Object.keys(porReserva).map(k => {
    const h = porReserva[k];
    h.mensajes.sort((a, b) => a.ts - b.ts);
    const msgs = h.mensajes.slice(-40).map(msg => {
      const o = { ts: fmtEcTareas(msg.ts), dir: msg.dir, tipo: msg.tipo, texto: msg.texto };
      if (msg.de) o.de = msg.de;
      return o;
    });
    const codH = String(h.r.codigo || '').trim().toUpperCase(), wa9 = String(h.r.wa || '').slice(-9);
    return {
      unidad: h.r.unidad, huesped: h.r.huesped, codigo: h.r.codigo,
      ci: isoDateTareas(h.r.ci), co: isoDateTareas(h.r.co),
      horaLlegada: (codH && horasH[codH + '|llegada']) || (wa9 && horasH['N' + wa9 + '|llegada']) || '',
      horaSalida: (codH && horasH[codH + '|checkout']) || (wa9 && horasH['N' + wa9 + '|checkout']) || '',
      ultimoTs: msgs.length ? msgs[msgs.length - 1].ts : '', mensajes: msgs,
    };
  });
  hilos.sort((a, b) => a.ultimoTs < b.ultimoTs ? 1 : -1);
  return hilos.slice(0, 30);
}

// Espejo PARCIAL de _apiNovedades_ — 3 de los 5 tipos (ver notas de diferencias arriba: "nueva
// reserva" y "confirmaciones de domingo" no tienen datos suficientes en Supabase todavía).
function tareasNovedades(R, hoy0, inventarioRows, logInRows, unidadesSet) {
  const out = [];
  const ahora = new Date();
  const MS_RESENA = 7 * 86400000, MS_RESERVA = 3 * 86400000;

  // 2) Reseñas 5★ reales recientes.
  R.lista.forEach(r => {
    if (r.estrellas === null || r.estrellas === undefined || r.estrellas === '') return;
    const est = Number(r.estrellas);
    if (isNaN(est) || est < 5) return;
    const fr = r.fechaResena;
    if (!fr || (ahora.getTime() - fr.getTime()) > MS_RESENA || fr.getTime() > ahora.getTime()) return;
    out.push({ ts: isoDateTareas(fr), _ms: fr.getTime(), unidad: r.unidad, huesped: r.huesped, icono: '⭐', titulo: 'Reseña 5★', detalle: '' });
  });

  // 3) Fotos del equipo — agrupadas por unidad+quien+DÍA (ver nota de diferencia #3 arriba: no por
  // hora, inventario.fecha es `date` en Postgres).
  const lotes = {};
  inventarioRows.forEach(row => {
    const u = String(row.unidad || '').toUpperCase();
    if (!unidadesSet.has(u) || !row.fecha) return;
    const fMs = Date.parse(row.fecha + 'T05:00:00Z');
    if (isNaN(fMs) || (ahora.getTime() - fMs) > MS_RESENA) return;
    const k = u + '|' + (row.quien || '') + '|' + row.fecha;
    if (!lotes[k]) lotes[k] = { ts: fMs, unidad: u, quien: row.quien || '', obs: '', n: 0 };
    lotes[k].n++;
    if (!lotes[k].obs && String(row.observaciones || '').trim()) lotes[k].obs = String(row.observaciones).trim();
  });
  Object.values(lotes).forEach(L => {
    out.push({
      ts: isoDateTareas(new Date(L.ts)), _ms: L.ts, unidad: L.unidad, huesped: '', icono: '📷',
      titulo: L.n + (L.n === 1 ? ' foto nueva' : ' fotos nuevas'), detalle: (L.obs ? L.obs + ' · ' : '') + L.quien,
    });
  });

  // 5) WhatsApp del huésped CAPTURADO (log_inbound.estado).
  logInRows.forEach(row => {
    const estL = String(row.estado || '').trim();
    let uL = '', titL = '';
    const mOk = estL.match(/^(?:OK|ACTUALIZADO)[^>]*->\s*(.+?)\s+fila\s+\d+/i);
    const mNom = estL.match(/^WHATSAPP AGREGADO por NOMBRE\s*\((.+)\)\s*$/i);
    const mVin = estL.match(/^WHATSAPP VINCULADO\s*\((.+)\)\s*$/i);
    if (mOk) { uL = mOk[1]; titL = 'WhatsApp del huésped registrado'; }
    else if (mNom) { uL = mNom[1]; titL = 'WhatsApp vinculado solo (por nombre)'; }
    else if (mVin) { uL = mVin[1]; titL = 'WhatsApp vinculado (lo dejó antes de su reserva)'; }
    else return;
    uL = uL.trim().toUpperCase();
    if (!unidadesSet.has(uL)) return;
    const tsL = new Date(row.fecha);
    if (isNaN(tsL) || (ahora.getTime() - tsL.getTime()) > MS_RESERVA) return;
    const codL = String(row.codigo || '').trim().toUpperCase();
    const rL = codL ? R.porCodigo[codL] : null;
    // 30/07/2026: `icono` separado de `titulo` (antes el emoji venía embebido adentro del string Y
    // además hardcodeado acá — mismo bug que _apiNovedades_ en api.js, corregido ahí también). El
    // título tiene que ser IDÉNTICO al que arma api.js: `novKey` (app.js) usa ts|unidad|titulo para
    // descartar una novedad, y un texto distinto entre el carril D1/Supabase y el carril en vivo de
    // Apps Script hacía que la MISMA tarjeta tuviera 2 claves distintas — el descarte de un carril no
    // pegaba en el otro y la tarjeta podía "resucitar" tras un repintado silencioso.
    out.push({ ts: fmtEcTareas(row.fecha), _ms: tsL.getTime(), unidad: uL, huesped: rL ? rL.huesped : '', icono: '📲', titulo: titL, detalle: String(row.numero || '').trim() });
  });

  out.sort((a, b) => b._ms - a._ms);
  return out.slice(0, 15).map(({ _ms, ...n }) => n);
}

// token -> mismo shape que _apiTareasBot_ (auth), o null si no se pudo resolver -> cae a D1/en vivo.
// Sin gate de rol adicional (a propósito): el original permite `tareasbot` a TODOS los roles
// incluido limpieza (ver doGet, api.js) — la única acotación es `auth.unidades` de la persona.
async function resolverTareasbotDesdeSupabase(token, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const persona = await resolverPersonaEquipo(token, env);
  if (!persona) return null;
  const hoy0 = hoyEcuador();
  const asignaciones = await supaFetch(env, 'equipo_unidad', `persona_id=eq.${persona.id}&select=unidad`);
  const unidadesAuth = asignaciones.map(a => a.unidad);
  if (!unidadesAuth.length) {
    return { hoy: isoDateTareas(hoy0), sinWhatsapp: [], pendientes: [], hilos: [], aprobaciones: [], novedades: [] };
  }
  const lista = pgListaUnidades(unidadesAuth);
  const unidadesSet = new Set(unidadesAuth);
  const DIA = 86400000;
  const desdeReservas = isoDateTareas(new Date(hoy0.getTime() - 35 * DIA));
  const hastaReservas = isoDateTareas(new Date(hoy0.getTime() + 35 * DIA));
  const lim14 = new Date(hoy0.getTime() - 14 * DIA).toISOString();
  const lim7 = isoDateTareas(new Date(hoy0.getTime() - 7 * DIA));

  const [reservasRows, unidadesRows, fichasRows, edificioRows, cfgRows, msgSwitchRows] = await Promise.all([
    supaFetch(env, 'reservas', `unidad=in.(${lista})&cancelada=eq.false&fecha_fin=gte.${desdeReservas}&fecha_inicio=lte.${hastaReservas}&select=unidad,huesped,codigo_confirmacion,fecha_inicio,fecha_fin,whatsapp_huesped,estrellas,fecha_resena`),
    supaFetch(env, 'unidades', `codigo=in.(${lista})&select=codigo,bot_activo,foto_url`),
    supaFetch(env, 'fichas_unidad', `unidad=in.(${lista})&select=unidad,direccion,clave_unidad,edificio,foto`),
    supaFetch(env, 'edificio_claves', 'select=edificio,exterior,vidrio,parqueadero'),
    supaFetch(env, 'config', 'select=clave,valor'),
    supaFetch(env, 'msg_switch_unidad', `unidad=in.(${lista})&select=unidad,etapa,activo`),
  ]);

  const R = { lista: [], porCodigo: {}, porNumero: {} };
  reservasRows.forEach(row => {
    const ci = fechaUTC(row.fecha_inicio), co = fechaUTC(row.fecha_fin);
    if (!ci || !co) return;
    const wd = String(row.whatsapp_huesped || '').replace(/\D/g, '');
    const r = {
      unidad: row.unidad, huesped: row.huesped || '', codigo: String(row.codigo_confirmacion || '').trim().toUpperCase(),
      ci, co, wa: wd.length >= 8 ? wd : '', estrellas: row.estrellas, fechaResena: fechaUTC(row.fecha_resena),
    };
    R.lista.push(r);
    if (r.codigo) R.porCodigo[r.codigo] = r;
    if (r.wa) { const k9 = r.wa.slice(-9); (R.porNumero[k9] ??= []).push(r); }
  });

  const codigosR = Object.keys(R.porCodigo);
  const enviados = {};
  if (codigosR.length) {
    const msgsRows = await supaFetch(env, 'msgs_bot', `codigo_confirmacion=in.(${codigosR.join(',')})&select=codigo_confirmacion,tipo,enviado_en`);
    msgsRows.forEach(m => { enviados[m.codigo_confirmacion + '|' + m.tipo] = new Date(m.enviado_en); });
  }

  const [logOutRows, logInRows, inventarioRows] = await Promise.all([
    supaFetch(env, 'log_outbound', `fecha=gte.${encodeURIComponent(lim14)}&select=fecha,to,tipo,plantilla,codigo,unidad,texto&order=fecha.asc&limit=3000`),
    supaFetch(env, 'log_inbound', `fecha=gte.${encodeURIComponent(lim14)}&select=fecha,from,huesped,codigo,numero,estado,texto&order=fecha.asc&limit=3000`),
    supaFetch(env, 'inventario', `unidad=in.(${lista})&tipo=eq.foto&fecha=gte.${lim7}&select=unidad,fecha,quien,observaciones`),
  ]);

  const fotoPorUnidad = {};
  fichasRows.forEach(f => { if (f.foto) fotoPorUnidad[f.unidad] = f.foto; });
  unidadesRows.forEach(u => { if (!fotoPorUnidad[u.codigo] && u.foto_url) fotoPorUnidad[u.codigo] = u.foto_url; });

  const cfg = {}; cfgRows.forEach(c => { cfg[c.clave] = c.valor; });
  const botActivoPorUnidad = {}; unidadesRows.forEach(u => { botActivoPorUnidad[u.codigo] = !!u.bot_activo; });
  const fichaPorUnidad = {}; fichasRows.forEach(f => { fichaPorUnidad[f.unidad] = f; });
  const edificioPorNombre = {}; edificioRows.forEach(e => { edificioPorNombre[e.edificio] = e; });
  const msgSwitchMap = {}; msgSwitchRows.forEach(m => { msgSwitchMap[m.unidad + '|' + m.etapa] = m.activo; });
  const clavePorUnidad = {};
  unidadesAuth.forEach(u => { clavePorUnidad[u] = !!claveCompuestaTareas(fichaPorUnidad[u], edificioPorNombre, cfg, u); });

  const sinWhatsapp = tareasSinWhatsapp(R.lista, hoy0, fotoPorUnidad);
  const pendientes = tareasPendientes(R.lista, enviados, hoy0, { botActivoPorUnidad, cfg, fichaPorUnidad, clavePorUnidad, msgSwitchMap });
  const hilos = tareasHilos(R, enviados, hoy0, logOutRows, logInRows);

  // Aprobaciones de clave pendientes (CODIGO_PROMPT sin CODIGO_ACCESO, reserva vigente) — espejo del
  // bloque final de _apiTareasBot_ (no vive en un helper aparte en el original).
  const promptsA = {}, accesosA = {};
  Object.keys(enviados).forEach(k => {
    const p = k.split('|'), cod = p[0], tipo = p[1];
    if (tipo === 'CODIGO_PROMPT') promptsA[cod] = enviados[k];
    else if (tipo === 'CODIGO_ACCESO') accesosA[cod] = true;
  });
  const horaLimParsed = parseInt(String(cfg['HORA_CHECKIN'] || '').replace(/[^\d]/g, ''), 10);
  const horaLim = (horaLimParsed >= 0 && horaLimParsed <= 23) ? horaLimParsed : 15;
  const ahoraEc = new Date(Date.now() - 5 * 3600000);
  const aprobaciones = [];
  Object.keys(promptsA).forEach(cod => {
    if (accesosA[cod] || !promptsA[cod]) return;
    const r = R.porCodigo[cod];
    if (!r) return;
    const ci0 = r.ci.getTime();
    if (ci0 < hoy0.getTime()) return;
    if (ci0 === hoy0.getTime() && ahoraEc.getUTCHours() >= horaLim) return;
    aprobaciones.push({ codigo: cod, unidad: r.unidad, huesped: r.huesped, ci: isoDateTareas(r.ci), desde: fmtEcTareas(promptsA[cod]) });
  });
  aprobaciones.sort((a, b) => a.ci < b.ci ? -1 : 1);

  const novedades = tareasNovedades(R, hoy0, inventarioRows, logInRows, unidadesSet);

  return { hoy: isoDateTareas(hoy0), sinWhatsapp, pendientes, hilos, aprobaciones, novedades };
}

// ---------------------------------------------------------------------------

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const token = String(u.searchParams.get('token') || '').trim();
  const c = String(u.searchParams.get('c') || '').trim().toLowerCase();
  // [a-z0-9:] y no solo [a-z] (22/07/2026): las fotos de REPORTES usan claves compuestas
  // "reportepng:<slug>:<o|m>" — con el regex viejo se rechazaban antes de mirar D1.
  if (!token || !/^[a-z0-9:]+$/.test(c)) return new Response(null, { status: 204, headers: SIN });

  if (c === 'unidades' || c === 'equipo' || c === 'equipoporunidad' || c === 'agenda' || c === 'me' || c === 'reporteglobal' || c === 'tareasbot') {
    try {
      // reporteglobal es la única acción de este carril con parámetros: anio/mes. Si no vienen (la
      // PWA solo usa la vía rápida para el mes en curso), la función cae al mes de hoy en Ecuador.
      const payload = c === 'unidades' ? await resolverUnidadesDesdeSupabase(token, env)
        : c === 'equipo' ? await resolverEquipoDesdeSupabase(token, env)
        : c === 'equipoporunidad' ? await resolverEquipoPorUnidadDesdeSupabase(token, env)
        : c === 'agenda' ? await resolverAgendaDesdeSupabase(token, env)
        : c === 'reporteglobal' ? await resolverReporteGlobalDesdeSupabase(token, env, u.searchParams.get('anio'), u.searchParams.get('mes'))
        : c === 'tareasbot' ? await resolverTareasbotDesdeSupabase(token, env)
        : await resolverMeDesdeSupabase(token, env);
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
