/* 1242BNB PMS — app del equipo (v1.1, rediseño de marca)
 * Lenguaje visual = reporte mensual 1242bnb: hero rojo #ED1C24 con wordmark + KPIs blancos,
 * títulos con subrayado rojo, barras 12 meses (mes activo rojo sólido), donas verde/ámbar/rojo,
 * agenda semanal con píldoras negras y P✦, footer con wordmark + tagline + URL. */

const API = 'https://script.google.com/macros/s/AKfycbzD1E7VhWXmC-WGPiHcBAK2spCiI_aCcK5OAJPu7j2rYbG7D1C8p8scnqB_-A1g363m/exec';
// Deployment del WEBHOOK del bot (OTRO deployment, regla de oro del CRM). Solo para la luz de salud
// del BOT: un GET ?action=ping de solo lectura — jamás se postea nada acá desde la app.
const WEBHOOK_PING = 'https://script.google.com/macros/s/AKfycbzEBAyJAoSFyJhQDmghKlUufJIuOBt6g7r_L54KuBiMQmlof34GLGVngkX5Y3-HniNa/exec?action=ping';

const $ = (sel) => document.querySelector(sel);
const estado = {
  token: localStorage.getItem('pms_token') || '',
  yo: null,
  tab: 'tareas',   // HOY es la primera pestaña y la de arranque (Tanda 6)
  tituloActual: 'Unidades',
  // 'pms_tema2' (clave nueva 18/07): TODOS arrancan en CLARO una vez, aunque tuvieran 'auto' en la
  // clave vieja — pedido del dueño "siempre empezar con modo claro". El selector sigue en Config.
  tema: localStorage.getItem('pms_tema2') || 'claro',
  unidadAbierta: null,
  repUnidad: null,
  repVista: null,     // T7.2: pestaña activa dentro de REPORTES — 'operativo' (default) | 'mensual'
  repOrden: 'az',     // T7.1: "ordenar por" de los chips de unidad (az · mayor · menor · fav)
  cache: {},
  stale: new Set(),   // claves que vienen de una sesión anterior (localStorage): se pintan ya y se revalidan por detrás
  enVuelo: {},        // pedidos en curso por clave: evita disparar el mismo GET dos veces a la vez
  silencioso: false,  // true = repintado en segundo plano: la vista NO muestra spinner ni se pone en blanco
  sinCerebro: 0,      // hasta este timestamp NO se usa el carril rápido (tras una escritura: datos frescos = Apps Script)
  mensajesFoco: null, // salto 💬 desde UNIDADES: {codigo, nombre} del huésped cuya conversación abrir en MENSAJES
  hechasLocal: JSON.parse(localStorage.getItem('pms_tareas_hechas') || '{}'),
};

/* ---------- Tema (claro / oscuro / automático según el sistema) ---------- */
function aplicarTema() {
  const oscuro = estado.tema === 'oscuro' ||
    (estado.tema === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.tema = oscuro ? 'oscuro' : 'claro';
  // La barra del sistema (Android / status bar) acompaña al fondo — ya no es roja (T6.1).
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = oscuro ? '#141414' : '#f4f4f5';
}
function setTema(pref) {
  estado.tema = pref;
  localStorage.setItem('pms_tema2', pref);
  aplicarTema();
}

/* ---------- API ----------
 * Con "stale-while-revalidate": si hay un dato de la sesión anterior (localStorage), se devuelve YA
 * para pintar la pantalla al instante y en paralelo se pide el dato fresco; si cambió, se repinta la
 * vista en silencio. Así la app se siente inmediata aunque el backend (Apps Script) tarde ~4 s.
 * Y sin copia local (primer uso, otro aparato): el "cerebro de lectura" en Cloudflare D1 (/datos,
 * mismo origen, ~0.2 s) sirve la foto que el CRM precalculó (sincronizarSnapshots en api.js del
 * repo del CRM); el Apps Script en vivo sigue en vuelo por detrás y repinta si algo cambió. */
const ACCIONES_RAPIDAS = new Set(['me', 'unidades', 'tareasbot', 'notificaciones', 'limpieza', 'agenda', 'equipo', 'equipoporunidad', 'reporteglobal']);
function urlRapida(params) {
  if (Date.now() < estado.sinCerebro) return null;          // acabo de escribir: solo Apps Script en vivo
  if (!ACCIONES_RAPIDAS.has(params.action)) return null;
  const extras = Object.keys(params).filter(k => k !== 'action');
  if (params.action === 'reporteglobal') {                  // la foto es SOLO del mes en curso
    const hoy = new Date();
    if (!extras.every(k => k === 'anio' || k === 'mes')) return null;
    if (params.anio != null && +params.anio !== hoy.getFullYear()) return null;
    if (params.mes != null && +params.mes !== hoy.getMonth() + 1) return null;
  } else if (extras.length) return null;                    // parámetros variables → sin foto
  return '/datos?' + new URLSearchParams({ token: estado.token, c: params.action });
}

async function api(params, usarCache = true) {
  const key = JSON.stringify(params);
  const enMem = estado.cache[key];
  const esViejo = estado.stale.has(key);
  if (usarCache && enMem && !esViejo) return enMem;   // fresco en esta sesión → directo

  if (!estado.enVuelo[key]) {
    const url = API + '?' + new URLSearchParams({ ...params, token: estado.token });
    // Apps Script bajo contención responde 200 con una PÁGINA HTML ("Se agotó el tiempo de espera del
    // servicio Hojas de cálculo"), no JSON. Sin este guard, r.json() lanzaba SyntaxError, el .catch() de la
    // vista lo volvía null y la sección desaparecía en silencio (era el caso de la agenda). apiPost ya lo
    // detectaba; el GET no. Ahora se tipifica igual y el llamador puede decidir.
    estado.enVuelo[key] = fetch(url)
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(txt => {
        const t = txt.trim();
        if (t.startsWith('<')) throw new Error('Apps Script devolvió HTML (timeout de Sheets)');
        return JSON.parse(t);
      })
      .then(j => { if (j && !j.error) { estado.cache[key] = j; estado.stale.delete(key); guardarLS(key, j); } return j; })
      .finally(() => { delete estado.enVuelo[key]; });
  }
  const traer = estado.enVuelo[key];

  if (usarCache && enMem) {   // hay copia vieja: pintar ya, refrescar por detrás, repintar si cambió
    traer.then(j => {
      if (j && !j.error && JSON.stringify(j) !== JSON.stringify(enMem)) repintarSilencioso();
    }).catch(() => {});
    return enMem;
  }

  // Sin copia local: probar el cerebro de Cloudflare (~0.2 s). Si tiene la foto, se pinta YA y el
  // Apps Script (que ya va en vuelo) repinta en silencio si algo cambió. Si no la tiene (204),
  // está lento o falla → se espera al Apps Script de siempre. Nunca peor que antes.
  const rapida = usarCache && urlRapida(params);
  if (rapida) {
    try {
      const r = await Promise.race([fetch(rapida),
        new Promise((_, rej) => setTimeout(() => rej(new Error('lento')), 2500))]);
      if (r.status === 200) {
        const foto = await r.json();
        if (foto && !foto.error) {
          estado.cache[key] = foto; estado.stale.delete(key); guardarLS(key, foto);
          traer.then(j => {
            if (j && !j.error && JSON.stringify(j) !== JSON.stringify(foto)) repintarSilencioso();
          }).catch(() => {});
          return foto;
        }
      }
    } catch (e) { /* cerebro caído o lento → Apps Script en vivo */ }
  }
  return await traer;
}

/* Guarda/recupera respuestas por usuario (token) en localStorage, para el arranque instantáneo.
 * Si el navegador se queda sin espacio, se descarta el bloque (los datos se re-piden y listo). */
function guardarLS(key, val) {
  try {
    const k = 'pms_datos_' + estado.token;
    const store = JSON.parse(localStorage.getItem(k) || '{}');
    store[key] = val;
    localStorage.setItem(k, JSON.stringify(store));
  } catch (e) { try { localStorage.removeItem('pms_datos_' + estado.token); } catch (_) {} }
}
function cargarDatosLS() {
  try {
    const store = JSON.parse(localStorage.getItem('pms_datos_' + estado.token) || '{}');
    Object.keys(store).forEach(k => { estado.cache[k] = store[k]; estado.stale.add(k); });
  } catch (e) { /* sin datos previos */ }
}
// Borra una respuesta cacheada de las TRES capas (memoria, marca de stale y localStorage) tras
// cambiar algo que vive en ella. `estado.cache = {}` NO alcanza: solo limpia la memoria, así que al
// reabrir la app `cargarDatosLS()` vuelve a pintar el estado anterior por un instante.
function invalidarClave(params) {
  const k = JSON.stringify(params);
  delete estado.cache[k]; estado.stale.delete(k);
  try {
    const lk = 'pms_datos_' + estado.token, s = JSON.parse(localStorage.getItem(lk) || '{}');
    delete s[k]; localStorage.setItem(lk, JSON.stringify(s));
  } catch (e) { /* ignore */ }
}
function invalidarMe() { invalidarClave({ action: 'me' }); }
// T15 — el directorio del equipo cambió (alta, edición o baja de una persona).
function invalidarEquipo() { invalidarClave({ action: 'equipo' }); invalidarClave({ action: 'equipoporunidad' }); }

/* Chip 🤖 de la cabecera: aparece SOLO para admins puros cuando la mensajería automática del bot
 * está apagada (me.mensajeriaAuto=false) — un toque la enciende. El switch completo sigue en
 * Configuración; esto es el acceso rápido que pidió el dueño. */
function pintarChipBot() {
  const el = $('#chip-bot');
  if (!el) return;
  const esAdminPuro = estado.yo && (estado.yo.rol === 'ceo_admin' || estado.yo.rol === 'admin');
  el.classList.toggle('oculto', !(esAdminPuro && estado.yo.mensajeriaAuto === false));
}

/* Repinta la vista actual sin spinner ni parpadeo (los datos ya están frescos en memoria). Solo
 * pestañas: el detalle de una unidad no se auto-repinta para no molestar (pull-to-refresh lo actualiza). */
function repintarSilencioso() {
  if (estado.unidadAbierta) return;
  estado.silencioso = true;
  Promise.resolve(irTab(estado.tab)).finally(() => { estado.silencioso = false; });
}

// F2: ESCRITURAS. POST sin headers (Content-Type text/plain) para evitar el preflight CORS que
// Apps Script no soporta; el body es el JSON con apiAction + token. Siempre devuelve {ok,...}.
// TIMEOUT (19/07/2026): antes no había ninguno y el botón se quedaba en "Creando…" para siempre si la
// red colgaba. 60 s — Apps Script corta solo a los 6 min. ⚠️ Abortar NO cancela al servidor: el CRM
// termina igual. Por eso el timeout solo es seguro ahora que las escrituras son IDEMPOTENTES del lado
// del servidor (_apiAgregarUnidad_ en api.js devuelve yaExistia:true en vez de duplicar).
async function apiPost(payload, msTimeout) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), msTimeout || 60000);
  let r;
  try {
    r = await fetch(API, { method: 'POST', body: JSON.stringify({ ...payload, token: estado.token }), signal: ctrl.signal });
  } finally { clearTimeout(t); }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  // Escribí algo → mis fotos del cerebro (Cloudflare) quedaron viejas: se borran y el carril
  // rápido se pausa un rato. Hasta el próximo job del CRM, mis lecturas salen del Apps Script
  // en vivo — jamás se ve el estado de ANTES del cambio.
  estado.sinCerebro = Date.now() + 10 * 60 * 1000;
  fetch('/datos?' + new URLSearchParams({ token: estado.token }), { method: 'DELETE' }).catch(() => {});
  // Apps Script NO siempre responde JSON: cuando el Sheet está bajo contención (los triggers tocando
  // el doc) devuelve una PÁGINA HTML "Se agotó el tiempo de espera del servicio Hojas de cálculo" con
  // status 200. r.json() reventaba ahí con un SyntaxError en inglés que llegaba crudo al usuario — es
  // el "FAILED TO LOAD" del 19/07/2026. Se detecta y se convierte en un error tipado y reintentable.
  const txt = await r.text();
  try {
    return JSON.parse(txt);
  } catch (e) {
    const err = new Error(/tiempo de espera|timed out/i.test(txt)
      ? 'el Sheet estaba ocupado' : 'respuesta no reconocida del servidor');
    err.sheetOcupado = true;
    throw err;
  }
}

/* ---------- Notificaciones push (Web Push, mismo origen que la PWA) ---------- */
const VAPID_PUBLIC = 'BDvdawPkcMMM_JEf7EdqjwIFk0y3xkv4LRPfQ9HWyhU3t_B4s-uM99WStEpUSlkTE355xZo-EnqVwDzkz124Xc4';
function urlB64ToU8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64), u = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
  return u;
}
function pushSoportado() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
async function estadoNotificaciones() {
  if (!pushSoportado()) return 'no-soportado';
  if (Notification.permission === 'denied') return 'bloqueado';
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (!reg) return 'sin-sw';
  return (await reg.pushManager.getSubscription()) ? 'activas' : 'inactivas';
}
async function activarNotificaciones() {
  if (!pushSoportado()) throw new Error('Este navegador no soporta notificaciones');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('No diste permiso de notificaciones');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(VAPID_PUBLIC) });
  const r = await fetch('/subscribe', { method: 'POST', body: JSON.stringify({ nombre: estado.yo.nombre, subscription: sub.toJSON() }) });
  const j = await r.json();
  if (!j.ok) throw new Error('No se pudo registrar el dispositivo');
  return true;
}

/* ---------- Utilidades ---------- */
const MES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const MES3 = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const DOW = ['DOM','LUN','MAR','MIÉ','JUE','VIE','SÁB'];
function fBonita(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-').map(Number);
  return d + ' ' + MES[m - 1].slice(0, 3);
}
// Fecha con el mes COMPLETO ("22 julio"), solo para los ENCABEZADOS de pestaña (pedido del dueño
// 22/07/2026). Las filas —check-ins, agenda, hilos— siguen con fBonita: ahí la corta es la que cabe.
function fLarga(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-').map(Number);
  return d + ' ' + MES[m - 1];
}
function hoyIso() { return new Date().toISOString().slice(0, 10); }
function esc(s) { const d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }
const PILL_ESTADO = {
  ocupada: ['busy', 'OCUPADA'], checkout_hoy: ['warn', 'CHECKOUT HOY'],
  checkout_manana: ['warn', 'CHECKOUT MAÑANA'], llegada_hoy: ['crit', 'LLEGADA HOY'], libre: ['ok', 'LIBRE'],
  rotacion: ['crit', 'ROTACIÓN HOY'],
};
// Fecha local del teléfono en ISO (hoyIso usa toISOString = UTC y en Ecuador corre 5 h adelantado
// por la noche — para comparar contra fechas del servidor SIEMPRE esta). offsetDias: -1 = ayer.
function hoyLocalIso(offsetDias) {
  const d = new Date(Date.now() + (offsetDias || 0) * 86400000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Hora "19:00" / "7 pm" / "11 45" → minutos desde medianoche. -1 si no interpreta. Espejo de
// _horaAMinutos_ del backend (whatsapp-huesped.js) para que app y bot midan igual.
function horaAMin(txt) {
  const t = String(txt || '').trim().toLowerCase();
  const ampm = /p\.?\s?m\.?/.test(t) ? 'pm' : (/a\.?\s?m\.?/.test(t) ? 'am' : '');
  const m = t.match(/([01]?\d|2[0-3])\s*[:h.\s]\s*([0-5]\d)/) || t.match(/([01]?\d|2[0-3])/);
  if (!m) return -1;
  let h = parseInt(m[1], 10); const mi = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return h * 60 + mi;
}
// SEMÁFORO POR HORA (21/07): estado de un huésped según fechas ci/co Y la hora del día + la hora que
// le dio al bot (hLleg/hSal). Reusado por HOY, Unidades y Mensajes. `luz` = clase del punto
// (.sem-dot ok/crit/prox; '' = sin punto). `inactivo` = ya salió → fila en gris tenue. `rank` = orden
// del dueño: sale hoy → salió/pasado → hospedando → entra hoy → próximos.
//   Check-in hoy: 🔴 Entra hoy hasta su hora de llegada (o HORA_CHECKIN, 3 PM) → 🟢 Hospedando.
//   Check-out hoy: 🔴 Sale hoy hasta su hora de salida (o HORA_CHECKOUT, 11 AM) → ⚪ inactivo.
function estadoHospedaje(ci, co, hLleg, hSal) {
  const hoy = hoyLocalIso(0);
  if (!ci || !co) return { luz: '', txt: '', rank: 6 };
  const ahora = new Date().getHours() * 60 + new Date().getMinutes();
  const cutIn = (hLleg && horaAMin(hLleg) >= 0 ? horaAMin(hLleg) : (estado.yo && estado.yo.horaCheckin != null ? estado.yo.horaCheckin : 15) * 60);
  const cutOut = (hSal && horaAMin(hSal) >= 0 ? horaAMin(hSal) : (estado.yo && estado.yo.horaCheckout != null ? estado.yo.horaCheckout : 11) * 60);
  if (co === hoy) {   // sale HOY
    if (ahora < cutOut) return { luz: 'crit', txt: 'Sale hoy' + (hSal ? ' ~' + hSal : ''), rank: 0 };
    return { luz: '', txt: 'Ya salió', rank: 1, inactivo: true };                 // pasó su hora → inactivo
  }
  if (co < hoy)   return { luz: '', txt: 'Finalizó ' + fBonita(co), rank: 1, inactivo: true };
  if (ci < hoy)   return { luz: 'ok', txt: 'Hospedando', rank: 2 };               // en curso (mid-stay)
  if (ci === hoy) {   // llega HOY
    if (ahora >= cutIn) return { luz: 'ok', txt: 'Hospedando', rank: 2 };         // ya pasó su hora → llegó
    return { luz: 'crit', txt: 'Entra hoy' + (hLleg ? ' ~' + hLleg : ''), rank: 3 };
  }
  return { luz: 'prox', txt: 'Próximo ' + fBonita(ci), rank: 5 };                 // futuro: punto gris
}
// El puntito del semáforo. '' = no dibuja nada (reservas terminadas/inactivas).
function semDot(luz) { return luz ? `<span class="sem-dot ${luz}"></span>` : ''; }
// Etiquetas legibles de los tipos de mensaje del bot (tareasbot: pendientes + hilos).
const TIPO_LABEL = {
  PRE_CHECKIN: 'Bienvenida pre check-in', CHECKIN_HORA: 'Pregunta de hora de llegada',
  POST_CHECKIN: '¿Todo bien con tu ingreso? (3 PM)',
  CODIGO_PROMPT: 'Propuesta de claves al admin', CODIGO_ACCESO: 'Claves de acceso',
  SEGUIMIENTO: 'Seguimiento de estadía', CHECKOUT: 'Recordatorio de checkout',
  POST_CHECKOUT: 'Agradecimiento post-checkout', CLAVE_ACTUALIZADA: 'Clave actualizada',
  DESCUENTO_5E: 'Descuento por 5★', FAQ: 'Preguntó (el bot respondió)', RELAY: 'Mensaje relevado al admin',
  HORA_LLEGADA: 'Dio su hora de llegada', HORA_SALIDA: 'Dio su hora de salida',
  WA_CAPTURADO: '📲 WhatsApp capturado', TEXTO: 'Mensaje del bot', IMAGEN: 'Imagen', DOCUMENTO: 'Documento',
  EQUIPO: 'Respuesta del equipo',
};
const PILL_PEND = {
  enviado: ['ok', '✅ ENVIADO'], programado: ['warn', '⏳ PROGRAMADO'],
  bloqueado_sin_numero: ['crit', '🚫 SIN NÚMERO'], bloqueado_sin_direccion: ['crit', '⚠️ SIN DIRECCIÓN'],
  switch_off: ['busy', '⛔ SWITCH OFF'],
};
// Copia texto al portapapeles con fallback iOS viejo + feedback en el botón.
async function copiarTexto(btn, texto) {
  let ok = false;
  try { await navigator.clipboard.writeText(texto); ok = true; }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = texto; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (e2) {}
    ta.remove();
  }
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = ok ? '✓ Copiado — pégalo en Airbnb' : 'No se pudo copiar';
    setTimeout(() => { btn.textContent = orig; }, 1800);
  }
}
// Badge rojo del tab TAREAS: huéspedes sin WhatsApp + envíos bloqueados. Silencioso si la API falla.
async function actualizarBadgeTareas() {
  const el = $('#badge-tareas');
  if (!el) return;
  try {
    const j = await api({ action: 'tareasbot' });
    // p.dia = solo hoy/mañana: sin ese filtro, el horizonte de 30 días de pendientes inflaría el badge.
    // Las aprobaciones de claves ya NO cuentan acá: viven en MENSAJES (#badge-msj).
    const n = (j.sinWhatsapp || []).length +
      (j.pendientes || []).filter(p => p.dia && String(p.estado).indexOf('bloqueado') === 0).length;
    el.textContent = n > 9 ? '9+' : String(n);
    el.classList.toggle('oculto', n === 0);
  } catch (e) { el.classList.add('oculto'); }
}
// Badge de MENSAJES: aprobaciones de claves que esperan el OK (la sección vive en esa pestaña).
async function actualizarBadgeMensajes() {
  const el = $('#badge-msj');
  if (!el) return;
  try {
    const j = await api({ action: 'tareasbot' });
    const n = (estado.yo && estado.yo.rol === 'limpieza') ? 0
      : (j.aprobaciones || []).filter(a => !estado.hechasLocal['apr:' + a.codigo]).length;
    el.textContent = n > 9 ? '9+' : String(n);
    el.classList.toggle('oculto', n === 0);
  } catch (e) { el.classList.add('oculto'); }
}
// (El badge de "avisos" murió con la pestaña Notificación — T9: los avisos viven ahora como
//  "Actividad" dentro de cada conversación de MENSAJES.)

/* ---------- SALUD DEL PMS (3 luces: BOT · GOOGLE SHEETS · PMS APP) ----------
 * Todas las señales ya se escriben solas en el CRM (acción `salud`, solo lectura); el ping del
 * webhook lo hace este cliente directo a su URL. En 👤 Cuenta viven las 3 luces siempre visibles;
 * en la appbar solo aparece un punto ROJO cuando algo NO está verde (el silencio es verde). */
async function comprobarSalud(pintarCaja) {
  const [s, pingOk] = await Promise.all([
    api({ action: 'salud' }, false).catch(() => null),
    fetch(WEBHOOK_PING).then(r => r.ok).catch(() => false),
  ]);
  const antes7 = new Date().getHours() < 7;   // los triggers de la mañana aún no corren: ayer cuenta
  const luces = {
    app: s ? 'ok' : 'crit',
    sheets: !s ? 'crit'
      : (s.sheets.ingestaMin == null ? 'warn'
        : s.sheets.ingestaMin <= 45 ? 'ok'
        : s.sheets.ingestaMin <= 180 ? 'warn' : 'crit'),
    bot: !pingOk ? 'crit'
      : (!s ? 'warn' : ((s.bot.triggersHoy || antes7) && s.bot.ingestaTrigger !== false ? 'ok' : 'warn')),
  };
  estado.saludMal = Object.values(luces).some(v => v !== 'ok');
  // 3 puntitos SIEMPRE visibles junto al 👤 (pedido del dueño 21/07): Bot · Sheets · App.
  const mini = $('#salud-mini');
  if (mini) {
    mini.classList.remove('oculto');
    mini.querySelectorAll('.dot').forEach(d => { d.className = 'dot ' + (luces[d.dataset.luz] || ''); });
  }
  if (!pintarCaja) return;
  const caja = $('#salud-caja');
  if (!caja) return;
  const icono = (e) => e === 'ok' ? '🟢' : e === 'warn' ? '🟡' : '🔴';
  const fila = (e, nombre, det) => `<div class="lista-item"><span style="flex:1;min-width:0">
    <span class="quien">${icono(e)} ${nombre}</span><br><span class="sub">${det}</span></span></div>`;
  const detBot = !pingOk ? 'El bot de WhatsApp no responde — avisa a Andrés.'
    : luces.bot === 'ok' ? 'Webhook respondiendo' + (s && s.bot.triggersHoy ? ' · los trabajos de la mañana corrieron hoy.' : ' (los trabajos de la mañana corren a las ~6 AM).')
    : 'El webhook vive, pero los trabajos de la mañana no corrieron' + (s && s.bot.ingestaTrigger === false ? ' y falta el trigger de ingesta' : '') + '.';
  const detSheets = !s ? 'Sin datos (la API no respondió).'
    : s.sheets.ingestaMin == null ? 'El Sheet abre, pero no hay registro de la ingesta de Gmail.'
    : luces.sheets === 'ok' ? `Sheet abierto · reservas de Gmail leídas hace ${s.sheets.ingestaMin} min.`
    : `La ingesta de Gmail no corre hace ${s.sheets.ingestaMin} min.`;
  caja.innerHTML =
    fila(luces.bot, 'Bot de WhatsApp', detBot) +
    fila(luces.sheets, 'Google Sheets (CRM)', detSheets) +
    fila(luces.app, 'PMS App (API)', s ? 'Respondiendo con normalidad.' : 'La API no responde — la app está usando su última copia local.') +
    `<button class="btn secundario btn-mini" id="salud-again" style="margin-top:10px">Volver a comprobar</button>`;
  const btn = $('#salud-again');
  if (btn) btn.addEventListener('click', () => {
    caja.innerHTML = '<div class="vacio">Comprobando…</div>';
    comprobarSalud(true);
  });
}
function pillEstado(e) {
  const [cls, txt] = PILL_ESTADO[e] || ['busy', String(e || '').toUpperCase()];
  return `<span class="pill ${cls}">${txt}</span>`;
}
// Píldora y sub-línea del estado de una unidad (tarjeta de la grilla Y detalle). Con rotación
// (sale Y llega hoy) la píldora es ROTACIÓN — nunca fiarse del `estado` del backend en ese caso,
// que depende del orden de filas de la hoja. Defensivo con payloads viejos (sin saleHoy/llegaHoy).
function pillUnidad(u) { return (u.saleHoy && u.llegaHoy) ? pillEstado('rotacion') : pillEstado(u.estado); }
function subUnidad(u) {
  const filas = [];
  if (u.saleHoy) filas.push('⬅ Sale hoy: ' + esc(u.saleHoy));
  if (u.llegaHoy) filas.push('➡ Llega hoy: ' + esc(u.llegaHoy));
  if (!u.saleHoy && u.estado !== 'libre' && u.huesped) filas.push(esc(u.huesped) + (u.hasta ? ' · hasta ' + fBonita(u.hasta) : ''));
  if (u.proximaLlegada && u.proximoHuesped !== u.llegaHoy) filas.push('Llega ' + fBonita(u.proximaLlegada) + ': ' + esc(u.proximoHuesped));
  if (!filas.length) filas.push('Sin reservas próximas');
  return filas.join('<br>');
}
// ★ favoritas (máx 3, clave FAV_<usuario> en la hoja vía setFavoritas — sincroniza entre teléfonos).
// Helper compartido por la tarjeta de la grilla y el detalle. Devuelve true si se guardó.
async function toggleFavorita(unidad, btn) {
  const favs = [...(estado.yo.favoritas || [])];
  const idx = favs.indexOf(unidad);
  if (idx >= 0) favs.splice(idx, 1);
  else {
    if (favs.length >= 3) { alert('Máximo 3 favoritas — quita la ★ de otra unidad primero.'); return false; }
    favs.push(unidad);
  }
  btn.disabled = true;
  try {
    const r = await apiPost({ apiAction: 'setFavoritas', unidades: favs });
    if (!r.ok) throw new Error(r.error || 'error');
    estado.yo.favoritas = r.favoritas || favs;
    estado.cache = {};
    return true;
  } catch (e) { alert('No se pudo guardar la favorita (' + e.message + ').'); return false; }
  finally { btn.disabled = false; }
}

/* ---------- Componentes de marca ---------- */
/* Tanda 6 (pedido del dueño): FUERA el bloque rojo gigante. hero() ahora es una franja SOBRIA —
 * subtítulo gris pequeño + KPIs en tarjeta compacta (números rojos) + extra. El título de la vista
 * vive en la appbar (negro, bold, a la izquierda). Mismo contrato de llamada: cero cambios en las
 * vistas que ya lo usan. */
function hero(sub, kpis, extra) {
  const k = (kpis || []).map(x => `<div><div class="n">${x[0]}</div><div class="l">${x[1]}</div></div>`).join('');
  let h = '';
  if (sub) h += `<div class="pagina-sub">${sub}</div>`;
  if (k) h += `<div class="tarjeta kpi-strip"><div class="kpis">${k}</div></div>`;
  if (extra) h += extra;
  return h ? `<div class="pagina-cabecera">${h}</div>` : '';
}
function tituloSeccion(t, sub) {
  return `<div class="titulo-seccion"><h2>${t}</h2></div>${sub ? `<div class="titulo-sub">${sub}</div>` : ''}`;
}
// (El pie de marca "1242bnb" se retiró de todas las pestañas — pedido del dueño 19/07: redundante.)
// Abrevia el nombre para que quepa en la caja del monograma: multi-palabra → iniciales (CASA CUENCA→CC,
// SAN ROQUE→SR); una sola palabra larga → primeras 3 letras; código corto (2A) → tal cual.
function abrevUnidad(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  const palabras = s.split(/\s+/).filter(Boolean);
  if (palabras.length > 1) return palabras.map(p => p[0]).join('').slice(0, 3).toUpperCase();
  return s.length <= 3 ? s.toUpperCase() : s.slice(0, 3).toUpperCase();
}
function monograma(u) { return `<div class="monograma" title="${esc(u)}">${esc(abrevUnidad(u))}</div>`; }
// Avatar de la unidad: miniatura del anuncio (og:image) si existe; si no, el monograma rojo.
function avatarUnidad(u) {
  return u && u.foto
    ? `<img class="foto-unidad" src="${esc(u.foto)}" alt="${esc(u.unidad)}" loading="lazy">`
    : monograma(u ? u.unidad : '');
}
// Avatar del box superior (variante con métricas): el NOMBRE de la unidad incrustado en blanco sobre la
// foto (abajo-izq, con degradado para legibilidad) + la estrella de favorita arriba-derecha. Sobre el
// monograma el nombre ya se ve, así que ahí no se duplica. El botón conserva data-fav (handler global).
function avatarUnidadNom(unidad, foto, favActiva) {
  const favBtn = `<button class="uni-foto-fav fav-btn ${favActiva ? 'activa' : ''}" data-fav="${esc(unidad)}" title="Favorita (máx 3)">${favActiva ? '★' : '☆'}</button>`;
  return foto
    ? `<div class="uni-foto-wrap">
         <img class="foto-unidad" src="${esc(foto)}" alt="${esc(unidad)}" loading="lazy">
         <span class="uni-foto-shade"></span><span class="uni-foto-nom">${esc(unidad)}</span>${favBtn}
       </div>`
    : `<div class="uni-foto-wrap">${monograma(unidad)}${favBtn}</div>`;
}

// Dona estilo reporte: segmentos [{v, color}], texto central grande + chico.
function dona(segs, centroN, centroL) {
  const R = 42, C = 2 * Math.PI * R;
  const total = segs.reduce((s, x) => s + x.v, 0) || 1;
  let off = C * 0.25, arcs = '';
  segs.forEach(s => {
    const len = s.v / total * C;
    if (s.v > 0) arcs += `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${s.color}" stroke-width="16" stroke-dasharray="${len.toFixed(1)} ${(C - len).toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>`;
    off -= len;
  });
  return `<svg viewBox="0 0 120 120" width="118" height="118" role="img">
    ${arcs || `<circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--line)" stroke-width="16"/>`}
    <text x="60" y="58" text-anchor="middle" class="dona-centro-n">${centroN}</text>
    <text x="60" y="74" text-anchor="middle" class="dona-centro-l">${centroL}</text>
  </svg>`;
}

// Barrita compacta de 3 meses (rendimiento de la unidad). vals = [{v, act}]; act = mes en curso, resaltado
// en rojo de marca; los dos anteriores en --tint-bar (GRIS desde el 22/07/2026: con el granate viejo
// tenían 1.37:1 de contraste contra la tarjeta y el dueño los veía como si no existieran, quedándose sin
// referencia contra qué comparar). Escala al máximo local.
function miniBarras(vals) {
  const w = 108, h = 34, n = vals.length || 1, gap = 3;
  const bw = (w - gap * (n - 1)) / n;
  const max = Math.max(1, ...vals.map(d => d.v));
  const barras = vals.map((d, i) => {
    const bh = Math.max(2, Math.round((d.v / max) * (h - 3)));
    const x = i * (bw + gap), y = h - bh;
    return `<rect class="mb${d.act ? ' mb-act' : ''}" x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${bh}" rx="1.5"></rect>`;
  }).join('');
  return `<svg class="minibar" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${barras}</svg>`;
}
// Métricas de la unidad para incrustar JUNTO A la foto en el box superior (una franja): 3 celdas
// (Reservas del mes · ADR/noche · Reseñas 5★ del año), cada una número + barrita de 6 meses. Solo llega
// con `perf` (quien ve ingresos); sin cifras de ingresos crudas, solo ADR/noche como en REPORTES.
function metricasUnidad(p) {
  const ult = p.serie.length - 1;
  const barr = (campo) => miniBarras(p.serie.map((s, i) => ({ v: s[campo], act: i === ult })));
  // 4 celdas: Reservas · ADR · 5★ del mes (genuinas) · dona de limpiezas (profundas/total hasta hoy).
  // Etiquetas en palabra completa (22/07/2026): el "·jul" salió de las tres porque el mes ya se lee en
  // el encabezado ("22 julio"), y el "de N" de la dona se fue ADENTRO de la dona ("2/5").
  const cards = [
    `<div class="perf-card"><div class="perf-num">${p.reservasMes}</div>${barr('reservas')}<div class="perf-lbl">Reservas</div></div>`,
    `<div class="perf-card"><div class="perf-num">$${p.adrMes || 0}</div>${barr('adr')}<div class="perf-lbl">ADR</div></div>`,
    `<div class="perf-card"><div class="perf-num">${p.cincoMes}</div>${barr('cinco')}<div class="perf-lbl">5★</div></div>`,
    `<div class="perf-card">${donaMini(p.profundasMes || 0, p.limpiezasMes || 0)}<div class="perf-lbl">Profundas</div></div>`,
  ];
  return `<div class="perf-grid g4">${cards.join('')}</div>`;
}
// Dona chica para la franja: `prof` (profundas del mes) resaltadas sobre `total` (limpiezas del mes hasta
// hoy). Centro = "2/5" — profundas SOBRE el total, adentro de la dona (pedido del dueño 22/07/2026); por
// eso .dona-mini-n bajó de 52 a 36 px: el hueco mide 68 y tres caracteres a 52 se salían por los lados.
// La etiqueta de la celda queda en "Profundas" a secas. Geometría de dona() (dashoffset C·0.25).
function donaMini(prof, total) {
  const R = 42, C = 2 * Math.PI * R;
  const t = Math.max(total, prof, 0);
  const len = t > 0 ? (prof / t) * C : 0;
  const arco = prof > 0
    ? `<circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--brand)" stroke-width="16" stroke-dasharray="${len.toFixed(1)} ${(C - len).toFixed(1)}" stroke-dashoffset="${(C * 0.25).toFixed(1)}"/>`
    : '';
  return `<svg class="dona-mini" viewBox="0 0 120 120" role="img" aria-label="${prof} profundas de ${t} limpiezas">
    <circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--tint-bar)" stroke-width="16"/>${arco}
    <text x="60" y="73" text-anchor="middle" class="dona-mini-n">${prof}/${t}</text>
  </svg>`;
}

/* ---------- Shell ---------- */
function mostrarCarga(on) { $('#cargando').classList.toggle('oculto', !on); }
function render(html) { $('#vista').innerHTML = html; }
// Título de la vista en la appbar: negro bold, alineado a la izquierda (regla del dueño, T6).
function setTitulo(t) { estado.tituloActual = t; const el = $('#titulo-vista'); if (el) el.textContent = t; }

async function irTab(tab) {
  estado.tab = tab;
  estado.unidadAbierta = null;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('activo', b.dataset.tab === tab));
  const btnMas = $('#btn-mas'); if (btnMas) btnMas.remove();
  if (!estado.silencioso) { mostrarCarga(true); render(''); }   // en repintado silencioso NO se pone en blanco
  try {
    if (tab === 'unidades') await vistaUnidades();
    else if (tab === 'tareas') await vistaTareas();
    else if (tab === 'reportes') await vistaReportes();
    else if (tab === 'config') await vistaConfigUnidad();
    else if (tab === 'mensajes') await vistaMensajes();
    else if (tab === 'fotos') await vistaFotoRapida();
    else await vistaCuenta();
  } catch (e) {
    render(`<div class="cuerpo-vista"><div class="error-caja">No se pudo cargar. Revisa tu conexión e intenta de nuevo.<br><small>${esc(e.message)}</small></div></div>`);
  }
  mostrarCarga(false);
}

/* Refresco de la vista actual: limpia el caché del cliente y re-renderiza la pestaña donde estés.
 * Lo usan el botón ⟳ y el gesto de arrastrar hacia abajo. */
function refrescarActual() {
  estado.cache = {};
  irTab(estado.tab);
  actualizarBadgeTareas(); actualizarBadgeMensajes();
}

/* Pull-to-refresh: arrastrar hacia abajo desde el tope de la página refresca la vista.
 * El scroll vive en el documento (body tiene overscroll-behavior-y: none, así que no pelea
 * con el rebote nativo). Solo se engancha si el gesto ARRANCA con la página en el tope,
 * es más vertical que horizontal y la app está visible (no en el login). */
function engancharPullToRefresh() {
  const UMBRAL = 70, TOPE = 110;
  const ind = $('#ptr');
  if (!ind) return;
  let y0 = 0, x0 = 0, activo = false, jalando = false;

  document.addEventListener('touchstart', (e) => {
    activo = jalando = false;
    if ($('#app').classList.contains('oculto')) return;
    if ((window.scrollY || document.documentElement.scrollTop) > 0) return;
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX;
    activo = true;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!activo) return;
    const dy = e.touches[0].clientY - y0, dx = e.touches[0].clientX - x0;
    if (!jalando) {
      if (dy < 12 || Math.abs(dx) > dy) { if (dy < -6 || Math.abs(dx) > 24) activo = false; return; }
      jalando = true;
      ind.classList.add('visible');
    }
    const d = Math.min(dy * 0.45, TOPE);
    ind.style.transform = `translateX(-50%) translateY(${d}px) rotate(${d * 3}deg)`;
    ind.classList.toggle('listo', d >= UMBRAL * 0.45);
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!jalando) { activo = false; return; }
    const suelta = ind.classList.contains('listo');
    ind.classList.remove('visible', 'listo');
    ind.style.transform = '';
    activo = jalando = false;
    if (suelta) refrescarActual();
  });
}

/* ---------- Vista: UNIDADES ---------- */
/* T11 (rediseño del dueño): UNIDADES deja de ser una grilla de tarjetas y pasa al MISMO patrón de
 * REPORTES — chips de unidad arriba + "ordenar por", y debajo TODO lo de la unidad elegida: su
 * estado de hoy y cuatro accesos (Contrato · Gastos · Descripción · Editar unidad). Las sub-pestañas
 * del detalle (Estado/Tareas/Reportes/Config) se retiraron: la configuración vive en la pestaña ⚙ y
 * el checklist que se MARCA vive en su propia pantalla, a la que se entra desde HOY. */
async function vistaUnidades() {
  setTitulo('Unidades');
  const j = await api({ action: 'unidades' });
  if (j.error) throw new Error(j.error);
  const favs = estado.yo.favoritas || [];
  const esLimpieza = estado.yo.rol === 'limpieza';
  const esAdminU = estado.yo.rol === 'ceo_admin' || estado.yo.rol === 'admin';
  let us = [...(j.unidades || [])];
  const nOcup = us.filter(u => u.estado === 'ocupada' || u.estado === 'checkout_manana').length;
  const nLibre = us.filter(u => u.estado === 'libre').length;
  const nHoy = us.filter(u => u.estado === 'llegada_hoy' || u.estado === 'checkout_hoy' || u.saleHoy || u.llegaHoy).length;

  // Mismo "ordenar por" que REPORTES (estado.uniOrden), con movimiento de hoy en vez de ingresos.
  const orden = estado.uniOrden || 'az';
  const conMov = u => (u.saleHoy || u.llegaHoy || u.estado === 'llegada_hoy' || u.estado === 'checkout_hoy') ? 1 : 0;
  if (orden === 'movimiento') us.sort((a, b) => conMov(b) - conMov(a) || a.unidad.localeCompare(b.unidad));
  else if (orden === 'fav') us.sort((a, b) => (favs.includes(b.unidad) - favs.includes(a.unidad)) || a.unidad.localeCompare(b.unidad));
  else us.sort((a, b) => a.unidad.localeCompare(b.unidad));
  const lista = us.map(u => u.unidad);
  if (!estado.uniSel || lista.indexOf(estado.uniSel) === -1) estado.uniSel = lista[0] || '';
  const U = estado.uniSel;
  const u = us.find(x => x.unidad === U) || {};

  const chips = us.map(x => `<button class="chipu ${x.unidad === U ? 'sel' : ''}" data-uni="${esc(x.unidad)}">${favs.includes(x.unidad) ? '★ ' : ''}${esc(x.unidad)}</button>`).join('');
  const ORDENES = [['az', 'A–Z'], ['movimiento', 'Movimiento hoy'], ['fav', '★ Favoritas']];

  // Instant: las MÉTRICAS salen de la LISTA (u.perf), ya cargada. El detalle `unidad` (calendario/ficha/
  // proximas) NO bloquea el primer paint: se usa el que haya en memoria y, si el fresco difiere, se
  // re-pinta por detrás (abajo). Así las gráficas aparecen al toque aunque el detalle tarde ~4 s.
  const dKey = JSON.stringify({ action: 'unidad', unidad: U });
  const d = U ? (estado.cache[dKey] || null) : null;
  const hoyI0 = hoyLocalIso(0);
  const pr = (d && d.proximas) || [];
  const enCursoR = pr.find(r => r.checkin < hoyI0 && r.checkout > hoyI0);
  const saleHoyR = pr.find(r => r.checkout === hoyI0);
  const llegaHoyR = pr.find(r => r.checkin === hoyI0);
  // Fila clickeable (estilo Airbnb, 21/07): toda la celda abre el chat del huésped en Mensajes — sin
  // botón "Chat". Semáforo POR HORA al inicio; el huésped que ya salió va en gris tenue (.inactivo).
  const filaRes = (r, tag) => {
    const e = estadoHospedaje(r.checkin, r.checkout, r.horaLlegada, r.horaSalida);
    return `
    <div class="lista-item${r.codigo ? ' tocable' : ''}${e.inactivo ? ' inactivo' : ''}"${r.codigo ? ` data-chat="${esc(r.codigo)}" data-chat-nombre="${esc(r.huesped)}"` : ''}>
      <span style="flex:1"><span class="quien">${semDot(e.luz)}${tag}: ${esc(r.huesped)}</span><br>
        <span class="sub">${fBonita(r.checkin)} → ${fBonita(r.checkout)} · ${r.noches} noche${r.noches === 1 ? '' : 's'}${r.huespedes ? ' · ' + r.huespedes + ' huésp.' : ''}</span></span>
    </div>`;
  };
  // T15 — antes esto solo mostraba lo de HOY, así que en una unidad sin movimiento del día la sección
  // salía vacía aunque hubiera un check-out mañana. Ahora lista los PRÓXIMOS check-ins y check-outs de
  // la unidad (los de hoy marcados como HOY), además de la reserva en curso.
  // No se reusa el markup de la pestaña HOY a propósito: allá cada fila lleva el monograma de la
  // unidad, que acá sería ruido — ya estamos dentro de una sola unidad.
  const movs = [];
  pr.forEach(r => {
    if (r.checkin >= hoyI0) movs.push({ f: r.checkin, tipo: 'Check-in', r });
    if (r.checkout >= hoyI0) movs.push({ f: r.checkout, tipo: 'Check-out', r });
  });
  movs.sort((a, b) => a.f.localeCompare(b.f) || (a.tipo === 'Check-out' ? -1 : 1));
  // Semáforo POR MOVIMIENTO (21/07): una fila de check-in usa el estado de LLEGADA (entra→hospedando
  // por su hora); una de check-out usa el de SALIDA (sale→ya salió por su hora). Futuro = gris.
  const ahoraMin = new Date().getHours() * 60 + new Date().getMinutes();
  const filaMov = (m) => {
    const esIn = m.tipo === 'Check-in', hoyMov = m.f === hoyI0;
    let luz = 'prox', label = m.tipo, inactivo = false;
    if (hoyMov && esIn) {
      const cut = (m.r.horaLlegada && horaAMin(m.r.horaLlegada) >= 0 ? horaAMin(m.r.horaLlegada) : (estado.yo.horaCheckin != null ? estado.yo.horaCheckin : 15) * 60);
      if (ahoraMin >= cut) { luz = 'ok'; label = 'Hospedando'; } else { luz = 'crit'; label = 'Check-in HOY'; }
    } else if (hoyMov && !esIn) {
      const cut = (m.r.horaSalida && horaAMin(m.r.horaSalida) >= 0 ? horaAMin(m.r.horaSalida) : (estado.yo.horaCheckout != null ? estado.yo.horaCheckout : 11) * 60);
      if (ahoraMin < cut) { luz = 'crit'; label = 'Check-out HOY'; } else { luz = ''; label = 'Salió'; inactivo = true; }
    }
    return `
    <div class="lista-item${m.r.codigo ? ' tocable' : ''}${inactivo ? ' inactivo' : ''}"${m.r.codigo ? ` data-chat="${esc(m.r.codigo)}" data-chat-nombre="${esc(m.r.huesped)}"` : ''}>
      <span style="flex:1"><span class="quien">${semDot(luz)}${label}: ${esc(m.r.huesped)}</span><br>
        <span class="sub">${fBonita(m.f)}${m.f === hoyLocalIso(1) ? ' · mañana' : ''}</span></span>
    </div>`;
  };
  const filasHoy = [
    enCursoR ? filaRes(enCursoR, 'Reserva en curso') : '',
    movs.slice(0, 6).map(filaMov).join(''),
  ].filter(Boolean).join('');
  const ficha = (d && d.ficha) || {};
  const fichaFilas = Object.keys(ficha)
    .filter(k => k !== 'unidad' && String(ficha[k]).trim() && !/_en$/.test(k))
    .map(k => `<div class="lista-item"><span class="quien">${esc(k.replace(/_/g, ' '))}</span><span style="text-align:right">${esc(ficha[k])}</span></div>`).join('');

  render(
    // T15 — la tira de 3 cuadros rojos (OCUPADAS/LIBRES/MOVIMIENTO HOY) se retiró: ocupaba un cuarto
    // de pantalla para tres números. Van en la MISMA línea del encabezado, con el mismo texto.
    hero(`${esLimpieza ? 'Hola ' + esc(estado.yo.nombre) + ' · tus unidades' : 'Tus unidades'} · ${fLarga(j.hoy)}` +
         ` · ${nOcup} ocupadas · ${nLibre} libres · ${nHoy} movimiento hoy`) +
    `<div class="cuerpo-vista">
      <div class="rep-barra">
        <div class="rep-chips">${chips}</div>
        <label class="rep-orden">ordenar por
          <select id="uni-orden">${ORDENES.map(o => `<option value="${o[0]}" ${orden === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>
        </label>
      </div>
      ${U ? `
      <div class="tarjeta">
        ${(u && u.perf) ? `
        <div class="fila-unidad fila-metricas">${avatarUnidadNom(U, (d && d.foto) || u.foto, favs.includes(U))}
          <div class="resto">${metricasUnidad(u.perf)}</div>
        </div>` : `
        <div class="fila-unidad">${avatarUnidad({ unidad: U, foto: (d && d.foto) || u.foto })}
          <div class="resto">
            <div class="tarjeta-fila"><h3>${esc(U)}</h3>
              <span style="display:flex;gap:6px;align-items:center">${pillUnidad(u)}<button class="fav-btn ${favs.includes(U) ? 'activa' : ''}" data-fav="${esc(U)}" title="Favorita (máx 3)">${favs.includes(U) ? '★' : '☆'}</button></span>
            </div>
            <div class="sub">${subUnidad(u)}</div>
          </div>
        </div>`}
      </div>
      ${/* T15 — la gestión sube a JUSTO DEBAJO del selector: son las acciones de la unidad elegida y
            estaban al fondo, después de todo el detalle. VER DESCRIPCIÓN se retiró (queda pendiente);
            su sección sigue en el DOM para poder devolverla con una línea. Se usa .fila-oscura, que
            existe en styles.css, en vez de .uni-acciones, que nunca existió y dejaba los botones
            apilados en vez de en fila. */''}
      <div class="fila-oscura">
        ${esAdminU ? `<button class="btn-oscuro" id="u-contrato">VER CONTRATO</button>` : ''}
        ${esAdminU ? '<button class="btn-oscuro" id="u-gastos">VER GASTOS</button>' : ''}
        ${esLimpieza ? '' : '<button class="btn-oscuro" id="u-editar">EDITAR UNIDAD</button>'}
      </div>
      <input type="file" id="u-file-contrato" accept="image/*,application/pdf" class="oculto">
      <div id="u-contrato-msg" class="sub oculto" style="margin:8px 4px 0"></div>
      ${esAdminU && d && d.contrato && d.contrato.url ? `<div class="sub" style="margin:8px 4px 0">Contrato del ${esc(d.contrato.fecha || '')} · <a class="enlace-wa" target="_blank" rel="noopener" href="${esc(d.contrato.url)}">Ver</a></div>` : ''}
      <div id="u-sec-descripcion" class="oculto">
        ${tituloSeccion('Descripción')}
        <div class="tarjeta">${(d && d.descripcion) ? esc(d.descripcion).replace(/\n/g, '<br>') : '<div class="vacio">Sin descripción aún — cárgala en la pestaña Config de la unidad.</div>'}
          ${fichaFilas ? `<div style="margin-top:10px">${fichaFilas}</div>` : ''}
        </div>
      </div>
      ${/* 21/07 — las 3 métricas (Reservas/ADR/5★) subieron a la tarjeta de arriba, junto a la foto
            (solo para quien ve ingresos). La lista de check-ins/check-outs REGRESA acá para todos los
            roles: ahí vuelve a verse el "Sale/Llega hoy" y se toca para abrir el chat del huésped. */''}
      ${(U && !d)
        ? tituloSeccion('Check-ins y check-outs') + `<div class="tarjeta"><div class="vacio">Cargando movimientos…</div></div>`
        : (filasHoy ? tituloSeccion('Check-ins y check-outs', 'Toca una fila para abrir el chat del huésped en Mensajes') + `<div class="tarjeta">${filasHoy}</div>` : '')}
      <button class="btn" id="u-fotos" style="margin-top:14px">AGREGAR FOTOS</button>
      ` : '<div class="vacio">No hay unidades visibles para tu usuario.</div>'}
      ${/* "Buscar disponibilidad" se APAGÓ de la app (21/07, decisión del dueño): se usa por la web o
            por el bot. El backend `disponibilidad` (público) sigue vivo; vistaDisponibilidad/
            buscarDisponibilidad quedan dormidas (restaurar = devolver la tarjeta con su handler). */''}
    </div>`);

  document.querySelectorAll('[data-uni]').forEach(c => c.addEventListener('click', () => { estado.uniSel = c.dataset.uni; vistaUnidades(); }));
  const selU = document.querySelector('.chipu.sel');
  if (selU) selU.scrollIntoView({ block: 'nearest', inline: 'center' });
  $('#uni-orden').addEventListener('change', e => { estado.uniOrden = e.target.value; vistaUnidades(); });
  document.querySelectorAll('[data-fav]').forEach(b => b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (await toggleFavorita(b.dataset.fav, b)) vistaUnidades();
  }));
  document.querySelectorAll('[data-chat]').forEach(b => b.addEventListener('click', () => {
    estado.mensajesFoco = { codigo: b.dataset.chat, nombre: b.dataset.chatNombre || '' };
    irTab('mensajes');
  }));
  const bg = $('#u-gastos'); if (bg) bg.addEventListener('click', () => vistaGastos(U));
  const bf = $('#u-fotos'); if (bf) bf.addEventListener('click', () => vistaInventario(U));
  const be = $('#u-editar'); if (be) be.addEventListener('click', () => { estado.cfgUnidad = U; irTab('config'); });
  // T15 — el botón VER DESCRIPCIÓN se retiró (queda pendiente). El handler se conserva, guardado por
  // el if: devolver el botón a `.fila-oscura` es la única línea que hace falta para reactivarlo.
  const bdesc = $('#u-descripcion');
  if (bdesc) bdesc.addEventListener('click', () => $('#u-sec-descripcion').classList.toggle('oculto'));
  // Contrato: el botón dice siempre VER CONTRATO. Si hay uno cargado, lo abre; si no, avisa y abre el
  // selector para subirlo (el mismo botón sirve para ver y para cargar el primero).
  const bc = $('#u-contrato'), fc = $('#u-file-contrato'), mc = $('#u-contrato-msg');
  if (bc) bc.addEventListener('click', () => {
    if (d && d.contrato && d.contrato.url) { window.open(d.contrato.url, '_blank', 'noopener'); return; }
    if (mc) { mc.textContent = 'Aún no hay contrato — elegí el archivo para subirlo.'; mc.style.color = 'var(--muted)'; mc.classList.remove('oculto'); }
    fc.click();
  });
  if (fc) fc.addEventListener('change', async () => {
    const f = fc.files && fc.files[0];
    if (!f) return;
    mc.textContent = 'Subiendo contrato…'; mc.style.color = 'var(--muted)'; mc.classList.remove('oculto');
    try {
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
      const r = await apiPost({ apiAction: 'invSubirContrato', unidad: U, nombre: f.name, mime: f.type, datos: b64 });
      if (!r.ok) throw new Error(r.error || 'error');
      mc.textContent = 'Contrato subido.'; mc.style.color = 'var(--good)';
      estado.cache = {};
      setTimeout(() => vistaUnidades(), 900);
    } catch (e) { mc.textContent = 'No se pudo subir (' + e.message + ').'; mc.style.color = 'var(--crit)'; }
  });
  if (!esLimpieza && !document.getElementById('btn-mas')) {
    const btn = document.createElement('button');
    btn.id = 'btn-mas'; btn.className = 'btn-flotante'; btn.textContent = '+'; btn.title = 'Agregar unidad';
    btn.addEventListener('click', vistaAgregarUnidad);
    document.body.appendChild(btn);
  }
  // Instant-load: dispara el detalle pesado en segundo plano; cuando llega (o cambia), re-pinta la vista
  // UNA vez (al re-entrar, el peek ya tiene el fresco cacheado → coincide → no vuelve a re-pintar).
  if (U) api({ action: 'unidad', unidad: U }).then(dd => {
    if (dd && !dd.error && JSON.stringify(dd) !== JSON.stringify(d)) vistaUnidades();
  }).catch(() => {});
}

/* ---------- Vista: INVENTARIO (F2 — fotos por categoría, contrato, gastos, PDF al dueño) ---------- */
const CAT_LABEL = { LINEA_BLANCA: '🧺 Línea blanca', INSUMOS: '🧴 Insumos', DISPOSITIVOS: '📺 Dispositivos', INMUEBLE: '🏠 Inmueble' };
function mesBonito(m) { return m && m.length === 7 ? MES[+m.slice(5) - 1][0].toUpperCase() + MES[+m.slice(5) - 1].slice(1) + ' ' + m.slice(0, 4) : m; }
function idDrive(url) { const m = String(url).match(/id=([\w-]+)/); return m ? m[1] : ''; }
function miniatura(url) { const id = idDrive(url); return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w400` : url; }

// Comprime una foto del celular a JPEG ~1280px (300KB aprox) y la devuelve como base64 puro.
async function comprimirImagen(file, maxLado = 1280) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const factor = Math.min(1, maxLado / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * factor); c.height = Math.round(img.height * factor);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
  return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
}

/* ---------- Vista: GASTOS de la unidad (reporte + export) ---------- */
/* T11: pantalla propia de REGISTRAR LIMPIEZA (antes era la sub-pestaña TAREAS del detalle). Se entra
 * desde HOY, que es la pestaña del equipo. Marca TODO (incluido el video) para habilitar el botón
 * verde → F2 limpiezaCompletada: registra en el Sheet y avisa al admin (y al huésped si el switch
 * LIMPIEZA_AVISO_HUESPED_<U> de la unidad está prendido). El progreso es local por unidad+día. */
async function vistaRegistrarLimpieza(unidad) {
  setTitulo('Registrar limpieza');
  estado.unidadAbierta = unidad;
  mostrarCarga(true); render('');
  try {
    const hoyI0 = hoyLocalIso(0);
    const [d, lj] = await Promise.all([
      api({ action: 'unidad', unidad }),
      api({ action: 'limpieza' }).catch(() => null),
    ]);
    if (d.error) throw new Error(d.error);
    // T15b — esta pantalla es para QUIEN LIMPIA, así que en vez de "movimientos" (lenguaje de admin)
    // muestra lo único que le cambia el trabajo: a qué hora se va el que está y a qué hora llega el que
    // entra. La hora sale de lo que el huésped le respondió al bot; si no respondió se dice
    // SIN RESPUESTA en vez de callarlo, porque "no sé" es información para quien tiene que organizarse.
    const movs = ((lj && lj.eventos) || []).filter(ev => String(ev.unidad).toUpperCase() === String(unidad).toUpperCase() && ev.dia === 'hoy');
    const movHtml = movs.length ? movs.map(ev => {
      const llega = ev.tipo === 'llegada';
      return `
      <div class="lista-item">
        <span style="flex:1"><span class="quien">${llega ? 'Entra' : 'Sale'}: ${esc(ev.huesped || 'huésped')}</span><br>
          <span class="sub">${ev.hora
            ? `${llega ? 'Llega' : 'Sale'} ~${esc(ev.hora)} · se lo dijo al bot`
            : `<b>Sin respuesta</b> — el bot le preguntó y todavía no contesta`}${cargoTardeTxt(ev)}${ev.recordatorio ? '<br>' + esc(ev.recordatorio) : ''}</span></span>
        <span class="pill ${llega || ev.tarde ? 'crit' : 'warn'}">${llega ? 'ENTRA' : (ev.tarde ? 'SALE TARDE' : 'SALE')}</span>
      </div>`;
    }).join('') : '<div class="vacio">Hoy no entra ni sale nadie en esta unidad.</div>';
    const items = d.checklist || [];
    const itemsProf = d.checklistProfunda || [];
    const chkKey = 'pms_chk_' + unidad + '_' + hoyI0;
    const profKey = 'pms_prof_' + unidad + '_' + hoyI0;
    const hechos = JSON.parse(localStorage.getItem(chkKey) || '[]');
    // T15c — filas estilo Airbnb: texto a la izquierda, checkbox a la DERECHA, todas con el mismo
    // formato (`.chk-fila` es un <label>, así que se marca tocando cualquier parte de la fila). El
    // checklist profundo se numera desde 1000 para que su progreso local no se pise con el del normal
    // cuando el admin agrega o quita ítems de cualquiera de los dos.
    const filaChk = (it, n) => `
      <label class="chk-fila"><span class="chk-txt">${esc(it)}</span>
        <input type="checkbox" class="check" data-chk="${n}" ${hechos.includes(n) ? 'checked' : ''}></label>`;
    const listaChk = items.map((it, i) => filaChk(it, i)).join('');
    const esProf = localStorage.getItem(profKey) === '1';
    const listaProf = itemsProf.map((it, i) => filaChk(it, 1000 + i)).join('');
    const rec = d.recordatorio || {};
    render(
      hero(`${esc(unidad)} · limpieza de hoy`) +
      `<div class="cuerpo-vista">
        <button class="volver" id="btn-volver">‹ Hoy</button>
        ${rec.texto && rec.cuando !== 'OFF' ? `<div class="tarjeta"><div class="sub">Recordatorio del admin: ${esc(rec.texto)}</div></div>` : ''}
        ${tituloSeccion('El huésped de hoy', 'Lo que respondió al bot sobre sus horarios')}
        <div class="tarjeta">${movHtml}</div>
        ${/* 22/07/2026 — cada limpieza en SU tarjeta. Antes el interruptor de profunda y sus 10 tareas
              vivían dentro de la misma tarjeta que los checks normales: con 7 ítems la frontera se
              notaba, pero al quedar 3 todo se leía como una sola lista de 13 casillas y se perdía qué
              era obligatorio. La lógica no cambió (normalBoxes <1000 habilitan el botón; profBoxes
              ≥1000 nunca bloquean); es puro reparto del markup. */''}
        ${tituloSeccion('Limpieza normal', 'Los tres son obligatorios')}
        <div class="tarjeta">${listaChk}</div>
        ${listaProf ? `
        ${tituloSeccion('Limpieza profunda', 'Opcional · solo si hoy toca a fondo')}
        <div class="tarjeta">
          <label class="chk-fila chk-jefe"><span class="chk-txt">¿Hiciste limpieza profunda?<span class="chk-sub">Actívalo y marca solo lo que hiciste — no hace falta todo. El admin ve qué tareas se cumplieron</span></span>
            <input type="checkbox" class="check" id="chk-profunda" ${esProf ? 'checked' : ''}></label>
          <div id="lista-profunda" class="${esProf ? '' : 'oculto'}">${listaProf}</div>
        </div>` : ''}
        <button class="btn btn-verde" id="btn-limpieza-ok" style="margin-top:18px" disabled>LIMPIEZA COMPLETADA</button>
        <div class="sub" style="text-align:center;margin-top:6px">Se habilita con los tres de arriba marcados</div>
        <div id="limpieza-msg" class="sub oculto" style="margin-top:6px"></div>
      </div>`);
    $('#btn-volver').addEventListener('click', () => irTab('tareas'));
    const btnOk = $('#btn-limpieza-ok');
    const chkProf = $('#chk-profunda');
    const boxes = [...document.querySelectorAll('[data-chk]')];
    // T15d — SOLO el checklist normal habilita el botón: hay que hacerlo entero. La profunda es
    // parcial a propósito (se hace de a poco entre estadías), así que sus casillas NO bloquean —
    // se registra con lo que se haya marcado.
    const normalBoxes = boxes.filter(b => +b.dataset.chk < 1000);
    const profBoxes = boxes.filter(b => +b.dataset.chk >= 1000);
    const refrescar = () => { btnOk.disabled = !normalBoxes.length || !normalBoxes.every(b => b.checked); };
    const guardar = () => localStorage.setItem(chkKey, JSON.stringify(boxes.filter(x => x.checked).map(x => +x.dataset.chk)));
    boxes.forEach(b => b.addEventListener('change', () => { guardar(); refrescar(); }));
    if (chkProf) chkProf.addEventListener('change', () => {
      localStorage.setItem(profKey, chkProf.checked ? '1' : '0');
      $('#lista-profunda').classList.toggle('oculto', !chkProf.checked);
      refrescar();
    });
    refrescar();
    btnOk.addEventListener('click', async () => {
      const prof = !!(chkProf && chkProf.checked);
      if (!confirm(`¿Confirmas que ${unidad} quedó limpia${prof ? ' con LIMPIEZA PROFUNDA' : ''} y con video de respaldo? Se avisará al admin${d.avisoHuesped ? ' y al huésped que llega hoy' : ''}.`)) return;
      btnOk.disabled = true; btnOk.textContent = 'Enviando…';
      const msg = $('#limpieza-msg');
      try {
        // Se manda el TEXTO de lo marcado, no los índices: la fila del Sheet tiene que seguir
        // leyéndose dentro de un año, cuando el checklist de la unidad ya haya cambiado. Normal y
        // profunda van SEPARADAS para que el admin vea qué tareas de la profunda se hicieron.
        const txtDe = b => b.closest('.chk-fila').querySelector('.chk-txt').textContent.trim();
        const items = normalBoxes.filter(b => b.checked).map(txtDe);
        const itemsProfunda = prof ? profBoxes.filter(b => b.checked).map(txtDe) : [];
        const r = await apiPost({ apiAction: 'limpiezaCompletada', unidad, video: true, profunda: prof, items, itemsProfunda });
        if (!r.ok) throw new Error(r.error || 'error');
        localStorage.removeItem(chkKey);
        localStorage.removeItem(profKey);
        estado.cache = {};
        // `masterApagado` (22/07/2026): la mensajería global está OFF, así que al huésped no le llegó
        // nada — ni el "está lista" ni las claves. Se dice explícito para que nadie asuma que salieron.
        msg.textContent = `Registrada${r.avisos && r.avisos.profunda ? ' como PROFUNDA' : ''}. Aviso enviado al admin${r.avisos && r.avisos.huesped ? ' y al huésped' : ''}.` +
          (r.avisos && r.avisos.masterApagado ? ' ⚠️ La mensajería automática global está APAGADA: al huésped no se le envió nada (tampoco las claves).' : '');
        msg.style.color = 'var(--good)'; msg.classList.remove('oculto');
        btnOk.textContent = 'LIMPIEZA COMPLETADA';
      } catch (e) {
        msg.textContent = 'No se pudo: ' + e.message; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto');
        btnOk.disabled = false; btnOk.textContent = 'LIMPIEZA COMPLETADA';
      }
    });
  } catch (e) {
    render(`<div class="cuerpo-vista"><button class="volver" id="btn-volver">‹ Hoy</button><div class="error-caja">${esc(e.message)}</div></div>`);
    $('#btn-volver').addEventListener('click', () => irTab('tareas'));
  }
  mostrarCarga(false);
}

async function vistaGastos(unidad) {
  setTitulo('Gastos ' + unidad);
  mostrarCarga(true); render('');
  try {
    const inv = await api({ action: 'inventario', unidad }, false);
    if (inv.error) throw new Error(inv.error);
    const meses = (inv.meses || []).filter(m => (m.gastos || []).length);
    const totalTodo = meses.reduce((s, m) => s + (m.totalGastos || 0), 0);
    const bloques = meses.map(m => `
      <div class="tarjeta">
        <div class="tarjeta-fila"><h3>${mesBonito(m.mes)}</h3><span class="monto">$${(m.totalGastos || 0).toFixed(2)}</span></div>
        ${m.gastos.map(g => `<div class="lista-item"><span><span class="quien">${esc(g.item)}</span><br><span class="sub">${esc(g.fecha)} · ${esc(g.quien)}${g.url ? ' · <a class="enlace-wa" target="_blank" rel="noopener" href="' + esc(g.url) + '">recibo ↗</a>' : ''}</span></span><span class="monto">$${Number(g.monto).toFixed(2)}</span></div>`).join('')}
      </div>`).join('');
    render(
      hero(`Gastos · ${esc(unidad)}`, meses.length ? [['$' + totalTodo.toFixed(0), 'TOTAL']] : null) +
      `<div class="cuerpo-vista">
        <button class="volver" id="btn-volver">‹ Unidad ${esc(unidad)}</button>
        ${meses.length ? `<button class="btn secundario btn-mini" id="btn-export" style="margin-bottom:10px">Exportar CSV</button>` : ''}
        ${bloques || '<div class="vacio">Sin gastos registrados. Agrégalos desde 📷 AGREGAR FOTOS → categoría GASTOS.</div>'}
        
      </div>`);
    $('#btn-volver').addEventListener('click', () => { estado.uniSel = unidad; irTab('unidades'); });
    const bx = $('#btn-export');
    if (bx) bx.addEventListener('click', () => {
      const filas = [['mes', 'fecha', 'item', 'monto', 'quien', 'recibo']];
      meses.forEach(m => m.gastos.forEach(g => filas.push([m.mes, g.fecha, g.item, Number(g.monto).toFixed(2), g.quien, g.url || ''])));
      const csv = filas.map(f => f.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      navigator.clipboard.writeText(csv).then(() => { bx.textContent = '✅ Copiado'; setTimeout(() => bx.textContent = '📋 Exportar CSV', 1500); });
    });
  } catch (err) {
    render(`<div class="cuerpo-vista"><button class="volver" id="btn-volver">‹ Volver</button><div class="error-caja">${esc(err.message)}</div></div>`);
    $('#btn-volver').addEventListener('click', () => { estado.uniSel = unidad; irTab('unidades'); });
  }
  mostrarCarga(false);
}

async function vistaInventario(unidad) {
  setTitulo('Agregar fotos ' + unidad);
  mostrarCarga(true); render('');
  try {
    const inv = await api({ action: 'inventario', unidad }, false);
    if (inv.error) throw new Error(inv.error);
    const esAdmin = inv.puedeAdmin === true;
    const catsFoto = inv.categorias || Object.keys(CAT_LABEL);
    const cats = catsFoto.concat(['GASTOS']);
    const catLbl = Object.assign({}, CAT_LABEL, { GASTOS: '🧾 Gasto' });
    const chipsCat = cats.map((c, i) => `<button class="chip chip-cat ${i === 0 ? 'activo' : ''}" data-cat="${c}">${catLbl[c] || c}</button>`).join('');

    const mesesHtml = (inv.meses || []).map(m => {
      const fotosCat = catsFoto.map(c => {
        const fotos = (m.categorias || {})[c] || [];
        if (!fotos.length) return '';
        return `<div class="sub" style="font-weight:800;margin:8px 0 4px">${CAT_LABEL[c] || c} · ${fotos.length}</div>
          <div class="grilla-fotos">${fotos.map(f => `<a href="${esc(f.url)}" target="_blank" rel="noopener"><img class="miniatura" loading="lazy" src="${esc(miniatura(f.url))}" alt=""></a>`).join('')}</div>`;
      }).join('');
      if (!fotosCat && !String(m.obs || '').trim()) return '';
      return `<div class="tarjeta">
        <div class="tarjeta-fila"><h3>${mesBonito(m.mes)}</h3>
          ${esAdmin ? `<button class="btn btn-mini" style="width:auto;padding:7px 10px" data-pdf="${esc(m.mes)}">PDF al dueño</button>` : ''}</div>
        ${fotosCat || '<div class="vacio">Sin fotos este mes</div>'}
        <label class="campo-label" style="margin-top:10px">Observaciones del mes</label>
        <textarea class="campo" rows="2" data-obs="${esc(m.mes)}">${esc(m.obs || '')}</textarea>
        <button class="btn secundario btn-mini" data-obs-guardar="${esc(m.mes)}">Guardar observaciones</button>
      </div>`;
    }).join('');

    render(
      hero(`Agregar fotos · ${esc(unidad)}`, null) +
      `<div class="cuerpo-vista" style="padding-bottom:90px">
        <button class="volver" id="btn-volver">‹ Unidad ${esc(unidad)}</button>
        ${tituloSeccion('Agregar fotos', '1) Toma las fotos · 2) Categoría + observaciones · 3) Guarda')}
        <div class="tarjeta">
          <button class="btn" id="btn-fotos">Tomar / subir fotos</button>
          <input type="file" id="file-fotos" accept="image/*" multiple capture="environment" class="oculto">
          <div id="prev-fotos" class="grilla-fotos" style="margin-top:10px"></div>
          <div id="prev-info" class="sub" style="margin-top:6px"></div>
          <label class="campo-label" style="margin-top:12px">Categoría</label>
          <div class="chips" style="justify-content:flex-start;flex-wrap:wrap;gap:6px">${chipsCat}</div>
          <div id="gasto-extra" class="oculto" style="margin-top:10px">
            <label class="campo-label">Monto del gasto (USD)</label>
            <input class="campo" id="gasto-monto" type="number" step="0.01" min="0" placeholder="0.00">
            <button class="btn secundario btn-mini" id="btn-leer-factura">Leer factura (IA)</button>
          </div>
          <label class="campo-label" style="margin-top:10px" id="obs-lbl">Observaciones (ej. lámpara rota)</label>
          <textarea class="campo" id="lote-obs" rows="2" placeholder="Detalle…"></textarea>
          <button class="btn" id="btn-guardar-lote" style="margin-top:6px">Guardar</button>
          <div id="inv-msg" class="sub oculto" style="text-align:center;margin-top:8px"></div>
        </div>
        ${tituloSeccion('Historial por mes')}
        ${mesesHtml || '<div class="vacio">Aún no hay fotos. Sube las primeras arriba. 📷</div>'}
        
      </div>`);

    const aviso = (txt, esError) => { const el = $('#inv-msg'); el.textContent = txt; el.style.color = esError ? 'var(--crit)' : 'var(--good)'; el.classList.remove('oculto'); };
    $('#btn-volver').addEventListener('click', () => { estado.uniSel = unidad; irTab('unidades'); });

    let fotosPend = [];
    const pintarPrev = () => {
      $('#prev-fotos').innerHTML = fotosPend.map(f => `<img class="miniatura" src="${URL.createObjectURL(f)}" alt="">`).join('');
      $('#prev-info').textContent = fotosPend.length ? `${fotosPend.length} foto(s) lista(s) para guardar` : '';
    };
    $('#btn-fotos').addEventListener('click', () => $('#file-fotos').click());
    $('#file-fotos').addEventListener('change', (ev) => { fotosPend = fotosPend.concat([...ev.target.files]); pintarPrev(); });

    let catActiva = cats[0];
    const syncCat = () => {
      const esGasto = catActiva === 'GASTOS';
      $('#gasto-extra').classList.toggle('oculto', !esGasto);
      $('#obs-lbl').textContent = esGasto ? '¿Qué se compró? (detalle)' : 'Observaciones (ej. lámpara rota)';
    };
    document.querySelectorAll('.chip-cat').forEach(ch => ch.addEventListener('click', () => {
      document.querySelectorAll('.chip-cat').forEach(x => x.classList.remove('activo'));
      ch.classList.add('activo'); catActiva = ch.dataset.cat; syncCat();
    }));
    syncCat();

    $('#btn-leer-factura').addEventListener('click', async () => {
      if (!fotosPend.length) { aviso('Toma primero la foto de la factura.', true); return; }
      const btn = $('#btn-leer-factura'); btn.disabled = true; btn.textContent = 'Leyendo…';
      try {
        const b64 = await comprimirImagen(fotosPend[0], 1600);
        const r = await apiPost({ apiAction: 'invLeerFactura', unidad, base64: b64 });
        if (r && r.ok) {
          if (r.monto) $('#gasto-monto').value = r.monto;
          const detalle = [r.proveedor, r.items].filter(Boolean).join(' · ');
          if (detalle) $('#lote-obs').value = detalle;
          aviso('✅ Factura leída. Revisa y guarda.', false);
        } else aviso(r && r.error === 'sin_ia' ? 'IA no configurada — escribe el monto a mano.' : 'No se pudo leer — escribe a mano.', true);
      } catch (e) { aviso('No se pudo leer la factura.', true); }
      btn.disabled = false; btn.textContent = '🤖 Leer factura (IA)';
    });

    $('#btn-guardar-lote').addEventListener('click', async () => {
      const obs = $('#lote-obs').value.trim();
      const btn = $('#btn-guardar-lote'); btn.disabled = true;
      try {
        if (catActiva === 'GASTOS') {
          const monto = parseFloat($('#gasto-monto').value);
          if (!(monto > 0) || !obs) { aviso('Pon el monto y el detalle del gasto.', true); btn.disabled = false; return; }
          const b64 = fotosPend.length ? await comprimirImagen(fotosPend[0]) : undefined;
          const r = await apiPost({ apiAction: 'invRegistrarGasto', unidad, item: obs.slice(0, 120), monto, observaciones: obs, base64: b64 });
          if (!r.ok) throw new Error(r.error || 'error');
          aviso('✅ Gasto guardado.', false);
        } else {
          if (!fotosPend.length) { aviso('Toma o sube al menos una foto.', true); btn.disabled = false; return; }
          let ok = 0;
          for (let i = 0; i < fotosPend.length; i++) {
            aviso(`Subiendo foto ${i + 1} de ${fotosPend.length}…`, false);
            try {
              const b64 = await comprimirImagen(fotosPend[i]);
              const r = await apiPost({ apiAction: 'invSubirFoto', unidad, categoria: catActiva, nombre: fotosPend[i].name, base64: b64, observaciones: i === 0 ? obs : '' });
              if (r.ok) ok++;
            } catch (e) { /* sigue */ }
          }
          aviso(`✅ ${ok} foto(s) guardada(s) en ${catLbl[catActiva] || catActiva}.`, false);
        }
        estado.cache = {}; setTimeout(() => vistaInventario(unidad), 1200);
      } catch (e) { aviso('No se pudo guardar (' + e.message + ').', true); btn.disabled = false; }
    });

    document.querySelectorAll('[data-obs-guardar]').forEach(b => b.addEventListener('click', async () => {
      const mes = b.dataset.obsGuardar;
      const texto = document.querySelector(`[data-obs="${mes}"]`).value;
      b.disabled = true;
      try {
        const r = await apiPost({ apiAction: 'invGuardarObs', unidad, mes, texto });
        if (!r.ok) throw new Error(r.error);
        b.textContent = '✓ Guardadas'; setTimeout(() => { b.textContent = 'Guardar observaciones'; }, 1500);
        estado.cache = {};
      } catch (e) { aviso('No se pudieron guardar las observaciones.', true); }
      b.disabled = false;
    }));
    document.querySelectorAll('[data-pdf]').forEach(b => b.addEventListener('click', async () => {
      const mes = b.dataset.pdf;
      b.disabled = true; b.textContent = 'Generando…';
      try {
        const r = await apiPost({ apiAction: 'invEnviarPdf', unidad, mes });
        if (r.ok) aviso(`✅ PDF de ${mesBonito(mes)} enviado al dueño (${r.via}).`, false);
        else if (r.error === 'ventana') aviso('El PDF quedó en Drive, pero WhatsApp no lo entregó: pide al dueño que le escriba al bot y reintenta.', true);
        else throw new Error(r.error);
      } catch (e) { aviso('No se pudo enviar el PDF (' + e.message + ').', true); }
      b.disabled = false; b.textContent = '📤 PDF al dueño';
    }));
  } catch (err) {
    render(`<div class="cuerpo-vista"><button class="volver" id="btn-volver">‹ Volver</button>
      <div class="error-caja">${esc(err.message)}</div></div>`);
    $('#btn-volver').addEventListener('click', () => { estado.uniSel = unidad; irTab('unidades'); });
  }
  mostrarCarga(false);
}

function vistaAgregarUnidad() {
  const btnMas = $('#btn-mas'); if (btnMas) btnMas.remove();
  setTitulo('Agregar unidad');
  const soloAdmin = estado.yo.rol === 'ceo_admin' || estado.yo.rol === 'admin';
  render(
    hero('Conectar unidad nueva') +
    `<div class="cuerpo-vista">
      <button class="volver" id="btn-volver">‹ Unidades</button>
      ${soloAdmin ? `<div class="tarjeta">
        <div class="tarjeta-fila"><h3>Nueva unidad</h3></div>
        <div class="sub" style="margin-bottom:14px">Pega el <b>iCal de Airbnb</b> (en Airbnb: Calendario → Disponibilidad → <b>Exportar calendario</b>). Con eso ya funciona el buscador y se saca la miniatura sola. Se crea con un nombre temporal (NUEVA1, NUEVA2…) que puedes <b>renombrar después</b>.</div>
        <label class="campo-label">Nombre corto (opcional — se asigna solo si lo dejas vacío)</label>
        <input class="campo" id="nu-nombre" autocomplete="off" placeholder="Se asigna NUEVA1, NUEVA2…">
        <label class="campo-label">iCal de Airbnb</label>
        <input class="campo" id="nu-ical" inputmode="url" autocomplete="off" placeholder="https://www.airbnb.com/calendar/ical/…ics">
        <label class="campo-label">Capacidad de huéspedes (opcional)</label>
        <input class="campo" id="nu-cap" type="number" min="1" max="16" placeholder="Ej. 4">
        <button class="btn" id="nu-crear">Crear unidad</button>
        <div id="nu-msg" class="sub oculto" style="margin-top:8px"></div>
      </div>
      <div id="nu-exito"></div>` : '<div class="tarjeta"><div class="vacio">Solo un administrador puede agregar unidades.</div></div>'}
      
    </div>`);
  $('#btn-volver').addEventListener('click', () => irTab('unidades'));
  const btnCrear = $('#nu-crear');
  if (btnCrear) btnCrear.addEventListener('click', async () => {
    const nombre = $('#nu-nombre').value.trim();
    const ical = $('#nu-ical').value.trim();
    const capacidad = $('#nu-cap').value.trim();
    const msg = $('#nu-msg');
    if (!/^https?:\/\//i.test(ical)) { msg.textContent = 'Pega el link iCal de Airbnb (empieza con http).'; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto'); return; }
    btnCrear.disabled = true; btnCrear.textContent = 'Creando…';
    msg.classList.add('oculto');
    try {
      // Ni un corte de red ni un "Sheet ocupado" significan que el alta falló: el CRM puede haber
      // terminado igual, o haber quedado a medias. Como el servidor es IDEMPOTENTE y REANUDABLE (mismo
      // iCal ⇒ continúa esa unidad, jamás crea otra), reintentar es siempre seguro y además completa lo
      // que faltó. 3 intentos con pausa: la contención del Sheet dura segundos, no minutos.
      const payload = { apiAction: 'agregarUnidad', nombre, ical, capacidad };
      let r = null, ultimo = null;
      for (let i = 0; i < 3 && !r; i++) {
        try {
          const resp = await apiPost(payload);
          if (!resp.ok && resp.error === 'ocupado') { ultimo = new Error('ocupado'); }
          else r = resp;
        } catch (eInt) { ultimo = eInt; }
        if (!r && i < 2) {
          btnCrear.textContent = 'Reintentando…';
          await new Promise(res => setTimeout(res, 4000));
        }
      }
      if (!r) throw (ultimo || new Error('error'));
      if (!r.ok) throw new Error(r.error || 'error');
      const yaEstaba = r.yaExistia === true;
      estado.cache = {};
      const preview = r.foto
        ? `<img class="foto-unidad" src="${esc(r.foto)}" alt="" style="width:88px;height:88px;margin:0 auto 10px">`
        : monograma(r.unidad);
      const notaFoto = r.foto ? '' :
        `<div class="sub" style="margin-top:6px">El buscador ya funciona con este iCal. Si querés la miniatura, revisá que sea el link de <b>Exportar calendario</b> de Airbnb (<code>…/calendar/ical/…ics</code>).</div>`;
      const infoAirbnb = (r.capacidad || r.ciudad)
        ? `<div class="sub" style="margin-top:6px">${[r.ciudad ? '📍 ' + esc(r.ciudad) : '', r.capacidad ? '👥 ' + esc(r.capacidad) + ' huéspedes' : ''].filter(Boolean).join(' · ')} <span class="badge-f2">de Airbnb</span></div>`
        : '';
      const pie = yaEstaba
        ? `<div class="sub" style="margin-top:8px">Este iCal <b>ya estaba conectado</b> a esta unidad — no se creó nada nuevo. Podés seguir tranquilo.</div>`
        : `<div class="sub" style="margin-top:8px">Admin por defecto: <b>${esc(r.adminPorDefecto)}</b> (la ve su usuario y el dueño asignado). Las reservas entran cuando Gmail las ingesta.</div>`;
      $('#nu-exito').innerHTML = tituloSeccion('Unidad ' + esc(r.unidad) + (yaEstaba ? ' ya estaba conectada' : ' creada')) +
        `<div class="tarjeta" style="text-align:center">${preview}
          <div class="tarjeta-fila" style="justify-content:center"><h3>${esc(r.unidad)}</h3></div>
          ${infoAirbnb}
          ${yaEstaba ? '' : notaFoto}
          ${pie}
          <button class="btn secundario btn-mini" id="nu-ver" style="margin-top:10px">Ver en Unidades</button>
        </div>`;
      $('#nu-crear').closest('.tarjeta').style.display = 'none';
      $('#nu-ver').addEventListener('click', () => irTab('unidades'));
    } catch (e) {
      // OJO: un error de red acá NO prueba que no se haya creado — el CRM termina aunque el teléfono
      // corte. Por eso el texto invita a reintentar: el servidor es idempotente y el 2º intento
      // responde "ya estaba conectada" en vez de duplicar (fue el bug del 19/07/2026).
      const red = e.name === 'AbortError' || e.sheetOcupado || e.message === 'ocupado' || e instanceof TypeError;
      msg.textContent = red
        ? 'El Sheet estaba ocupado y no pudimos confirmar. Tocá "Crear unidad" de nuevo en un minuto: no se duplica, retoma donde quedó.'
        : 'No se pudo crear (' + e.message + ').';
      msg.style.color = 'var(--crit)'; msg.classList.remove('oculto');
      btnCrear.disabled = false; btnCrear.textContent = 'Crear unidad';
    }
  });
}

/* ---------- Vista: EDITAR unidad (renombrar + identidad/FICHA) ---------- */
async function vistaEditarUnidad(unidad) {
  setTitulo('Editar ' + unidad);
  mostrarCarga(true); render('');
  try {
    const d = await api({ action: 'unidadeditar', unidad }, false);
    if (d.error) throw new Error(d.error);
    const campo = (id, label, val, ph = '', tipo = 'text') =>
      `<label class="campo-label">${label}</label><input class="campo" id="${id}" ${tipo === 'number' ? 'type="number" min="1" max="16"' : 'autocomplete="off"'} value="${esc(val || '')}" placeholder="${esc(ph)}">`;
    const area = (id, label, val, ph = '') =>
      `<label class="campo-label">${label}</label><textarea class="campo" id="${id}" rows="2" placeholder="${esc(ph)}">${esc(val || '')}</textarea>`;
    render(
      hero('Editar unidad ' + esc(unidad)) +
      `<div class="cuerpo-vista">
        <button class="volver" id="btn-volver">‹ Unidad ${esc(unidad)}</button>
        <div class="tarjeta">
          ${tituloSeccion('Nombre')}
          <div class="sub" style="margin-bottom:8px">Cambiar el nombre corto la renombra en todo el CRM (hoja, switches, asignaciones).</div>
          ${campo('ed-nombre', 'Nombre corto de la unidad', d.unidad)}
        </div>
        <div class="tarjeta">
          ${tituloSeccion('Identidad')}
          ${campo('ed-cap', 'Capacidad de huéspedes', d.capacidad, 'Ej. 8', 'number')}
          ${campo('ed-direccion', 'Dirección', d.direccion, 'Sector, calle, referencia')}
          ${campo('ed-wifi_red', 'WiFi — red', d.wifi_red)}
          ${campo('ed-wifi_clave', 'WiFi — clave', d.wifi_clave)}
          ${area('ed-checkin_info', 'Info de check-in', d.checkin_info)}
          ${area('ed-checkout_info', 'Info de check-out', d.checkout_info)}
          ${area('ed-notas', 'Notas', d.notas)}
        </div>
        <div class="tarjeta">
          ${tituloSeccion('Mensajería')}
          <div class="switch-fila">
            <span class="quien" style="font-weight:800">Copia de mensajes al admin</span>
            <label class="toggle"><input type="checkbox" id="ed-copia" ${d.copiaAdmin !== false ? 'checked' : ''}><span class="track"></span></label>
          </div>
          <div class="sub" style="margin-top:2px">Solo esta unidad. El switch general vive en CONFIGURACIÓN → Mensajería del bot.</div>
        </div>
        <button class="btn" id="ed-guardar">Guardar cambios</button>
        <div id="ed-msg" class="sub oculto" style="text-align:center;margin-top:8px"></div>
        
      </div>`);
    $('#btn-volver').addEventListener('click', () => { estado.uniSel = unidad; irTab('unidades'); });
    $('#ed-guardar').addEventListener('click', async () => {
      const b = $('#ed-guardar'), msg = $('#ed-msg');
      const payload = {
        apiAction: 'editarUnidad', unidad,
        nuevoNombre: $('#ed-nombre').value.trim(),
        capacidad: $('#ed-cap').value.trim(),
        direccion: $('#ed-direccion').value, wifi_red: $('#ed-wifi_red').value, wifi_clave: $('#ed-wifi_clave').value,
        checkin_info: $('#ed-checkin_info').value, checkout_info: $('#ed-checkout_info').value, notas: $('#ed-notas').value,
        copiaAdmin: $('#ed-copia').checked,
      };
      b.disabled = true; b.textContent = 'Guardando…';
      try {
        const r = await apiPost(payload);
        if (!r.ok) throw new Error(r.error || 'error');
        estado.cache = {};
        msg.textContent = r.renombrada ? '✅ Guardado y renombrada a ' + r.unidad : '✅ Cambios guardados';
        msg.style.color = 'var(--good)'; msg.classList.remove('oculto');
        setTimeout(() => { estado.uniSel = r.unidad; irTab('unidades'); }, 1200);
      } catch (e) {
        msg.textContent = 'No se pudo guardar (' + e.message + ').'; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto');
        b.disabled = false; b.textContent = 'Guardar cambios';
      }
    });
  } catch (err) {
    render(`<div class="cuerpo-vista"><button class="volver" id="btn-volver">‹ Volver</button>
      <div class="error-caja">${esc(err.message)}</div></div>`);
    $('#btn-volver').addEventListener('click', () => { estado.uniSel = unidad; irTab('unidades'); });
  }
  mostrarCarga(false);
}

/* ---------- Vista: DISPONIBILIDAD (buscador → link a Airbnb) ---------- */
function vistaDisponibilidad() {
  const btnMas = $('#btn-mas'); if (btnMas) btnMas.remove();
  estado.unidadAbierta = null;
  setTitulo('Disponibilidad');
  const hoy = hoyIso();
  const salida = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  render(
    hero('Buscar disponibilidad') +
    `<div class="cuerpo-vista">
      <button class="volver" id="btn-volver">‹ Unidades</button>
      <div class="tarjeta">
        <label class="campo-label">Llegada</label>
        <input class="campo" type="date" id="disp-desde" value="${hoy}" min="${hoy}">
        <label class="campo-label">Salida</label>
        <input class="campo" type="date" id="disp-hasta" value="${salida}" min="${hoy}">
        <label class="campo-label">Huéspedes (opcional)</label>
        <input class="campo" type="number" id="disp-hu" min="1" max="16" placeholder="Cualquiera">
        <button class="btn" id="disp-buscar">Buscar disponibilidad</button>
      </div>
      <div id="disp-resultados"></div>
      
    </div>`);
  $('#btn-volver').addEventListener('click', () => irTab('unidades'));
  $('#disp-buscar').addEventListener('click', buscarDisponibilidad);
}

async function buscarDisponibilidad() {
  const desde = $('#disp-desde').value, hasta = $('#disp-hasta').value, hu = $('#disp-hu').value;
  const cont = $('#disp-resultados');
  if (!desde || !hasta) { cont.innerHTML = '<div class="error-caja">Elige llegada y salida.</div>'; return; }
  cont.innerHTML = '<div class="sub" style="text-align:center;padding:18px">Buscando…</div>';
  try {
    const params = { action: 'disponibilidad', desde, hasta };
    if (hu) params.huespedes = hu;
    const j = await api(params, false);
    if (j.error) { cont.innerHTML = `<div class="error-caja">${esc(j.error)}</div>`; return; }
    const us = j.unidades || [];
    const libres = us.filter(u => u.libre), ocup = us.filter(u => !u.libre);
    const tarjeta = (u) => {
      const img = u.foto
        ? `<img src="${esc(u.foto)}" alt="${esc(u.unidad)}" loading="lazy" style="width:52px;height:52px;border-radius:10px;object-fit:cover;flex:0 0 auto">`
        : monograma(u.unidad);
      const meta = [u.desde ? `desde $${u.desde}/noche` : '', u.capacidad ? `${u.capacidad} huésp.` : ''].filter(Boolean).join(' · ');
      const cta = u.libre
        ? (u.airbnbUrl
            ? `<a class="btn" target="_blank" rel="noopener" href="${esc(u.airbnbUrl)}" style="display:inline-block;text-decoration:none;text-align:center">Reservar en Airbnb ↗</a>`
            : `<span class="sub">Falta cargar el link de Airbnb (AIRBNB_URL_${esc(u.unidad)})</span>`)
        : `<span class="pill busy">OCUPADA ESAS FECHAS</span>`;
      return `<div class="tarjeta" style="${u.libre ? '' : 'opacity:.55'}">
        <div class="fila-unidad">${img}
          <div class="resto"><div class="tarjeta-fila"><h3>${esc(u.unidad)}</h3>${u.libre ? '<span class="pill ok">LIBRE</span>' : ''}</div>
          <div class="sub">${meta || '&nbsp;'}</div></div>
        </div>
        <div style="margin-top:10px">${cta}</div>
      </div>`;
    };
    const n = j.noches;
    cont.innerHTML =
      `<div class="sub" style="text-align:center;margin:12px 0">${fBonita(j.desde)} → ${fBonita(j.hasta)} · ${n} noche${n === 1 ? '' : 's'}${j.huespedes ? ` · ${j.huespedes} huésp.` : ''}</div>` +
      (libres.length ? tituloSeccion(`Disponibles (${libres.length})`) + libres.map(tarjeta).join('') : '<div class="vacio">Ninguna unidad libre en esas fechas.</div>') +
      (ocup.length ? tituloSeccion(`Ocupadas (${ocup.length})`) + ocup.map(tarjeta).join('') : '');
  } catch (e) {
    cont.innerHTML = `<div class="error-caja">No se pudo buscar. ${esc(e.message)}</div>`;
  }
}

/* ---------- Vista: TAREAS (agenda semanal + lista) ---------- */
function agendaGrid(a) {
  const hoy = a.hoy;
  const dias = a.fechas.map((iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    return `<div class="dia ${iso === hoy ? 'hoy' : ''}">${DOW[dow]}<span class="num">${d}</span></div>`;
  }).join('');
  let filas = '';
  (a.grupos || []).forEach(g => {
    filas += `<div class="agenda-grupo">CEO ${esc(g.ceo)}${g.limpiador ? ' · ' + esc(g.limpiador) : ''}</div>`;
    g.unidades.forEach(u => {
      const salidasPorDia = {};
      (u.salidas || []).forEach(s => { salidasPorDia[s.dia] = s; });
      let celdas = '';
      for (let d = 0; d < 7; d++) {
        const s = salidasPorDia[d];
        celdas += `<div class="agenda-celda">${s && !s.profunda ? '<span class="marca-s">S</span>' : ''}${s && s.profunda ? '<span class="marca-p">P✦</span>' : ''}</div>`;
      }
      // Convención hotelera: la píldora ARRANCA a media celda del día de check-in y TERMINA a media
      // celda del día de checkout — así el corte entre dos píldoras se LEE como rotación (salida +
      // llegada el mismo día), que antes se veía como una sola banda negra continua (pedido del
      // dueño 18/07). abreIzq/abreDer = la reserva sigue fuera de la semana visible → va al borde.
      const pildoras = (u.reservas || []).map(r => {
        const ini = r.abreIzq ? r.s : r.s + 0.55;
        const fin = r.abreDer ? r.e + 1 : r.e + 0.45;
        const izq = (ini / 7 * 100).toFixed(2), ancho = (Math.max(fin - ini, 0.5) / 7 * 100).toFixed(2);
        return `<div class="pildora" style="left:${izq}%;width:calc(${ancho}% - 4px)">
          <span class="ini">${esc((r.nom || '?').charAt(0).toUpperCase())}</span>${esc(r.nom)}</div>`;
      }).join('');
      filas += `<div class="agenda-fila">
        <div class="unidad-label">${esc(u.unidad)}</div>${celdas}
        <div class="agenda-pildoras">${pildoras}</div>
      </div>`;
    });
  });
  let carga = '';
  const personas = Object.keys(a.carga || {});
  if (personas.length) {
    carga = `<div class="carga-titulo">Carga por persona</div>` + personas.map(p => {
      const chips = (a.carga[p] || []).map((n, i) => {
        const [y, m, d] = a.fechas[i].split('-').map(Number);
        const dom = new Date(y, m - 1, d).getDay() === 0;
        if (dom) return `<span class="chip-carga c0">desc</span>`;
        const cls = n === 0 ? 'c0' : n === 1 ? 'c1' : n === 2 ? 'c2' : 'c3';
        return `<span class="chip-carga ${cls}">${n === 0 ? '—' : n}</span>`;
      }).join('');
      return `<div class="carga-fila"><span class="nombre">${esc(p)}</span>${chips}</div>`;
    }).join('');
  }
  return `<div class="agenda-scroll"><div class="agenda">
      <div class="agenda-dias"><div></div>${dias}</div>
      ${filas}
      ${carga}
    </div></div>
    <div class="agenda-leyenda"><b>S</b> salida (limpieza) · <b>P✦</b> limpieza profunda · píldora = reserva · Dom = descanso</div>`;
}

// Última agenda conocida (imagen + su fecha). La imagen la genera el trigger de las ~6 AM: que hoy no
// podamos PEDIRLA no la invalida. Antes, si `agenda` fallaba, la sección entera desaparecía en silencio.
function guardarAgendaLS(ag) {
  try { if (ag && ag.img) localStorage.setItem('pms_agenda', JSON.stringify({ img: ag.img, imgFecha: ag.imgFecha || '' })); }
  catch (e) { /* sin espacio en localStorage: seguimos igual */ }
}
function leerAgendaLS() {
  try { return JSON.parse(localStorage.getItem('pms_agenda') || 'null'); } catch (e) { return null; }
}
// HTML de la sección "Agenda semanal". `cargando` = la respuesta todavía viene en camino.
// Nunca devuelve vacío: si no hay dato vivo, cae a la última imagen guardada y lo dice.
function agendaSeccionHTML(ag, cargando) {
  const vivo = (ag && !ag.error) ? ag : null;
  const guardada = leerAgendaLS();
  const img = (vivo && vivo.img) || (guardada && guardada.img) || '';
  const imgFecha = ((vivo && vivo.img) ? vivo.imgFecha : (guardada && guardada.imgFecha)) || '';
  const deRespaldo = !!img && !(vivo && vivo.img);
  if (!img && vivo) return tituloSeccion('Agenda semanal', 'La misma agenda de las 6 AM') + `<div class="tarjeta">${agendaGrid(vivo)}</div>`;
  if (!img) return tituloSeccion('Agenda semanal', cargando ? 'Cargando…' : 'No se pudo cargar — desliza hacia abajo para reintentar') +
    `<div class="tarjeta"><div class="vacio">${cargando ? 'Cargando la agenda…' : 'Sin agenda disponible.'}</div></div>`;
  const sub = `La MISMA imagen que manda el bot${imgFecha ? ' · generada el ' + fBonita(imgFecha) : ''}${deRespaldo ? ' · última conocida' : ''}`;
  return tituloSeccion('Agenda semanal', sub) +
    `<div class="agenda-img-wrap" id="agenda-zoom" title="Toca para ampliar / reducir"><img class="agenda-img" src="${esc(imgDrive(img))}" alt="Agenda de limpieza de las 6 AM"></div>
     <div class="sub" style="margin:6px 4px 0">Toca la imagen para ampliar — se enfoca en HOY (izquierda). <a class="enlace-wa" target="_blank" rel="noopener" href="${esc(img)}">Ver completa ↗</a></div>`;
}
// Tocar la imagen la amplía (y viceversa); al ampliar crece desde la izquierda y fija scrollLeft=0 para
// priorizar HOY. Se re-engancha cada vez que se re-pinta la sección.
function engancharAgendaZoom() {
  const azoom = document.getElementById('agenda-zoom');
  if (azoom) azoom.addEventListener('click', () => { if (azoom.classList.toggle('zoomed')) azoom.scrollLeft = 0; });
}

async function vistaTareas() {
  setTitulo('Agenda de limpieza');
  // BLINDAJE (21/07/2026): ninguna de las 3 llamadas puede tumbar la vista entera. `limpieza`
  // lanzaba si fallaba (o si el rol no la tenía permitida — caso Maritza) y HOY moría en blanco;
  // ahora cada sección degrada sola y la de movimientos ofrece REINTENTAR.
  // 22/07: `agenda` YA NO se espera. Era la más cara (llegó a tardar ~90 s) y vive AL FINAL de la
  // pantalla: bloquear TODO HOY por ella era lo que dejaba el spinner girando. Se pide en paralelo y
  // rellena su sección cuando llega; mientras tanto se muestra la última imagen conocida.
  const agProm = api({ action: 'agenda' }).catch(() => null);
  const [j, tb] = await Promise.all([
    api({ action: 'limpieza' }).catch(e => ({ error: String((e && e.message) || e || 'error') })),
    api({ action: 'tareasbot' }).catch(() => null),
  ]);
  const jOk = !!(j && !j.error);
  const bot = (tb && !tb.error) ? tb : null;

  // --- 1. Huéspedes SIN WhatsApp (lo accionable va primero) ---
  const sinWa = (bot && bot.sinWhatsapp) || [];
  const seccionSinWa = tituloSeccion('Huéspedes sin WhatsApp', 'Sin número, el bot no puede atenderlos — captúralo con un toque') +
    (sinWa.length ? sinWa.map((r, i) => `
      <div class="tarjeta">
        <div class="fila-unidad">${avatarUnidad({ unidad: r.unidad, foto: r.foto })}
          <div class="resto">
            <div class="tarjeta-fila"><h3>${esc(r.huesped || 'Huésped')}</h3><span class="pill crit">📵 SIN NÚMERO</span></div>
            <div class="sub">${esc(r.unidad)} · ${fBonita(r.ci)} → ${fBonita(r.co)}${r.codigo ? ' · ' + esc(r.codigo) : ''}</div>
          </div>
        </div>
        ${r.codigo
          ? `<div class="sub" style="margin-top:8px">📱 Airbnb muestra su teléfono desde que la reserva se confirma (detalles de la reserva): cópialo y pégalo aquí. ⚠️ Si es un "número temporal" de Airbnb (huéspedes de EE.UU./Canadá), NO funciona en WhatsApp — usa el mensaje de Airbnb 👇.</div>
             <div style="display:flex;gap:6px;margin-top:8px">
               <input class="campo" data-wa="${i}" inputmode="tel" autocomplete="off" placeholder="WhatsApp (09… o +593…)" style="margin-bottom:0;flex:1">
               <button class="btn btn-mini" data-wa-guardar="${i}" style="width:auto;padding:9px 14px">Guardar</button>
             </div>
             <div class="sub" data-wa-msg="${i}" style="margin-top:6px">¿Ya tienes su número? Escríbelo y guárdalo. Si no, copia el mensaje para Airbnb 👇</div>
             <button class="btn secundario btn-mini" data-copiar="${i}" style="margin-top:8px">Copiar mensaje para el chat de Airbnb</button>`
          : '<div class="sub" style="margin-top:8px">Reserva sin código de confirmación: pide el número por Airbnb y envíalo al bot como siempre.</div>'}
      </div>`).join('')
    : `<div class="tarjeta"><div class="vacio">${bot ? '✅ Todas las reservas próximas tienen WhatsApp.' : '⚠️ No se pudo cargar — desliza hacia abajo para reintentar.'}</div></div>`);

  // (Las secciones "El bot hoy" y "Conversaciones" viven ahora en la pestaña MENSAJES:
  //  los hilos como chat y los pendientes como leyenda amarilla dentro de cada conversación.)

  // --- 2. Checklist operativo hoy/mañana (limpiezas y llegadas) + agenda semanal (se conservan) ---
  // HOY = operación del día: check-ins y check-outs con la hora que el huésped dio al bot (ev.hora
  // viene de _apiLimpieza_, que la extrae de LOG_INBOUND con el mismo regex del bot).
  const evHoy = ((jOk && j.eventos) || []).filter(ev => ev.dia === 'hoy');
  // Semáforo POR HORA (21/07): un check-in ya pasó su hora de llegada → HOSPEDANDO (no "entra hoy");
  // un check-out que ya pasó su hora sale de la lista (ya no es movimiento activo).
  const ahoraMinT = new Date().getHours() * 60 + new Date().getMinutes();
  const cutCk = (estado.yo.horaCheckin != null ? estado.yo.horaCheckin : 15) * 60;
  const cutCo = (estado.yo.horaCheckout != null ? estado.yo.horaCheckout : 11) * 60;
  const yaLlego = (ev) => ahoraMinT >= (ev.hora && horaAMin(ev.hora) >= 0 ? horaAMin(ev.hora) : cutCk);
  const yaSalio = (ev) => ahoraMinT >= (ev.hora && horaAMin(ev.hora) >= 0 ? horaAMin(ev.hora) : cutCo);
  const llegadasHoy = evHoy.filter(ev => ev.tipo === 'llegada');
  const salidasHoy = evHoy.filter(ev => ev.tipo === 'checkout' && !yaSalio(ev));   // los que ya salieron dejan de aparecer
  const filaMov = (ev) => `
    <div class="lista-item">
      ${monograma(ev.unidad)}
      <span style="flex:1"><span class="quien">${esc(ev.huesped || 'Huésped')}</span><br>
        <span class="sub">${esc(ev.unidad)}${ev.hora ? ` · 🕐 sale ~${esc(ev.hora)} <b>(dijo al bot)</b>` : ' · sin hora estimada aún'}${cargoTardeTxt(ev)}${ev.recordatorio ? '<br>📌 ' + esc(ev.recordatorio) : ''}</span></span>
      <span class="pill ${ev.tarde ? 'crit' : 'warn'}">${ev.tarde ? 'SALE TARDE' : 'SALE'}</span>
    </div>`;
  // CHECK IN como BOTÓN (pedido del dueño): abre el detalle de la unidad en su sub-pestaña TAREAS,
  // donde viven el checklist de limpieza y el botón verde LIMPIEZA COMPLETADA (ítems en CONFIG).
  // La píldora sigue la HORA: verde HOSPEDANDO si ya llegó, rojo ENTRA HOY si todavía no.
  const cardCheckin = (ev) => {
    const llego = yaLlego(ev);
    return `
    <div class="tarjeta tocable" data-checkin-u="${esc(ev.unidad)}">
      <div class="fila-unidad">${monograma(ev.unidad)}
        <div class="resto">
          <div class="tarjeta-fila"><h3>${esc(ev.huesped || 'Huésped')}</h3><span class="pill ${llego ? 'ok' : 'crit'}">${llego ? 'HOSPEDANDO' : 'ENTRA HOY'}</span></div>
          <div class="sub">${esc(ev.unidad)}${ev.hora ? ` · 🕐 llega ~${esc(ev.hora)} <b>(dijo al bot)</b>` : ' · sin hora estimada aún'}${ev.recordatorio ? '<br>📌 ' + esc(ev.recordatorio) : ''}</div>
        </div>
      </div>
      <button class="btn btn-mini" style="margin-top:10px">REGISTRAR LIMPIEZA</button>
    </div>`;
  };
  const seccionMov = jOk
    ? tituloSeccion('Check-ins de hoy', 'Toca REGISTRAR LIMPIEZA para abrir el checklist de esa unidad') +
      (llegadasHoy.length ? llegadasHoy.map(cardCheckin).join('') : '<div class="tarjeta"><div class="vacio">Nadie llega hoy.</div></div>') +
      tituloSeccion('Check-outs de hoy', 'Salen de la lista al pasar su hora de salida') +
      `<div class="tarjeta">${salidasHoy.length ? salidasHoy.map(filaMov).join('') : '<div class="vacio">Nadie por salir ahora.</div>'}</div>`
    : tituloSeccion('Check-ins y check-outs', 'No se pudieron cargar los movimientos de hoy') +
      `<div class="tarjeta"><div class="vacio">⚠️ ${esc((j && j.error) || 'Error de conexión')}</div>
        <button class="btn btn-mini" data-reintentar style="margin-top:10px">REINTENTAR</button></div>`;

  // --- El bot hoy (mensajería automática del día, solo lectura): el detalle y las conversaciones
  // viven en MENSAJES, pero HOY muestra de un vistazo qué salió y qué va a salir (pedido del dueño
  // 21/07: HOY = check-ins/outs + registrar limpieza + ver mensajería del bot).
  const hoyIso = hoyLocalIso(0);
  const pendHoy = ((bot && bot.pendientes) || []).filter(p => (p.fecha ? p.fecha === hoyIso : p.dia === 'hoy'));
  const filaBot = (p) => {
    const nom = TIPO_LABEL[p.tipo] || p.tipo;
    const quien = `${esc(p.unidad || '')}${p.huesped ? ' · ' + esc(p.huesped) : ''}`;
    const sello = p.estado === 'enviado' ? `✔ Enviado${p.enviadoTs ? ' ' + esc(p.enviadoTs.slice(11)) : ''}`
      : p.estado === 'programado' ? `⏳ Sale ${p.rama === '6PM' ? '6 PM' : '6 AM'}`
      : (PILL_PEND[p.estado] || ['', String(p.estado || '').toUpperCase()])[1];
    return `<div class="lista-item"><span style="flex:1"><span class="quien">${esc(nom)}</span><br>
      <span class="sub">${quien}</span></span><span class="pill ${p.estado === 'enviado' ? 'ok' : p.estado === 'programado' ? 'warn' : 'busy'}">${sello}</span></div>`;
  };
  // Con `tareasbot` caído NO se afirma "no hay mensajes" (sería falso): se dice que no cargó.
  const seccionBot = tituloSeccion('El bot hoy', 'Mensajes automáticos de hoy — las conversaciones viven en MENSAJES') +
    `<div class="tarjeta">${pendHoy.length ? pendHoy.map(filaBot).join('')
      : `<div class="vacio">${bot ? 'El bot no tiene mensajes para hoy.' : '⚠️ No se pudo cargar — desliza hacia abajo para reintentar.'}</div>`}</div>`;

  // (Las aprobaciones de claves "🔑 Necesitan tu OK" viven ahora en MENSAJES — pedido del dueño 18/07:
  //  son parte de la conversación bot⇄huésped. Su badge también se movió: #badge-msj.)
  const fHoy = (jOk && j.hoy) ? `${_diaSemanaApp(j.hoy)} ${fLarga(j.hoy)}` : '';

  // Novedades (21/07): reservas NUEVAS + reseñas 5★ REALES recientes, que el bot ya detectó. Informativa.
  const nov = (bot && bot.novedades) || [];
  const fechaNov = (ts) => { const s = String(ts || ''); return fBonita(s.slice(0, 10)) + (s.length > 10 ? ' · ' + s.slice(11, 16) : ''); };
  const seccionNovedades = nov.length
    ? tituloSeccion('Novedades', 'Reservas nuevas y reseñas 5★ recientes') +
      `<div class="tarjeta">${nov.map(n => `
        <div class="lista-item"><span style="flex:1"><span class="quien">${n.icono || '•'} ${esc(n.titulo)}${n.unidad ? ' · ' + esc(n.unidad) : ''}</span><br>
          <span class="sub">${n.huesped ? esc(n.huesped) + ' · ' : ''}${fechaNov(n.ts)}</span></span></div>`).join('')}</div>`
    : '';

  // --- PARA MAÑANA (22/07/2026, pedido del dueño): pasadas las 3 PM lo de hoy ya está resuelto y lo
  // que importa es prepararse para mañana. Va PRIMERO, pero sin quitar nada de hoy: un check-out
  // tardío o una limpieza sin registrar siguen abajo. Los eventos de mañana ya venían en el payload
  // de `limpieza` (dia:'manana'); hasta ahora la app simplemente no los pintaba.
  const HORA_MANANA = 15;
  const esTarde = new Date().getHours() >= HORA_MANANA;
  const llegadasManana = ((j && j.eventos) || []).filter(ev => ev.dia === 'manana' && ev.tipo === 'llegada');
  const filaManana = (ev) => `
    <div class="lista-item">
      ${monograma(ev.unidad)}
      <span style="flex:1"><span class="quien">${esc(ev.huesped || 'Huésped')}</span><br>
        <span class="sub">${esc(ev.unidad)}${ev.hora ? ` · 🕐 llega ~${esc(ev.hora)} <b>(dijo al bot)</b>` : ' · sin hora estimada aún'}</span></span>
      <span class="pill warn">ENTRA MAÑANA</span>
    </div>`;
  // Bloque DOMINGO: el domingo es descanso salvo que ENTRE huésped. Quien limpia confirma si la hace
  // (botones); el admin/CoHost lo ve en lectura para saber qué domingo está cubierto.
  const dom = (j && j.domingo) || null;
  const esLimpiezaRol = estado.yo.rol === 'limpieza';
  const domHtml = (dom && (dom.entradas || []).length) ? (() => {
    const conf = dom.confirmaciones || {};
    const dia = +String(dom.fecha).split('-')[2];
    const filas = dom.entradas.map(e => {
      const c = conf[e.unidad] || null;
      const estadoTxt = c ? (c.respuesta === 'SI' ? '✅ SÍ la hace' : '⛔ NO puede') + (c.quien ? ' · ' + esc(c.quien) : '')
        : (e.pregunta ? '⏳ Sin confirmar' : (e.persona ? esc(e.persona) + ' trabaja los domingos' : 'Sin nadie asignado'));
      const botones = (esLimpiezaRol && e.pregunta)
        ? `<div class="fila-oscura" style="margin-top:8px">
             <button class="btn-oscuro" data-dom-si="${esc(e.unidad)}">SÍ LA HAGO</button>
             <button class="btn-oscuro" data-dom-no="${esc(e.unidad)}">NO PUEDO</button>
           </div>` : '';
      return `<div class="lista-item" style="display:block">
        <span class="quien">${esc(e.unidad)} · entra ${esc(e.huesped || 'huésped')}</span><br>
        <span class="sub">${estadoTxt}</span>${botones}</div>`;
    }).join('');
    return tituloSeccion(`Domingo ${dia}`, esLimpiezaRol
      ? 'El domingo descansas, pero entra huésped: confirma si haces esa limpieza'
      : 'Entra huésped en domingo — el equipo confirma si lo cubre') +
      `<div class="tarjeta">${filas}<div id="dom-msg" class="sub oculto" style="margin-top:8px"></div></div>`;
  })() : '';
  const seccionManana = esTarde
    ? tituloSeccion('Para mañana', 'Lo que viene, para organizarte desde hoy') +
      (llegadasManana.length
        ? `<div class="tarjeta">${llegadasManana.map(filaManana).join('')}</div>`
        : '<div class="tarjeta"><div class="vacio">Mañana no llega nadie.</div></div>')
    : '';
  // ⚠️ El bloque del domingo NO se esconde antes de las 3 PM: el WhatsApp del viernes sale a las 6 AM
  // diciendo "confirma en la app", y si la pregunta apareciera recién a las 3 PM ese mensaje mandaría
  // a una pantalla vacía. Las llegadas de mañana sí son solo de la tarde, como pidió el dueño.

  // Orden (dictado del dueño 21/07, reemplaza al de T6.1): HOY es CHECK-IN/CHECK-OUT primero
  // (con REGISTRAR LIMPIEZA en cada check-in), luego la mensajería del bot, la captura de
  // WhatsApp (solo ≤48 h del check-in) y la agenda semanal AL FINAL como referencia.
  // Desde el 22/07 "Para mañana" se cuela ARRIBA de todo, pero solo después de las 3 PM.
  render(
    hero(fHoy ? fHoy + ' · la misma agenda de las 6 AM' : null) +
    `<div class="cuerpo-vista">
      ${seccionManana}
      ${domHtml}
      ${seccionMov}
      ${seccionNovedades}
      ${seccionBot}
      ${seccionSinWa}
      <div id="agenda-sec">${agendaSeccionHTML(null, true)}</div>
    </div>`);
  document.querySelectorAll('[data-reintentar]').forEach(b => b.addEventListener('click', () => vistaTareas()));
  engancharAgendaZoom();
  // La agenda llega por detrás y solo rellena SU sección (no re-pinta HOY entera).
  agProm.then(ag => {
    const cont = document.getElementById('agenda-sec');
    if (!cont) return;                       // el usuario ya cambió de pestaña
    if (ag && !ag.error && ag.img) guardarAgendaLS(ag);
    cont.innerHTML = agendaSeccionHTML(ag, false);
    engancharAgendaZoom();
  }).catch(() => {});
  document.querySelectorAll('[data-checkin-u]').forEach(c => c.addEventListener('click', () =>
    vistaRegistrarLimpieza(c.dataset.checkinU)));
  // Domingo: SÍ/NO. El servidor recalcula la fecha y comprueba que ese domingo entre alguien, así que
  // acá no hace falta más que mandar la unidad. Al guardar avisa al admin por WhatsApp.
  const responderDomingo = async (unidad, respuesta, btn) => {
    const msg = $('#dom-msg');
    document.querySelectorAll('[data-dom-si],[data-dom-no]').forEach(b => { b.disabled = true; });
    btn.textContent = 'Enviando…';
    try {
      const r = await apiPost({ apiAction: 'confirmarDomingo', unidad, fecha: (j.domingo || {}).fecha, respuesta });
      if (!r.ok) throw new Error(r.error || 'No se pudo guardar');
      estado.cache = {};
      vistaTareas();
    } catch (e) {
      if (msg) { msg.textContent = '⚠️ ' + e.message; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto'); }
      document.querySelectorAll('[data-dom-si],[data-dom-no]').forEach(b => { b.disabled = false; });
      btn.textContent = respuesta === 'SI' ? 'SÍ LA HAGO' : 'NO PUEDO';
    }
  };
  document.querySelectorAll('[data-dom-si]').forEach(b =>
    b.addEventListener('click', () => responderDomingo(b.dataset.domSi, 'SI', b)));
  document.querySelectorAll('[data-dom-no]').forEach(b =>
    b.addEventListener('click', () => responderDomingo(b.dataset.domNo, 'NO', b)));
  document.querySelectorAll('[data-wa-guardar]').forEach(b => b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const i = +b.dataset.waGuardar, r = sinWa[i];
    const inp = document.querySelector(`[data-wa="${i}"]`), msg = document.querySelector(`[data-wa-msg="${i}"]`);
    const num = (inp.value || '').replace(/[^\d+]/g, '');
    if (num.replace(/\D/g, '').length < 9) { msg.textContent = 'Escribe un número válido (09… o +593…).'; msg.style.color = 'var(--crit)'; return; }
    b.disabled = true; b.textContent = 'Guardando…';
    try {
      const res = await apiPost({ apiAction: 'setWhatsappHuesped', unidad: r.unidad, codigo: r.codigo, whatsapp: num });
      if (!res.ok) throw new Error(res.error || '');
      msg.textContent = '✅ Guardado — el bot ya puede atenderlo.'; msg.style.color = 'var(--good)';
      estado.cache = {};
      setTimeout(() => vistaTareas(), 1200);
    } catch (e) { msg.textContent = 'No se pudo guardar (' + e.message + ').'; msg.style.color = 'var(--crit)'; b.disabled = false; b.textContent = 'Guardar'; }
  }));
  document.querySelectorAll('[data-copiar]').forEach(b => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    copiarTexto(b, sinWa[+b.dataset.copiar].textoAirbnb);
  }));
  actualizarBadgeTareas();
}

// Línea del cargo por SALIDA TARDE (ev.tarde/cargo/huespedes/tarifaTarde de _apiLimpieza_). El
// servidor decide si es tarde (hora dada > HORA_CHECKOUT); acá solo se pinta.
function cargoTardeTxt(ev) {
  if (!ev.tarde) return '';
  return `<br>⚠️ Salida tarde${ev.cargo
    ? ` · cargo <b>$${ev.cargo}</b> (${ev.huespedes} huésp. × $${ev.tarifaTarde})`
    : ` · cargo $${ev.tarifaTarde || 5}/persona`}`;
}

// Día de la semana en español para un ISO yyyy-MM-dd (cabecera de HOY).
function _diaSemanaApp(iso) {
  const d = new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  return ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][d.getDay()];
}

/* ---------- Vista: MENSAJES (conversaciones bot ⇄ huésped con la leyenda del bot) ---------- */
/* Leyenda amarilla bajo cada conversación: qué envió/enviará el bot para ESA reserva (pendientes
 * matcheados por código — el guard h.codigo es OBLIGATORIO: hilos sin código usan clave unidad|wa
 * y sin él los ítems con código vacío se cruzarían entre hilos). Muestra el mensaje del bot en el
 * contexto de la conversación real: ahí se ve si el mensaje es óptimo o necesita mejora. */
function legendaBot(h, pendientes) {
  if (!h.codigo) return '';
  const hoyI = hoyLocalIso(0), manI = hoyLocalIso(1);
  // Se listan HOY y lo que viene (lo enviado de días pasados ya se ve como burbuja en el hilo).
  // Fotos viejas del cerebro D1 (sin `fecha`): cae al campo `dia` de la forma anterior.
  const del = (pendientes || []).filter(p => p.codigo === h.codigo && (p.fecha ? p.fecha >= hoyI : !!p.dia));
  if (!del.length) return '';
  return del.map(p => {
    const nom = TIPO_LABEL[p.tipo] || p.tipo;
    if (p.estado === 'enviado') {
      return `<div class="hilo-bot on">✔ Enviado${p.enviadoTs ? ' ' + esc(p.enviadoTs.slice(11)) : ''} · ${esc(nom)}</div>`;
    }
    if (p.estado === 'programado') {
      const cuando = (p.fecha === hoyI || p.dia === 'hoy') ? 'HOY'
        : (p.fecha === manI || p.dia === 'manana') ? 'mañana'
        : (p.fecha ? fBonita(p.fecha) : '');
      return `<div class="hilo-bot on">✅ Auto mensajería ON · ${esc(nom)}${cuando ? ' · ' + cuando : ''}, ${p.rama === '6PM' ? '6 PM' : '6 AM'}</div>`;
    }
    // ⛔ = ese TIPO de mensaje está apagado en CONFIGURACION (formato corto pedido por el dueño;
    // se prende desde ✏️ Editar unidad / switches de mensajería).
    if (p.estado === 'switch_off') {
      return `<div class="hilo-bot off">⛔ Auto mensajería OFF · ${esc(nom)}</div>`;
    }
    const txt = (PILL_PEND[p.estado] || ['', String(p.estado).toUpperCase()])[1];
    return `<div class="hilo-bot">🤖 ${esc(nom)}${p.fecha ? ' · ' + fBonita(p.fecha) : ''} — ${txt}</div>`;
  }).join('');
}

async function vistaMensajes() {
  setTitulo('Mensajes');
  // T9: los avisos del bot (ex-pestaña Notificación) viven acá, agrupados POR HUÉSPED — el log de
  // cada reserva dentro de su conversación. Se piden en paralelo con los hilos.
  const [tb, jn] = await Promise.all([
    api({ action: 'tareasbot' }),
    api({ action: 'notificaciones' }).catch(() => null),
  ]);
  if (tb.error) throw new Error(tb.error);
  const hilos = tb.hilos || [], pend = tb.pendientes || [];
  const evsAll = (jn && jn.eventos) || [];
  // Suma días a un ISO local (para la ventana check-in −1 → check-out +1 de cada reserva).
  const sumaDias = (iso, n) => {
    const d = new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  // Log de actividad de UNA reserva: eventos de su unidad dentro de su ventana de fechas, con el
  // sello de origen (A Airbnb · 💬 WhatsApp · inicial limpieza · • sistema).
  const actividadDe = h => {
    if (!h.ci || !h.co || !h.unidad) return '';
    const d0 = sumaDias(h.ci, -1), d1 = sumaDias(h.co, 1);
    const evs = evsAll.filter(e => String(e.unidad).toUpperCase() === String(h.unidad).toUpperCase() &&
      e.ts.slice(0, 10) >= d0 && e.ts.slice(0, 10) <= d1);
    if (!evs.length) return '';
    return `<div class="hilo-actividad">
      <div class="sub" style="font-weight:800;margin:10px 0 4px">📋 Actividad de esta reserva</div>
      ${evs.map(e => `<div class="sub" style="margin:3px 0">${e.icono || '🔔'}${selloOrigen(e)} ${esc(e.titulo)}${e.detalle ? ' — ' + esc(e.detalle) : ''} · <span style="font-size:.72rem">${fBonita(e.ts.slice(0, 10))} ${esc(e.ts.slice(11, 16))}</span></div>`).join('')}
    </div>`;
  };
  // 🔑 Aprobaciones de claves pendientes (movidas de HOY — pedido del dueño 18/07: son parte de la
  // conversación bot⇄huésped). Solo con permiso real de aprobar (esAdmin del bot); limpieza no.
  const aps = (estado.yo.rol !== 'limpieza')
    ? (tb.aprobaciones || []).filter(a => !estado.hechasLocal['apr:' + a.codigo]) : [];
  // T13: la tarjeta se DESLIZA a la izquierda para darla de baja (además del botón Descartar, que
  // se queda como alternativa accesible). Debajo asoma el fondo rojo con "Descartar".
  const seccionAprob = aps.length
    ? tituloSeccion('Necesitan tu OK', 'Desliza la tarjeta a la izquierda para descartarla · caduca sola a la hora del check-in') +
      aps.map((a, i) => `<div class="swipe-caja" data-swipe="${i}">
        <div class="swipe-fondo">Descartar</div>
        <div class="tarjeta swipe-frente">
          <div class="tarjeta-fila"><h3>${esc(a.huesped || 'Huésped')}</h3><span class="pill crit">ESPERA OK</span></div>
          <div class="sub">${esc(a.unidad)} · llega ${fBonita(a.ci)} · pedido desde ${esc((a.desde || '').slice(5, 16))}</div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn btn-mini" data-aprobar="${i}" style="flex:1">Aprobar y enviar claves</button>
            <button class="btn secundario btn-mini" data-aprobar-ocultar="${i}" style="width:auto;padding:9px 12px">Descartar</button>
          </div>
          <div class="sub oculto" data-aprobar-msg="${i}" style="margin-top:6px"></div>
        </div>
      </div>`).join('')
    : '';
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // ORDEN (pedido del dueño 21/07): último checkout → hospedados → próximos check-ins hacia abajo.
  // Se ordena por el `rank` del semáforo; desempate: checkouts recientes por co DESC (más reciente
  // arriba), próximos por ci ASC (más próximo arriba). El índice original i queda estable dentro del
  // hilo (data-hilo) porque el map recibe el arreglo YA ordenado.
  // 22/07 — MENSAJES muestra SOLO huéspedes ACTIVOS (pedido del dueño; reemplaza el orden anterior de
  // "último checkout arriba"). PASADO = checkout ANTERIOR a hoy. Se corta por `co < hoy` y NO por el
  // `inactivo` del semáforo a propósito: quien salió HOY a las 11:00 sigue activo hasta el fin del día,
  // porque su ventana de 24 h de WhatsApp sigue abierta y todavía le llega el agradecimiento post-checkout.
  // Los pasados NO se borran: se renderizan ocultos y el buscador los revela (así no se pierde el acceso).
  const hoyMsjIso = hoyLocalIso(0);
  const esPasado = h => (h.co || '') < hoyMsjIso;
  hilos.sort((a, b) => {
    const pa = esPasado(a) ? 1 : 0, pb = esPasado(b) ? 1 : 0;
    if (pa !== pb) return pa - pb;                                      // activos primero, pasados al final
    const ea = estadoHospedaje(a.ci, a.co, a.horaLlegada, a.horaSalida), eb = estadoHospedaje(b.ci, b.co, b.horaLlegada, b.horaSalida);
    if (ea.rank !== eb.rank) return ea.rank - eb.rank;
    if (pa === 1) return (b.co || '').localeCompare(a.co || '');        // entre pasados: más reciente primero
    if (ea.rank === 5) return (a.ci || '').localeCompare(b.ci || '');   // próximos: soonest primero
    return (a.co || '').localeCompare(b.co || '');
  });
  const nPasados = hilos.filter(esPasado).length;
  const tarjetas = hilos.map((h, i) => {
    const ult = h.mensajes[h.mensajes.length - 1] || {};
    const preview = ult.texto ? ult.texto.slice(0, 64) : (TIPO_LABEL[ult.tipo] || ult.tipo || '');
    const burbujas = h.mensajes.map(msg => `
      <div class="burbuja ${msg.dir === 'in' ? 'in' : 'out'}">
        <div class="meta">${msg.dir === 'in' ? '👤 ' + esc(h.huesped || 'Huésped')
          : (msg.tipo === 'EQUIPO' ? '👤 ' + esc(msg.de || 'Equipo') + ' (equipo)' : '🤖 Bot')} · ${esc((msg.ts || '').slice(5))}${TIPO_LABEL[msg.tipo] ? ' · ' + esc(TIPO_LABEL[msg.tipo]) : ''}</div>
        ${msg.texto ? esc(msg.texto).replace(/\n/g, '<br>') : `<span class="sub">${esc(TIPO_LABEL[msg.tipo] || msg.tipo)}</span>`}
      </div>`).join('');
    // Responder: WhatsApp solo acepta texto libre dentro de las 24 h desde el ÚLTIMO mensaje del
    // huésped (regla de Meta). Sin código de reserva no hay a quién resolver el número → sin cajita.
    const ultIn = [...h.mensajes].reverse().find(m => m.dir === 'in');
    const dentroVentana = !!ultIn && (Date.now() - new Date(String(ultIn.ts).replace(' ', 'T')).getTime()) < 24 * 3600 * 1000;
    const responder = !h.codigo ? '' : `<div class="hilo-responder">${dentroVentana
      ? `<textarea class="campo" data-resp="${i}" rows="2" maxlength="1000" placeholder="Escribe tu respuesta a ${esc(h.huesped || 'el huésped')}…" style="margin-bottom:0"></textarea>
         <button class="btn btn-mini" data-envia="${i}">Responder por WhatsApp</button>
         <div class="sub oculto" data-msj-msg="${i}"></div>`
      : `<div class="sub">⏳ Fuera de la ventana de 24 h de WhatsApp: para texto libre, el huésped debe escribir primero.</div>`}</div>`;
    const eH = estadoHospedaje(h.ci, h.co, h.horaLlegada, h.horaSalida);
    return `<div class="tarjeta tocable hilo${eH.inactivo ? ' inactivo' : ''}" data-hilo="${i}"${esPasado(h) ? ' data-pasado="1" style="display:none"' : ''} data-buscar="${esc(norm(h.huesped + ' ' + h.unidad))}">
      <div class="fila-unidad">${monograma(h.unidad)}
        <div class="resto">
          <div class="tarjeta-fila"><h3>${esc(h.huesped || 'Huésped')}</h3><span class="sub">${esc((h.ultimoTs || '').slice(5, 16))}</span></div>
          <div class="sub">${semDot(eH.luz) + (eH.txt ? esc(eH.txt) + ' · ' : '') + (h.ci && h.co ? fBonita(h.ci) + '–' + fBonita(h.co) + ' · ' : '') + esc(h.unidad)}</div>
          <div class="sub hilo-preview">${esc(preview)}${ult.texto && ult.texto.length > 64 ? '…' : ''}</div>
        </div>
      </div>
      ${legendaBot(h, pend)}
      <div class="hilo-mensajes oculto">${burbujas}${actividadDe(h)}${responder}</div>
    </div>`;
  }).join('');
  render(
    hero('Conversaciones con huéspedes · toca una para abrirla') +
    `<div class="cuerpo-vista">
      ${seccionAprob}
      <input class="campo" id="msj-buscar" inputmode="search" autocomplete="off" placeholder="🔍 Buscar por huésped o unidad…">
      ${tarjetas || `<div class="tarjeta"><div class="vacio">Sin conversaciones en los últimos 14 días.<br><span class="sub">Solo hay hilo con huéspedes CON WhatsApp — la captura de números vive en TAREAS.</span></div></div>`}
      ${nPasados ? `<div class="sub" style="margin:12px 4px 0">👤 ${nPasados} huésped${nPasados === 1 ? '' : 'es'} anterior${nPasados === 1 ? '' : 'es'} — escribí el nombre arriba para verlos.<br><span style="opacity:.75">Solo alcanza los últimos 14 días.</span></div>` : ''}
    </div>`);
  const buscador = $('#msj-buscar');
  if (buscador) buscador.addEventListener('input', () => {
    const q = norm(buscador.value.trim());
    document.querySelectorAll('[data-hilo]').forEach(el => {
      // Sin texto: se ven solo los ACTIVOS (los pasados vuelven a ocultarse).
      // Con texto: se busca en TODOS, incluidos los pasados — esa es la puerta a las conversaciones viejas.
      const coincide = !q ? !el.dataset.pasado : el.dataset.buscar.includes(q);
      el.style.display = coincide ? '' : 'none';
    });
  });
  document.querySelectorAll('[data-hilo]').forEach(card => card.addEventListener('click', (ev) => {
    if (ev.target.closest('.hilo-responder')) return;   // escribir/enviar NO pliega el hilo
    card.querySelector('.hilo-mensajes').classList.toggle('oculto');
    card.querySelector('.hilo-preview').classList.toggle('oculto');
  }));
  // Salto 💬 desde UNIDADES: abrir la conversación de ese huésped y bajar hasta ella. Si no tiene
  // hilo (sin mensajes aún), se deja su nombre en el buscador — la lista vacía lo dice sola.
  const foco = estado.mensajesFoco;
  if (foco) {
    estado.mensajesFoco = null;
    const iFoco = hilos.findIndex(h => h.codigo && h.codigo === foco.codigo);
    const card = iFoco >= 0 ? document.querySelector(`[data-hilo="${iFoco}"]`) : null;
    if (card) {
      card.querySelector('.hilo-mensajes').classList.remove('oculto');
      card.querySelector('.hilo-preview').classList.add('oculto');
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (buscador && foco.nombre) {
      buscador.value = foco.nombre;
      buscador.dispatchEvent(new Event('input'));
    }
  }
  // Enviar respuesta al huésped (sale del número del bot; el CRM la registra como 👤 EQUIPO).
  document.querySelectorAll('[data-envia]').forEach(b => b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const i = +b.dataset.envia, h = hilos[i];
    const ta = document.querySelector(`[data-resp="${i}"]`), msg = document.querySelector(`[data-msj-msg="${i}"]`);
    const texto = (ta.value || '').trim();
    if (!texto) { ta.focus(); return; }
    b.disabled = true; b.textContent = 'Enviando…';
    try {
      const r = await apiPost({ apiAction: 'enviarMensajeHuesped', unidad: h.unidad, codigo: h.codigo, texto });
      if (!r.ok) throw new Error(r.error || 'error');
      const div = document.createElement('div');
      div.className = 'burbuja out';
      div.innerHTML = `<div class="meta">👤 ${esc(estado.yo.nombre)} (equipo) · ahora</div>${esc(texto).replace(/\n/g, '<br>')}`;
      b.closest('.hilo-mensajes').insertBefore(div, b.closest('.hilo-responder'));
      ta.value = '';
      msg.textContent = '✅ Enviado al huésped por WhatsApp.'; msg.style.color = 'var(--good)'; msg.classList.remove('oculto');
    } catch (e) {
      msg.textContent = 'No se pudo: ' + e.message; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto');
    }
    b.disabled = false; b.textContent = '📨 Responder por WhatsApp';
  }));
  // Aprobar envío de claves (F2 aprobarClaves = mismo efecto que responder "codigo 2A si" al bot).
  document.querySelectorAll('[data-aprobar]').forEach(b => b.addEventListener('click', async () => {
    const i = +b.dataset.aprobar, a = aps[i];
    const msg = document.querySelector(`[data-aprobar-msg="${i}"]`);
    if (!confirm(`¿Enviar las claves de ingreso de ${a.unidad} a ${a.huesped || 'el huésped'} por WhatsApp?`)) return;
    b.disabled = true; b.textContent = 'Enviando…';
    try {
      const r = await apiPost({ apiAction: 'aprobarClaves', unidad: a.unidad });
      if (!r.ok) throw new Error(r.error || 'error');
      estado.cache = {};
      msg.textContent = r.resultado || '✅ Claves enviadas.'; msg.style.color = 'var(--good)'; msg.classList.remove('oculto');
      b.textContent = '✅ Enviadas';
      actualizarBadgeMensajes();
    } catch (e) {
      msg.textContent = 'No se pudo: ' + e.message; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto');
      b.disabled = false; b.textContent = '🔑 Aprobar y enviar claves';
    }
  }));
  // Deslizar a la izquierda para descartar (T13). Solo horizontal: si el dedo va más en vertical,
  // se suelta el gesto para no secuestrar el scroll de la lista.
  const descartar = (a) => {
    estado.hechasLocal['apr:' + a.codigo] = 1;
    localStorage.setItem('pms_tareas_hechas', JSON.stringify(estado.hechasLocal));
    actualizarBadgeMensajes();
    vistaMensajes();
  };
  document.querySelectorAll('[data-swipe]').forEach(caja => {
    const frente = caja.querySelector('.swipe-frente');
    let x0 = null, y0 = null, dx = 0, activo = false;
    frente.addEventListener('touchstart', (ev) => {
      x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; dx = 0; activo = false;
      frente.style.transition = 'none';
    }, { passive: true });
    frente.addEventListener('touchmove', (ev) => {
      if (x0 === null) return;
      const nx = ev.touches[0].clientX - x0, ny = ev.touches[0].clientY - y0;
      if (!activo && Math.abs(nx) < Math.abs(ny)) { x0 = null; return; }   // es scroll vertical
      activo = true;
      dx = Math.min(0, nx);                                               // solo hacia la izquierda
      frente.style.transform = `translateX(${dx}px)`;
    }, { passive: true });
    frente.addEventListener('touchend', () => {
      if (x0 === null) { frente.style.transform = ''; return; }
      frente.style.transition = 'transform .18s ease';
      const a = aps[+caja.dataset.swipe];
      if (dx < -90) { frente.style.transform = 'translateX(-110%)'; setTimeout(() => descartar(a), 160); }
      else frente.style.transform = '';
      x0 = null;
    });
  });
  document.querySelectorAll('[data-aprobar-ocultar]').forEach(b => b.addEventListener('click', () => {
    const a = aps[+b.dataset.aprobarOcultar];
    estado.hechasLocal['apr:' + a.codigo] = 1;
    localStorage.setItem('pms_tareas_hechas', JSON.stringify(estado.hechasLocal));
    vistaMensajes();
  }));
  actualizarBadgeMensajes();
}

/* ---------- Vista: FOTOS (el ➕ central de cohost/limpieza — atajo al inventario) ---------- */
async function vistaFotoRapida() {
  setTitulo('Fotos');
  const j = await api({ action: 'unidades' });
  if (j.error) throw new Error(j.error);
  const cards = (j.unidades || []).map(u => `
    <div class="tarjeta tocable" data-foto-u="${esc(u.unidad)}">
      <div class="fila-unidad">${avatarUnidad(u)}
        <div class="resto">
          <div class="tarjeta-fila"><h3>${esc(u.unidad)}</h3><span class="pill ok">📷</span></div>
          <div class="sub">Toca para agregar fotos de esta unidad</div>
        </div>
      </div>
    </div>`).join('');
  render(
    hero('¿A qué unidad le agregas fotos?') +
    `<div class="cuerpo-vista">
      <div class="sub" style="margin-bottom:10px">Elige la unidad y luego la categoría (línea blanca, insumos, dispositivos, inmueble). Va directo al inventario del CRM, igual que 📷 AGREGAR FOTOS del detalle.</div>
      ${cards || '<div class="vacio">No hay unidades visibles para tu usuario.</div>'}
      
    </div>`);
  document.querySelectorAll('[data-foto-u]').forEach(el =>
    el.addEventListener('click', () => vistaInventario(el.dataset.fotoU)));
}

/* ---------- Vista: REPORTES (réplica del reporte mensual de marca) ---------- */
/* T7.2 (corrección del dueño): línea gris con totales, chips ROJOS de unidad + "ordenar por" a la
 * derecha, y DOS pestañas POR UNIDAD con la info ya desplegada — espejo de lo que el bot envía por
 * WhatsApp: Reporte Operativo (default; serie COMPLETA de admins) y Reporte Mensual (SOLO lo que
 * recibe el propietario + ENVIAR A PROPIETARIO). Siempre del mes en curso — sin nav de mes; el
 * consolidado global vive en el bot (día 1 / comando "global"), no en la app. */
let repReq = 0;           // invalida cargas de gráficas en vuelo cuando el usuario pide otra cosa
// (Se retiró repPngCache: era una CUARTA caché en memoria que duplicaba la de api() y, peor, la
//  tapaba — el repintado silencioso seguía mostrando la serie vieja. Ahora manda api() y punto.)

/* Glosario del pie de REPORTES (22/07/2026, pedido del dueño): la jerga de las gráficas explicada
 * como para un PROPIETARIO cliente, no para el equipo. Texto FIJO — nada viene del servidor, por eso
 * no pasa por esc(). Va cerrado por defecto para no alargar el scroll de todos los días.
 * Son los 7 términos que pidió el dueño, ni uno más: ocupación · ADR · RevPAR · ingresos · reservas ·
 * reseñas 5★ · ocupación de Cuenca. El ejemplo numérico va PRIMERO porque es lo que hace entender los
 * tres primeros de golpe (RevPAR = ADR × ocupación, sin decirlo con fórmula). */
const GLOSARIO_REPORTES = [
  ['Ocupación', 'De cada 100 noches del mes, cuántas se vendieron. Son los cuadros verdes del calendario.'],
  ['ADR — tarifa promedio por noche', 'Cuánto se cobró, en promedio, por cada noche <i>vendida</i>. Sube si subes el precio.'],
  ['RevPAR — ingreso por noche disponible', 'Cuánto rinde el departamento por cada noche del mes, esté ocupado o vacío. Es el número que manda: un precio alto con la casa vacía no sirve.'],
  ['Ingresos', 'Lo registrado por las reservas del mes. No es el depósito de Airbnb: una reserva que cruza dos meses se reparte por noches.'],
  ['Reservas', 'Cuántos grupos distintos de huéspedes, no cuántas noches.'],
  ['Reseñas 5★', 'Reseñas con la calificación máxima. Sostienen el Superhost y la posición del anuncio.'],
  ['Ocupación de Cuenca', 'Promedio del mercado local ese mes, para comparar contra la unidad.']
];
function glosarioReportes() {
  return `<details class="glosario">
      <summary>¿Qué significa cada dato?</summary>
      <div class="gl-ej">Un mes de 30 noches: se vendieron 24 y entraron $1.800<br>
        → ocupación <b>80%</b> · ADR <b>$75</b> · RevPAR <b>$60</b></div>
      ${GLOSARIO_REPORTES.map(g => `<div class="gl-item"><div class="gl-t">${g[0]}</div><div class="gl-d">${g[1]}</div></div>`).join('')}
    </details>`;
}

async function vistaReportes() {
  setTitulo('Reportes');
  if (!estado.yo.veIngresos) {
    render(hero('Reportes') + `<div class="cuerpo-vista"><div class="vacio">🔒 Los reportes son solo para administradores.<br>Tu rol (CoHost) es operativo: unidades y tareas.</div></div>`);
    return;
  }
  const hoy = new Date(), A = hoy.getFullYear(), M = hoy.getMonth() + 1;
  if (estado.repVista !== 'mensual' && estado.repVista !== 'operativo') estado.repVista = 'operativo';

  // Consolidado del mes: totales para la línea gris + ingresos por unidad para ordenar los chips.
  const g = await api({ action: 'reporteglobal', anio: A, mes: M });
  if (g.error) throw new Error(g.error);
  const k = g.kpis || {};
  const mesTit = MES[M - 1][0].toUpperCase() + MES[M - 1].slice(1);
  const favs = estado.yo.favoritas || [];

  let lista = [...(g.unidades || [])];
  if (!lista.length) lista = (estado.yo.unidades || []).map(u => ({ unidad: u, ingresos: 0 }));
  const orden = estado.repOrden || 'az';
  if (orden === 'mayor') lista.sort((a, b) => b.ingresos - a.ingresos);
  else if (orden === 'menor') lista.sort((a, b) => a.ingresos - b.ingresos);
  else if (orden === 'fav') lista.sort((a, b) => (favs.includes(b.unidad) - favs.includes(a.unidad)) || a.unidad.localeCompare(b.unidad));
  else lista.sort((a, b) => a.unidad.localeCompare(b.unidad));
  if (!estado.repUnidad || estado.repUnidad === '*' || !lista.some(f => f.unidad === estado.repUnidad)) {
    const fav1 = lista.find(f => favs.includes(f.unidad));
    estado.repUnidad = (fav1 || lista[0] || {}).unidad || '';
  }
  const U = estado.repUnidad, vista = estado.repVista;

  const chips = lista.map(f =>
    `<button class="chipu ${f.unidad === U ? 'sel' : ''}" data-rep-unidad="${esc(f.unidad)}">${favs.includes(f.unidad) ? '★ ' : ''}${esc(f.unidad)}</button>`).join('');
  const ORDENES = [['az', 'A–Z'], ['mayor', 'Mayor $'], ['menor', 'Menor $'], ['fav', '★ Favoritas']];
  const nU = g.nUnidades || lista.length;

  render(
    hero(`${mesTit} ${A} · $${Number(k.ingresos || 0).toFixed(2)} ingresos · ${k.ocupacion || 0}% ocupación · $${k.revpar || 0} RevPAR · ${nU} unidad${nU === 1 ? '' : 'es'}`) +
    `<div class="cuerpo-vista">
      <div class="rep-barra">
        <div class="rep-chips">${chips}</div>
        <label class="rep-orden">ordenar por
          <select id="rep-orden">${ORDENES.map(o => `<option value="${o[0]}" ${orden === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>
        </label>
      </div>
      <div class="chips subtabs">
        <button class="chip ${vista === 'operativo' ? 'activo' : ''}" data-rep-vista="operativo">Reporte Operativo</button>
        <button class="chip ${vista === 'mensual' ? 'activo' : ''}" data-rep-vista="mensual">Reporte Mensual</button>
      </div>
      <div id="rep-cont"></div>
      ${glosarioReportes()}
    </div>`);

  document.querySelectorAll('[data-rep-unidad]').forEach(c =>
    c.addEventListener('click', () => { estado.repUnidad = c.dataset.repUnidad; irTab('reportes'); }));
  const selChip = document.querySelector('.chipu.sel');
  if (selChip) selChip.scrollIntoView({ block: 'nearest', inline: 'center' });
  $('#rep-orden').addEventListener('change', e => { estado.repOrden = e.target.value; irTab('reportes'); });
  document.querySelectorAll('[data-rep-vista]').forEach(b =>
    b.addEventListener('click', () => { estado.repVista = b.dataset.repVista; irTab('reportes'); }));

  // La pestaña activa carga sola, sin bloquear los controles de arriba (el shell ya es usable).
  cargarReportePng(vista, U);
}

/* Los PNG del CRM viven en Drive con URL uc?export=download (perfecta para WhatsApp/YCloud), pero
 * Chrome NO pinta en <img> respuestas con Content-Disposition: attachment. Para mostrarlas en la app
 * se reescribe al endpoint thumbnail (sirve la imagen inline, mismo archivo público). */
function imgDrive(url) {
  const m = String(url || '').match(/drive\.google\.com\/uc\?[^"']*id=([\w-]+)/);
  return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w2000' : url;
}

/* PRECARGA de REPORTES (22/07/2026): al entrar, y en segundo plano, se trae la serie de la unidad
 * que la pestaña va a mostrar por defecto (favorita ★ primero, si no la 1ª alfabética — el mismo
 * criterio de vistaReportes) y se "calientan" sus PNG con new Image(): el service worker los deja
 * en la caché pms-img-v1, así que al tocar REPORTES ya están en el teléfono. Nada de esto bloquea
 * ni se ve: va en idle, sin await y con catch mudo. Solo para quien ve ingresos (CoHost no entra). */
function precalentarReportes() {
  if (!estado.yo || !estado.yo.veIngresos) return;
  const unis = (estado.yo.unidades || []).slice().sort((a, b) => String(a).localeCompare(String(b)));
  const favs = estado.yo.favoritas || [];
  const U = favs.find(f => unis.indexOf(f) !== -1) || unis[0];
  if (!U) return;
  const enCalma = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 8000 }) : setTimeout(fn, 3000));
  enCalma(() => {
    api({ action: 'reportepng', unidad: U, tipo: 'operativo' })
      .then(j => { if (j && !j.error) (j.imagenes || []).forEach(im => { new Image().src = imgDrive(im.url); }); })
      .catch(() => {});
  });
}

/* REPORTES (T7.2): llena #rep-cont con la pestaña activa — ambas POR UNIDAD y espejo del bot.
 * OPERATIVO = serie COMPLETA de admins (reportepng tipo=operativo → _serieReporteUnidadUrls_ en
 * reportes.js del CRM: calendarios actual+próximo, ingresos YoY, RevPAR diario, marcador); interno,
 * JAMÁS va al propietario. MENSUAL = SOLO lo que recibe el PROPIETARIO (tipo=mensual →
 * _seriePropietarioUrls_: calendario del mes, ingresos del año, marcador) + su resumen + nota +
 * ENVIAR A PROPIETARIO (apiAction enviarReporteProp → plantilla reporte_invitacion; el bot le
 * responde esta misma serie). */
async function cargarReportePng(vista, U) {
  const cont = $('#rep-cont');
  if (!cont) return;
  const esMensual = vista === 'mensual';
  const mi = ++repReq;   // toda carga nueva (aun de caché) invalida las respuestas en vuelo

  cont.innerHTML = `<div class="sub" style="margin:2px 4px 8px">${esMensual
    ? `Unidad ${esc(U)} · exactamente lo que recibe el propietario`
    : `Unidad ${esc(U)} · la serie completa que el bot envía a admins`}</div>
    <div id="rep-hojas"><div class="vacio">⏳ Cargando las gráficas de ${esc(U)}…<br><span class="sub">Se pre-generan de madrugada. Si aún no están listas, la primera vez tarda ~20-30 segundos.</span></div></div>`;

  // CON caché (22/07/2026): antes iba con `false` — "son respuestas pesadas y por sesión basta" —
  // y eso apagaba localStorage Y el cerebro D1, así que al cerrar la app se perdía TODO y las
  // gráficas volvían a tardar. El payload real son ~5 URLs + títulos (≈1 KB): lo que pesa son los
  // PNG, y esos los guarda el service worker. Ahora manda api(): memoria → localStorage → red, con
  // stale-while-revalidate (pinta la serie de ayer al instante y se repinta sola con la del día).
  let j;
  try { j = await api({ action: 'reportepng', unidad: U, tipo: esMensual ? 'mensual' : 'operativo' }); }
  catch (e) { j = { error: e.message }; }
  if (mi !== repReq || estado.tab !== 'reportes') return;   // el usuario ya pidió otra cosa
  const hojas = $('#rep-hojas');
  if (!hojas) return;
  if (j.error) { hojas.innerHTML = `<div class="vacio">⚠️ ${esc(j.error)}</div>`; return; }
  const imgs = (j.imagenes || []).map(im => `
    ${tituloSeccion(esc(im.titulo))}
    <a href="${esc(im.url)}" target="_blank" rel="noopener"><img class="rep-img" src="${esc(imgDrive(im.url))}" alt="${esc(im.titulo)}"></a>`).join('');
  if (!esMensual) {
    hojas.innerHTML = `${imgs || '<div class="vacio">No se generaron gráficas — reintenta en un momento.</div>'}
      <div class="tarjeta"><div class="sub">🔒 Reporte interno (admins). El propietario NO recibe estas gráficas — solo su Reporte Mensual.</div></div>`;
    return;
  }
  const resumen = String(j.resumen || '').replace(/\*/g, '');
  hojas.innerHTML = `${imgs || '<div class="vacio">No se generaron gráficas — reintenta en un momento.</div>'}
    ${resumen ? `<div class="tarjeta"><div class="sub" style="white-space:pre-line">${esc(resumen)}</div></div>` : ''}
    ${j.nota ? `<div class="tarjeta"><div class="sub">${esc(j.nota)}</div></div>` : ''}
    <button class="btn" id="btn-rep-prop">ENVIAR A PROPIETARIO</button>
    <div class="sub" style="margin:8px 4px 0">Le llega una invitación por WhatsApp; al tocar "Recibir reporte" el bot le manda su versión resumida con la nota de ingresos.</div>
    <div class="sub oculto" id="rep-prop-msg" style="margin:8px 4px 0"></div>`;
  $('#btn-rep-prop').addEventListener('click', async () => {
    const btn = $('#btn-rep-prop'), msg = $('#rep-prop-msg');
    if (!confirm('Se enviará al PROPIETARIO de ' + U + ' una invitación por WhatsApp para recibir su reporte. ¿Continuar?')) return;
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const r = await apiPost({ apiAction: 'enviarReporteProp', unidad: U });
      if (!r.ok) throw new Error(r.error || 'error');
      msg.textContent = '✅ Invitación enviada' + (r.propietario ? ' a ' + r.propietario : '') + '. Cuando toque "Recibir reporte" en WhatsApp, el bot le manda sus gráficas.';
      msg.style.color = 'var(--good)';
    } catch (e) {
      msg.textContent = '⚠️ ' + e.message;
      msg.style.color = 'var(--crit)';
    }
    msg.classList.remove('oculto');
    btn.disabled = false; btn.textContent = '📤 ENVIAR A PROPIETARIO';
  });
}

/* (La pestaña BUSCAR se retiró: la búsqueda de disponibilidad vive SOLO en Unidades —
 *  vistaDisponibilidad/buscarDisponibilidad, tarjeta "🔍 Buscar disponibilidad".) */

/* ---------- Vista: NOTIFICACIONES (feed del bot) ---------- */
// Engancha el bloque de push (estado + activar + probar). Reutilizable donde se pinte su markup.
function engancharPush() {
  const elEstado = $('#noti-estado'), btn = $('#btn-noti'), probar = $('#btn-noti-probar'), msg = $('#noti-msg');
  if (!elEstado) return;
  (async () => {
    const est = await estadoNotificaciones();
    if (est === 'no-soportado') elEstado.innerHTML = 'Para recibir avisos en el teléfono, abre la app <b>instalada en la pantalla de inicio</b>. iPhone: Compartir → Añadir a pantalla de inicio.';
    else if (est === 'bloqueado') elEstado.innerHTML = '⛔ Bloqueadas. Actívalas en Ajustes del teléfono → 1242BNB → Notificaciones.';
    else if (est === 'activas') { elEstado.innerHTML = '✅ Push activadas en este teléfono.'; probar.style.display = 'inline-block'; }
    else { elEstado.textContent = 'Push desactivadas en este teléfono.'; btn.style.display = 'inline-block'; }
  })();
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Activando…';
    try {
      await activarNotificaciones();
      msg.textContent = '✅ Notificaciones activadas.'; msg.style.color = 'var(--good)'; msg.classList.remove('oculto');
      btn.style.display = 'none'; probar.style.display = 'inline-block';
    } catch (e) {
      msg.textContent = e.message; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto');
      btn.disabled = false; btn.textContent = '🔔 Activar notificaciones en este teléfono';
    }
  });
  probar.addEventListener('click', async () => {
    probar.disabled = true;
    try { const r = await apiPost({ apiAction: 'notiTest' }); if (!r.ok) throw new Error(r.error || ''); msg.textContent = 'Enviada — debería llegarte en unos segundos.'; msg.style.color = 'var(--good)'; }
    catch (e) { msg.textContent = 'No se pudo enviar la prueba.'; msg.style.color = 'var(--crit)'; }
    msg.classList.remove('oculto'); probar.disabled = false;
  });
}

// Sello de ORIGEN de un aviso (ex-pestaña Notificación — T9: lo usa la "Actividad" por huésped en
// MENSAJES): A coral = chat de Airbnb · 💬 verde = WhatsApp del bot · inicial gris = limpieza ·
// punto rojo = sistema 1242bnb.
function selloOrigen(e) {
  const o = e.origen || 'sistema';
  if (o === 'airbnb') return '<span class="sello sello-airbnb" title="Vino del chat de Airbnb">A</span>';
  if (o === 'whatsapp') return '<span class="sello sello-wa" title="Vino del WhatsApp del bot">💬</span>';
  if (o === 'limpieza') return `<span class="sello sello-limp" title="Equipo de limpieza${e.quien ? ': ' + esc(e.quien) : ''}">${esc((e.quien || 'L').trim().charAt(0).toUpperCase())}</span>`;
  return '<span class="sello sello-sis" title="Sistema 1242bnb">•</span>';
}

/* ---------- Vista: pestaña CONFIGURACIÓN por unidad (T9 — reemplaza a Notificación) ---------- */
/* Mismo layout que REPORTES: chips de unidad arriba, y abajo TODA la configuración de la elegida.
 * Los switches de mensajería son POR UNIDAD con herencia del global (payload msgSwitches de
 * unidadeditar; escribe apiAction setMsgUnidad con SI/NO/HEREDAR). Permisos espejo del backend:
 * switches solo ADMIN puro · checklist/recordatorio también CoHost · limpieza ve en lectura. */
/* "Mis datos" (22/07/2026) — lo ÚNICO que ve limpieza/CoHost en la pestaña ⚙: su nombre y su WhatsApp.
 * Regla del dueño: la configuración de una unidad es SOLO del admin. El backend acompaña (la acción
 * setMisDatos resuelve la fila del servidor y solo acepta esos dos campos; checklist y recordatorio
 * ahora rechazan al CoHost), así que esto no es una restricción de pantalla nada más. */
async function vistaMisDatos() {
  setTitulo('Mis datos');
  const yo = estado.yo || {};
  const rolTxt = { cohost: 'CoHost (operativo)', limpieza: 'Equipo de limpieza' }[yo.rol] || yo.rol;
  render(
    hero(`${esc(yo.nombre || '')} · ${esc(rolTxt)}${(yo.unidades || []).length ? ' · ' + esc(yo.unidades.join(', ')) : ''}`) +
    `<div class="cuerpo-vista">
      ${tituloSeccion('Tus datos', 'Lo único que puedes cambiar de tu ficha')}
      <div class="tarjeta">
        <label class="campo-label" for="mis-nombre">Tu nombre</label>
        <input class="campo" id="mis-nombre" maxlength="40" value="${esc(yo.nombre || '')}" placeholder="Ej. Maritza">
        <label class="campo-label" for="mis-wa">Tu WhatsApp (con 593…)</label>
        <input class="campo" id="mis-wa" inputmode="numeric" maxlength="15" value="${esc(yo.whatsapp || '')}" placeholder="593987654321">
        <button class="btn" id="mis-guardar">GUARDAR MIS DATOS</button>
        <div id="mis-msg" class="sub oculto" style="margin-top:8px"></div>
        <div class="sub" style="margin-top:10px">Es el número al que el bot te escribe la agenda y los avisos. Tu acceso a la app sigue siendo los <b>últimos 4 dígitos de tu cédula</b>.</div>
      </div>
      <div class="tarjeta"><div class="sub">La configuración de las unidades —checklist, recordatorios, claves, automatizaciones— la maneja el administrador.</div></div>
      ${tituloSeccion('Tu cuenta', 'Apariencia, notificaciones y manuales')}
      <div class="tarjeta"><button class="btn secundario" id="mis-ir-cuenta">ABRIR MI CUENTA</button></div>
    </div>`);
  $('#mis-ir-cuenta').addEventListener('click', () =>
    vistaCuenta().catch(e => render(`<div class="cuerpo-vista"><div class="error-caja">${esc(e.message)}</div></div>`)));
  $('#mis-guardar').addEventListener('click', async () => {
    const btn = $('#mis-guardar'), msg = $('#mis-msg');
    const nombre = $('#mis-nombre').value.trim(), whatsapp = $('#mis-wa').value.replace(/\D/g, '');
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const r = await apiPost({ apiAction: 'setMisDatos', nombre, whatsapp });
      if (!r.ok) throw new Error(r.error || 'No se pudo guardar');
      // El nombre se pinta en el saludo de UNIDADES y en Mi cuenta: hay que refrescar `me` de verdad,
      // no solo la memoria (invalidarClave limpia también el localStorage).
      invalidarMe();
      const me = await api({ action: 'me' }, false);
      if (me && !me.error) estado.yo = me;
      msg.textContent = '✅ Listo, tus datos quedaron guardados.'; msg.style.color = 'var(--good)';
    } catch (e) {
      msg.textContent = '⚠️ ' + e.message; msg.style.color = 'var(--crit)';
    }
    msg.classList.remove('oculto');
    btn.disabled = false; btn.textContent = 'GUARDAR MIS DATOS';
  });
}

async function vistaConfigUnidad() {
  setTitulo('Configuración');
  const rol = estado.yo.rol;
  const esLimpieza = rol === 'limpieza';
  const puedeSw = rol === 'ceo_admin' || rol === 'admin';
  // Corte en seco: quien no es admin puro ni siquiera pide `unidades`/`unidad`/`unidadeditar`.
  if (!puedeSw) return vistaMisDatos();
  const puedeChk = !esLimpieza;
  const ju = await api({ action: 'unidades' });
  if (ju.error) throw new Error(ju.error);
  const unidades = ju.unidades || [];
  const lista = unidades.map(u => u.unidad);
  if (!estado.cfgUnidad || lista.indexOf(estado.cfgUnidad) === -1) estado.cfgUnidad = lista[0] || '';
  const U = estado.cfgUnidad;
  const uInfo = unidades.find(u => u.unidad === U) || {};
  const [d, ed] = await Promise.all([
    api({ action: 'unidad', unidad: U }),
    esLimpieza ? Promise.resolve(null) : api({ action: 'unidadeditar', unidad: U }).catch(() => null),
  ]);
  if (d.error) throw new Error(d.error);

  const favs = estado.yo.favoritas || [];
  const chips = lista.map(u => `<button class="chipu ${u === U ? 'sel' : ''}" data-cfg-u="${esc(u)}">${favs.includes(u) ? '★ ' : ''}${esc(u)}</button>`).join('');

  // Fila de una ETAPA de mensajería con su tri-estado: ON/OFF efectivo + de dónde sale (propio de
  // la unidad o heredado del global) + "usar global" para volver a heredar.
  const sw = (ed && ed.msgSwitches) || {};
  const filaEtapa = (et, lbl, det) => {
    const s = sw[et] || { propio: null, global: false };
    const efectivo = s.propio ? s.propio === 'SI' : !!s.global;
    const origen = s.propio ? '<b>propio de ' + esc(U) + '</b>' : 'heredado del global (' + (s.global ? 'ON' : 'OFF') + ')';
    return `<div class="switch-fila">
      <span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">${lbl}</span><br>
        <span class="sub">${det} · ${origen}${s.propio && puedeSw ? ` · <a href="#" class="enlace-wa" data-msg-heredar="${et}">usar global</a>` : ''}</span></span>
      <label class="toggle"><input type="checkbox" data-msg-et="${et}" ${efectivo ? 'checked' : ''} ${puedeSw ? '' : 'disabled'}><span class="track"></span></label>
    </div>`;
  };
  const filaSwitch = (lbl, det, tipo, on) => `<div class="switch-fila">
    <span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">${lbl}</span><br><span class="sub">${det}</span></span>
    <label class="toggle"><input type="checkbox" data-cfg-sw="${tipo}" ${on ? 'checked' : ''} ${puedeSw ? '' : 'disabled'}><span class="track"></span></label>
  </div>`;

  // El editor del checklist NORMAL se retiró (22/07/2026): esa lista es fija de 3 puntos —áreas,
  // toallas y papel según los huéspedes que llegan, y video— así que un editor ahí mentiría. Lo que
  // sí es propio de cada unidad vive en el editor de la PROFUNDA, acá abajo.

  // T15c — editor de la LIMPIEZA PROFUNDA: mismo patrón que el normal, pero SOLO admin puro (el backend
  // _apiSetChecklistProfunda_ bloquea CoHost y limpieza). Acá el admin agrega tareas propias de la
  // unidad, p. ej. el jacuzzi de 7A. Guardar vacío = vuelve a los 10 ítems por defecto.
  const itemsProfCfg = d.checklistProfunda || [];
  const checklistProfHtml = puedeSw ? `
    <div id="cfg-chkp-lista">${itemsProfCfg.map((it, i) => `
      <div class="lista-item" data-chkp-fila="${i}"><span style="flex:1" data-chkp-txt>${esc(it)}</span>
        <button class="btn secundario btn-mini" data-chkp-quitar="${i}" style="width:auto;padding:6px 10px">✕</button></div>`).join('')}</div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <input class="campo" id="cfg-chkp-nuevo" maxlength="80" placeholder="Ej. Limpieza del jacuzzi" style="flex:1;margin-bottom:0">
      <button class="btn secundario btn-mini" id="cfg-chkp-add" style="width:auto;padding:9px 14px">＋</button>
    </div>
    <button class="btn btn-mini" id="cfg-chkp-guardar" style="margin-top:8px">Guardar limpieza profunda</button>
    <div id="cfg-chkp-msg" class="sub oculto" style="margin-top:6px"></div>` : '';

  // Recordatorio personalizado (admin y CoHost editan; limpieza lo VE — a ellas les llega a las 6 AM).
  const rec = d.recordatorio || {};
  const MODOS_REC = [['TODAS', 'Cada limpieza'], ['PROFUNDA', 'Solo profunda'], ['PROXIMA', 'Solo la próxima'], ['OFF', 'Apagado']];
  const recordatorioHtml = puedeChk ? `
    <textarea class="campo" id="cfg-rec-texto" rows="2" maxlength="150" placeholder="Ej. Revisar el filtro del aire y avisar cómo está" style="margin-bottom:8px">${esc(rec.texto || '')}</textarea>
    <div class="chips" id="cfg-rec-chips" style="justify-content:center">
      ${MODOS_REC.map(o => `<button class="chip ${(rec.cuando || 'OFF') === o[0] ? 'activo' : ''}" data-rec-cuando="${o[0]}">${o[1]}</button>`).join('')}
    </div>
    <button class="btn secundario btn-mini" id="cfg-rec-guardar" style="margin-top:8px">Guardar recordatorio</button>
    <div id="cfg-rec-msg" class="sub oculto" style="margin-top:6px"></div>`
    : `<div class="sub">${rec.texto && rec.cuando !== 'OFF' ? '📌 ' + esc(rec.texto) : 'Sin recordatorio activo.'}</div>`;

  // Limpieza operativa (solo con unidadeditar): aviso al huésped + responsable + frecuencia profunda.
  const equipoL = (d.equipoLimpieza || []).map(p => (typeof p === 'string' ? p : (p && p.nombre) || '')).filter(Boolean);
  const respOpts = ['FORANEO'].concat(equipoL).filter((v, i, a) => a.indexOf(v) === i);
  // T14 — descanso dominical de quien limpia ESTA unidad. El dato vive en la col F de su fila
  // LIMPIEZA_n, o sea que es de la PERSONA: se avisa explícito para que nadie crea que apagó el
  // domingo solo en esta unidad. Sin persona asignada (FORANEO) no hay fila a la que escribirle.
  // T15 — `limpiezaPersona` AUSENTE (payload viejo servido del caché, anterior a T14) no es lo mismo
  // que `null` (la unidad es FORANEO de verdad). Tratarlos igual hacía que la app AFIRMARA que una
  // unidad no tiene nadie asignado cuando en realidad no lo sabía todavía. Sin el dato, no se dice nada.
  const lpSabido = !!(ed && Object.prototype.hasOwnProperty.call(ed, 'limpiezaPersona'));
  const lp = (ed && ed.limpiezaPersona) || null;
  const domingoHtml = (!puedeSw || !lpSabido) ? '' : (lp ? `
    <div class="switch-fila">
      <span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">${esc(lp.nombre)} descansa los domingos</span><br>
        <span class="sub">Apagado = trabaja el domingo como cualquier otro día. ⚠️ Es un dato de la persona: aplica a <b>todas las unidades de ${esc(lp.nombre)}</b>, no solo a ${esc(U)}.</span></span>
      <label class="toggle"><input type="checkbox" id="cfg-dom" data-dom-clave="${esc(lp.clave)}" data-dom-nombre="${esc(lp.nombre)}" ${lp.descansaDomingo ? 'checked' : ''}><span class="track"></span></label>
    </div>` : `
    <div class="sub" style="margin-top:6px">Esta unidad no tiene a nadie del equipo asignado (FORANEO). El descanso dominical se configura sobre una persona, así que acá no aplica.</div>`);

  // T14 — texto EXACTO de las claves que recibe el huésped (CLAVES_TEXTO_<U>). Solo admin puro: es el
  // mismo secreto que la clave de la puerta, y por eso viaja únicamente en `unidadeditar` — la acción
  // `unidad`, que ven CoHost y limpieza, no lo trae nunca.
  const clavesHtml = !puedeSw ? '' : `
    ${/* 22/07/2026 — caja GRANDE (era rows=4): es el texto más largo que se edita en la app y con 4
          líneas había que escribir a ciegas, haciendo scroll dentro del propio campo. El contador de
          abajo existe porque el tope de 600 es REAL (lo aplica _apiEditarUnidad_ en el CRM): sin él,
          el navegador deja de aceptar letras de golpe y no se entiende por qué. */''}
    <textarea class="campo" id="cfg-claves-txt" rows="12" maxlength="600" placeholder="Ej. Puerta de la calle (Schlage): 1234 · Puerta de tu unidad: 5678" style="margin-bottom:4px;min-height:210px;line-height:1.5">${esc((ed && ed.clavesTexto) || '')}</textarea>
    <div class="sub" id="cfg-claves-cuenta" style="text-align:right;margin-bottom:6px"></div>
    <div class="sub">Vacío = el bot arma el texto solo, con la clave de la ficha y las del edificio. Los saltos de línea se envían como " · " (las plantillas de WhatsApp no los aceptan).</div>
    <button class="btn btn-mini" id="cfg-claves-guardar" style="margin-top:8px">Guardar claves</button>
    <div id="cfg-claves-msg" class="sub oculto" style="margin-top:6px"></div>`;
  const limpiezaAdminHtml = ed ? `
    <div class="switch-fila">
      <span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">Avisar al huésped "unidad lista"</span><br>
        <span class="sub">Al completar la limpieza, WhatsApp al huésped que llega HOY. El aviso al admin va siempre.</span></span>
      <label class="toggle"><input type="checkbox" id="cfg-aviso-h" ${d.avisoHuesped ? 'checked' : ''} ${puedeSw ? '' : 'disabled'}><span class="track"></span></label>
    </div>
    ${puedeSw ? `
    <div class="lista-item"><span class="quien">Responsable de limpieza</span>
      <select class="campo" id="cfg-resp" style="width:auto;margin:0">${respOpts.map(n => `<option ${String(d.responsable || 'FORANEO') === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
    <div class="lista-item"><span class="quien">Limpieza profunda cada</span>
      <span><input class="campo" id="cfg-profcada" inputmode="numeric" value="${d.profundaCada || ''}" placeholder="${d.profundaCadaGeneral || 30}" style="width:70px;margin:0;text-align:center"> días</span></div>
    <div class="sub">Vacío = usar la frecuencia general (${d.profundaCadaGeneral || 30} días).</div>
    ${domingoHtml}
    <button class="btn btn-mini" id="cfg-limp-guardar" style="margin-top:8px">Guardar limpieza</button>
    <div id="cfg-limp-msg" class="sub oculto" style="margin-top:6px"></div>` : ''}` : '';

  // Reportes: propietario + switch por unidad + copia al admin.
  const reportesHtml = ed ? `
    <label class="campo-label" for="cfg-prop-nombre">Nombre del propietario</label>
    <input class="campo" id="cfg-prop-nombre" maxlength="60" value="${esc(ed.propietario || '')}" placeholder="Ej. María Torres" ${puedeSw ? '' : 'disabled'}>
    <label class="campo-label" for="cfg-prop-wa">WhatsApp del propietario (con código de país)</label>
    <input class="campo" id="cfg-prop-wa" inputmode="numeric" maxlength="15" value="${esc(ed.propietario_wa || '')}" placeholder="Ej. 593998877665" ${puedeSw ? '' : 'disabled'}>
    <div class="switch-fila"><span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">Reporte mensual al propietario</span><br>
      <span class="sub">${ed.reportePropMaster ? 'Se envía el día 1 por WhatsApp' : 'El envío automático global está APAGADO — el botón manual de REPORTES sí funciona'}</span></span>
      <label class="toggle"><input type="checkbox" id="cfg-prop-sw" ${ed.reporteProp ? 'checked' : ''} ${puedeSw ? '' : 'disabled'}><span class="track"></span></label></div>
    <div class="switch-fila"><span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">Copia de mensajes al admin</span><br>
      <span class="sub">Resumen al admin de cada mensaje automático de esta unidad</span></span>
      <label class="toggle"><input type="checkbox" id="cfg-copia" ${ed.copiaAdmin ? 'checked' : ''} ${puedeSw ? '' : 'disabled'}><span class="track"></span></label></div>
    ${puedeSw ? '<button class="btn btn-mini" id="cfg-prop-guardar" style="margin-top:8px">Guardar reportes</button><div id="cfg-prop-msg" class="sub oculto" style="margin-top:6px"></div>' : ''}` : '';

  const masterOff = (ed && ed.mensajeriaAuto === false)
    ? `<div class="tarjeta"><div class="sub">⚠️ La <b>mensajería automática GLOBAL</b> está APAGADA (se prende en 👤 Cuenta o con el chip 🤖 de arriba): ningún mensaje sale a huéspedes aunque estos switches estén ON.</div></div>` : '';

  // T15e — dos sub-pestañas debajo de la selección de unidad: CONFIGURACIÓN (datos y operación de la
  // unidad) y AUTOMATIZACIONES (todo lo que el bot hace solo: switches maestros, mensajería, reseñas,
  // FAQ). Se recuerda entre unidades con estado.cfgTab; alternan sin volver a pedir datos.
  if (estado.cfgTab !== 'auto' && estado.cfgTab !== 'config') estado.cfgTab = 'config';
  const cfgTab = estado.cfgTab;

  render(
    hero(`${esc(U)} · toda la configuración de la unidad`) +
    `<div class="cuerpo-vista">
      <div class="rep-barra"><div class="rep-chips">${chips}</div></div>
      <div class="chips subtabs" style="margin:2px 0 6px">
        <button class="chip ${cfgTab === 'config' ? 'activo' : ''}" data-cfgtab="config">Configuración</button>
        <button class="chip ${cfgTab === 'auto' ? 'activo' : ''}" data-cfgtab="auto">Automatizaciones</button>
      </div>
      <div id="cfg-grupo-auto" class="${cfgTab === 'auto' ? '' : 'oculto'}">
      ${tituloSeccion('Automatizaciones', 'Los switches maestros de ' + esc(U))}
      <div class="tarjeta">
        ${filaSwitch('Automatizaciones del bot', 'Maestro de la unidad: mensajería, agenda, avisos y reportes', 'bot', uInfo.botActivo)}
        ${filaSwitch('En reportes', 'La unidad entra en los reportes de ingresos', 'reportes', uInfo.enReportes)}
        ${(ed && ed.cohostActivo) ? (() => {
          // Cableado CoHost (21/07/2026): ON = Huésped→Bot→CoHost→Limpieza; OFF = Huésped→Bot→Limpieza.
          // Mismo patrón propio/heredado de filaEtapa, pero escribe vía editarUnidad {cohostActivo}.
          const s = ed.cohostActivo;
          const efectivo = s.propio ? s.propio === 'SI' : !!s.global;
          const origen = s.propio ? '<b>propio de ' + esc(U) + '</b>' : 'heredado del global (' + (s.global ? 'ON' : 'OFF') + ')';
          return `<div class="switch-fila">
            <span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">CoHost en la cadena</span><br>
              <span class="sub">ON: Huésped→Bot→CoHost→Limpieza · OFF: Huésped→Bot→Limpieza · ${origen}${s.propio && puedeSw ? ' · <a href="#" class="enlace-wa" data-cohost-heredar="1">usar global</a>' : ''}</span></span>
            <label class="toggle"><input type="checkbox" data-cohost-sw ${efectivo ? 'checked' : ''} ${puedeSw ? '' : 'disabled'}><span class="track"></span></label>
          </div>`;
        })() : ''}
        <div id="cfg-sw-msg" class="sub oculto" style="margin-top:6px"></div>
      </div>
      ${ed ? `${masterOff}
      ${tituloSeccion('Mensajería automática', 'El ciclo del huésped en ' + esc(U) + ' — cada switch hereda del global o es propio')}
      <div class="tarjeta">
        ${/* T15b — las claves van PRIMERAS: son lo que el dueño toca más y lo único que le da acceso
              físico al huésped. El botón EDITAR abre acá mismo el texto que se envía (CLAVES_TEXTO_<U>,
              creado en T14), en vez de mandarlo a una sección aparte más abajo. */''}
        ${filaEtapa('CODIGO_ACCESO', 'Claves de ingreso', 'Salen SOLAS al registrar la limpieza en HOY. El admin puede mandarlas a mano en emergencia')}
        ${clavesHtml ? `<div class="lista-item"><span style="flex:1"><span class="quien">Instrucciones de check-in y claves</span><br>
          <span class="sub">El texto exacto que recibe el huésped</span></span>
          <button class="btn-oscuro" id="cfg-claves-edit" style="flex:none;padding:8px 14px">EDITAR</button></div>
        <div id="cfg-claves-caja" class="oculto" style="margin-top:8px">${clavesHtml}</div>` : ''}
        ${filaEtapa('PRE_CHECKIN', '👋 Bienvenida pre check-in', 'Víspera 6 PM, con la dirección')}
        ${filaEtapa('CHECKIN_HORA', '🕐 Pregunta la hora de llegada', 'Día del check-in, 6 AM')}
        ${filaEtapa('POST_CHECKIN', '🛎 ¿Todo bien con tu ingreso?', 'Día del check-in, ~3 PM. El huésped responde TODO OK')}
        ${filaEtapa('SEGUIMIENTO_ESTADIA', '🛎 Seguimiento en la estadía', '"¿Todo bien?" al día siguiente de llegar')}
        ${filaEtapa('CHECKOUT', '🧳 Indicaciones de check-out', 'Día de salida, 6 AM')}
        ${filaEtapa('POST_CHECKOUT', '🙌 Agradecimiento post-checkout', 'Al día siguiente de salir')}
        <div id="cfg-msg-msg" class="sub oculto" style="margin-top:6px"></div>
      </div>
      ${tituloSeccion('Reseñas y descuentos', 'Seguimiento de reseñas y 5 estrellas')}
      <div class="tarjeta">
        ${filaEtapa('RESENAS', '⭐ Seguimiento de reseñas', 'Avisos de reseñas nuevas al equipo y al admin')}
        ${filaEtapa('DESCUENTO_5E', '🎁 Descuento por reseña 5★', 'Agradecimiento con descuento directo al huésped')}
      </div>
      ${tituloSeccion('Asistente 24/7', 'Respuestas automáticas a preguntas del huésped')}
      <div class="tarjeta">
        ${filaEtapa('FAQ_HUESPED', '💬 Preguntas frecuentes (FAQ)', 'Wifi, claves, parqueadero… desde la ficha de la unidad')}
        <div class="sub" style="margin-top:6px">ℹ️ El cambio del FAQ rige cuando se actualice el bot (webhook).</div>
      </div>` : ''}
      </div>
      <div id="cfg-grupo-config" class="${cfgTab === 'config' ? '' : 'oculto'}">
      ${tituloSeccion('Asistente de limpiezas', 'Avisos, responsable y frecuencia de profunda')}
      ${ed ? `<div class="tarjeta">${limpiezaAdminHtml}</div>` : '<div class="tarjeta"><div class="sub">La configuración de limpieza la maneja el administrador.</div></div>'}
      ${/* La sección aparte de claves se retiró: ahora vive dentro de Mensajería, detrás de EDITAR. */''}
      ${tituloSeccion('Recordatorio para el equipo', 'Viaja DENTRO del WhatsApp de limpieza de las 6 AM')}
      <div class="tarjeta">${recordatorioHtml}</div>
      ${checklistProfHtml ? `${tituloSeccion('Limpieza profunda', 'Tareas extra de esta unidad — agregá las propias, como el jacuzzi de 7A')}
      <div class="tarjeta">${checklistProfHtml}</div>` : ''}
      ${ed ? `${tituloSeccion('Reportes y propietario', 'El dueño real del inmueble y la copia al admin')}
      <div class="tarjeta">${reportesHtml}</div>` : ''}
      ${puedeSw ? `${tituloSeccion('Datos base', 'Nombre, capacidad, iCal y switches de la unidad')}
      <div class="tarjeta"><button class="btn secundario" id="cfg-editar-base">EDITAR DATOS BASE</button></div>` : ''}
      ${/* T15b — esta pestaña es la config de la UNIDAD; la del USUARIO vive en Mi cuenta, a la que solo
            se llegaba por el 👤 del encabezado. El dueño la buscó acá y no la encontró, así que se deja
            el camino explícito en vez de confiar en que descubra el icono. */''}
      ${tituloSeccion('Tu cuenta', 'Apariencia, notificaciones, equipo y mensajería general')}
      <div class="tarjeta"><button class="btn secundario" id="cfg-ir-cuenta">ABRIR MI CUENTA</button></div>
      </div>
    </div>`);

  // Chips de unidad (mismo gesto que REPORTES).
  document.querySelectorAll('[data-cfg-u]').forEach(c => c.addEventListener('click', () => { estado.cfgUnidad = c.dataset.cfgU; irTab('config'); }));
  // T15e — sub-pestañas Configuración / Automatizaciones: alternan sin re-pedir datos (los dos grupos
  // ya están en el DOM), recordando la elección para cuando se cambia de unidad.
  document.querySelectorAll('[data-cfgtab]').forEach(b => b.addEventListener('click', () => {
    estado.cfgTab = b.dataset.cfgtab;
    document.querySelectorAll('[data-cfgtab]').forEach(x => x.classList.toggle('activo', x === b));
    $('#cfg-grupo-auto').classList.toggle('oculto', estado.cfgTab !== 'auto');
    $('#cfg-grupo-config').classList.toggle('oculto', estado.cfgTab !== 'config');
    window.scrollTo({ top: 0 });
  }));
  // Datos base (nombre/capacidad/iCal): vive en su propia pantalla — T11 la reubicó acá al retirarse
  // el detalle de unidad con sub-pestañas.
  const bEB = $('#cfg-editar-base');
  if (bEB) bEB.addEventListener('click', () => vistaEditarUnidad(U));
  const bCta = $('#cfg-ir-cuenta');
  if (bCta) bCta.addEventListener('click', () => vistaCuenta().catch(e => render(`<div class="cuerpo-vista"><div class="error-caja">${esc(e.message)}</div></div>`)));
  const selC = document.querySelector('.chipu.sel');
  if (selC) selC.scrollIntoView({ block: 'nearest', inline: 'center' });
  const repintar = () => { estado.cache = {}; irTab('config'); };
  const aviso = (sel, txt, ok) => { const m = $(sel); if (m) { m.textContent = txt; m.style.color = ok ? 'var(--good)' : 'var(--crit)'; m.classList.remove('oculto'); } };

  // BOT ACTIVO / EN REPORTES (optimista; si falla, revierte).
  document.querySelectorAll('[data-cfg-sw]').forEach(ch => ch.addEventListener('change', async () => {
    const valor = ch.checked;
    ch.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'setSwitch', unidad: U, tipo: ch.dataset.cfgSw, valor });
      if (!r.ok) throw new Error(r.error || 'error');
      estado.cache = {};
    } catch (e) { ch.checked = !valor; aviso('#cfg-sw-msg', 'No se pudo (' + e.message + ')', false); }
    ch.disabled = false;
  }));

  // Etapas de mensajería: el toggle escribe SI/NO propio; "usar global" vuelve a heredar.
  document.querySelectorAll('[data-msg-et]').forEach(ch => ch.addEventListener('change', async () => {
    const valor = ch.checked ? 'SI' : 'NO';
    ch.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'setMsgUnidad', unidad: U, etapa: ch.dataset.msgEt, valor });
      if (!r.ok) throw new Error(r.error || 'error');
      repintar();
    } catch (e) { ch.checked = !ch.checked; ch.disabled = false; aviso('#cfg-msg-msg', 'No se pudo (' + e.message + ')', false); }
  }));
  document.querySelectorAll('[data-msg-heredar]').forEach(a => a.addEventListener('click', async (ev) => {
    ev.preventDefault();
    try {
      const r = await apiPost({ apiAction: 'setMsgUnidad', unidad: U, etapa: a.dataset.msgHeredar, valor: 'HEREDAR' });
      if (!r.ok) throw new Error(r.error || 'error');
      repintar();
    } catch (e) { aviso('#cfg-msg-msg', 'No se pudo (' + e.message + ')', false); }
  }));
  // Cableado CoHost por unidad (toggle = SI/NO propio; "usar global" = HEREDAR).
  const swCoh = document.querySelector('[data-cohost-sw]');
  if (swCoh) swCoh.addEventListener('change', async () => {
    swCoh.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'editarUnidad', unidad: U, cohostActivo: swCoh.checked ? 'SI' : 'NO' });
      if (!r.ok) throw new Error(r.error || 'error');
      repintar();
    } catch (e) { swCoh.checked = !swCoh.checked; swCoh.disabled = false; aviso('#cfg-sw-msg', 'No se pudo (' + e.message + ')', false); }
  });
  document.querySelectorAll('[data-cohost-heredar]').forEach(a => a.addEventListener('click', async (ev) => {
    ev.preventDefault();
    try {
      const r = await apiPost({ apiAction: 'editarUnidad', unidad: U, cohostActivo: 'HEREDAR' });
      if (!r.ok) throw new Error(r.error || 'error');
      repintar();
    } catch (e) { aviso('#cfg-sw-msg', 'No se pudo (' + e.message + ')', false); }
  }));

  // Aviso al huésped al completar limpieza (editarUnidad).
  const avisoH = $('#cfg-aviso-h');
  if (avisoH) avisoH.addEventListener('change', async () => {
    const valor = avisoH.checked;
    avisoH.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'editarUnidad', unidad: U, avisoHuesped: valor });
      if (!r.ok) throw new Error(r.error || 'error');
      estado.cache = {};
      aviso('#cfg-limp-msg', valor ? '✅ El huésped recibirá "tu unidad está lista".' : '✅ Solo el admin recibirá el aviso.', true);
    } catch (e) { avisoH.checked = !valor; aviso('#cfg-limp-msg', 'No se pudo (' + e.message + ')', false); }
    avisoH.disabled = false;
  });
  const limpG = $('#cfg-limp-guardar');
  if (limpG) limpG.addEventListener('click', async () => {
    limpG.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'editarUnidad', unidad: U, responsable: $('#cfg-resp').value, profundaCada: $('#cfg-profcada').value.trim() });
      if (!r.ok) throw new Error(r.error || 'error');
      estado.cache = {};
      aviso('#cfg-limp-msg', '✅ Limpieza guardada.', true);
    } catch (e) { aviso('#cfg-limp-msg', 'No se pudo (' + e.message + ')', false); }
    limpG.disabled = false;
  });

  // T14 — descanso dominical: escribe la col F de la fila LIMPIEZA_n de esa persona (setEquipo).
  // Se mandan SOLO clave/nombre/descansaDomingo: _apiSetEquipo_ preserva unidades, WhatsApp y tope.
  const domCh = $('#cfg-dom');
  if (domCh) domCh.addEventListener('change', async () => {
    const valor = domCh.checked, quien = domCh.dataset.domNombre;
    domCh.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'setEquipo', tipo: 'limpieza', clave: domCh.dataset.domClave, nombre: quien, descansaDomingo: valor });
      if (!r.ok) throw new Error(r.error || 'error');
      estado.cache = {};
      aviso('#cfg-limp-msg', valor ? `✅ ${quien} descansa los domingos (en todas sus unidades).` : `✅ ${quien} trabaja también los domingos (en todas sus unidades).`, true);
    } catch (e) { domCh.checked = !valor; aviso('#cfg-limp-msg', 'No se pudo (' + e.message + ')', false); }
    domCh.disabled = false;
  });

  // T14 — texto de claves (editarUnidad → CLAVES_TEXTO_<U>). Vacío restaura el compositor automático.
  const clavesEd = $('#cfg-claves-edit');
  if (clavesEd) clavesEd.addEventListener('click', () => {
    const caja = $('#cfg-claves-caja');
    caja.classList.toggle('oculto');
    clavesEd.textContent = caja.classList.contains('oculto') ? 'EDITAR' : 'CERRAR';
    if (!caja.classList.contains('oculto')) $('#cfg-claves-txt').focus();
  });
  // Contador de caracteres del texto de claves (el tope de 600 lo impone el CRM, no la app).
  const clavesTxt = $('#cfg-claves-txt'), clavesCta = $('#cfg-claves-cuenta');
  if (clavesTxt && clavesCta) {
    const pintarCuenta = () => {
      const n = clavesTxt.value.length;
      clavesCta.textContent = n + ' / 600';
      clavesCta.style.color = n >= 600 ? 'var(--crit)' : 'var(--muted)';
    };
    clavesTxt.addEventListener('input', pintarCuenta);
    pintarCuenta();
  }
  const clavesG = $('#cfg-claves-guardar');
  if (clavesG) clavesG.addEventListener('click', async () => {
    clavesG.disabled = true;
    try {
      const txt = $('#cfg-claves-txt').value;
      const r = await apiPost({ apiAction: 'editarUnidad', unidad: U, clavesTexto: txt });
      if (!r.ok) throw new Error(r.error || 'error');
      estado.cache = {};
      aviso('#cfg-claves-msg', txt.trim() ? '✅ Claves guardadas.' : '✅ Vacío: el bot vuelve a armar el texto solo.', true);
    } catch (e) { aviso('#cfg-claves-msg', 'No se pudo (' + e.message + ')', false); }
    clavesG.disabled = false;
  });

  // Recordatorio (setRecordatorio).
  let recCuando = rec.cuando || 'OFF';
  document.querySelectorAll('#cfg-rec-chips .chip').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#cfg-rec-chips .chip').forEach(x => x.classList.remove('activo'));
    b.classList.add('activo');
    recCuando = b.dataset.recCuando;
  }));
  const recG = $('#cfg-rec-guardar');
  if (recG) recG.addEventListener('click', async () => {
    recG.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'setRecordatorio', unidad: U, texto: $('#cfg-rec-texto').value, cuando: recCuando });
      if (!r.ok) throw new Error(r.error || 'error');
      estado.cache = {};
      aviso('#cfg-rec-msg', '✅ Recordatorio guardado.', true);
    } catch (e) { aviso('#cfg-rec-msg', 'No se pudo (' + e.message + ')', false); }
    recG.disabled = false;
  });

  // (El editor del checklist NORMAL se retiró con su sección: la lista es fija de 3 puntos.
  //  El de la PROFUNDA sigue justo abajo.)

  // T15c — editor de la limpieza profunda (setChecklistProfunda). Mismo patrón que el normal; guardar
  // sin ítems vuelve a los 10 por defecto.
  const chkpG = $('#cfg-chkp-guardar');
  if (chkpG) {
    const engancharQuitarP = () => document.querySelectorAll('[data-chkp-quitar]').forEach(b => { b.onclick = () => b.closest('[data-chkp-fila]').remove(); });
    engancharQuitarP();
    $('#cfg-chkp-add').addEventListener('click', () => {
      const inp = $('#cfg-chkp-nuevo'), v = (inp.value || '').trim();
      if (!v) { inp.focus(); return; }
      const idx = document.querySelectorAll('#cfg-chkp-lista [data-chkp-fila]').length;
      $('#cfg-chkp-lista').insertAdjacentHTML('beforeend',
        `<div class="lista-item" data-chkp-fila="${idx}"><span style="flex:1" data-chkp-txt>${esc(v)}</span><button class="btn secundario btn-mini" data-chkp-quitar="${idx}" style="width:auto;padding:6px 10px">✕</button></div>`);
      inp.value = '';
      engancharQuitarP();
    });
    chkpG.addEventListener('click', async () => {
      chkpG.disabled = true;
      const items = [...document.querySelectorAll('#cfg-chkp-lista [data-chkp-txt]')].map(x => x.textContent.trim()).filter(Boolean);
      try {
        const r = await apiPost({ apiAction: 'setChecklistProfunda', unidad: U, items });
        if (!r.ok) throw new Error(r.error || 'error');
        estado.cache = {};
        aviso('#cfg-chkp-msg', items.length ? '✅ Limpieza profunda guardada (' + r.items.length + ' tareas).' : '✅ Vacío: vuelve a las 10 tareas por defecto.', true);
      } catch (e) { aviso('#cfg-chkp-msg', 'No se pudo (' + e.message + ')', false); }
      chkpG.disabled = false;
    });
  }

  // Reportes y propietario (editarUnidad) + copia al admin.
  const propG = $('#cfg-prop-guardar');
  if (propG) propG.addEventListener('click', async () => {
    propG.disabled = true;
    try {
      const r = await apiPost({
        apiAction: 'editarUnidad', unidad: U,
        propietario: $('#cfg-prop-nombre').value.trim(),
        propietario_wa: $('#cfg-prop-wa').value.replace(/\D/g, ''),
        reporteProp: $('#cfg-prop-sw').checked,
        copiaAdmin: $('#cfg-copia').checked,
      });
      if (!r.ok) throw new Error(r.error || 'error');
      estado.cache = {};
      aviso('#cfg-prop-msg', '✅ Guardado.', true);
    } catch (e) { aviso('#cfg-prop-msg', 'No se pudo (' + e.message + ')', false); }
    propG.disabled = false;
  });
}

/* ---------- Vista: CUENTA (👤 arriba-izquierda — settings del USUARIO, T9) ---------- */
async function vistaCuenta() {
  setTitulo('Mi cuenta');
  // T9: acá viven SOLO los settings del USUARIO y de la cuenta (identidad, apariencia, push, equipo,
  // manuales, inventario, mensajería global, salir). TODO lo de una unidad está en la pestaña ⚙ Config.
  // Los 2 pedidos EN PARALELO; "me" se refresca por si otro admin cambió los switches generales.
  const yoPrevio = estado.yo || {};
  const seraAdmin = yoPrevio.rol === 'ceo_admin' || yoPrevio.rol === 'admin';
  const [meF, eqRaw] = await Promise.all([
    api({ action: 'me' }).catch(() => null),
    seraAdmin ? api({ action: 'equipo' }, false).catch(() => null) : Promise.resolve(null),
  ]);
  if (meF && !meF.error) estado.yo = meF;
  const yo = estado.yo;
  const puedeEscribir = yo.rol === 'ceo_admin' || yo.rol === 'admin';
  // F2: directorio del equipo editable (solo admins) — filas COHOST_n y LIMPIEZA_n del CRM.
  let eq = (eqRaw && !eqRaw.error) ? eqRaw : null;
  // T15 — UNA sola sección de equipo. Antes había dos listas de la misma gente ("Equipo de trabajo" de
  // T14 arriba y este directorio abajo) y cada persona ocupaba un formulario de 4 campos, incluidas las
  // filas vacías: para ver a dos personas había que pasar por cinco formularios.
  // Ahora: una FILA por persona y el formulario detrás de "Editar", con el acordeón que ya usan los
  // hilos de MENSAJES. El backend (_apiEquipo_) ya no manda filas vacías ni gente de otros admins.
  const filaPersona = (tipo, p) => {
    const sub = tipo === 'cohost'
      ? (p.whatsapp ? '+' + esc(p.whatsapp) : 'sin WhatsApp')
      : (p.pendiente ? 'pendiente de asignar' : esc((p.mias || []).join(', ')));
    return `
    <div class="eq-persona" data-tipo="${tipo}" data-clave="${esc(p.clave || '')}">
      <div class="eq-cabecera">
        <span style="flex:1;min-width:0">
          <span class="quien" style="font-weight:800">${esc(p.nombre)}</span><br>
          <span class="sub">${sub}</span>
        </span>
        ${tipo === 'limpieza' ? `<label class="toggle" title="Descansa los domingos"><input type="checkbox" class="eq-domingo" ${p.descansaDomingo ? 'checked' : ''}><span class="track"></span></label>` : ''}
        <button class="btn-oscuro eq-editar" style="flex:none;padding:8px 14px">Editar</button>
      </div>
      <div class="eq-detalle oculto">
        <label class="campo-label">Nombre</label>
        <input class="campo eq-nombre" value="${esc(p.nombre || '')}" placeholder="${tipo === 'cohost' ? 'Ej. Fabián' : 'Ej. Maritza'}">
        <label class="campo-label">WhatsApp (con 593…)</label>
        <input class="campo eq-wa" inputmode="numeric" value="${esc(p.whatsapp || '')}" placeholder="593…">
        <label class="campo-label">Cédula (su acceso a la app = últimos 4 dígitos)</label>
        <input class="campo eq-cedula" inputmode="numeric" value="${esc(p.cedula || '')}" placeholder="Nº de cédula">
        <label class="campo-label">Unidades asignadas (separadas por coma)</label>
        <input class="campo eq-unidades" value="${esc(p.unidades || '')}" placeholder="Ej. 2A, 4A, 6A">
        <div class="fila-oscura">
          <button class="btn btn-mini eq-guardar" style="flex:1">Guardar</button>
          ${p.clave ? '<button class="btn secundario btn-mini eq-borrar" style="flex:none;width:auto;padding:9px 14px">Borrar</button>' : ''}
        </div>
      </div>
    </div>`;
  };
  // Al AGREGAR se piden solo nombre y WhatsApp: la persona entra sin unidades y queda "pendiente de
  // asignar" (visible para todos los admins) hasta que alguien la elija en Config → unidad → Responsable.
  const formNuevo = (tipo) => `
    <div class="eq-persona eq-nueva" data-tipo="${tipo}" data-clave="">
      <div class="tarjeta-fila"><h3 style="font-size:.95rem">${tipo === 'cohost' ? 'Nuevo CoHost' : 'Nueva limpiadora'}</h3></div>
      <label class="campo-label">Nombre</label>
      <input class="campo eq-nombre" placeholder="${tipo === 'cohost' ? 'Ej. Fabián' : 'Ej. Maritza'}">
      <label class="campo-label">WhatsApp (con 593…)</label>
      <input class="campo eq-wa" inputmode="numeric" placeholder="593…">
      <button class="btn btn-mini eq-guardar">Guardar</button>
    </div>`;
  const equipoHtml = eq ? `
    <div class="tarjeta">
      <div class="sub" style="font-weight:800;margin-bottom:6px">CoHosts</div>
      <button class="btn btn-mini" id="eq-mas-cohost" style="margin-bottom:10px">＋ Agregar CoHost</button>
      <div id="eq-lista-cohost">${eq.cohosts.map(p => filaPersona('cohost', p)).join('') || '<div class="vacio">Sin CoHosts en tus unidades</div>'}</div>
      <div class="sub" style="font-weight:800;margin:16px 0 6px">Limpieza</div>
      <button class="btn btn-mini" id="eq-mas-limpieza" style="margin-bottom:10px">＋ Agregar limpiadora</button>
      <div id="eq-lista-limpieza">${eq.limpieza.map(p => filaPersona('limpieza', p)).join('') || '<div class="vacio">Sin limpiadoras en tus unidades</div>'}</div>
      <div class="sub" style="margin-top:12px">Solo aparece quien trabaja en <b>tus unidades</b>, más quien todavía no tiene ninguna asignada. La <b>cédula</b> es su acceso a la app: entra con sus <b>últimos 4 dígitos</b>. El toggle es el descanso dominical y aplica a <b>todas las unidades</b> de esa persona.</div>
      <div id="eq-msg" class="sub oculto" style="text-align:center;margin-top:6px"></div>
    </div>`
    : `<div class="tarjeta"><div class="sub">El directorio del equipo lo edita el administrador.</div></div>`;
  // T14 dejó acá una sección "Equipo de trabajo" que era una SEGUNDA lista de la misma gente; T15 la
  // disolvió dentro del directorio de arriba, que ahora ya viene filtrado por el backend.
  const rolTxt ={ ceo_admin: 'CEO y administrador', ceo: 'CEO', admin: 'Administrador', cohost: 'CoHost (operativo)', limpieza: 'Equipo de limpieza' }[yo.rol] || yo.rol;
  render(
    hero(`${esc(yo.nombre)} · ${rolTxt}`) +
    `<div class="cuerpo-vista">
      <div class="tarjeta">
        <div class="tarjeta-fila"><h3>${esc(yo.nombre)}</h3><span class="pill ${yo.veIngresos ? 'ok' : 'busy'}">${esc(rolTxt).toUpperCase()}</span></div>
        <div class="sub">Unidades: ${yo.unidades.join(', ') || '—'}</div>
      </div>
      ${tituloSeccion('Salud del sistema', 'Bot · Google Sheets · PMS App — que todo esté en verde')}
      <div class="tarjeta" id="salud-caja"><div class="vacio">Comprobando…</div></div>
      ${/* T15 — Apariencia compacta: los chips salen de su tarjeta y van en la misma línea del título.
            Son tres opciones sin estado en el servidor; no justificaban un bloque propio. */''}
      <div class="titulo-seccion" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <h2>Apariencia</h2>
        <div class="chips" style="padding:0">
          ${[['auto', 'Automático'], ['claro', 'Claro'], ['oscuro', 'Oscuro']].map(o =>
            `<button class="chip ${estado.tema === o[0] ? 'activo' : ''}" data-tema="${o[0]}">${o[1]}</button>`).join('')}
        </div>
      </div>
      ${tituloSeccion('Notificaciones push', 'Avisos del bot en este teléfono')}
      <div class="tarjeta">
        <div id="noti-estado" class="sub">Comprobando…</div>
        <button class="btn" id="btn-noti" style="margin-top:8px;display:none">Activar notificaciones en este teléfono</button>
        <button class="btn secundario btn-mini" id="btn-noti-probar" style="margin-top:8px;display:none">Enviar notificación de prueba</button>
        <div id="noti-msg" class="sub oculto" style="margin-top:6px"></div>
      </div>
      ${tituloSeccion('Equipo', 'Quién trabaja en tus unidades — CoHosts y limpieza')}
      ${equipoHtml}
      ${puedeEscribir ? tituloSeccion('Equipo por unidad', 'Quién es el CEO/admin, CoHost y limpieza de cada unidad') : ''}
      ${puedeEscribir ? '<div class="tarjeta"><div id="eq-unidad" class="sub">Cargando…</div></div>' : ''}
      ${tituloSeccion('Manuales del equipo', 'El bot se los envía por WhatsApp a cada persona según su rol')}
      <div class="tarjeta">
        ${[['👔 Manual del administrador', (yo.manuales || {}).admin || 'https://www.1242bnb.com/admin'],
           ['🤝 Manual del CoHost', (yo.manuales || {}).cohost || 'https://www.1242bnb.com/cohost'],
           ['🧹 Manual del equipo de limpieza', (yo.manuales || {}).limpieza || 'https://www.1242bnb.com/limpieza']]
          .map(m => `<div class="lista-item"><span class="quien">${m[0]}</span>
            <a class="enlace-wa" target="_blank" rel="noopener" href="${esc(m[1])}">Abrir ↗</a></div>`).join('')}
        <div class="sub" style="margin-top:10px">Links en CONFIGURACION (MANUAL_ADMIN / MANUAL_COHOST / MANUAL_LIMPIEZA). El job de las 6 AM se los manda una sola vez a cada persona.</div>
      </div>
      ${tituloSeccion('Recordatorio de inventario', 'Aviso al admin si una unidad no tiene fotos nuevas en este tiempo')}
      <div class="tarjeta">
        <div class="chips" style="justify-content:center">
          ${/* T15 — en DÍAS (antes eran meses): el dueño razona el inventario en 30/45 días. */''}
          ${[[0, 'Apagado'], [30, 'Cada 30 días'], [45, 'Cada 45 días']].map(o =>
            `<button class="chip ${(yo.invFrecuencia || 0) === o[0] ? 'activo' : ''}" data-frec="${o[0]}" ${puedeEscribir ? '' : 'disabled'}>${o[1]}</button>`).join('')}
        </div>
        <div id="frec-msg" class="sub oculto" style="text-align:center;margin-top:8px"></div>
      </div>
      ${tituloSeccion('Mensajería del bot', 'Switches generales — aplican a TODAS las unidades')}
      ${puedeEscribir ? `<div class="tarjeta">
        <div class="switch-fila">
          <span class="quien" style="font-weight:800">Mensajería automática del bot</span>
          <label class="toggle"><input type="checkbox" id="tg-mensajeria" ${yo.mensajeriaAuto !== false ? 'checked' : ''}><span class="track"></span></label>
        </div>
        <div class="sub" style="margin:2px 0 12px">Apagado: NO salen los mensajes automáticos a huéspedes (bienvenida, check-in, seguimiento, check-out, descuento 5★). No afecta avisos internos, agenda, reportes ni las respuestas del bot a quien le escribe.</div>
        <div class="switch-fila">
          <span class="quien" style="font-weight:800">Copia de mensajes al admin</span>
          <label class="toggle"><input type="checkbox" id="tg-copia" ${yo.msgCopiaAdmin !== false ? 'checked' : ''}><span class="track"></span></label>
        </div>
        <div class="sub" style="margin:2px 0 12px">El admin de cada unidad recibe por WhatsApp un resumen de cada mensaje automático enviado al huésped ("📤 COPIA · 2A · Bienvenida → Juan").</div>
        <div class="switch-fila">
          <span class="quien" style="font-weight:800">CoHost en la cadena (global)</span>
          <label class="toggle"><input type="checkbox" id="tg-cohost" ${yo.cohostGlobal === true ? 'checked' : ''}><span class="track"></span></label>
        </div>
        <div class="sub" style="margin-top:2px">Encendido: Huésped→Bot→CoHost→Limpieza. Apagado (default): Huésped→Bot→Limpieza. El admin lo ve todo en MENSAJES + notificaciones. Cada unidad puede sobreescribirlo en su ⚙ Config.</div>
        <div class="sub" style="margin-top:8px">ℹ️ Cada unidad puede sobreescribir sus etapas de mensajería en la pestaña <b>⚙ Config</b> de abajo.</div>
        <div id="msg-gral-msg" class="sub oculto" style="margin-top:8px"></div>
      </div>` : `<div class="tarjeta"><div class="sub">
        <span class="switch-punto ${yo.mensajeriaAuto !== false ? 'on' : 'off'}"></span>Mensajería automática
        &nbsp;&nbsp;<span class="switch-punto ${yo.msgCopiaAdmin !== false ? 'on' : 'off'}"></span>Copia al admin
      </div></div>`}
      <div style="margin-top:22px"><button class="btn secundario" id="btn-salir">Cerrar sesión en este teléfono</button></div>
      <div class="sub" style="text-align:center;margin-top:14px">1242BNB PMS v1.2 · API F1 (solo lectura)</div>
      
    </div>`);
  $('#btn-salir').addEventListener('click', () => {
    localStorage.removeItem('pms_token');
    location.reload();
  });
  comprobarSalud(true);   // las 3 luces (async; pinta #salud-caja cuando llega)
  engancharPush();  // el bloque de push vive SOLO acá (T6.1); la pestaña Notificación es puro feed
  // Switches generales de mensajería (UI optimista; si el POST falla, se revierte el toggle).
  [['#tg-mensajeria', 'mensajeria', 'mensajeriaAuto'], ['#tg-copia', 'copiaAdmin', 'msgCopiaAdmin'], ['#tg-cohost', 'cohost', 'cohostGlobal']].forEach(([sel, clave, campo]) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('change', async () => {
      const valor = el.checked, msg = $('#msg-gral-msg');
      el.disabled = true;
      try {
        const r = await apiPost({ apiAction: 'setMsgGeneral', clave, valor });
        if (!r.ok) throw new Error(r.error || 'error');
        estado.yo[campo] = valor;
        invalidarMe();   // el "me" cacheado quedó viejo; se re-pide fresco la próxima vez
        pintarChipBot(); // el chip 🤖 de la cabecera sigue el estado del switch general
        if (msg) { msg.textContent = valor ? '✅ Activado.' : '⏸ Apagado.'; msg.style.color = 'var(--good)'; msg.classList.remove('oculto'); }
      } catch (e) {
        el.checked = !valor;
        if (msg) { msg.textContent = 'No se pudo guardar (' + e.message + ').'; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto'); }
      }
      el.disabled = false;
    });
  });
  // (La tarjeta "IA de facturas" se retiró: GEMINI_API_KEY ya vive en la hoja CONFIGURACION del
  //  CRM. El botón "🤖 Leer factura (IA)" de Gastos sigue usándola igual.)

  // T15 — EQUIPO: fila compacta + acordeón. Todos los enganches usan el guard `dataset.listo` porque
  // se vuelven a llamar al insertar un formulario de alta, y así no se duplican listeners.
  const eqMsg = (txt, ok) => {
    const m = $('#eq-msg');
    if (m) { m.textContent = txt; m.style.color = ok ? 'var(--good)' : 'var(--crit)'; m.classList.remove('oculto'); }
  };
  const engancharEquipo = () => {
    // Abrir/cerrar el detalle.
    document.querySelectorAll('.eq-editar').forEach(b => {
      if (b.dataset.listo) return;
      b.dataset.listo = '1';
      b.addEventListener('click', () => {
        const caja = b.closest('.eq-persona');
        const det = caja.querySelector('.eq-detalle');
        det.classList.toggle('oculto');
        b.textContent = det.classList.contains('oculto') ? 'Editar' : 'Cerrar';
      });
    });
    // Descanso dominical: se mandan SOLO clave/nombre/descansaDomingo y _apiSetEquipo_ preserva
    // unidades, WhatsApp y tope (ver el bug que se arregló en T14).
    document.querySelectorAll('.eq-domingo').forEach(ch => {
      if (ch.dataset.listo) return;
      ch.dataset.listo = '1';
      ch.addEventListener('change', async () => {
        const caja = ch.closest('.eq-persona'), valor = ch.checked;
        const quien = caja.querySelector('.eq-nombre').value.trim();
        ch.disabled = true;
        try {
          const r = await apiPost({ apiAction: 'setEquipo', tipo: 'limpieza', clave: caja.dataset.clave, nombre: quien, descansaDomingo: valor });
          if (!r.ok) throw new Error(r.error || 'error');
          invalidarEquipo();
          eqMsg(valor ? `✓ ${quien} descansa los domingos (en todas sus unidades).` : `✓ ${quien} trabaja también los domingos (en todas sus unidades).`, true);
        } catch (e) { ch.checked = !valor; eqMsg('No se pudo (' + e.message + ')', false); }
        ch.disabled = false;
      });
    });
    // Guardar. En el formulario de ALTA solo hay nombre y WhatsApp: los campos ausentes NO se mandan,
    // así la persona entra sin unidades (queda "pendiente de asignar") en vez de con basura.
    document.querySelectorAll('.eq-guardar').forEach(b => {
      if (b.dataset.listo) return;
      b.dataset.listo = '1';
      b.addEventListener('click', async () => {
        const caja = b.closest('.eq-persona');
        const val = (sel) => { const el = caja.querySelector(sel); return el ? el.value.trim() : undefined; };
        const payload = { apiAction: 'setEquipo', tipo: caja.dataset.tipo, clave: caja.dataset.clave, nombre: val('.eq-nombre') };
        ['.eq-wa|whatsapp', '.eq-cedula|cedula', '.eq-unidades|unidades'].forEach(par => {
          const [sel, campo] = par.split('|');
          const v = val(sel);
          if (v !== undefined) payload[campo] = v;
        });
        if (!payload.nombre) { eqMsg('Falta el nombre.', false); return; }
        b.disabled = true; b.textContent = 'Guardando…';
        try {
          const r = await apiPost(payload);
          if (!r.ok) throw new Error(r.error || 'error');
          invalidarEquipo();
          eqMsg(`✓ ${r.nombre} guardado (${r.clave})`, true);
          vistaCuenta();   // repinta la lista ya filtrada y con la fila nueva en formato compacto
        } catch (e) {
          eqMsg('No se pudo guardar (' + e.message + ').', false);
          b.disabled = false; b.textContent = 'Guardar';
        }
      });
    });
    // Borrar: vacía la fila conservando la clave. El backend lo NIEGA si la persona todavía tiene
    // unidades asignadas — ese error se muestra tal cual, porque dice cuáles hay que reasignar.
    document.querySelectorAll('.eq-borrar').forEach(b => {
      if (b.dataset.listo) return;
      b.dataset.listo = '1';
      b.addEventListener('click', async () => {
        const caja = b.closest('.eq-persona');
        const quien = caja.querySelector('.eq-nombre').value.trim() || caja.dataset.clave;
        if (!confirm(`¿Borrar a ${quien} del equipo?\n\nPierde el acceso a la app y deja de recibir avisos del bot. Sus datos se borran de la hoja; se puede volver a cargar después.`)) return;
        b.disabled = true; b.textContent = 'Borrando…';
        try {
          const r = await apiPost({ apiAction: 'borrarEquipo', clave: caja.dataset.clave });
          if (!r.ok) throw new Error(r.error || 'error');
          invalidarEquipo();
          eqMsg(`✓ ${r.nombre || quien} borrado.` + (r.aviso ? ' ' + r.aviso : ''), true);
          vistaCuenta();
        } catch (e) {
          eqMsg(e.message, false);
          b.disabled = false; b.textContent = 'Borrar';
        }
      });
    });
  };
  if (eq) {
    engancharEquipo();
    const agregar = (tipo, btnId, listaId) => $(btnId).addEventListener('click', () => {
      if (document.querySelector(`#${listaId} .eq-nueva`)) return;   // un alta a la vez
      const div = document.createElement('div');
      div.innerHTML = formNuevo(tipo);
      $('#' + listaId).prepend(div.firstElementChild);
      engancharEquipo();
      $(`#${listaId} .eq-nueva .eq-nombre`).focus();
    });
    agregar('cohost', '#eq-mas-cohost', 'eq-lista-cohost');
    agregar('limpieza', '#eq-mas-limpieza', 'eq-lista-limpieza');
  }
  // Vista "Equipo por unidad" (solo admins): CEO/admin + CoHost + limpieza de cada unidad.
  if (puedeEscribir) (async () => {
    const cont = $('#eq-unidad');
    if (!cont) return;
    try {
      const j = await api({ action: 'equipoporunidad' }, false);
      const us = (j && j.unidades) || [];
      cont.innerHTML = us.length ? us.map(u => `
        <div class="lista-item" style="flex-direction:column;align-items:flex-start;gap:2px">
          <span class="quien" style="font-weight:800">${esc(u.unidad)} · ${esc(u.ceo || '—')}</span>
          <span class="sub">CoHost: ${esc(u.cohost || '—')} · Limpieza: ${esc(u.limpieza || '—')}</span>
        </div>`).join('') : '<div class="vacio">Sin unidades</div>';
    } catch (e) { cont.textContent = 'No se pudo cargar el equipo por unidad.'; }
  })();
  // Tema: claro / oscuro / automático (guardado en este teléfono).
  document.querySelectorAll('[data-tema]').forEach(b => b.addEventListener('click', () => {
    setTema(b.dataset.tema);
    document.querySelectorAll('[data-tema]').forEach(x => x.classList.remove('activo'));
    b.classList.add('activo');
  }));
  // F2e: frecuencia del recordatorio de inventario.
  document.querySelectorAll('[data-frec]').forEach(b => b.addEventListener('click', async () => {
    if (!puedeEscribir) return;
    const dias = +b.dataset.frec;   // T15: en días (0 / 30 / 45), antes eran meses
    document.querySelectorAll('[data-frec]').forEach(x => x.classList.remove('activo'));
    b.classList.add('activo');
    const msg = $('#frec-msg');
    try {
      const r = await apiPost({ apiAction: 'setInvFrecuencia', dias });
      if (!r.ok) throw new Error(r.error);
      estado.yo.invFrecuencia = dias;
      msg.textContent = '✓ Guardado'; msg.style.color = 'var(--good)'; msg.classList.remove('oculto');
      setTimeout(() => msg.classList.add('oculto'), 1500);
    } catch (e) {
      msg.textContent = 'No se pudo guardar. Intenta de nuevo.'; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto');
    }
  }));
  // (Los toggles BOT/EN REPORTES por unidad viven ahora en la pestaña ⚙ Config — vistaConfigUnidad.)
}

/* ---------- Login / arranque ---------- */
async function entrar(token) {
  const errEl = $('#login-error');
  errEl.classList.add('oculto');
  mostrarCarga(true);
  try {
    estado.token = token;
    const yo = await api({ action: 'me' }, false);
    if (yo.error) throw new Error('Cédula incorrecta. Revisa tus últimos 4 dígitos e intenta de nuevo.');
    estado.yo = yo;
    localStorage.setItem('pms_token', token);
    cargarDatosLS();   // precarga los datos de la última sesión → la 1ª pantalla pinta al instante
    $('#login').classList.add('oculto');
    $('#app').classList.remove('oculto');
    // Salud siempre a la vista: primera comprobación al entrar + refresco cada 10 min (la acción
    // `salud` está cacheada 60 s en el servidor; el ping del webhook es un GET barato).
    comprobarSalud(false);
    if (!estado.saludTimer) estado.saludTimer = setInterval(() => comprobarSalud(false), 600000);
    // Cabecera: arriba-izquierda va el PERFIL (rol) del usuario, FIJO — el nombre de la vista ya
    // vive en el wordmark del hero rojo, así no se repite.
    // La appbar muestra el TÍTULO de la vista (negro bold, izquierda) — el rol vive en Configuración.
    // Barra SIEMPRE de 5 íconos: el slot central es Reportes para admins y se TRANSFORMA en ➕
    // Fotos para CoHost/limpieza (atajo al inventario). El candado interno de vistaReportes queda
    // de defensa; los datos financieros ya se bloquean por rol/veIngresos en el backend.
    if (yo.rol === 'cohost' || yo.rol === 'limpieza') {
      const centro = document.querySelector('.tab[data-tab="reportes"]');
      if (centro) {
        centro.dataset.tab = 'fotos';
        centro.innerHTML = '<span class="tab-icono"><span class="tab-mas">＋</span></span>Fotos';
      }
      // ⚙ Config → "Mis datos" (22/07/2026): para estos roles la pestaña ya no configura la unidad,
      // solo su nombre y su WhatsApp. El data-tab sigue siendo 'config' — el router no cambia.
      const cfgTab = document.querySelector('.tab[data-tab="config"]');
      if (cfgTab) cfgTab.innerHTML = '<span class="tab-icono">⚙</span>Mis datos';
    }
    pintarChipBot();
    irTab('tareas');   // la app arranca en HOY (primera pestaña — Tanda 6)
    actualizarBadgeTareas(); actualizarBadgeMensajes();
    precalentarReportes();   // en segundo plano: que REPORTES ya esté listo cuando lo toquen
  } catch (e) {
    errEl.textContent = e.message.indexOf('Cédula') === 0 ? e.message : 'No se pudo conectar. Revisa tu internet.';
    errEl.classList.remove('oculto');
    $('#login').classList.remove('oculto');
  }
  mostrarCarga(false);
}

document.addEventListener('DOMContentLoaded', () => {
  aplicarTema();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (estado.tema === 'auto') aplicarTema();
  });
  $('#btn-entrar').addEventListener('click', () => {
    const t = $('#token-input').value.trim();
    if (t) entrar(t);
  });
  $('#token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-entrar').click(); });
  // 👤 CUENTA arriba a la izquierda (T9): settings del USUARIO (logout, apariencia, push, equipo…).
  // La pestaña Config de abajo es 100% POR UNIDAD.
  $('#btn-cuenta').addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('activo'));
    const btnMas = $('#btn-mas'); if (btnMas) btnMas.remove();
    estado.tab = 'cuenta'; estado.unidadAbierta = null;
    mostrarCarga(true); render('');
    vistaCuenta().catch(e => render(`<div class="cuerpo-vista"><div class="error-caja">${esc(e.message)}</div></div>`)).finally(() => mostrarCarga(false));
  });
  $('#btn-refrescar').addEventListener('click', refrescarActual);
  // Los puntitos de salud abren el detalle (Cuenta → Salud del sistema).
  $('#salud-mini').addEventListener('click', () => $('#btn-cuenta').click());
  $('#chip-bot').addEventListener('click', async () => {
    if (!confirm('¿Encender la mensajería automática del bot para TODAS las unidades?')) return;
    const el = $('#chip-bot');
    el.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'setMsgGeneral', clave: 'mensajeria', valor: true });
      if (!r.ok) throw new Error(r.error || 'error');
      estado.yo.mensajeriaAuto = true;
      invalidarMe();
      pintarChipBot();
    } catch (e) { alert('No se pudo encender (' + e.message + ').'); }
    el.disabled = false;
  });
  engancharPullToRefresh();
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => irTab(b.dataset.tab)));
  if (estado.token) entrar(estado.token);
  else $('#login').classList.remove('oculto');
});
