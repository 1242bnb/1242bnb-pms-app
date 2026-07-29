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
  repVista: null,     // pestaña activa dentro de REPORTES — 'operativo' (default) | 'ingresos' | 'egresos' | 'limpieza'
  cache: {},
  stale: new Set(),   // claves que vienen de una sesión anterior (localStorage): se pintan ya y se revalidan por detrás
  // Claves ya traídas FRESCAS de la red en esta sesión. `estado.cache = {}` se usa como martillo en
  // ~20 sitios (cualquier escritura lo vacía), y sin esto el detalle de unidad se volvía a pedir tras
  // marcar una favorita o registrar una limpieza aunque no hubiera cambiado — el "se regenera a cada
  // rato" que reportó el dueño. Sobrevive al martillo; solo refrescarActual (↻ y pull-to-refresh) la vacía.
  revalidado: new Set(),
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
  // Gráficas de REPORTES (22/07/2026, clave sin sufijo desde la fusión del 28/07): reportepng:<slug>.
  // El slug (minúsculas, solo [a-z0-9]) debe calzar EXACTO con el que empuja sincronizarSnapshots en
  // api.js del CRM.
  if (params.action === 'reportepng') {
    const slug = String(params.unidad || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!slug) return null;
    return '/datos?' + new URLSearchParams({ token: estado.token, c: 'reportepng:' + slug });
  }
  // Detalle de la unidad (check-ins/check-outs): misma idea, clave unidad:<slug>. Iba SIEMPRE al Apps
  // Script en vivo (3.4-4.7 s medidos) y por eso "se regeneraba a cada rato" al cambiar de chip.
  if (params.action === 'unidad' || params.action === 'unidadeditar') {
    const slug = String(params.unidad || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const extrasU = Object.keys(params).filter(k => k !== 'action' && k !== 'unidad');
    if (!slug || extrasU.length) return null;
    return '/datos?' + new URLSearchParams({ token: estado.token, c: params.action + ':' + slug });
  }
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
  let enMem = estado.cache[key];
  const esViejo = estado.stale.has(key);
  if (usarCache && enMem && !esViejo) return enMem;   // fresco en esta sesión → directo
  // Ya se trajo fresca en esta sesión pero el martillo `estado.cache = {}` la borró: se rescata de
  // localStorage y se sirve SIN volver a pedirla. Lo que de verdad cambió lo invalida quien escribe
  // (invalidarClave) y el usuario siempre puede forzar con ↻ / pull-to-refresh.
  if (usarCache && !enMem && estado.revalidado.has(key)) {
    const guardado = leerLS(key);
    if (guardado) { estado.cache[key] = guardado; return guardado; }
  }

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
      .then(j => { if (j && !j.error) { estado.cache[key] = j; estado.stale.delete(key); estado.revalidado.add(key); guardarLS(key, j); } return j; })
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
          estado.cache[key] = foto; estado.stale.delete(key); estado.revalidado.add(key); guardarLS(key, foto);
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
// Lee UNA respuesta guardada, sin tocar la memoria. La usa api() para rescatar del disco lo que el
// martillo `estado.cache = {}` borró pero ya se había revalidado en esta sesión.
function leerLS(key) {
  try {
    const store = JSON.parse(localStorage.getItem('pms_datos_' + estado.token) || '{}');
    return store[key] || null;
  } catch (e) { return null; }
}
// Borra una respuesta cacheada de las TRES capas (memoria, marca de stale y localStorage) tras
// cambiar algo que vive en ella. `estado.cache = {}` NO alcanza: solo limpia la memoria, así que al
// reabrir la app `cargarDatosLS()` vuelve a pintar el estado anterior por un instante.
function invalidarClave(params) {
  const k = JSON.stringify(params);
  delete estado.cache[k]; estado.stale.delete(k); estado.revalidado.delete(k);
  try {
    const lk = 'pms_datos_' + estado.token, s = JSON.parse(localStorage.getItem(lk) || '{}');
    delete s[k]; localStorage.setItem(lk, JSON.stringify(s));
  } catch (e) { /* ignore */ }
}
function invalidarMe() { invalidarClave({ action: 'me' }); }
/* Parte G (29/07/2026) — recarga `me` EN VIVO (bypass de caché y del carril rápido) tras un cambio que
 * puede mover el gate de HOY (`unidadesSinLimpieza`). No navega a ningún lado: el usuario vuelve a
 * tocar la pestaña y, con la lista ya vacía, irTab lo deja pasar. */
async function refrescarMe() {
  invalidarMe();
  try {
    const me = await api({ action: 'me' }, false);
    if (me && !me.error) estado.yo = me;
  } catch (e) { /* si falla, se reintenta solo al re-entrar a la app */ }
}
// T15 — el directorio del equipo cambió (alta, edición o baja de una persona).
function invalidarEquipo() { invalidarClave({ action: 'equipo' }); invalidarClave({ action: 'equipoporunidad' }); }
// Parte L (29/07/2026) — un grupo de reparto de gastos cambió (alta, edición o borrado).
function invalidarGruposGastos() { invalidarClave({ action: 'gruposgastos' }); }

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
  // INVALIDACIÓN ACOTADA (24/07/2026 — arreglo del lag, medido): antes CUALQUIER escritura borraba TODOS
  // los snapshots de D1 y apagaba el carril 10 min. Como subir una foto es la escritura MÁS frecuente del
  // trabajo real y las fotos/inventario van EN VIVO (no a D1), cada foto dejaba HOY en el Apps Script en
  // vivo (medido: tareasbot en frío 36-51s) hasta el próximo sync. Ahora solo se invalida cuando la
  // escritura de verdad cambia datos del carril rápido (HOY/unidades). Las que NO lo tocan —fotos,
  // contrato, obs, config de push— dejan el carril intacto, así el equipo sigue rápido mientras
  // trabaja. (La foto igual se ve al instante: el repositorio va en vivo con auto-cura del SW.)
  const NO_TOCA_CARRIL = ['invSubirFoto', 'invLeerFactura', 'invSubirGasto', 'invSubirContrato',
    'invEnviarPdf', 'configPush', 'notiTest', 'enviarIngresosProp', 'enviarEgresosProp', 'enviarOperativoProp',
    'ingresosPdfUrl'];
  if (NO_TOCA_CARRIL.indexOf(payload.apiAction) === -1) {
    estado.sinCerebro = Date.now() + 10 * 60 * 1000;
    fetch('/datos?' + new URLSearchParams({ token: estado.token }), { method: 'DELETE' }).catch(() => {});
  }
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
  EQUIPO: 'Respuesta del equipo', AVISO_HUESPED: 'Aviso enviado a huéspedes',
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
    // Parte H: + las respuestas de huésped sin contestar ("Conversaciones recientes", al tope de HOY).
    // Se cuentan con la MISMA función pura que pinta la sección, así el número nunca miente. Cero
    // llamadas nuevas: `tareasbot` ya trae los hilos.
    const n = (j.sinWhatsapp || []).length +
      (j.pendientes || []).filter(p => p.dia && String(p.estado).indexOf('bloqueado') === 0).length +
      respuestasHuespedPendientes(j.hilos, estado.hechasLocal).length;
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
// foto (abajo-izq, con degradado para legibilidad). Sobre el monograma el nombre ya se ve, así que ahí
// no se duplica.
function avatarUnidadNom(unidad, foto) {
  return foto
    ? `<div class="uni-foto-wrap">
         <img class="foto-unidad" src="${esc(foto)}" alt="${esc(unidad)}" loading="lazy">
         <span class="uni-foto-shade"></span><span class="uni-foto-nom">${esc(unidad)}</span>
       </div>`
    : `<div class="uni-foto-wrap">${monograma(unidad)}</div>`;
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
// Parte J (29/07/2026): iniciales para el avatar de #btn-cuenta — 1 palabra → su primera letra
// ("Fabián" → "F"); 2+ palabras → primera letra de las dos primeras ("Andrés Vimos" → "AV").
function iniciales(nombre) {
  const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '';
  if (partes.length === 1) return partes[0][0].toUpperCase();
  return (partes[0][0] + partes[1][0]).toUpperCase();
}

async function irTab(tab) {
  estado.tab = tab;
  estado.unidadAbierta = null;
  // Parte H (29/07/2026): el foco de MENSAJES muere al SALIR de la pestaña, no al consumirse. Antes
  // vistaMensajes lo ponía en null apenas lo leía, así que el primer repintado silencioso (SWR) volvía
  // a colapsar el hilo que el usuario acababa de abrir desde HOY.
  if (tab !== 'mensajes') estado.mensajesFoco = null;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('activo', b.dataset.tab === tab));
  if (!estado.silencioso) { mostrarCarga(true); render(''); }   // en repintado silencioso NO se pone en blanco
  try {
    if (tab === 'unidades') await vistaUnidades();
    else if (tab === 'tareas') {
      // Parte G — REGLA DE ORO del dueño (28/07/2026): admin y CoHost no ven HOY mientras alguna de sus
      // unidades no tenga responsable de limpieza. El rol `limpieza` NUNCA se bloquea, y si el backend
      // no manda el campo (versión vieja de la API) la lista es vacía y no bloquea a nadie.
      const pendGate = (estado.yo && estado.yo.rol !== 'limpieza' && Array.isArray(estado.yo.unidadesSinLimpieza))
        ? estado.yo.unidadesSinLimpieza : [];
      if (pendGate.length) vistaGateHoy(pendGate);
      else await vistaTareas();
    }
    else if (tab === 'reportes') await vistaReportes();
    else if (tab === 'mensajes') await vistaMensajes();
    else if (tab === 'mas') await vistaFotoRapida();   // Parte J: "+" central, TODOS los roles
    else if (tab === 'agenda') await vistaAgendaLimpieza();   // C4: solo limpieza (swap del slot Unidades)
    else await vistaCuenta();
  } catch (e) {
    render(`<div class="cuerpo-vista"><div class="error-caja">No se pudo cargar. Revisa tu conexión e intenta de nuevo.<br><small>${esc(e.message)}</small></div></div>`);
  }
  mostrarCarga(false);
}

/* Parte H (29/07/2026) — LA ÚNICA PUERTA a la conversación de un huésped. Regla del dueño: "EL NOMBRE
 * SIEMPRE ABRE MENSAJES… ES UN SISTEMA LINKEADO, UNIFICADO". Todo lo que muestre el nombre de un
 * huésped (tarjetas de HOY, novedades, conversaciones recientes) navega por acá.
 * Sin `codigo` resoluble NO es un error: vistaMensajes deja el nombre precargado en el buscador, que
 * es el resultado correcto para un huésped sin WhatsApp (no tiene hilo que abrir). */
function irMensajesDe(codigo, nombre) {
  const cod = String(codigo || '').trim().toUpperCase();
  estado.mensajesFoco = { codigo: cod || null, nombre: String(nombre || '').trim() };
  irTab('mensajes');
}

/* Normalizador de nombres compartido (sin acentos, minúsculas): lo usan el buscador de MENSAJES y el
 * desempate por nombre de hiloDeEvento. Vivía suelto dentro de vistaMensajes. */
function normNombre(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/* Refresco de la vista actual: limpia el caché del cliente y re-renderiza la pestaña donde estés.
 * Lo usan el botón ⟳ y el gesto de arrastrar hacia abajo. */
function refrescarActual() {
  estado.cache = {};
  estado.revalidado.clear();   // el ↻ / pull-to-refresh SÍ vuelve a pedir todo: es el forzado manual
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
 * REPORTES — chips de unidad arriba, y debajo TODO lo de la unidad elegida: su
 * estado de hoy y cuatro accesos (Contrato · Gastos · Descripción · Editar unidad). Las sub-pestañas
 * del detalle (Estado/Tareas/Reportes/Config) se retiraron: la configuración vive en la pestaña ⚙ y
 * el checklist que se MARCA vive en su propia pantalla, a la que se entra desde HOY. */
async function vistaUnidades() {
  setTitulo('Unidades');
  const j = await api({ action: 'unidades' });
  if (j.error) throw new Error(j.error);
  const esLimpieza = estado.yo.rol === 'limpieza';
  const esAdminU = estado.yo.rol === 'ceo_admin' || estado.yo.rol === 'admin';
  let us = [...(j.unidades || [])];
  const nOcup = us.filter(u => u.estado === 'ocupada' || u.estado === 'checkout_manana').length;
  const nLibre = us.filter(u => u.estado === 'libre').length;
  const nHoy = us.filter(u => u.estado === 'llegada_hoy' || u.estado === 'checkout_hoy' || u.saleHoy || u.llegaHoy).length;

  // El selector "ordenar por" se retiró de UNIDADES (22/07/2026, pedido del dueño): las unidades van
  // siempre alfabéticas, que es como el equipo las nombra y busca. (REPORTES conserva el suyo, donde
  // ordenar por ingresos sí cambia la lectura.)
  us.sort((a, b) => a.unidad.localeCompare(b.unidad));
  const lista = us.map(u => u.unidad);
  if (!estado.uniSel || lista.indexOf(estado.uniSel) === -1) estado.uniSel = lista[0] || '';
  const U = estado.uniSel;
  const u = us.find(x => x.unidad === U) || {};

  const chips = us.map(x => `<button class="chipu ${x.unidad === U ? 'sel' : ''}" data-uni="${esc(x.unidad)}">${esc(x.unidad)}</button>`).join('')
    // Parte J (29/07/2026): "Agregar unidad" perdió su hogar en el botón flotante (retirado, el "+"
    // central de la tabbar ahora es SIEMPRE el atajo a fotos) — vuelve como último chip de esta misma
    // fila, visible solo para admin.
    + (esAdminU ? `<button class="chipu" id="u-agregar-unidad" title="Agregar unidad">+ Agregar</button>` : '');

  // Instant: las MÉTRICAS salen de la LISTA (u.perf), ya cargada. El detalle `unidad` (calendario/ficha/
  // proximas) NO bloquea el primer paint: se usa el que haya en memoria y, si el fresco difiere, se
  // re-pinta por detrás (abajo). Así las gráficas aparecen al toque aunque el detalle tarde ~4 s.
  const dKey = JSON.stringify({ action: 'unidad', unidad: U });
  const d = U ? (estado.cache[dKey] || null) : null;
  const ficha = (d && d.ficha) || {};
  const fichaFilas = Object.keys(ficha)
    .filter(k => k !== 'unidad' && String(ficha[k]).trim() && !/_en$/.test(k))
    .map(k => `<div class="lista-item"><span class="quien">${esc(k.replace(/_/g, ' '))}</span><span style="text-align:right">${esc(ficha[k])}</span></div>`).join('');

  // 28/07/2026 (pedido del dueño) — TODO lo de configuración/automatización de la unidad vive INLINE
  // acá, sin botón intermedio (antes era la pantalla aparte vistaEditarUnidad + su botón EDITAR
  // UNIDAD, C5+C8). Mismo gate de siempre: solo esAdminU. `uInfo` reusa `u` (misma acción `unidades`
  // que ya se pidió arriba — cero llamada nueva) en vez de un `ju` aparte.
  const edKey = JSON.stringify({ action: 'unidadeditar', unidad: U });
  const ed = (U && esAdminU) ? (estado.cache[edKey] || null) : null;
  if (['auto', 'datos', 'limpieza'].indexOf(estado.cfgTab) === -1) estado.cfgTab = 'datos';
  const cfgTab = estado.cfgTab;
  let cfgHtml = '';
  if (U && esAdminU) {
    if (!ed) {
      cfgHtml = tituloSeccion('Datos y configuración', 'Identidad, claves y automatización del bot') +
        `<div class="tarjeta"><div class="vacio">Cargando…</div></div>`;
    } else {
      const uInfo = u;
      const campo = (id, label, val, ph = '', tipo = 'text') =>
        `<label class="campo-label">${label}</label><input class="campo" id="${id}" ${tipo === 'number' ? 'type="number" min="1" max="16"' : 'autocomplete="off"'} value="${esc(val || '')}" placeholder="${esc(ph)}">`;
      const area = (id, label, val, ph = '') =>
        `<label class="campo-label">${label}</label><textarea class="campo" id="${id}" rows="2" placeholder="${esc(ph)}">${esc(val || '')}</textarea>`;

      // Fila de una ETAPA de mensajería con su tri-estado: ON/OFF efectivo + de dónde sale (propio de
      // la unidad o heredado del global) + "usar global" para volver a heredar.
      const sw = ed.msgSwitches || {};
      const filaEtapa = (et, lbl, det) => {
        const s = sw[et] || { propio: null, global: false };
        const efectivo = s.propio ? s.propio === 'SI' : !!s.global;
        const origen = s.propio ? '<b>propio de ' + esc(U) + '</b>' : 'heredado del global (' + (s.global ? 'ON' : 'OFF') + ')';
        return `<div class="switch-fila">
          <span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">${lbl}</span><br>
            <span class="sub">${det} · ${origen}${s.propio ? ` · <a href="#" class="enlace-wa" data-msg-heredar="${et}">usar global</a>` : ''}</span></span>
          <label class="toggle"><input type="checkbox" data-msg-et="${et}" ${efectivo ? 'checked' : ''}><span class="track"></span></label>
        </div>`;
      };
      const filaSwitch = (lbl, det, tipo, on) => `<div class="switch-fila">
        <span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">${lbl}</span><br><span class="sub">${det}</span></span>
        <label class="toggle"><input type="checkbox" data-cfg-sw="${tipo}" ${on ? 'checked' : ''}><span class="track"></span></label>
      </div>`;

      // T15c — editor de la LIMPIEZA PROFUNDA: el admin agrega tareas propias de la unidad, p. ej. el
      // jacuzzi de 7A. Guardar vacío = vuelve a los 10 ítems por defecto.
      const itemsProfCfg = d.checklistProfunda || [];
      const checklistProfHtml = `
        <div id="cfg-chkp-lista">${itemsProfCfg.map((it, i) => `
          <div class="lista-item" data-chkp-fila="${i}"><span style="flex:1" data-chkp-txt>${esc(it)}</span>
            <button class="btn secundario btn-mini" data-chkp-quitar="${i}" style="width:auto;padding:6px 10px">✕</button></div>`).join('')}</div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <input class="campo" id="cfg-chkp-nuevo" maxlength="80" placeholder="Ej. Limpieza del jacuzzi" style="flex:1;margin-bottom:0">
          <button class="btn secundario btn-mini" id="cfg-chkp-add" style="width:auto;padding:9px 14px">＋</button>
        </div>
        <button class="btn btn-mini" id="cfg-chkp-guardar" style="margin-top:8px">Guardar limpieza profunda</button>
        <div id="cfg-chkp-msg" class="sub oculto" style="margin-top:6px"></div>`;

      // Recordatorio personalizado para el equipo (viaja dentro del WhatsApp de limpieza de las 6 AM).
      const rec = d.recordatorio || {};
      const MODOS_REC = [['TODAS', 'Cada limpieza'], ['PROFUNDA', 'Solo profunda'], ['PROXIMA', 'Solo la próxima'], ['OFF', 'Apagado']];
      const recordatorioHtml = `
        <textarea class="campo" id="cfg-rec-texto" rows="2" maxlength="150" placeholder="Ej. Revisar el filtro del aire y avisar cómo está" style="margin-bottom:8px">${esc(rec.texto || '')}</textarea>
        <div class="chips" id="cfg-rec-chips" style="justify-content:center">
          ${MODOS_REC.map(o => `<button class="chip ${(rec.cuando || 'OFF') === o[0] ? 'activo' : ''}" data-rec-cuando="${o[0]}">${o[1]}</button>`).join('')}
        </div>
        <button class="btn secundario btn-mini" id="cfg-rec-guardar" style="margin-top:8px">Guardar recordatorio</button>
        <div id="cfg-rec-msg" class="sub oculto" style="margin-top:6px"></div>`;

      // Limpieza operativa: aviso al huésped + responsable + frecuencia profunda.
      const equipoL = (d.equipoLimpieza || []).map(p => (typeof p === 'string' ? p : (p && p.nombre) || '')).filter(Boolean);
      const respOpts = ['FORANEO'].concat(equipoL).filter((v, i, a) => a.indexOf(v) === i);
      const limpiezaAdminHtml = `
        <div class="switch-fila">
          <span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">Avisar al huésped "unidad lista"</span><br>
            <span class="sub">Al completar la limpieza, WhatsApp al huésped que llega HOY. El aviso al admin va siempre.</span></span>
          <label class="toggle"><input type="checkbox" id="cfg-aviso-h" ${d.avisoHuesped ? 'checked' : ''}><span class="track"></span></label>
        </div>
        <div class="lista-item"><span class="quien">Responsable de limpieza</span>
          <select class="campo" id="cfg-resp" style="width:auto;margin:0">${respOpts.map(n => `<option ${String(d.responsable || 'FORANEO') === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
        <div class="lista-item"><span class="quien">Limpieza profunda cada</span>
          <span><input class="campo" id="cfg-profcada" inputmode="numeric" value="${d.profundaCada || ''}" placeholder="${d.profundaCadaGeneral || 30}" style="width:70px;margin:0;text-align:center"> días</span></div>
        <div class="sub">Vacío = usar la frecuencia general (${d.profundaCadaGeneral || 30} días).</div>
        <button class="btn btn-mini" id="cfg-limp-guardar" style="margin-top:8px">Guardar limpieza</button>
        <div id="cfg-limp-msg" class="sub oculto" style="margin-top:6px"></div>`;

      const masterOff = ed.mensajeriaAuto === false
        ? `<div class="tarjeta"><div class="sub">⚠️ La <b>mensajería automática GLOBAL</b> está APAGADA (se prende en 👤 Mis datos): ningún mensaje sale a huéspedes aunque estos switches estén ON.</div></div>` : '';

      cfgHtml = `
        ${tituloSeccion('Datos y configuración', 'Identidad, claves y automatización del bot')}
        <div class="chips subtabs" style="margin:2px 0 6px">
          <button class="chip ${cfgTab === 'datos' ? 'activo' : ''}" data-cfgtab="datos">Datos</button>
          <button class="chip ${cfgTab === 'auto' ? 'activo' : ''}" data-cfgtab="auto">Automatización</button>
          <button class="chip ${cfgTab === 'limpieza' ? 'activo' : ''}" data-cfgtab="limpieza">Limpieza</button>
          <button class="chip" id="u-contrato">Contrato</button>
        </div>
        <input type="file" id="u-file-contrato" accept="image/*,application/pdf" class="oculto">
        <div id="u-contrato-msg" class="sub oculto" style="margin:8px 4px 0"></div>
        <div id="cfg-grupo-datos" class="${cfgTab === 'datos' ? '' : 'oculto'}">
        <div class="tarjeta">
          ${tituloSeccion('Nombre')}
          <div class="sub" style="margin-bottom:8px">Cambiar el nombre corto la renombra en todo el CRM (hoja, switches, asignaciones).</div>
          ${campo('ed-nombre', 'Nombre corto de la unidad', ed.unidad)}
        </div>
        <div class="tarjeta">
          ${tituloSeccion('Identidad')}
          ${campo('ed-cap', 'Capacidad de huéspedes', ed.capacidad, 'Ej. 8', 'number')}
          ${campo('ed-direccion', 'Dirección', ed.direccion, 'Sector, calle, referencia')}
          ${campo('ed-wifi_red', 'WiFi — red', ed.wifi_red)}
          ${campo('ed-wifi_clave', 'WiFi — clave', ed.wifi_clave)}
          ${area('ed-checkin_info', 'Info de check-in', ed.checkin_info)}
          ${area('ed-checkout_info', 'Info de check-out', ed.checkout_info)}
          ${area('ed-notas', 'Notas', ed.notas)}
        </div>
        <div class="tarjeta">
          ${tituloSeccion('Claves de acceso', 'Sin esto el bot no puede mandar el código al huésped')}
          ${campo('ed-clave-unidad', 'Clave de la puerta de la unidad', ed.claveUnidad, 'Ej. 4212')}
          ${area('ed-claves-texto', 'Texto completo de claves (opcional)', ed.clavesTexto, 'Vacío = se arma solo con lo de arriba + las claves del edificio')}
        </div>
        <button class="btn" id="ed-guardar">Guardar cambios</button>
        <div id="ed-msg" class="sub oculto" style="text-align:center;margin-top:8px"></div>
        ${tituloSeccion('Reportes y propietario', 'El dueño real del inmueble y la copia al admin')}
        <div class="tarjeta">
          <label class="campo-label" for="cfg-prop-nombre">Nombre del propietario</label>
          <input class="campo" id="cfg-prop-nombre" maxlength="60" value="${esc(ed.propietario || '')}" placeholder="Ej. María Torres">
          <label class="campo-label" for="cfg-prop-wa">WhatsApp del propietario (con código de país)</label>
          <input class="campo" id="cfg-prop-wa" inputmode="numeric" maxlength="15" value="${esc(ed.propietario_wa || '')}" placeholder="Ej. 593998877665">
          <div class="switch-fila"><span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">Reporte mensual al propietario</span><br>
            <span class="sub">${ed.reportePropMaster ? 'Se envía el día 1 por WhatsApp' : 'El envío automático global está APAGADO — el botón manual de REPORTES sí funciona'}</span></span>
            <label class="toggle"><input type="checkbox" id="cfg-prop-sw" ${ed.reporteProp ? 'checked' : ''}><span class="track"></span></label></div>
          <div class="switch-fila"><span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">Copia de mensajes al admin</span><br>
            <span class="sub">Resumen al admin de cada mensaje automático de esta unidad</span></span>
            <label class="toggle"><input type="checkbox" id="cfg-copia" ${ed.copiaAdmin ? 'checked' : ''}><span class="track"></span></label></div>
          <button class="btn btn-mini" id="cfg-prop-guardar" style="margin-top:8px">Guardar reportes</button>
          <div id="cfg-prop-msg" class="sub oculto" style="margin-top:6px"></div>
        </div>
        </div>
        <div id="cfg-grupo-auto" class="${cfgTab === 'auto' ? '' : 'oculto'}">
        ${tituloSeccion('Automatizaciones', 'Los switches maestros de ' + esc(U))}
        <div class="tarjeta">
          ${filaSwitch('Automatizaciones del bot', 'Maestro de la unidad: mensajería, agenda, avisos y reportes', 'bot', uInfo.botActivo)}
          <div class="switch-fila">
            <span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">En reportes</span><br>
              <span class="sub">${uInfo.enReportes ? 'Sí — recibe ingesta de correos' : 'No — sin ingesta de correos (solo iCal), no entra en los reportes de ingresos'} · automático, no editable</span></span>
          </div>
          ${ed.cohostActivo ? (() => {
            // Cableado CoHost: ON = Huésped→Bot→CoHost→Limpieza; OFF = Huésped→Bot→Limpieza.
            // 28/07/2026: sin CoHost asignado a la unidad el switch no ofrece nada real que prender —
            // se muestra un enlace a Cuenta → Equipo en vez del toggle (mismo patrón que "Agregar datos
            // del propietario", data-ir-prop-unidad). El backend igual rechaza el SI como red de seguridad.
            if (!ed.cohostAsignado) {
              return `<div class="switch-fila">
                <span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">CoHost en la cadena</span><br>
                  <span class="sub">Esta unidad no tiene CoHost asignado. Asígnalo en <a href="#" class="enlace-wa" data-ir-equipo-unidad>Cuenta → Equipo</a> para activarlo.</span></span>
              </div>`;
            }
            const s = ed.cohostActivo;
            const efectivo = s.propio ? s.propio === 'SI' : !!s.global;
            const origen = s.propio ? '<b>propio de ' + esc(U) + '</b>' : 'heredado del global (' + (s.global ? 'ON' : 'OFF') + ')';
            return `<div class="switch-fila">
              <span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">CoHost en la cadena</span><br>
                <span class="sub">ON: Huésped→Bot→CoHost→Limpieza · OFF: Huésped→Bot→Limpieza · ${origen}${s.propio ? ' · <a href="#" class="enlace-wa" data-cohost-heredar="1">usar global</a>' : ''}</span></span>
              <label class="toggle"><input type="checkbox" data-cohost-sw ${efectivo ? 'checked' : ''}><span class="track"></span></label>
            </div>`;
          })() : ''}
          <div id="cfg-sw-msg" class="sub oculto" style="margin-top:6px"></div>
        </div>
        ${masterOff}
        ${tituloSeccion('Mensajería automática', 'El ciclo del huésped en ' + esc(U) + ' — cada switch hereda del global o es propio')}
        <div class="tarjeta">
          ${filaEtapa('CODIGO_ACCESO', 'Claves de ingreso', 'Salen SOLAS al registrar la limpieza en HOY. El admin puede mandarlas a mano en emergencia — el texto se edita en Datos ↑')}
          ${filaEtapa('PRE_CHECKIN', '👋 Bienvenida pre check-in', 'Víspera 6 PM, con la dirección')}
          ${filaEtapa('CHECKIN_HORA', '🕐 Pregunta la hora de llegada', 'Día del check-in, 6 AM')}
          ${filaEtapa('EARLY_CHECKIN', '🏃 Check-in anticipado', 'Avisa "tu unidad ya está lista" + claves si no hay checkout/turnover el mismo día')}
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
        </div>
        </div>
        <div id="cfg-grupo-limpieza" class="${cfgTab === 'limpieza' ? '' : 'oculto'}">
        ${tituloSeccion('Asistente de limpiezas', 'Avisos, responsable y frecuencia de profunda')}
        <div class="tarjeta">${limpiezaAdminHtml}</div>
        ${tituloSeccion('Recordatorio para el equipo', 'Viaja DENTRO del WhatsApp de limpieza de las 6 AM')}
        <div class="tarjeta">${recordatorioHtml}</div>
        ${tituloSeccion('Checklist de limpieza', 'Fijo para todas las unidades — el equipo lo marca al registrar')}
        <div class="tarjeta">
          ${(d.checklist || []).map(it => `<div class="lista-item"><span style="flex:1">☐ ${esc(it)}</span></div>`).join('')
            || '<div class="vacio">No se pudo leer el checklist.</div>'}
          <div class="sub" style="margin-top:10px">Los tres son obligatorios para registrar la limpieza. El segundo se arma solo con la próxima reserva de esta unidad. Las tareas propias de ${esc(U)} van abajo, en Limpieza profunda.</div>
        </div>
        ${tituloSeccion('Limpieza profunda', 'Tareas extra de esta unidad — agregá las propias, como el jacuzzi de 7A')}
        <div class="tarjeta">${checklistProfHtml}</div>
        </div>`;
    }
  }

  // Parte G (29/07/2026) — PANEL ANGOSTO PARA COHOST. El bloque de arriba es solo de admins, así que
  // hasta hoy un CoHost no tenía NINGÚN camino de UI para asignar el responsable de limpieza — y con el
  // gate de HOY quedaría bloqueado sin poder resolverlo. Esto es lo MÍNIMO: el selector de responsable
  // y nada más. Usa solo datos de la acción `unidad` (que el CoHost ya puede pedir) y postea el payload
  // EXACTO {unidad, responsable}, que es lo único que _apiEditarUnidad_ le acepta (allowlist).
  const esCoHostU = estado.yo.rol === 'cohost';
  let cfgHtmlCoHost = '';
  if (U && esCoHostU && d) {
    const equipoCH = (d.equipoLimpieza || []).map(p => (typeof p === 'string' ? p : (p && p.nombre) || '')).filter(Boolean);
    const respOptsCH = ['FORANEO'].concat(equipoCH).filter((v, i, a) => a.indexOf(v) === i);
    cfgHtmlCoHost = `
      ${tituloSeccion('Limpieza de ' + esc(U), 'Quién es responsable de esta unidad')}
      <div class="tarjeta">
        <div class="lista-item"><span class="quien">Responsable de limpieza</span>
          <select class="campo" id="cfg-resp-ch" style="width:auto;margin:0">${respOptsCH.map(n => `<option ${String(d.responsable || 'FORANEO') === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
        <div class="sub">FORANEO = la limpia el propietario o alguien de fuera del equipo.</div>
        <button class="btn btn-mini" id="cfg-resp-ch-guardar" style="margin-top:8px">Guardar responsable</button>
        <div id="cfg-resp-ch-msg" class="sub oculto" style="margin-top:6px"></div>
      </div>`;
  }

  render(
    // T15 — la tira de 3 cuadros rojos (OCUPADAS/LIBRES/MOVIMIENTO HOY) se retiró: ocupaba un cuarto
    // de pantalla para tres números. Van en la MISMA línea del encabezado, con el mismo texto.
    hero(`${esLimpieza ? 'Hola ' + esc(estado.yo.nombre) + ' · tus unidades' : 'Tus unidades'} · ${fLarga(j.hoy)}` +
         ` · ${nOcup} ocupadas · ${nLibre} libres · ${nHoy} movimiento hoy`) +
    `<div class="cuerpo-vista">
      <div class="rep-barra">
        <div class="rep-chips">${chips}</div>
      </div>
      ${U ? `
      <div class="tarjeta">
        ${(u && u.perf) ? `
        <div class="fila-unidad fila-metricas">${avatarUnidadNom(U, (d && d.foto) || u.foto)}
          <div class="resto">${metricasUnidad(u.perf)}</div>
        </div>` : `
        <div class="fila-unidad">${avatarUnidad({ unidad: U, foto: (d && d.foto) || u.foto })}
          <div class="resto">
            <div class="tarjeta-fila"><h3>${esc(U)}</h3>
              <span style="display:flex;gap:6px;align-items:center">${pillUnidad(u)}</span>
            </div>
            <div class="sub">${subUnidad(u)}</div>
          </div>
        </div>`}
      </div>
      ${/* T15 — VER DESCRIPCIÓN se retiró (queda pendiente); su sección sigue en el DOM para poder
            devolverla con una línea (ver handler bdesc más abajo). 29/07: VER CONTRATO (antes acá,
            en .fila-oscura) bajó a la fila de chips Datos|Automatización|Limpieza dentro de cfgHtml. */''}
      ${esAdminU && d && d.contrato && d.contrato.url ? `<div class="sub" style="margin:8px 4px 0">Contrato del ${esc(d.contrato.fecha || '')} · <a class="enlace-wa" target="_blank" rel="noopener" href="${esc(d.contrato.url)}">Ver</a></div>` : ''}
      <div id="u-sec-descripcion" class="oculto">
        ${tituloSeccion('Descripción')}
        <div class="tarjeta">${(d && d.descripcion) ? esc(d.descripcion).replace(/\n/g, '<br>') : '<div class="vacio">Sin descripción aún — cárgala en Datos y configuración ↓.</div>'}
          ${fichaFilas ? `<div style="margin-top:10px">${fichaFilas}</div>` : ''}
        </div>
      </div>
      <button class="btn" id="u-fotos" style="margin-top:14px">AGREGAR FOTOS</button>
      ${cfgHtml}${cfgHtmlCoHost}
      ` : '<div class="vacio">No hay unidades visibles para tu usuario.</div>'}
      ${/* "Buscar disponibilidad" se APAGÓ de la app (21/07, decisión del dueño): se usa por la web o
            por el bot. El backend `disponibilidad` (público) sigue vivo; vistaDisponibilidad/
            buscarDisponibilidad quedan dormidas (restaurar = devolver la tarjeta con su handler). */''}
    </div>`);

  document.querySelectorAll('[data-uni]').forEach(c => c.addEventListener('click', () => { estado.uniSel = c.dataset.uni; vistaUnidades(); }));
  const selU = document.querySelector('.chipu.sel');
  if (selU) selU.scrollIntoView({ block: 'nearest', inline: 'center' });
  // Parte J: "+ Agregar" vive al final de la fila de chips (antes era el botón flotante retirado).
  const bAgregarU = $('#u-agregar-unidad');
  if (bAgregarU) bAgregarU.addEventListener('click', vistaAgregarUnidad);
  const bf = $('#u-fotos'); if (bf) bf.addEventListener('click', () => vistaInventario(U));
  // T15 — el botón VER DESCRIPCIÓN se retiró (queda pendiente). El handler se conserva, guardado por
  // el if: devolver el botón a `.fila-oscura` es la única línea que hace falta para reactivarlo.
  const bdesc = $('#u-descripcion');
  if (bdesc) bdesc.addEventListener('click', () => $('#u-sec-descripcion').classList.toggle('oculto'));
  // Contrato: chip dentro de Datos|Automatización|Limpieza (29/07, no cambia cfgTab ni revela panel
  // propio). Si hay uno cargado, lo abre; si no, avisa y abre el selector para subirlo (el mismo botón
  // sirve para ver y para cargar el primero).
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
  // Instant-load: dispara el detalle pesado en segundo plano; cuando llega (o cambia), re-pinta la vista
  // UNA vez (al re-entrar, el peek ya tiene el fresco cacheado → coincide → no vuelve a re-pintar).
  if (U) api({ action: 'unidad', unidad: U }).then(dd => {
    if (dd && !dd.error && JSON.stringify(dd) !== JSON.stringify(d)) vistaUnidades();
  }).catch(() => {});
  // Mismo patrón instant-load para `unidadeditar` (Datos y configuración) — solo admin.
  if (U && esAdminU) api({ action: 'unidadeditar', unidad: U }).then(dd => {
    if (dd && !dd.error && JSON.stringify(dd) !== JSON.stringify(ed)) vistaUnidades();
  }).catch(() => {});

  // Parte G — handler del panel angosto de CoHost. Va ANTES del `return` de abajo a propósito: para un
  // CoHost `ed` es SIEMPRE null (no pide `unidadeditar`), así que cualquier cosa cableada después de
  // esa línea nunca se engancharía. Payload EXACTO {unidad, responsable}: un campo de más y el backend
  // lo rechaza (allowlist de _apiEditarUnidad_).
  const respCHg = $('#cfg-resp-ch-guardar');
  if (respCHg) respCHg.addEventListener('click', async () => {
    respCHg.disabled = true;
    const m = $('#cfg-resp-ch-msg');
    const poner = (txt, ok) => { if (m) { m.textContent = txt; m.style.color = ok ? 'var(--good)' : 'var(--crit)'; m.classList.remove('oculto'); } };
    try {
      const r = await apiPost({ apiAction: 'editarUnidad', unidad: U, responsable: $('#cfg-resp-ch').value });
      if (!r.ok) throw new Error(r.error || 'error');
      estado.cache = {};
      invalidarClave({ action: 'unidad', unidad: U });
      await refrescarMe();   // puede destrabar el gate de HOY
      poner('✅ Responsable guardado.', true);
    } catch (e) { poner('No se pudo (' + e.message + ')', false); }
    respCHg.disabled = false;
  });

  if (!ed) return;   // sin datos de configuración cargados aún (o no-admin): nada que cablear abajo

  // Sub-pestañas Datos / Configuración: alternan sin re-pedir datos (los 2 grupos ya están en el DOM).
  document.querySelectorAll('[data-cfgtab]').forEach(b => b.addEventListener('click', () => {
    estado.cfgTab = b.dataset.cfgtab;
    document.querySelectorAll('[data-cfgtab]').forEach(x => x.classList.toggle('activo', x === b));
    $('#cfg-grupo-datos').classList.toggle('oculto', estado.cfgTab !== 'datos');
    $('#cfg-grupo-auto').classList.toggle('oculto', estado.cfgTab !== 'auto');
    $('#cfg-grupo-limpieza').classList.toggle('oculto', estado.cfgTab !== 'limpieza');
  }));

  const repintarCfg = () => { estado.cache = {}; vistaUnidades(); };
  const avisoCfg = (sel, txt, ok) => { const m = $(sel); if (m) { m.textContent = txt; m.style.color = ok ? 'var(--good)' : 'var(--crit)'; m.classList.remove('oculto'); } };

  // --- Datos base (nombre/identidad/claves) ---
  $('#ed-guardar').addEventListener('click', async () => {
    const b = $('#ed-guardar'), msg = $('#ed-msg');
    const payload = {
      apiAction: 'editarUnidad', unidad: U,
      nuevoNombre: $('#ed-nombre').value.trim(),
      capacidad: $('#ed-cap').value.trim(),
      direccion: $('#ed-direccion').value, wifi_red: $('#ed-wifi_red').value, wifi_clave: $('#ed-wifi_clave').value,
      checkin_info: $('#ed-checkin_info').value, checkout_info: $('#ed-checkout_info').value, notas: $('#ed-notas').value,
      claveUnidad: $('#ed-clave-unidad').value, clavesTexto: $('#ed-claves-texto').value,
    };
    b.disabled = true; b.textContent = 'Guardando…';
    try {
      const r = await apiPost(payload);
      if (!r.ok) throw new Error(r.error || 'error');
      estado.cache = {};
      invalidarClave({ action: 'unidadeditar', unidad: U });
      invalidarClave({ action: 'unidad', unidad: U });
      invalidarClave({ action: 'unidades' });
      if (r.renombrada && r.unidad) { invalidarClave({ action: 'unidadeditar', unidad: r.unidad }); invalidarClave({ action: 'unidad', unidad: r.unidad }); invalidarMe(); }
      msg.textContent = r.renombrada ? '✅ Guardado y renombrada a ' + r.unidad : '✅ Cambios guardados';
      msg.style.color = 'var(--good)'; msg.classList.remove('oculto');
      setTimeout(() => { estado.uniSel = r.unidad; irTab('unidades'); }, 1200);
    } catch (e) {
      msg.textContent = 'No se pudo guardar (' + e.message + ').'; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto');
      b.disabled = false; b.textContent = 'Guardar cambios';
    }
  });

  // --- Reportes y propietario ---
  $('#cfg-prop-guardar').addEventListener('click', async () => {
    const propG = $('#cfg-prop-guardar');
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
      avisoCfg('#cfg-prop-msg', '✅ Guardado.', true);
    } catch (e) { avisoCfg('#cfg-prop-msg', 'No se pudo (' + e.message + ')', false); }
    propG.disabled = false;
  });

  // --- BOT ACTIVO / EN REPORTES (optimista; si falla, revierte) ---
  document.querySelectorAll('[data-cfg-sw]').forEach(ch => ch.addEventListener('change', async () => {
    const valor = ch.checked;
    ch.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'setSwitch', unidad: U, tipo: ch.dataset.cfgSw, valor });
      if (!r.ok) throw new Error(r.error || 'error');
      estado.cache = {};
    } catch (e) { ch.checked = !valor; avisoCfg('#cfg-sw-msg', 'No se pudo (' + e.message + ')', false); }
    ch.disabled = false;
  }));

  // --- Etapas de mensajería: el toggle escribe SI/NO propio; "usar global" vuelve a heredar ---
  document.querySelectorAll('[data-msg-et]').forEach(ch => ch.addEventListener('change', async () => {
    const valor = ch.checked ? 'SI' : 'NO';
    ch.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'setMsgUnidad', unidad: U, etapa: ch.dataset.msgEt, valor });
      if (!r.ok) throw new Error(r.error || 'error');
      repintarCfg();
    } catch (e) { ch.checked = !ch.checked; ch.disabled = false; avisoCfg('#cfg-msg-msg', 'No se pudo (' + e.message + ')', false); }
  }));
  document.querySelectorAll('[data-msg-heredar]').forEach(a => a.addEventListener('click', async (ev) => {
    ev.preventDefault();
    try {
      const r = await apiPost({ apiAction: 'setMsgUnidad', unidad: U, etapa: a.dataset.msgHeredar, valor: 'HEREDAR' });
      if (!r.ok) throw new Error(r.error || 'error');
      repintarCfg();
    } catch (e) { avisoCfg('#cfg-msg-msg', 'No se pudo (' + e.message + ')', false); }
  }));

  // --- Cableado CoHost por unidad (toggle = SI/NO propio; "usar global" = HEREDAR) ---
  const swCoh = document.querySelector('[data-cohost-sw]');
  if (swCoh) swCoh.addEventListener('change', async () => {
    swCoh.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'editarUnidad', unidad: U, cohostActivo: swCoh.checked ? 'SI' : 'NO' });
      if (!r.ok) throw new Error(r.error || 'error');
      repintarCfg();
    } catch (e) { swCoh.checked = !swCoh.checked; swCoh.disabled = false; avisoCfg('#cfg-sw-msg', 'No se pudo (' + e.message + ')', false); }
  });
  document.querySelectorAll('[data-ir-equipo-unidad]').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault(); irTab('config');
  }));
  document.querySelectorAll('[data-cohost-heredar]').forEach(a => a.addEventListener('click', async (ev) => {
    ev.preventDefault();
    try {
      const r = await apiPost({ apiAction: 'editarUnidad', unidad: U, cohostActivo: 'HEREDAR' });
      if (!r.ok) throw new Error(r.error || 'error');
      repintarCfg();
    } catch (e) { avisoCfg('#cfg-sw-msg', 'No se pudo (' + e.message + ')', false); }
  }));

  // --- Aviso al huésped al completar limpieza + responsable + frecuencia ---
  const avisoH = $('#cfg-aviso-h');
  if (avisoH) avisoH.addEventListener('change', async () => {
    const valor = avisoH.checked;
    avisoH.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'editarUnidad', unidad: U, avisoHuesped: valor });
      if (!r.ok) throw new Error(r.error || 'error');
      estado.cache = {};
      avisoCfg('#cfg-limp-msg', valor ? '✅ El huésped recibirá "tu unidad está lista".' : '✅ Solo el admin recibirá el aviso.', true);
    } catch (e) { avisoH.checked = !valor; avisoCfg('#cfg-limp-msg', 'No se pudo (' + e.message + ')', false); }
    avisoH.disabled = false;
  });
  const limpG = $('#cfg-limp-guardar');
  if (limpG) limpG.addEventListener('click', async () => {
    limpG.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'editarUnidad', unidad: U, responsable: $('#cfg-resp').value, profundaCada: $('#cfg-profcada').value.trim() });
      if (!r.ok) throw new Error(r.error || 'error');
      estado.cache = {};
      await refrescarMe();   // Parte G: asignar responsable puede destrabar el gate de HOY
      avisoCfg('#cfg-limp-msg', '✅ Limpieza guardada.', true);
    } catch (e) { avisoCfg('#cfg-limp-msg', 'No se pudo (' + e.message + ')', false); }
    limpG.disabled = false;
  });

  // --- Recordatorio (setRecordatorio) ---
  let recCuando = (d.recordatorio || {}).cuando || 'OFF';
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
      avisoCfg('#cfg-rec-msg', '✅ Recordatorio guardado.', true);
    } catch (e) { avisoCfg('#cfg-rec-msg', 'No se pudo (' + e.message + ')', false); }
    recG.disabled = false;
  });

  // --- Limpieza profunda (setChecklistProfunda): guardar sin ítems vuelve a los 10 por defecto ---
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
        avisoCfg('#cfg-chkp-msg', items.length ? '✅ Limpieza profunda guardada (' + r.items.length + ' tareas).' : '✅ Vacío: vuelve a las 10 tareas por defecto.', true);
      } catch (e) { avisoCfg('#cfg-chkp-msg', 'No se pudo (' + e.message + ')', false); }
      chkpG.disabled = false;
    });
  }
}

/* ---------- Vista: FOTOS de la unidad (repositorio simple, sin categorías) ---------- */
/* (CAT_LABEL se retiró el 22/07/2026 con las categorías: las fotos ya no se clasifican.) */
function mesBonito(m) { return m && m.length === 7 ? MES[+m.slice(5) - 1][0].toUpperCase() + MES[+m.slice(5) - 1].slice(1) + ' ' + m.slice(0, 4) : m; }
function idDrive(url) { const m = String(url).match(/id=([\w-]+)/); return m ? m[1] : ''; }
function miniatura(url) { const id = idDrive(url); return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w400` : url; }
function fotoGrande(url) { const id = idDrive(url); return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w2000` : url; }

// Comprime una foto del celular a JPEG ~1280px (300KB aprox) y la devuelve como base64 puro.
// `sello` (22/07/2026): texto que se QUEMA en la esquina inferior izquierda — unidad · fecha y hora ·
// quién. Va acá porque la foto ya pasa por este canvas: cero costo extra y la marca viaja dentro del
// JPEG, así que sigue ahí aunque el archivo se baje de Drive o se reenvíe por WhatsApp.
async function comprimirImagen(file, maxLado = 1280, sello) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const factor = Math.min(1, maxLado / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * factor); c.height = Math.round(img.height * factor);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  if (sello) {
    // Tamaño relativo al ancho: legible igual en una foto de 800 px que en una de 1280.
    const fs = Math.max(13, Math.round(c.width * 0.028));
    ctx.font = `600 ${fs}px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`;
    ctx.textBaseline = 'alphabetic';
    const pad = Math.round(fs * 0.45), ancho = ctx.measureText(sello).width;
    const alto = fs + pad * 2, y = c.height - alto;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(0, y, Math.min(c.width, ancho + pad * 3), alto);
    ctx.fillStyle = '#fff';
    ctx.fillText(sello, pad * 1.5, c.height - pad * 1.2);
  }
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
  return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
}
// Texto del sello: "2A · 22/07/2026 15:40 · Nena". Se arma en el momento de subir, no al elegir la foto.
function selloFoto(unidad, obs) {
  const d = new Date(), dos = (n) => String(n).padStart(2, '0');
  const base = `${unidad} · ${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()} ${dos(d.getHours())}:${dos(d.getMinutes())}` +
    ((estado.yo && estado.yo.nombre) ? ` · ${estado.yo.nombre}` : '');
  const sit = String(obs || '').trim().replace(/\s+/g, ' ');
  return sit ? base + ' · ' + (sit.length > 42 ? sit.slice(0, 41) + '…' : sit) : base;
}

/* REPOSITORIO DE FOTOS de la unidad (22/07/2026 — reemplaza al inventario por categorías).
 * Regla del dueño: "ya no seleccionamos ninguna categoría, solo subir fotos, sin IA para procesar
 * nada; las facturas también se suben; hagamos simple para que funcione". Acá entra el día a día:
 * insumos que se acaban, daños, toallas sucias, facturas. Lo ven ADMIN y LIMPIEZA (el CoHost no:
 * lo bloquea _apiInvAcceso_ en el CRM). Al guardar, un solo WhatsApp por lote al admin.
 * Cada foto sale ESTAMPADA con unidad · fecha y hora · quién — la marca se quema en el JPEG, así
 * que sigue ahí aunque el archivo se baje de Drive o se reenvíe.
 * PARTE K (29/07/2026), tres cambios sobre lo anterior:
 *   1. La nota "¿Qué pasó?" es OBLIGATORIA y de MÁXIMO 3 PALABRAS (el servidor la revalida igual).
 *   2. Se puede REASIGNAR la unidad después de tomar la foto (antes quedaba fija a la de entrada).
 *   3. Toggle "¿Es una factura?" → el lote deja de ir por `invSubirFoto` y va por el flujo de gasto.
 * PARTE K v2 (29/07/2026) — CONFIRMAR ANTES DE ESCRIBIR. Antes, apenas Gemini leía el monto el gasto
 * se escribía DE UNA en el Sheet: si el OCR leía $180 donde decía $18 quedaba un gasto mal cargado sin
 * forma de arreglarlo desde la app. Ahora el ciclo es de DOS pasos, igual que el viejo flujo de WhatsApp
 * ("gasto si/no"):
 *   LEER (`invLeerFactura`, no escribe nada ni sube nada a Drive) → MOSTRAR el monto y el proveedor en
 *   campos EDITABLES + el resumen de cómo se reparte → el usuario CONFIRMA → recién ahí `invSubirGasto`
 *   sube la foto a Drive y escribe las filas. Si cancela, no queda NADA: ni fila ni archivo.
 * El reparto se PRE-LLENA con el grupo de gastos de la unidad (Parte L, acción `gruposgastos`) pero es
 * editable — el grupo es un default, nunca una regla — y la selección que el usuario confirme se GUARDA
 * como su preferencia (el servidor la escribe como grupo), así la próxima factura de esa unidad ya viene
 * armada. La pregunta de si el gasto es compartido va EXPLÍCITA en pantalla, no escondida en un toggle. */
async function vistaInventario(unidad) {
  setTitulo('Fotos ' + unidad);
  mostrarCarga(true); render('');
  try {
    const inv = await api({ action: 'inventario', unidad }, false);
    if (inv.error) throw new Error(inv.error);
    // `fotos` viene plano y ordenado (lo último primero) e incluye las fotos VIEJAS, que tenían
    // categoría: acá se muestran todas juntas, que es de lo que se trata el repositorio.
    const fotos = inv.fotos || [];
    const porMes = {};
    fotos.forEach(f => { const m = f.mes || String(f.fecha || '').slice(0, 7); (porMes[m] = porMes[m] || []).push(f); });
    const filaFoto = (f) => `
      <a class="lista-item tocable" href="${esc(fotoGrande(f.url))}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">
        <img class="miniatura" loading="lazy" src="${esc(miniatura(f.url))}" alt="" style="width:52px;height:52px;flex:none">
        <span style="flex:1;min-width:0">
          <span class="quien">${esc(f.obs || 'Foto')}</span><br>
          <span class="sub">${esc(f.fecha || '')}${f.quien ? ' · ' + esc(f.quien) : ''}</span>
        </span>
      </a>`;
    const historial = Object.keys(porMes).sort().reverse().map(m => `
      ${tituloSeccion(mesBonito(m), porMes[m].length + (porMes[m].length === 1 ? ' foto' : ' fotos'))}
      <div class="tarjeta">${porMes[m].map(filaFoto).join('')}</div>`).join('');

    // "Recién subidas" (arreglo de fotos, 24/07): tras subir, Drive tarda en generar la miniatura, así
    // que se muestran YA desde el base64 LOCAL que guardamos en memoria — el usuario ve su foto al
    // instante, sin depender de Drive. La galería de abajo (historial) las trae luego con la miniatura de
    // Drive (que el SW ya cura). Viven en `estado.fotosRecien` hasta recargar la app.
    const recientes = (estado.fotosRecien && estado.fotosRecien[unidad]) || [];
    const bloqueRecientes = recientes.length ? `
      ${tituloSeccion('Recién subidas', 'Guardadas ✓ — se ven al instante desde tu teléfono')}
      <div class="tarjeta">${recientes.map(f => `
        <div class="lista-item">
          <img class="miniatura" src="data:image/jpeg;base64,${f.b64}" alt="" style="width:52px;height:52px;flex:none">
          <span style="flex:1;min-width:0">
            <span class="quien">${esc(f.obs || 'Foto')}</span><br>
            <span class="sub">${esc(f.fecha || '')}${f.quien ? ' · ' + esc(f.quien) : ''} · ✓ guardada</span>
          </span>
        </div>`).join('')}</div>` : '';

    // Parte K — unidades entre las que se puede reasignar / repartir. Son las del usuario (el servidor
    // revalida CADA una con _apiInvAcceso_, así que esta lista es comodidad, nunca el control de acceso).
    const misUnidades = (estado.yo && Array.isArray(estado.yo.unidades) ? estado.yo.unidades.slice() : [])
      .map(u => String(u).toUpperCase());
    if (misUnidades.indexOf(String(unidad).toUpperCase()) === -1) misUnidades.unshift(String(unidad).toUpperCase());
    misUnidades.sort((a, b) => a.localeCompare(b));

    render(
      hero(`Fotos · ${esc(unidad)}`) +
      `<div class="cuerpo-vista" style="padding-bottom:90px">
        <button class="volver" id="btn-volver">‹ Unidad ${esc(unidad)}</button>
        ${tituloSeccion('Subir fotos por situación', 'Una situación a la vez · un daño, insumos con llave, una mancha, toallas… hasta 3 fotos y una nota de 3 palabras')}
        <div class="tarjeta">
          <button class="btn" id="btn-fotos">TOMAR / SUBIR FOTOS</button>
          <input type="file" id="file-fotos" accept="image/*" multiple capture="environment" class="oculto">
          <div id="prev-fotos" class="grilla-fotos" style="margin-top:10px"></div>
          <div id="prev-info" class="sub" style="margin-top:6px"></div>
          <label class="campo-label" style="margin-top:12px">¿Qué pasó? <b>(obligatorio · máximo 3 palabras)</b></label>
          <textarea class="campo" id="lote-obs" rows="2" maxlength="300" placeholder="Ej. falta papel higiénico"></textarea>
          <div id="obs-cuenta" class="sub" style="margin-top:-6px">0 de 3 palabras</div>
          <label class="campo-label" style="margin-top:12px">Unidad</label>
          <select class="campo" id="lote-unidad">${misUnidades.map(u => `<option ${u === String(unidad).toUpperCase() ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>
          <div class="switch-fila" style="margin-top:4px">
            <span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">¿Es una factura?</span><br>
              <span class="sub">Se lee el monto solo y se registra como gasto del mes</span></span>
            <label class="toggle"><input type="checkbox" id="lote-factura"><span class="track"></span></label>
          </div>
          <div id="bloque-reparto" class="oculto" style="margin-top:2px">
            <label class="campo-label">¿Este gasto es solo de esta unidad, o se comparte con otras?</label>
            <div class="sub" style="margin:-4px 0 6px">Toca las unidades que lo comparten. Si es solo de ${esc(String(unidad).toUpperCase())}, déjala sola.</div>
            <div class="chips" id="reparto-chips">${misUnidades.map(u => `<button type="button" class="chipu" data-rep-u="${esc(u)}">${esc(u)}</button>`).join('')}</div>
            <div id="reparto-info" class="sub" style="margin-top:2px"></div>
          </div>
          <button class="btn" id="btn-guardar-lote">GUARDAR</button>
          <div id="inv-msg" class="sub oculto" style="text-align:center;margin-top:8px"></div>
          <div class="sub" style="margin-top:10px">Cada foto se guarda con la unidad, la fecha, tu nombre y la situación marcados encima.</div>
        </div>
        <div id="bloque-confirmar" class="oculto">
          ${tituloSeccion('Revisa el gasto antes de guardarlo', 'Lo leyó la IA de la foto · corrige lo que esté mal — nada se guarda hasta que confirmes')}
          <div class="tarjeta">
            <div id="conf-lectura" class="sub" style="margin-bottom:10px"></div>
            <label class="campo-label">Monto total de la factura (USD)</label>
            <input class="campo" id="conf-monto" inputmode="decimal" autocomplete="off" placeholder="Ej. 18.50">
            <label class="campo-label">Proveedor</label>
            <input class="campo" id="conf-proveedor" autocomplete="off" maxlength="120" placeholder="Nombre del comercio">
            <div id="conf-reparto" class="sub" style="margin-top:10px"></div>
            <button class="btn" id="conf-guardar" style="margin-top:12px">CONFIRMAR Y GUARDAR</button>
            <button class="btn secundario" id="conf-cancelar" style="margin-top:8px">CANCELAR</button>
            <div id="conf-msg" class="sub oculto" style="text-align:center;margin-top:8px"></div>
          </div>
        </div>
        ${bloqueRecientes}
        ${historial || '<div class="vacio" style="margin-top:16px">Todavía no hay fotos de esta unidad. 📷</div>'}
      </div>`);

    const aviso = (txt, esError) => { const el = $('#inv-msg'); el.textContent = txt; el.style.color = esError ? 'var(--crit)' : 'var(--good)'; el.classList.remove('oculto'); };
    $('#btn-volver').addEventListener('click', () => { estado.uniSel = unidad; irTab('unidades'); });

    let fotosPend = [];
    const esFactura = () => $('#lote-factura').checked;
    const unidadDestino = () => String($('#lote-unidad').value || unidad).toUpperCase();
    const palabras = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);
    const topeFotos = () => esFactura() ? 1 : 3;

    const pintarPrev = () => {
      $('#prev-fotos').innerHTML = fotosPend.map(f => `<img class="miniatura" src="${URL.createObjectURL(f)}" alt="">`).join('');
      $('#prev-info').textContent = fotosPend.length ? `${fotosPend.length} foto(s) lista(s) para guardar` : '';
    };
    // La nota manda: sin ella (o con más de 3 palabras) el botón GUARDAR queda deshabilitado. Es la regla
    // de Parte K y el servidor la revalida — esto solo evita el viaje perdido.
    const validarObs = () => {
      const n = palabras($('#lote-obs').value).length;
      const okObs = n >= 1 && n <= 3;
      const c = $('#obs-cuenta');
      c.textContent = n > 3 ? `${n} palabras — el máximo es 3` : `${n} de 3 palabras`;
      c.style.color = (n > 3) ? 'var(--crit)' : '';
      $('#btn-guardar-lote').disabled = !okObs;
      return okObs;
    };
    $('#lote-obs').addEventListener('input', validarObs);
    validarObs();

    $('#btn-fotos').addEventListener('click', () => $('#file-fotos').click());
    $('#file-fotos').addEventListener('change', (ev) => {
      cerrarConfirmacion();   // otra foto = otra factura: lo leído antes ya no aplica
      fotosPend = fotosPend.concat([...ev.target.files]).slice(0, topeFotos());
      if (esFactura()) aviso('Una foto por factura · si son varias, súbelas como facturas aparte.', false);
      else if (fotosPend.length >= 3) aviso('Máximo 3 fotos por situación · guarda estas y sube otra situación aparte.', false);
      pintarPrev();
    });

    /* ---- Parte K: reparto del gasto entre unidades ----
     * La unidad DESTINO siempre entra en el reparto (es donde queda el archivo en Drive y la primera fila
     * que escribe el servidor); las demás se marcan/desmarcan libremente. El grupo de la Parte L solo
     * PRE-LLENA la selección la primera vez que se abre el bloque o cuando cambia la unidad destino. */
    let gruposCache = null;   // null = todavía no pedido; [] = pedido y sin grupos (o sin permiso)
    const chipRep = (u) => $(`[data-rep-u="${u}"]`);
    const repSeleccionadas = () => [...document.querySelectorAll('#reparto-chips .chipu.sel')].map(el => el.dataset.repU);
    const pintarReparto = () => {
      const n = repSeleccionadas().length;
      $('#reparto-info').textContent = n > 1
        ? `El monto se divide en partes iguales entre ${n} unidades.`
        : 'El monto completo va a esta unidad.';
    };
    const prellenarReparto = async () => {
      const U = unidadDestino();
      if (gruposCache === null) {
        // `gruposgastos` es solo-admin en el CRM: para el rol limpieza devuelve error y el prellenado
        // simplemente queda en "solo esta unidad" (no es un fallo, es que no hay grupos que ver).
        const g = await api({ action: 'gruposgastos' }, false).catch(() => null);
        gruposCache = (g && !g.error && Array.isArray(g.grupos)) ? g.grupos : [];
      }
      const grupo = gruposCache.filter(g => (g.unidades || []).indexOf(U) !== -1)[0];
      const marcadas = grupo ? grupo.unidades.filter(u => misUnidades.indexOf(u) !== -1) : [U];
      document.querySelectorAll('#reparto-chips .chipu').forEach(el => el.classList.toggle('sel', marcadas.indexOf(el.dataset.repU) !== -1));
      if (chipRep(U)) chipRep(U).classList.add('sel');   // el destino nunca queda fuera
      pintarReparto();
    };
    document.querySelectorAll('#reparto-chips .chipu').forEach(el => el.addEventListener('click', () => {
      if (el.dataset.repU === unidadDestino()) { aviso('La unidad de la foto siempre entra en el reparto — cámbiala arriba si es otra.', false); return; }
      el.classList.toggle('sel');
      pintarReparto();
      // Si la tarjeta de confirmación ya está abierta, el reparto se actualiza en vivo (no hace falta
      // volver a leer la factura: la lectura de la IA no depende de entre cuántas unidades se divida).
      if (facturaPend) {
        const us = repSeleccionadas();
        if (us.indexOf(facturaPend.unidad) === -1) us.unshift(facturaPend.unidad);
        facturaPend.unidades = us;
        pintarConfReparto();
      }
    }));
    $('#lote-factura').addEventListener('change', async () => {
      $('#bloque-reparto').classList.toggle('oculto', !esFactura());
      cerrarConfirmacion();
      $('#btn-guardar-lote').textContent = esFactura() ? 'LEER FACTURA' : 'GUARDAR';
      if (esFactura()) {
        if (fotosPend.length > 1) { fotosPend = fotosPend.slice(0, 1); pintarPrev(); aviso('Una foto por factura · se guarda la primera.', false); }
        await prellenarReparto();
      }
    });
    $('#lote-unidad').addEventListener('change', async () => { if (esFactura()) { cerrarConfirmacion(); await prellenarReparto(); } });

    /* ---- Parte K v2: paso de CONFIRMACIÓN del gasto ----
     * `facturaPend` guarda, SOLO EN MEMORIA, la foto ya comprimida + el reparto elegido entre el paso
     * LEER y el paso CONFIRMAR. Si el usuario cancela (o cambia de pantalla) se pierde y no queda nada:
     * la foto todavía no se subió a Drive y no se escribió ninguna fila. Ese es el punto del rediseño. */
    let facturaPend = null;
    const avisoConf = (txt, esError) => { const el = $('#conf-msg'); el.textContent = txt; el.style.color = esError ? 'var(--crit)' : 'var(--good)'; el.classList.remove('oculto'); };
    const cerrarConfirmacion = () => { facturaPend = null; $('#bloque-confirmar').classList.add('oculto'); };
    const montoConf = () => {
      // Mismo criterio que _parsearMontoLibre_ en api.js: un reemplazo ingenuo de coma→punto corrompía
      // en silencio montos ≥$1.000 con ambos símbolos ('$1,234.56' pasaba a $1.234).
      let t = String($('#conf-monto').value || '').replace(/\s/g, '').replace(/[^0-9.,]/g, '');
      if (t === '') return null;
      const lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
      if (lastComma !== -1 && lastDot !== -1) {
        const decPos = Math.max(lastComma, lastDot);
        t = t.slice(0, decPos).replace(/[.,]/g, '') + '.' + t.slice(decPos + 1).replace(/[.,]/g, '');
      } else if (lastComma !== -1) {
        const partesC = t.split(',');
        t = (partesC.length > 2 || partesC[partesC.length - 1].length !== 2) ? partesC.join('') : partesC.join('.');
      } else if (lastDot !== -1) {
        const partesP = t.split('.');
        t = (partesP.length > 2 || partesP[partesP.length - 1].length !== 2) ? partesP.join('') : partesP.join('.');
      }
      const n = parseFloat(t);
      return isNaN(n) ? null : n;
    };
    const pintarConfReparto = () => {
      if (!facturaPend) { $('#conf-reparto').innerHTML = ''; return; }
      const us = facturaPend.unidades, m = montoConf();
      const valido = m !== null && isFinite(m) && m > 0;
      const cada = valido ? (us.length > 1 ? Math.round((m / us.length) * 100) / 100 : m) : 0;
      $('#conf-reparto').innerHTML = (us.length > 1
        ? `Se reparte entre <b>${us.map(esc).join(', ')}</b>` + (valido ? ` — <b>$${cada.toFixed(2)}</b> para cada una.` : ' — pon el monto para ver cuánto va a cada una.') +
          ' Esta selección queda guardada como tu preferencia para la próxima factura de esta unidad.'
        : `Va completo a <b>${esc(us[0])}</b>` + (valido ? ` — <b>$${cada.toFixed(2)}</b>.` : '.'));
    };
    const abrirConfirmacion = (r) => {
      $('#conf-monto').value = (r.leida && r.monto) ? String(r.monto) : '';
      $('#conf-proveedor').value = r.proveedor || '';
      $('#conf-lectura').innerHTML = r.leida
        ? `Factura leída: <b>$${esc(String(r.monto))}</b>${r.proveedor ? ` · ${esc(r.proveedor)}` : ''}` +
          (r.items ? `<br>${esc(r.items)}` : '') +
          (r.sospechoso ? '<br><b style="color:var(--crit)">⚠️ Monto alto — revísalo bien antes de confirmar.</b>' : '')
        : '<b style="color:var(--crit)">No pude leer el monto de la foto.</b> Escríbelo a mano abajo · si lo dejas vacío se guarda solo la foto y le pones el valor después.';
      $('#conf-msg').classList.add('oculto');
      $('#conf-guardar').disabled = false;
      $('#bloque-confirmar').classList.remove('oculto');
      pintarConfReparto();
      $('#bloque-confirmar').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    $('#conf-monto').addEventListener('input', pintarConfReparto);

    // Guarda las previews LOCALES para que la foto se vea AL INSTANTE (Drive tarda en generar la
    // miniatura). Se muestran en "Recién subidas" hasta recargar la app; la galería de Drive las
    // alcanza después (el SW ya cura el blanco). Cap 12 para no inflar memoria.
    const trasSubir = (U, subidas) => {
      estado.fotosRecien = estado.fotosRecien || {};
      estado.fotosRecien[U] = subidas.concat(estado.fotosRecien[U] || []).slice(0, 12);
      estado.cache = {};
      setTimeout(() => vistaInventario(U), 1800);
    };

    $('#btn-guardar-lote').addEventListener('click', async () => {
      if (!fotosPend.length) { aviso('Toma o sube al menos una foto.', true); return; }
      if (!validarObs()) { aviso('Escribe qué pasó, con 1 a 3 palabras.', true); return; }
      const obs = palabras($('#lote-obs').value).join(' ');
      const U = unidadDestino();
      const btn = $('#btn-guardar-lote'); btn.disabled = true;
      const sello = selloFoto(U, obs);

      if (esFactura()) {
        // PASO 1 — LEER. `invLeerFactura` NO escribe ni sube nada: solo devuelve lo que la IA entendió
        // para mostrárselo al usuario. La escritura ocurre en #conf-guardar, y solo si él confirma.
        const unidadesRep = repSeleccionadas();
        if (unidadesRep.indexOf(U) === -1) unidadesRep.unshift(U);
        aviso('Leyendo la factura…', false);
        try {
          const b64 = await comprimirImagen(fotosPend[0], 1280, sello);
          const r = await apiPost({ apiAction: 'invLeerFactura', unidad: U, base64: b64 });
          if (!r.ok) { aviso(r.error || 'No se pudo leer la factura.', true); btn.disabled = false; return; }
          facturaPend = { b64, nombre: fotosPend[0].name, unidad: U, unidades: unidadesRep, obs, items: r.items || '' };
          abrirConfirmacion(r);
        } catch (e) { aviso('No se pudo leer la factura.', true); btn.disabled = false; }
        return;   // nada se guardó todavía: el botón queda inhabilitado hasta confirmar o cancelar
      }

      const subidas = [];   // previews LOCALES (base64) para verlas al instante tras subir
      let ok = 0;
      for (let i = 0; i < fotosPend.length; i++) {
        aviso(`Subiendo foto ${i + 1} de ${fotosPend.length}…`, false);
        try {
          const b64 = await comprimirImagen(fotosPend[i], 1280, sello);
          // `avisar` va SOLO en la última: un WhatsApp por lote, no uno por foto.
          const r = await apiPost({ apiAction: 'invSubirFoto', unidad: U, nombre: fotosPend[i].name,
            base64: b64, observaciones: obs, avisar: (i === fotosPend.length - 1) ? fotosPend.length : 0 });
          if (r.ok) { ok++; subidas.push({ b64, obs, fecha: hoyLocalIso(0), quien: (estado.yo && estado.yo.nombre) || '' }); }
        } catch (e) { /* sigue con las demás */ }
      }
      aviso(ok ? `✅ ${ok} foto(s) guardada(s).` : 'No se pudo subir ninguna foto.', !ok);
      if (ok) trasSubir(U, subidas); else btn.disabled = false;
    });

    // CANCELAR es limpio de verdad: no hay fila que borrar ni archivo que quede huérfano en Drive,
    // porque en el paso LEER no se escribió absolutamente nada. Solo se descarta la memoria.
    $('#conf-cancelar').addEventListener('click', () => {
      cerrarConfirmacion();
      $('#btn-guardar-lote').disabled = false;
      aviso('Gasto cancelado — no se guardó nada.', false);
    });

    // PASO 2 — CONFIRMAR Y GUARDAR. Manda el monto que el usuario aceptó (o corrigió); el servidor ya
    // no vuelve a llamar a la IA: escribe exactamente esto y guarda el reparto como preferencia.
    $('#conf-guardar').addEventListener('click', async () => {
      if (!facturaPend) return;
      const m = montoConf();
      if (m !== null && (!isFinite(m) || m < 0)) { avisoConf('Monto inválido — escribe solo números, ej. 18.50', true); return; }
      // Tope $300 (29/07/2026, dato del dueño: una factura de insumos nunca pasa de $300). Espejo del
      // guard del servidor en _apiInvSubirGasto_ (api.js del CRM) — acá solo evita el viaje perdido.
      if (m !== null && m > 300) { avisoConf('Monto fuera de rango (máximo $300 — si es mayor, avísale al dueño directamente).', true); return; }
      const bc = $('#conf-guardar'); bc.disabled = true;
      avisoConf('Guardando el gasto…', false);
      const pend = facturaPend;
      try {
        const r = await apiPost({ apiAction: 'invSubirGasto', unidad: pend.unidad, unidades: pend.unidades,
          nombre: pend.nombre, base64: pend.b64, observaciones: pend.obs,
          monto: m === null ? '' : m, proveedor: String($('#conf-proveedor').value || '').trim(), items: pend.items });
        if (!r.ok) { avisoConf(r.error || 'No se pudo registrar el gasto.', true); bc.disabled = false; return; }
        const donde = (r.unidades || pend.unidades).join(', ');
        // La tarjeta NO se cierra: el usuario está mirando acá abajo y el resultado tiene que aparecerle
        // donde está, no arriba. Se bloquea (facturaPend=null + los dos botones) para que no se pueda
        // confirmar dos veces, y en 1.8 s la vista se repinta sola con la foto ya en "Recién subidas".
        facturaPend = null;
        $('#conf-cancelar').disabled = true;
        const txt = r.leida
          ? `✅ Gasto registrado: $${r.montoCada}${(r.unidades || []).length > 1 ? ` c/u (total $${r.monto})` : ''} · ${r.proveedor || 'factura'} · ${donde}` +
            (r.grupo ? ' · reparto guardado para la próxima' : '')
          : `⚠️ Guardado sin monto: la foto quedó en GASTOS de ${donde} — ponle el valor a mano.`;
        avisoConf(txt, !r.leida);
        aviso(txt, !r.leida);
        trasSubir(pend.unidad, [{ b64: pend.b64, obs: pend.obs, fecha: hoyLocalIso(0), quien: (estado.yo && estado.yo.nombre) || '' }]);
      } catch (e) { avisoConf('No se pudo registrar el gasto.', true); bc.disabled = false; }
    });
  } catch (err) {
    render(`<div class="cuerpo-vista"><button class="volver" id="btn-volver">‹ Volver</button>
      <div class="error-caja">${esc(err.message)}</div></div>`);
    $('#btn-volver').addEventListener('click', () => { estado.uniSel = unidad; irTab('unidades'); });
  }
  mostrarCarga(false);
}

function vistaAgregarUnidad() {
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

/* ---------- Vista: DISPONIBILIDAD (buscador → link a Airbnb) ---------- */
function vistaDisponibilidad() {
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
        // S! = domingo con entrada que quien limpia RECHAZÓ: el trabajo existe y no tiene dueño.
        // Pisa a la S normal, igual que en la gráfica del bot (las dos vistas no pueden discrepar).
        celdas += `<div class="agenda-celda">${s && s.sinCubrir ? '<span class="marca-sc">S!</span>'
          : `${s && !s.profunda ? '<span class="marca-s">S</span>' : ''}${s && s.profunda ? '<span class="marca-p">P✦</span>' : ''}`}</div>`;
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
    <div class="agenda-leyenda"><b>S</b> salida (limpieza) · <b>P✦</b> limpieza profunda · <b>S!</b> domingo sin cubrir · píldora = reserva · Dom = descanso</div>`;
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
// Slug de unidad para armar ids de DOM estables ("SAN ROQUE" → "SANROQUE").
function idSlugUnidad(u) { return String(u || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// ============================================================================================
// TARJETAS-NOTIFICACIÓN "EN EL SITIO" (27/07/2026, pedido del dueño) — reemplazan la vieja pantalla
// vistaRegistrarLimpieza y el resto de HOY, que mostraba todo el detalle siempre visible. Ahora cada
// tarea es un resumen de una línea, estilo notificación de iPhone: tocarlo la despliega AHÍ MISMO
// (acordeón .notif-expand, mismo mecanismo que ya usaba MENSAJES para abrir un hilo) — nunca navega a
// otra pantalla/pestaña. Lo resuelto NUNCA se borra de la lista: se pinta atenuado (.completada) y se
// junta en la sección "Completadas hoy" al fondo. Novedades es la única que NO entra en este patrón:
// no es una tarea (no hay nada que decidir), así que usa el gesto de deslizar que ya existía en
// MENSAJES para las aprobaciones de clave (mismo swipe, mismo `estado.hechasLocal`).
// `sinAcordeon` (check-outs): la fila ya muestra TODO lo que hay (hora, cargo, recordatorio) — sin
// nada que ocultar, forzar un acordeón vacío sería un chevron que promete detalle y no lo entrega.
// Parte H (29/07/2026) — RESPALDO para resolver el `codigo` de reserva de un evento de HOY (check-in /
// check-out) cuando el backend todavía no lo manda. `_apiLimpieza_` (api.js del CRM) ya agrega
// `ev.codigo`, pero el carril rápido de Cloudflare D1 sirve fotos precalculadas que pueden tardar
// ~12-24 h en traer el campo nuevo; hasta entonces se deduce del hilo de MENSAJES, que ya está en
// memoria (mismo payload `tareasbot`, cero llamadas nuevas).
// Match: misma unidad + la fecha del evento calza con el check-in (llegada) o el check-out (salida) del
// hilo. Si eso deja más de un candidato (dos reservas de la misma unidad el mismo día), desempata por
// NOMBRE; si ni así es único, devuelve null y el llamador cae al fallback por nombre — nunca adivina.
function hiloDeEvento(hilos, ev) {
  if (!ev) return null;
  const U = String(ev.unidad || '').toUpperCase();
  const campo = ev.tipo === 'llegada' ? 'ci' : 'co';
  const cands = (hilos || []).filter(h => String(h.unidad || '').toUpperCase() === U && h[campo] === ev.fecha);
  if (cands.length === 1) return cands[0];
  if (cands.length > 1) {
    const n = normNombre(ev.huesped);
    return cands.find(h => normNombre(h.huesped) === n) || null;
  }
  return null;
}

// Parte H — RESPUESTAS DEL HUÉSPED PENDIENTES, agrupadas POR HUÉSPED. Regla del dueño: "todas pero
// agrupadas en una sola notificación que se va actualizando según novedades". Por eso devuelve como
// máximo UN ítem por hilo (su último mensaje entrante) en vez de uno por mensaje: un mensaje nuevo del
// mismo huésped ACTUALIZA su tarjeta, no crea otra. No hay estado que mantener — la lista se recalcula
// de `tb.hilos`, que siempre trae el último estado.
// Se descarta un hilo si: (a) no hay ningún mensaje del huésped, (b) el último es de hace más de 48 h,
// (c) el equipo YA respondió desde la app después de ese mensaje (tipo EQUIPO más nuevo), o (d) alguien
// lo descartó a mano (clave en `hechas`, que lleva el ts embebido: un mensaje MÁS nuevo genera una
// clave distinta y la tarjeta vuelve a aparecer sola).
// Función pura y aparte para que HOY y el badge rojo cuenten EXACTAMENTE lo mismo.
function respuestasHuespedPendientes(hilos, hechas) {
  const LIM = 48 * 3600e3;
  const ms = (ts) => new Date(String(ts || '').replace(' ', 'T')).getTime();   // 'yyyy-MM-dd HH:mm' → ms (Safari)
  return (hilos || []).map(h => {
    let ultIn = null, ultEq = null;
    (h.mensajes || []).forEach(m => {
      if (m.dir === 'in') ultIn = m;                        // ya vienen ordenados por ts
      if (m.dir === 'out' && m.tipo === 'EQUIPO') ultEq = m;
    });
    if (!ultIn) return null;
    const tIn = ms(ultIn.ts);
    if (!tIn || Date.now() - tIn > LIM) return null;
    if (ultEq && ultEq.ts > ultIn.ts) return null;          // ancho fijo: comparar como texto es seguro
    const key = 'msj:' + (h.codigo || h.unidad) + '|' + ultIn.ts;
    if ((hechas || {})[key]) return null;
    return { h, m: ultIn, key };
  }).filter(Boolean).sort((a, b) => b.m.ts.localeCompare(a.m.ts));
}

// "hace X" corto para las tarjetas de conversación (el ts del hilo es 'yyyy-MM-dd HH:mm').
function haceCuanto(ts) {
  const t = new Date(String(ts || '').replace(' ', 'T')).getTime();
  if (!t) return '';
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (min < 1) return 'ahora mismo';
  if (min < 60) return 'hace ' + min + ' min';
  const hrs = Math.round(min / 60);
  if (hrs < 24) return 'hace ' + hrs + ' h';
  return 'hace ' + Math.round(hrs / 24) + ' d';
}

// Parte H (29/07/2026) — `chat`: {codigo, nombre} del huésped de esta tarjeta. Cuando viene, el TÍTULO
// deja de ser texto plano y pasa a ser un <button> que abre su conversación en MENSAJES. Se eligió un
// <button> a propósito: el toggle del acordeón (más abajo, [data-notif-toggle]) YA ignora los clicks
// sobre `button`, así que el nombre-link no puede romper el acordeón de ninguna tarjeta existente.
function tituloChat(titulo, chat) {
  if (!chat) return titulo;
  return `<button type="button" class="nombre-chat" data-ir-msj="${esc(chat.codigo || '')}" data-ir-msj-nom="${esc(chat.nombre || '')}">${titulo}<span class="nombre-chat-ico">💬</span></button>`;
}

function notifCard({ id, avatar, titulo, pillHtml, subHtml, completada, expandHtml, expandAbierto, lazyUnidad, panelUnidad, sinAcordeon, chat }) {
  const tit = tituloChat(titulo, chat);
  if (sinAcordeon) {
    return `<div class="tarjeta notif-tarjeta${completada ? ' completada' : ''}" data-notif-caja="${esc(id)}">
      <div class="fila-unidad">
        ${avatar}
        <div class="resto">
          <div class="tarjeta-fila"><h3>${tit}</h3>${pillHtml || ''}</div>
          ${subHtml ? `<div class="sub">${subHtml}</div>` : ''}
        </div>
      </div>
    </div>`;
  }
  const abierto = !!expandAbierto;
  return `<div class="tarjeta notif-tarjeta${completada ? ' completada' : ''}" data-notif-caja="${esc(id)}">
    <div class="fila-unidad notif-resumen" data-notif-toggle="${esc(id)}"${lazyUnidad ? ` data-lazy-unidad="${esc(lazyUnidad)}"` : ''}>
      ${avatar}
      <div class="resto">
        <div class="tarjeta-fila"><h3>${tit}</h3>${pillHtml || ''}</div>
        ${subHtml ? `<div class="sub">${subHtml}</div>` : ''}
      </div>
      <span class="notif-chev${abierto ? ' abierto' : ''}">⌄</span>
    </div>
    <div class="notif-expand${abierto ? '' : ' oculto'}" id="${esc(id)}"${panelUnidad ? ` data-panel-unidad="${esc(panelUnidad)}" data-panel-listo="${expandHtml != null ? '1' : '0'}"` : ''}>${expandHtml != null ? expandHtml : '<div class="carga-mini">Toca para ver el detalle…</div>'}</div>
  </div>`;
}

// El checklist + botón LIMPIEZA COMPLETADA + ENVIAR CLAVES que antes vivían en la pantalla propia
// vistaRegistrarLimpieza — ahora es el contenido del acordeón, compartido por las tarjetas de check-in
// Y por "Profunda sin fecha para hacerla" (las dos abrían la misma pantalla antes). `d` es la respuesta
// de `api({action:'unidad', unidad})`; cuando la limpieza YA se sabe registrada (se descubrió antes en
// esta sesión) se arma un `d` parcial solo con `limpiezaHoy` — el checklist ni el recordatorio hacen
// falta para pintar el sello verde + Cancelar + Enviar claves.
// Botón + fila de confirmación inline (28/07/2026, pedido del dueño: doble confirmación en toda
// acción importante — LIMPIEZA/CLAVES/WhatsApp). Nunca reemplaza DOM (outerHTML pierde listeners):
// son 2 elementos hermanos, uno oculto, que se togglean con la clase `.oculto` ya usada en toda la
// app. `engancharConfirmable` cablea los 3 botones (disparador/sí/no) — reusar en los 3 lugares.
function botonConfirmable(idConf, textoBoton, textoConfirmar, opts = {}) {
  const { disabled = false, claseExtra = '' } = opts;
  return `
    <button class="btn ${claseExtra}" data-conf-btn="${esc(idConf)}" ${disabled ? 'disabled' : ''}>${esc(textoBoton)}</button>
    <div class="confirmar-fila oculto" data-conf-fila="${esc(idConf)}" style="margin-top:8px">
      <div class="sub" style="text-align:center;margin-bottom:6px">${textoConfirmar}</div>
      <div style="display:flex;gap:8px">
        <button class="btn" data-conf-si="${esc(idConf)}" style="flex:1">Sí, confirmar</button>
        <button class="btn secundario" data-conf-no="${esc(idConf)}" style="flex:1">Cancelar</button>
      </div>
    </div>`;
}
function engancharConfirmable(root, idConf, onConfirmar) {
  const btn = root.querySelector(`[data-conf-btn="${idConf}"]`), fila = root.querySelector(`[data-conf-fila="${idConf}"]`);
  if (!btn || !fila) return;
  btn.addEventListener('click', () => { btn.classList.add('oculto'); fila.classList.remove('oculto'); });
  fila.querySelector(`[data-conf-no="${idConf}"]`).addEventListener('click', () => { fila.classList.add('oculto'); btn.classList.remove('oculto'); });
  fila.querySelector(`[data-conf-si="${idConf}"]`).addEventListener('click', () => onConfirmar(btn, fila));
}

function registrarLimpiezaHtml(unidad, d, movs) {
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
  // FIX 28/07/2026 (pedido del dueño): se quitan los 3 checkboxes de "limpieza normal" — un solo
  // botón REGISTRAR LIMPIEZA con confirmación inline. El backend NO cambia: sigue esperando
  // `items` (T15b, auditoría de qué se marcó) — se manda `d.checklist` COMPLETO tal cual, igual que
  // antes cuando el botón exigía los 3 marcados (nunca se podía enviar parcial). La profunda sigue
  // con su checkbox propio: es OPCIONAL y parcial a propósito (T15d), eso no lo tocó el pedido.
  const itemsProf = d.checklistProfunda || [];
  const hoyI0 = hoyLocalIso(0);
  const profKey = 'pms_prof_' + unidad + '_' + hoyI0;
  const filaChk = (it, n) => `<label class="chk-fila"><span class="chk-txt">${esc(it)}</span>
      <input type="checkbox" class="check" data-chk-profunda-item="${n}"></label>`;
  const esProf = localStorage.getItem(profKey) === '1';
  const listaProf = itemsProf.map((it, i) => filaChk(it, i)).join('');
  const rec = d.recordatorio || {};
  const lh = d.limpiezaHoy || {};
  const registrada = !!lh.registrada;
  const bloqueClaves = lh.huespedHoy
    ? (lh.clavesEnviadas
        ? `<button class="btn btn-respondido" disabled style="margin-top:10px">✓ Claves enviadas al huésped</button>`
        : `<div style="margin-top:10px">${botonConfirmable('claves-' + unidad, 'ENVIAR CLAVES A HUÉSPED',
            '¿Confirmas que la unidad está lista de verdad? El huésped recibe las claves y sabe que puede entrar.')}</div>`)
    : `<div class="sub" style="text-align:center;margin-top:10px">No hay huésped con WhatsApp llegando hoy a esta unidad.</div>`;
  const accionHtml = registrada
    ? `<div class="tarjeta" style="margin-top:16px">
         <button class="btn btn-respondido" disabled>✓ Limpieza registrada${lh.quien ? ' · ' + esc(lh.quien) : ''}${lh.hora ? ' · ' + esc(lh.hora) : ''}</button>
         <div class="sub" style="text-align:center;margin-top:4px">Ya registrada. Si necesitas registrarla otra vez, toca Cancelar registro.</div>
         ${bloqueClaves}
         <button class="btn secundario btn-mini" data-btn-cancelar-limpieza="${esc(unidad)}" style="margin-top:14px">Cancelar registro</button>
         <div class="sub oculto" data-limpieza-msg="${esc(unidad)}" style="margin-top:8px"></div>
       </div>`
    : `<div style="margin-top:18px">${botonConfirmable('limpieza-' + unidad, 'REGISTRAR LIMPIEZA',
         '¿Confirmas que la unidad quedó limpia y con video de respaldo? Se avisará al admin.')}</div>
       <div class="sub oculto" data-limpieza-msg="${esc(unidad)}" style="margin-top:6px"></div>`;
  const bloqueChecklist = registrada ? '' : (listaProf ? `
      <div style="margin:14px 2px 4px"><div style="font-size:.92rem;font-weight:700;color:var(--ink)">Limpieza profunda</div><div class="sub" style="margin-top:2px">Opcional · solo si hoy toca a fondo</div></div>
      <div class="tarjeta">
        <label class="chk-fila chk-jefe"><span class="chk-txt">¿Hiciste limpieza profunda?<span class="chk-sub">Actívalo y marca solo lo que hiciste — no hace falta todo. El admin ve qué tareas se cumplieron</span></span>
          <input type="checkbox" class="check" data-chk-profunda="${esc(unidad)}" ${esProf ? 'checked' : ''}></label>
        <div class="${esProf ? '' : 'oculto'}" data-lista-profunda="${esc(unidad)}">${listaProf}</div>
      </div>` : '');
  return `
    ${rec.texto && rec.cuando !== 'OFF' ? `<div class="sub" style="margin-bottom:10px">📌 Recordatorio del admin: ${esc(rec.texto)}</div>` : ''}
    <div style="margin:2px 2px 4px"><div style="font-size:.92rem;font-weight:700;color:var(--ink)">El huésped de hoy</div><div class="sub" style="margin-top:2px">Lo que respondió al bot sobre sus horarios</div></div>
    <div class="tarjeta">${movHtml}</div>
    ${bloqueChecklist}
    ${accionHtml}`;
}

// Cablea los 3 botones del panel (LIMPIEZA COMPLETADA / ENVIAR CLAVES / Cancelar registro), acotado al
// propio panel (varias tarjetas pueden estar abiertas a la vez). Tras cualquier escritura se repinta
// HOY entera desde el servidor — mismo patrón ya probado que usan Domingo y Profunda más abajo: sigue
// siendo la MISMA pestaña (nunca navega), y la tarjeta renace ya en la sección correcta.
// Tras cualquier escritura hay que refrescar `estado._limpiezaHoySesion[unidad]` ANTES de repintar HOY:
// si se dejara el valor viejo (p.ej. `false` de cuando se abrió el panel la primera vez), la tarjeta
// volvería a nacer como pendiente aunque la limpieza YA quedó registrada — mismo costo que antes (la
// pantalla aparte también volvía a pedir `unidad` al re-pintarse tras cada acción).
// `fallbackSiFalla` (opcional): qué dejar en la sesión si el refresco en sí falla — el caller ya sabe
// qué pasó de verdad (la escritura anterior tuvo éxito), así que un fallo de RED acá no debe pisar
// ese resultado con un falso "sin hacer". Sin fallback, se deja el valor que ya había (no se toca).
async function refrescarSesionLimpieza(unidad, fallbackSiFalla) {
  const fresco = await api({ action: 'unidad', unidad }, false).catch(() => null);
  if (!fresco) { if (fallbackSiFalla !== undefined) estado._limpiezaHoySesion[unidad] = fallbackSiFalla; return; }
  const reg = !!(fresco.limpiezaHoy && fresco.limpiezaHoy.registrada);
  estado._limpiezaHoySesion[unidad] = reg ? { ...fresco.limpiezaHoy } : false;
}

function engancharPanelLimpieza(unidad, panelEl, checklistUnidad) {
  const msg = panelEl.querySelector('[data-limpieza-msg]');
  const chkProf = panelEl.querySelector('[data-chk-profunda]');
  const hoyI0 = hoyLocalIso(0);
  const profKey = 'pms_prof_' + unidad + '_' + hoyI0;
  if (chkProf) chkProf.addEventListener('change', () => {
    localStorage.setItem(profKey, chkProf.checked ? '1' : '0');
    const listaP = panelEl.querySelector('[data-lista-profunda]');
    if (listaP) listaP.classList.toggle('oculto', !chkProf.checked);
  });
  // REGISTRAR LIMPIEZA (28/07/2026: sin checklist visible — confirmación inline reemplaza al
  // confirm() nativo). `checklistUnidad` = d.checklist tal cual vino del servidor (los 3 textos con
  // el conteo de huéspedes/noches ya resueltos) — se manda COMPLETO, igual que antes cuando el botón
  // exigía marcar los 3 (nunca se podía mandar parcial).
  engancharConfirmable(panelEl, 'limpieza-' + unidad, async (btn) => {
    const prof = !!(chkProf && chkProf.checked);
    const profBoxes = [...panelEl.querySelectorAll('[data-chk-profunda-item]')];
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const items = checklistUnidad || [];
      const itemsProfunda = prof ? profBoxes.filter(b => b.checked).map(b => b.closest('.chk-fila').querySelector('.chk-txt').textContent.trim()) : [];
      const r = await apiPost({ apiAction: 'limpiezaCompletada', unidad, video: true, profunda: prof, items, itemsProfunda });
      if (!r.ok) throw new Error(r.error || 'error');
      localStorage.removeItem(profKey);
      estado.cache = {};
      await refrescarSesionLimpieza(unidad);
      vistaTareas();   // HOY renace: la tarjeta ya sale atenuada en su misma sección (C2)
    } catch (e) {
      if (msg) { msg.textContent = 'No se pudo: ' + e.message; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto'); }
      btn.disabled = false; btn.textContent = 'REGISTRAR LIMPIEZA'; btn.classList.remove('oculto');
      const fila = panelEl.querySelector('[data-conf-fila="limpieza-' + unidad + '"]');
      if (fila) fila.classList.add('oculto');
    }
  });
  engancharConfirmable(panelEl, 'claves-' + unidad, async (btn) => {
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const r = await apiPost({ apiAction: 'enviarClaves', unidad });
      if (!r.ok) throw new Error(r.error || 'No se pudo enviar');
      estado.cache = {};
      await refrescarSesionLimpieza(unidad);
      vistaTareas();
    } catch (e) {
      if (msg) { msg.textContent = '⚠️ ' + e.message; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto'); }
      btn.disabled = false; btn.textContent = 'ENVIAR CLAVES A HUÉSPED'; btn.classList.remove('oculto');
      const fila = panelEl.querySelector('[data-conf-fila="claves-' + unidad + '"]');
      if (fila) fila.classList.add('oculto');
    }
  });
  const btnCancel = panelEl.querySelector('[data-btn-cancelar-limpieza]');
  if (btnCancel) btnCancel.addEventListener('click', async () => {
    if (!confirm(`¿Cancelar el registro de limpieza de ${unidad} de hoy? Podrás volver a registrarla.`)) return;
    btnCancel.disabled = true; btnCancel.textContent = 'Cancelando…';
    try {
      const r = await apiPost({ apiAction: 'cancelarLimpieza', unidad });
      if (!r.ok) throw new Error(r.error || 'No se pudo cancelar');
      estado.cache = {};
      await refrescarSesionLimpieza(unidad);
      if (r.clavesYaEnviadas) alert('Registro cancelado. Ojo: las claves YA se habían enviado al huésped (un WhatsApp no se puede des-enviar).');
      vistaTareas();
    } catch (e) {
      if (msg) { msg.textContent = '⚠️ ' + e.message; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto'); }
      btnCancel.disabled = false; btnCancel.textContent = 'Cancelar registro';
    }
  });
}

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

/* ---------- Vista: AGENDA (C4, 28/07/2026 — reemplaza a Unidades para el rol limpieza) ----------
 * agendaGrid(a) ya existía (venía como respaldo cuando no hay PNG en agendaSeccionHTML); acá pasa a
 * ser la vista PRINCIPAL — texto, liviano en celular — para quien coordina limpiezas, en vez del PNG
 * que ya ve en HOY. Reusa la misma acción `agenda` (payload de Supabase, `agenda_cache`). */
async function vistaAgendaLimpieza() {
  setTitulo('Agenda');
  const a = await api({ action: 'agenda' }).catch(() => null);
  render(
    hero('Agenda de limpieza · toda la semana') +
    `<div class="cuerpo-vista">
      ${(a && !a.error) ? `<div class="tarjeta">${agendaGrid(a)}</div>` : '<div class="tarjeta"><div class="vacio">No se pudo cargar la agenda. Desliza hacia abajo para reintentar.</div></div>'}
    </div>`);
}

/* Parte G (29/07/2026) — PANTALLA DE BLOQUEO de HOY. Regla de oro del dueño: "no puede ver HOY hasta
 * que agregue datos de equipo de limpieza de sus unidades". Reemplaza a vistaTareas mientras queden
 * unidades propias sin responsable; el rol `limpieza` nunca llega acá. Sin CSS nuevo: reusa hero,
 * .tarjeta, .lista-item y .enlace-wa. Cada unidad lleva al mismo lugar donde se resuelve (UNIDADES →
 * sub-pestaña Limpieza de esa unidad). */
function vistaGateHoy(pendientes) {
  setTitulo('Tareas de Hoy');
  const us = (pendientes || []).map(x => String(x)).filter(Boolean);
  render(
    hero('Falta un dato para poder abrir HOY') +
    `<div class="cuerpo-vista">
      ${tituloSeccion('Asigna el equipo de limpieza', 'HOY se abre cuando TODAS tus unidades tengan responsable')}
      <div class="tarjeta">
        <div class="sub" style="margin-bottom:10px">La agenda, los avisos al equipo y el registro de limpieza se arman con el responsable de cada unidad.
          ${us.length === 1 ? 'Esta unidad todavía no lo tiene' : 'Estas unidades todavía no lo tienen'}:</div>
        ${us.map(u => `<div class="lista-item"><span class="quien">${esc(u)}</span>
          <a href="#" class="enlace-wa" data-gate-uni="${esc(u)}">Asignar responsable</a></div>`).join('')}
        <div class="sub" style="margin-top:12px">Si a esa unidad la limpia el propietario o alguien de fuera del equipo, elige <b>FORANEO</b>: deja de pedirse y sale de la agenda.</div>
      </div>
    </div>`);
  document.querySelectorAll('[data-gate-uni]').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault();
    estado.uniSel = a.dataset.gateUni; estado.cfgTab = 'limpieza'; irTab('unidades');
  }));
}

async function vistaTareas() {
  setTitulo('Tareas de Hoy');
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

  // Cachés de sesión (27/07): qué unidades ya se sabe que tienen la limpieza de HOY registrada — se
  // descubre al abrir una tarjeta (fetch en vivo, igual costo que antes) o al registrarla desde acá. NO
  // se persiste a localStorage a propósito: es un dato que puede cambiar de servidor (alguien cancela
  // el registro desde otro teléfono) y mostrar un "completada" viejo sería peor que redescubrirlo.
  estado._limpiezaHoySesion = estado._limpiezaHoySesion || {};
  // "wa:" en hechasLocal SÍ se persiste (es de una sola vía: capturar un número no se deshace), pero
  // solo interesa HOY — se poda lo de días anteriores para que "Completadas hoy" no acumule basura.
  const hoyI0Poda = hoyLocalIso(0), limPodaMsj = hoyLocalIso(-3);
  let _podado = false;
  Object.keys(estado.hechasLocal).forEach(k => {
    if (k.startsWith('wa:') && estado.hechasLocal[k] && estado.hechasLocal[k].fecha !== hoyI0Poda) {
      delete estado.hechasLocal[k]; _podado = true;
    }
    // Parte H: los descartes de "Conversaciones recientes" llevan el ts del mensaje EN la clave
    // ('msj:<codigo>|yyyy-MM-dd HH:mm'), así que se podan por ahí. Sin esto, localStorage acumularía
    // una clave por cada mensaje descartado, para siempre.
    // El corte NO es "hoy" sino 3 días atrás, A PROPÓSITO: la tarjeta vive 48 h, así que podar lo de
    // ayer haría reaparecer algo que el usuario ya descartó. Se poda cuando la tarjeta ya no existe.
    if (k.startsWith('msj:') && k.slice(k.indexOf('|') + 1, k.indexOf('|') + 11) < limPodaMsj) {
      delete estado.hechasLocal[k]; _podado = true;
    }
  });
  if (_podado) localStorage.setItem('pms_tareas_hechas', JSON.stringify(estado.hechasLocal));

  const completadasHoy = [];   // HTML de tarjetas ya resueltas — se junta al fondo, nunca se borra

  // --- 0. CONVERSACIONES RECIENTES (Parte H, 29/07/2026) — "TODAS LAS RESPUESTAS DEL HUÉSPED deben ser
  // notificaciones en HOY, con un link al chat en MENSAJES" (dueño). Va al TOPE: un huésped esperando
  // respuesta es lo más urgente del día. UNA tarjeta por huésped que se actualiza sola (ver
  // respuestasHuespedPendientes); tocarla abre su conversación completa en MENSAJES.
  // SIN swipe a propósito: la tarjeta entera navega al tap, y mezclar un gesto de deslizar con la
  // navegación es un conflicto de gestos — descartar es el botón ✕.
  // Visible para los 3 roles (admin/CoHost/limpieza): todos reciben ya el relay de estos mensajes por
  // WhatsApp y todos ven la pestaña MENSAJES.
  const hilosBot = (bot && bot.hilos) || [];
  const conversaciones = respuestasHuespedPendientes(hilosBot, estado.hechasLocal);
  const seccionConversaciones = conversaciones.length
    ? tituloSeccion('Conversaciones recientes', 'Huéspedes que escribieron — toca para abrir el chat completo') +
      conversaciones.map((c, i) => {
        const h = c.h, txt = String(c.m.texto || '').trim();
        // El pill es SIEMPRE rojo: respuestasHuespedPendientes ya excluye los hilos donde el equipo
        // contestó desde la app, así que todo lo que llega acá está, por definición, sin resolver.
        return `<div class="tarjeta tocable notif-tarjeta" data-conv="${i}">
          <div class="fila-unidad">
            ${monograma(h.unidad)}
            <div class="resto">
              <div class="tarjeta-fila"><h3>${tituloChat(esc(h.huesped || 'Huésped'), { codigo: h.codigo, nombre: h.huesped })}</h3>
                <span class="pill crit">ESPERANDO RESPUESTA</span></div>
              <div class="sub">${esc(h.unidad)} · ${esc(haceCuanto(c.m.ts))}</div>
              <div class="sub hilo-preview">${txt ? esc(txt.slice(0, 90)) + (txt.length > 90 ? '…' : '') : '<i>(mensaje sin texto)</i>'}</div>
            </div>
            <button class="btn-icono" data-conv-ocultar="${i}" style="width:26px;height:26px;font-size:.95rem" title="Descartar">✕</button>
          </div>
        </div>`;
      }).join('')
    : '';

  // --- 1. Huéspedes SIN WhatsApp. Va PRIMERO cuando hay pendientes (22/07/2026, pedido del dueño:
  // "al tope de la lista"): sin número el bot no puede atender a ese huésped, así que es lo más
  // accionable del día. Cuando NO hay ninguno su tarjeta es un "✅ todos tienen WhatsApp", y ese
  // visto bueno no merece el primer lugar: en ese caso se pinta al final, donde estaba. ---
  const sinWa = (bot && bot.sinWhatsapp) || [];
  const sinWaCardsHtml = sinWa.map((r, i) => {
    const expandHtml = r.codigo
      ? `<div class="sub">📱 Airbnb muestra su teléfono desde que la reserva se confirma (detalles de la reserva): cópialo y pégalo aquí. ⚠️ Si es un "número temporal" de Airbnb (huéspedes de EE.UU./Canadá), NO funciona en WhatsApp — usa el mensaje de Airbnb 👇.</div>
         <div style="display:flex;gap:6px;margin-top:8px">
           <input class="campo" data-wa="${i}" inputmode="tel" autocomplete="off" placeholder="WhatsApp (09… o +593…)" style="margin-bottom:0;flex:1">
           ${botonConfirmable('wa-guardar-' + i, 'Guardar', '¿Confirmas que este es el WhatsApp correcto del huésped?', { claseExtra: 'btn-mini' })}
         </div>
         <div class="sub" data-wa-msg="${i}" style="margin-top:6px">¿Ya tienes su número? Escríbelo y guárdalo. Si no, copia el mensaje para Airbnb 👇</div>
         <button class="btn secundario btn-mini" data-copiar="${i}" style="margin-top:8px">Copiar mensaje para el chat de Airbnb</button>`
      : `<div class="sub">Reserva sin código de confirmación: pide el número por Airbnb y envíalo al bot como siempre.</div>`;
    return notifCard({
      id: 'wa-' + i, avatar: avatarUnidad({ unidad: r.unidad, foto: r.foto }),
      titulo: esc(r.huesped || 'Huésped'), pillHtml: `<span class="pill crit">📵 SIN NÚMERO</span>`,
      subHtml: `${esc(r.unidad)} · ${fBonita(r.ci)} → ${fBonita(r.co)}${r.codigo ? ' · ' + esc(r.codigo) : ''}`,
      expandHtml,
      // Sin WhatsApp NO hay hilo que abrir: el link deja su nombre en el buscador de MENSAJES, que es
      // exactamente lo que hace falta para comprobar si ya escribió desde otro número.
      chat: { codigo: r.codigo, nombre: r.huesped },
    });
  }).join('');
  // C3 (28/07/2026): capturados en ESTA sesión o antes hoy (persistido en estado.hechasLocal 'wa:')
  // se quedan EN ESTA MISMA SECCIÓN, atenuados — ya NO saltan a "Completadas hoy".
  const sinWaDoneHtml = Object.keys(estado.hechasLocal).filter(k => k.startsWith('wa:')).map(k => {
    const info = estado.hechasLocal[k];
    if (!info) return '';
    return notifCard({
      id: 'wa-done-' + idSlugUnidad(info.unidad) + '-' + (info.ts || ''),
      avatar: monograma(info.unidad), titulo: esc(info.huesped || 'Huésped'),
      pillHtml: `<span class="pill ok">✓ NÚMERO CAPTURADO</span>`,
      subHtml: `${esc(info.unidad)}${info.whatsapp ? ' · ' + esc(info.whatsapp) : ''}`,
      completada: true, sinAcordeon: true,
    });
  }).join('');
  const seccionSinWa = tituloSeccion('Huéspedes sin WhatsApp', 'Toca una tarjeta para capturar su número') +
    (sinWa.length || sinWaDoneHtml ? sinWaCardsHtml + sinWaDoneHtml
      : `<div class="tarjeta"><div class="vacio">${bot ? '✅ Todas las reservas próximas tienen WhatsApp.' : '⚠️ No se pudo cargar — desliza hacia abajo para reintentar.'}</div></div>`);

  // (Las secciones "El bot hoy" y "Conversaciones" viven ahora en la pestaña MENSAJES:
  //  los hilos como chat y los pendientes como leyenda amarilla dentro de cada conversación.)

  // --- 2. Check-ins / check-outs de hoy — cada uno es una tarjeta-notificación que se despliega EN EL
  // SITIO. La de check-in abre el MISMO checklist que antes vivía en la pantalla aparte
  // vistaRegistrarLimpieza (ahora retirada): se pide una sola vez (fetch en vivo, igual costo que
  // antes) la primera vez que se toca la tarjeta. Semáforo POR HORA (21/07): un check-in ya pasó su
  // hora de llegada → HOSPEDANDO; un check-out que ya pasó la suya se considera resuelto y pasa a
  // Completadas hoy — YA NO desaparece sin más.
  const evHoy = ((jOk && j.eventos) || []).filter(ev => ev.dia === 'hoy');
  const ahoraMinT = new Date().getHours() * 60 + new Date().getMinutes();
  const cutCk = (estado.yo.horaCheckin != null ? estado.yo.horaCheckin : 15) * 60;
  const cutCo = (estado.yo.horaCheckout != null ? estado.yo.horaCheckout : 11) * 60;
  const yaLlego = (ev) => ahoraMinT >= (ev.hora && horaAMin(ev.hora) >= 0 ? horaAMin(ev.hora) : cutCk);
  const yaSalio = (ev) => ahoraMinT >= (ev.hora && horaAMin(ev.hora) >= 0 ? horaAMin(ev.hora) : cutCo);
  const llegadasHoy = evHoy.filter(ev => ev.tipo === 'llegada');
  const salidasHoy = evHoy.filter(ev => ev.tipo === 'checkout');
  const cargados = {};   // unidad → true una vez que su panel de limpieza ya se pidió/pintó esta vez
  // Parte H: `chat` de un movimiento de hoy. `ev.codigo` viene de _apiLimpieza_ (api.js); mientras la
  // foto de D1 sea vieja y no lo traiga, se deduce del hilo (hiloDeEvento). Sin código igual se navega:
  // el nombre queda en el buscador de MENSAJES.
  const chatDeEvento = (ev) => ({
    codigo: ev.codigo || (hiloDeEvento(hilosBot, ev) || {}).codigo || '',
    nombre: ev.huesped || '',
  });

  async function cargarPanelLimpieza(cardId, unidad, panelEl) {
    // Clave por TARJETA (no por unidad sola): la misma unidad puede aparecer en más de una sección
    // hoy (ej. check-in + profunda vencida) — con una sola clave, la segunda tarjeta se quedaba
    // pidiendo el detalle para siempre porque la primera ya la había marcado "cargada".
    if (cargados[cardId]) return;
    cargados[cardId] = true;
    try {
      const d = await api({ action: 'unidad', unidad }, false);   // LIVE — cambia intra-día
      if (d.error) throw new Error(d.error);
      const movs = evHoy.filter(ev => String(ev.unidad).toUpperCase() === unidad.toUpperCase());
      const registrada = !!(d.limpiezaHoy && d.limpiezaHoy.registrada);
      estado._limpiezaHoySesion[unidad] = registrada ? { ...d.limpiezaHoy } : false;
      panelEl.innerHTML = registrarLimpiezaHtml(unidad, d, movs);
      engancharPanelLimpieza(unidad, panelEl, d.checklist);
      // Se descubrió DESPUÉS de pintar la tarjeta como pendiente: se marca completada EN EL SITIO, sin
      // recargar el resto de HOY — la próxima vez que se repinte, ya nace en "Completadas hoy".
      if (registrada) {
        const caja = panelEl.closest('.notif-tarjeta');
        if (caja && !caja.classList.contains('completada')) {
          caja.classList.add('completada');
          const pill = caja.querySelector('.pill');
          if (pill) { pill.className = 'pill ok'; pill.textContent = 'LIMPIEZA LISTA'; }
        }
      }
    } catch (e) {
      panelEl.innerHTML = `<div class="error-caja">${esc(e.message)}</div>`;
      cargados[unidad] = false;   // permite reintentar tocando de nuevo
    }
  }

  // C2 (28/07/2026, pedido del dueño): check-ins/check-outs ya NO saltan a "Completadas hoy" al
  // resolverse — se quedan EN SU SECCIÓN, atenuados (.completada, ya la aplica notifCard), pendientes
  // primero y resueltos al final DENTRO de la misma caja. `completadasHoy` sigue existiendo para las
  // demás categorías (Domingo/Profunda) que no pidió cambiar.
  const checkinsPend = [], checkinsDone = [];
  llegadasHoy.forEach(ev => {
    const u = String(ev.unidad).toUpperCase();
    const llego = yaLlego(ev);
    const conocidaReg = estado._limpiezaHoySesion[u];
    const yaRegistrada = !!conocidaReg;
    const pillHtml = yaRegistrada
      ? `<span class="pill ok">LIMPIEZA LISTA</span>`
      : `<span class="pill ${llego ? 'ok' : 'crit'}">${llego ? 'HOSPEDANDO' : 'ENTRA HOY'}</span>`;
    const subHtml = `${esc(ev.unidad)}${ev.hora ? ` · 🕐 llega ~${esc(ev.hora)} <b>(dijo al bot)</b>` : ' · sin hora estimada aún'}${ev.recordatorio ? '<br>📌 ' + esc(ev.recordatorio) : ''}`;
    const movs = evHoy.filter(e => String(e.unidad).toUpperCase() === u);
    const partialD = yaRegistrada ? { limpiezaHoy: conocidaReg, checklist: [], checklistProfunda: [], recordatorio: {} } : null;
    const html = notifCard({
      id: 'lim-ci-' + idSlugUnidad(u), avatar: monograma(ev.unidad), titulo: esc(ev.huesped || 'Huésped'),
      pillHtml, subHtml, completada: yaRegistrada,
      lazyUnidad: yaRegistrada ? null : u,
      panelUnidad: u,
      expandHtml: yaRegistrada ? registrarLimpiezaHtml(u, partialD, movs) : null,
      expandAbierto: yaRegistrada,   // recién resuelta: se abre sola para que ENVIAR CLAVES quede a un toque
      chat: chatDeEvento(ev),
    });
    (yaRegistrada ? checkinsDone : checkinsPend).push(html);
  });
  const checkinsHtml = checkinsPend.concat(checkinsDone).join('');
  const filaSalida = (ev, hecha) => notifCard({
    id: 'sal-' + idSlugUnidad(ev.unidad) + '-' + idSlugUnidad(ev.huesped || ''),
    avatar: monograma(ev.unidad), titulo: esc(ev.huesped || 'Huésped'),
    pillHtml: hecha ? `<span class="pill ok">✓ SALIÓ</span>` : `<span class="pill ${ev.tarde ? 'crit' : 'warn'}">${ev.tarde ? 'SALE TARDE' : 'SALE'}</span>`,
    subHtml: `${esc(ev.unidad)}${ev.hora ? ` · 🕐 ${hecha ? 'salió' : 'sale'} ~${esc(ev.hora)} <b>(dijo al bot)</b>` : ' · sin hora estimada aún'}${cargoTardeTxt(ev)}${ev.recordatorio ? '<br>📌 ' + esc(ev.recordatorio) : ''}`,
    completada: hecha, sinAcordeon: true,
    // Aunque esta fila NO tenga acordeón (turnover), el nombre sí es link al chat: es justo el huésped
    // al que hay que escribirle si se va tarde o no contesta la hora de salida.
    chat: chatDeEvento(ev),
  });
  // FIX 28/07/2026 (bug real, cazado en vivo): una unidad con SOLO checkout hoy (nadie llega el mismo
  // día) no tenía NINGÚN camino para registrar su limpieza — el panel de checklist solo estaba
  // conectado a las tarjetas de check-in. `filaSalida` (arriba) es sinAcordeon a propósito para el caso
  // de turnover (checkout+llegada mismo día: la tarjeta de check-in de esa unidad YA trae el panel, uno
  // segundo sería redundante) — pero una unidad SOLO-salida necesita su PROPIA tarjeta con panel.
  const unidadesConLlegadaHoy = new Set(llegadasHoy.map(ev => String(ev.unidad).toUpperCase()));
  const filaSalidaConRegistro = (ev) => {
    const u = String(ev.unidad).toUpperCase();
    const conocidaReg = estado._limpiezaHoySesion[u];
    const yaRegistrada = !!conocidaReg;
    const pillHtml = yaRegistrada
      ? `<span class="pill ok">LIMPIEZA LISTA</span>`
      : `<span class="pill ${ev.tarde ? 'crit' : 'warn'}">${ev.tarde ? 'SALE TARDE' : 'SALE'}</span>`;
    const subHtml = `${esc(ev.unidad)}${ev.hora ? ` · 🕐 sale ~${esc(ev.hora)} <b>(dijo al bot)</b>` : ' · sin hora estimada aún'}${cargoTardeTxt(ev)}${ev.recordatorio ? '<br>📌 ' + esc(ev.recordatorio) : ''}`;
    const movs = evHoy.filter(e => String(e.unidad).toUpperCase() === u);
    const partialD = yaRegistrada ? { limpiezaHoy: conocidaReg, checklist: [], checklistProfunda: [], recordatorio: {} } : null;
    return notifCard({
      id: 'sal-reg-' + idSlugUnidad(u), avatar: monograma(ev.unidad), titulo: esc(ev.huesped || 'Huésped'),
      pillHtml, subHtml, completada: yaRegistrada,
      lazyUnidad: yaRegistrada ? null : u, panelUnidad: u,
      expandHtml: yaRegistrada ? registrarLimpiezaHtml(u, partialD, movs) : null,
      expandAbierto: yaRegistrada,
      chat: chatDeEvento(ev),
    });
  };
  // Turnover (checkout+llegada mismo día): informativa, se resuelve con la HORA (filaSalida) — el
  // check-in de esa unidad ya trae el panel real. Solo-salida: se resuelve cuando se REGISTRA la
  // limpieza (estado._limpiezaHoySesion), NUNCA por la hora — si no, pasada la hora de checkout la
  // tarjeta caía a "Completadas" sin panel y la limpieza quedaba sin forma de registrarse (bug real).
  const esTurnover = (ev) => unidadesConLlegadaHoy.has(String(ev.unidad).toUpperCase());
  const salidaResuelta = (ev) => esTurnover(ev) ? yaSalio(ev) : !!estado._limpiezaHoySesion[String(ev.unidad).toUpperCase()];
  const salidaHtml = (ev) => esTurnover(ev) ? filaSalida(ev, yaSalio(ev)) : filaSalidaConRegistro(ev);
  // C2: igual que check-ins — pendientes primero, resueltas al final, todas dentro de la misma caja.
  const salidasPend = salidasHoy.filter(ev => !salidaResuelta(ev));
  const salidasDone = salidasHoy.filter(ev => salidaResuelta(ev));
  const salidasHtml = salidasPend.concat(salidasDone).map(salidaHtml).join('');
  const seccionMov = jOk
    ? tituloSeccion('Check-ins de hoy', 'Toca una tarjeta para ver el detalle y registrar la limpieza') +
      (checkinsPend.length || checkinsDone.length ? checkinsHtml : '<div class="tarjeta"><div class="vacio">Nadie llega hoy.</div></div>') +
      tituloSeccion('Check-outs de hoy', 'Toca una tarjeta para ver el detalle y registrar la limpieza') +
      (salidasPend.length || salidasDone.length ? salidasHtml : '<div class="tarjeta"><div class="vacio">Nadie por salir ahora.</div></div>')
    : tituloSeccion('Check-ins y check-outs', 'No se pudieron cargar los movimientos de hoy') +
      `<div class="tarjeta"><div class="vacio">⚠️ ${esc((j && j.error) || 'Error de conexión')}</div>
        <button class="btn btn-mini" data-reintentar style="margin-top:10px">REINTENTAR</button></div>`;

  // --- El bot hoy (mensajería automática del día, solo lectura): SIN cambios — el detalle y las
  // conversaciones viven en MENSAJES, esto es solo un vistazo de qué salió y qué va a salir.
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
  const seccionBot = tituloSeccion('El bot hoy', 'Mensajes automáticos de hoy — las conversaciones viven en MENSAJES') +
    `<div class="tarjeta">${pendHoy.length ? pendHoy.map(filaBot).join('')
      : `<div class="vacio">${bot ? 'El bot no tiene mensajes para hoy.' : '⚠️ No se pudo cargar — desliza hacia abajo para reintentar.'}</div>`}</div>`;

  const fHoy = (jOk && j.hoy) ? `${_diaSemanaApp(j.hoy)} ${fLarga(j.hoy)}` : '';

  // Novedades (21/07, ahora con deslizar-para-descartar 27/07; Parte N 29/07 — lupa 🔍 de búsqueda hasta
  // 30 días): reservas NUEVAS + reseñas 5★ REALES recientes. Informativa — no es una tarea, así que NO
  // entra en el acordeón: se descarta deslizando a la izquierda (mismo gesto y el mismo
  // `estado.hechasLocal` que las aprobaciones de clave en MENSAJES), con un botón ✕ como alternativa
  // para quien no tiene pantalla táctil.
  const nov = (bot && bot.novedades) || [];
  const fechaNov = (ts) => { const s = String(ts || ''); return fBonita(s.slice(0, 10)) + (s.length > 10 ? ' · ' + s.slice(11, 16) : ''); };
  const novKey = (n) => 'nov:' + (n.ts || '') + '|' + (n.unidad || '') + '|' + (n.titulo || '');
  const novVisibles = nov.filter(n => !estado.hechasLocal[novKey(n)]);
  // Tarjeta reusada por el default (con swipe-para-descartar) y por el resultado de la búsqueda ampliada
  // (sin swipe: es historial, no algo para "resolver" en HOY) — mismo componente visual en los dos casos.
  const novTarjetaHtml = (n, i, swipe) => {
    const cuerpo = `<div class="tarjeta${swipe ? ' swipe-frente' : ''}${n.huesped ? ' tocable' : ''}"${n.huesped ? ` data-nov-chat="${i}"` : ''}>
        <div class="tarjeta-fila">
          <span class="quien">${n.icono || '•'} ${esc(n.titulo)}${n.unidad ? ' · ' + esc(n.unidad) : ''}</span>
          ${swipe ? `<button class="btn-icono" data-nov-ocultar="${i}" style="width:26px;height:26px;font-size:.95rem" title="Descartar">✕</button>` : ''}
        </div>
        <div class="sub">${n.huesped ? tituloChat(esc(n.huesped), { codigo: n.codigo, nombre: n.huesped }) + ' · ' : ''}${n.detalle ? esc(n.detalle) + ' · ' : ''}${fechaNov(n.ts)}</div>
        ${n.accion === 'reintentarDomingo'
          ? `<button class="btn-chico" data-reint-dom="${esc(n.unidad)}" data-reint-fecha="${esc(n.fecha || '')}" style="margin-top:8px">REINTENTAR</button>`
          : ''}
      </div>`;
    return swipe ? `<div class="swipe-caja" data-swipe-nov="${i}">
        <div class="swipe-fondo">Descartar</div>
        ${cuerpo}
      </div>` : cuerpo;
  };
  const novDefaultHtml = novVisibles.length ? novVisibles.map((n, i) => novTarjetaHtml(n, i, true)).join('')
    : `<div class="tarjeta"><div class="vacio">Sin novedades recientes.</div></div>`;
  // Búsqueda ampliada (Parte N, 29/07/2026): SOLO se pide con la lupa — la carga normal de HOY (arriba,
  // `api({action:'tareasbot'})`) NUNCA trae la ventana de 30 días, sería más lento todos los días para
  // algo que la mayoría de las veces no hace falta. `estado.novBuscar` vive en `estado` (no local) para
  // sobrevivir un repintado silencioso de esta vista sin perder la búsqueda en curso.
  const nb = estado.novBuscar;
  const novContHtml = !nb ? novDefaultHtml
    : nb.cargando ? `<div class="tarjeta"><div class="vacio">Buscando…</div></div>`
    : nb.error ? `<div class="tarjeta"><div class="vacio">⚠️ ${esc(nb.error)}</div><button class="btn btn-mini" data-nov-reintentar style="margin-top:8px">REINTENTAR</button></div>`
    : (nb.items.length ? nb.items.map((n, i) => novTarjetaHtml(n, i, false)).join('')
      : `<div class="tarjeta"><div class="vacio">Sin novedades en los últimos ${nb.dias} días.</div></div>`);
  const novAbierto = !!estado.novBuscarAbierto || !!nb;
  const novChipsHtml = [7, 15, 30].map(d =>
    `<button class="chip${nb && nb.dias === d ? ' activo' : ''}" data-nov-dias="${d}">${d} días</button>`).join('');
  const seccionNovedades = `<div class="titulo-seccion" style="display:flex;align-items:center;justify-content:space-between">
      <h2>Novedades</h2>
      <button class="btn-icono" id="nov-lupa" style="width:30px;height:30px;font-size:1rem" title="Buscar más atrás">🔍</button>
    </div>
    <div class="titulo-sub">Reservas nuevas, cancelaciones y reseñas 5★ · toca para abrir el chat, desliza para descartar</div>` +
    (novAbierto ? `<div class="tarjeta" style="padding:10px 12px;margin-bottom:8px">
        <div class="sub" style="margin:0 0 8px">Ver novedades de los últimos:</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${novChipsHtml}</div>
      </div>` : '') +
    `<div id="nov-cont">${novContHtml}</div>` +
    (nb ? `<div style="text-align:center;margin:8px 0"><button class="btn secundario btn-mini" id="nov-volver">Volver a lo de hoy</button></div>` : '') +
    `<div id="nov-msg" class="sub oculto" style="margin-top:8px"></div>`;

  // --- PARA MAÑANA (22/07/2026): sin cambios — informativa, no la pidió el dueño para este rediseño.
  const HORA_MANANA = 15;
  const esTarde = new Date().getHours() >= HORA_MANANA;
  const llegadasManana = ((j && j.eventos) || []).filter(ev => ev.dia === 'manana' && ev.tipo === 'llegada');
  const limpiezasManana = ((j && j.manana) || {}).limpiezas || [];
  const filaLimpieza = (l) => `
    <div class="lista-item">
      ${monograma(l.unidad)}
      <span style="flex:1"><span class="quien">${esc(l.unidad)}${l.persona ? ' · ' + esc(l.persona) : ''}</span><br>
        <span class="sub">${l.sale ? 'Sale ' + esc(l.sale) : 'Sin salida'}${l.entra ? ' · entra ' + esc(l.entra) : ''}${l.diferida ? ' · <b>viene del domingo</b>' : ''}${l.sinCubrir ? `<br>⛔ <b>${esc(l.persona || 'El equipo')} dijo que no puede</b> — hay que cubrirla` : ''}</span></span>
      <span class="pill crit">${l.sinCubrir ? 'SIN CUBRIR' : 'LIMPIEZA'}</span>
    </div>`;
  const filaManana = (ev) => `
    <div class="lista-item">
      ${monograma(ev.unidad)}
      <span style="flex:1"><span class="quien">${esc(ev.huesped || 'Huésped')}</span><br>
        <span class="sub">${esc(ev.unidad)}${ev.hora ? ` · 🕐 llega ~${esc(ev.hora)} <b>(dijo al bot)</b>` : ' · sin hora estimada aún'}</span></span>
      <span class="pill warn">ENTRA MAÑANA</span>
    </div>`;
  const dom = (j && j.domingo) || null;
  const domHtml = (() => {
    if (!dom || !(dom.entradas || []).length) return '';
    const conf = dom.confirmaciones || {};
    const dia = +String(dom.fecha).split('-')[2];
    const domPend = [];
    dom.entradas.forEach(e => {
      const c = conf[e.unidad] || null;
      const dijoSi = !!c && c.respuesta === 'SI';
      const dijoNo = !!c && c.respuesta === 'NO';
      // "NO puede" NO es una tarea resuelta para el admin — sigue sin cubrirse (regla del 24/07: el
      // rojo del pendiente vive en la fila de quien lo resuelve, no en el botón de quien contestó).
      // Solo un SI archiva la tarjeta; un NO se queda arriba, visible, hasta que se cubra.
      const resuelto = dijoSi;
      const pillHtml = dijoNo ? `<span class="pill crit">SIN CUBRIR</span>` : dijoSi ? `<span class="pill ok">✓ CONFIRMADO</span>` : (e.pregunta ? `<span class="pill warn">SIN CONFIRMAR</span>` : '');
      const estadoTxt = dijoSi ? '✅ Confirmado' + (c.quien ? ' · ' + esc(c.quien) : '')
        : dijoNo ? (esc(c.quien || 'El equipo') + ' no puede — hay que cubrir el domingo')
        : (e.pregunta ? '⏳ Sin confirmar' : (e.persona ? esc(e.persona) + ' trabaja los domingos' : 'Sin nadie asignado'));
      const botones = e.pregunta
        ? `<div class="fila-oscura" style="margin-top:8px">
             ${dijoSi ? `<button class="btn-oscuro btn-respondido" disabled>✓ Confirmado</button>`
                      : `<button class="btn-oscuro${dijoNo ? ' btn-cancelar' : ''}" ${dijoNo ? 'data-dom-cancelar' : 'data-dom-si'}="${esc(e.unidad)}">${dijoNo ? 'Cancelar' : 'Confirmo'}</button>`}
             ${dijoNo ? `<button class="btn-oscuro btn-respondido" disabled>✓ No confirmado</button>`
                      : `<button class="btn-oscuro${dijoSi ? ' btn-cancelar' : ''}" ${dijoSi ? 'data-dom-cancelar' : 'data-dom-no'}="${esc(e.unidad)}">${dijoSi ? 'Cancelar' : 'No confirmo'}</button>`}
           </div>` : '';
      const html = notifCard({
        id: 'dom-' + idSlugUnidad(e.unidad), avatar: monograma(e.unidad), titulo: esc(e.unidad),
        pillHtml,
        // Parte H: acá el título es la UNIDAD, así que el link al chat va sobre el nombre del huésped
        // dentro del subtítulo. `_apiDomingoBloque_` no da código de reserva → cae al buscador por
        // nombre en MENSAJES, que es suficiente para avisarle si el domingo no se cubre.
        subHtml: `entra ${tituloChat(esc(e.huesped || 'huésped'), { codigo: '', nombre: e.huesped })}`,
        completada: resuelto,
        expandHtml: `<div class="sub"${dijoNo ? ' style="color:var(--crit)"' : ''}>${estadoTxt}</div>${botones}<div class="sub oculto" data-dom-msg="${esc(e.unidad)}" style="margin-top:8px"></div>`,
      });
      if (resuelto) completadasHoy.push(html); else domPend.push(html);
    });
    return domPend.length
      ? tituloSeccion(`Limpieza Domingo ${dia}`, 'Entra huésped en domingo — confirma si se cubre esa limpieza') + domPend.join('')
      : '';
  })();
  const seccionManana = esTarde
    ? tituloSeccion('Para mañana', 'Lo que viene, para organizarte desde hoy') +
      ((limpiezasManana.length || llegadasManana.length)
        ? `<div class="tarjeta">${limpiezasManana.map(filaLimpieza).join('')}${llegadasManana.map(filaManana).join('')}</div>`
        : '<div class="tarjeta"><div class="vacio">Mañana no hay limpiezas ni llegadas.</div></div>')
    : '';

  // PROFUNDA VENCIDA (22/07/2026): sin fecha para hacerla — usa el MISMO panel de check-in/registrar
  // limpieza (antes las dos abrían vistaRegistrarLimpieza).
  const vencidas = (j && j.vencidas) || [];
  const seccionVencidas = (() => {
    if (!vencidas.length) return '';
    const pend = [];
    vencidas.forEach(v => {
      const u = String(v.unidad).toUpperCase();
      const conocidaReg = estado._limpiezaHoySesion[u];
      const yaRegistrada = !!conocidaReg;
      const subHtml = `${v.nunca ? 'Sin registro de limpieza profunda' : `${v.dias} días desde la última (cada ${v.cada})`}${v.proximoCheckout ? ' · próximo check-out ' + fBonita(v.proximoCheckout) : ' · sin check-out a la vista'}`;
      const partialD = yaRegistrada ? { limpiezaHoy: conocidaReg, checklist: [], checklistProfunda: [], recordatorio: {} } : null;
      const html = notifCard({
        id: 'lim-ve-' + idSlugUnidad(u), avatar: monograma(v.unidad), titulo: esc(v.unidad),
        pillHtml: yaRegistrada ? `<span class="pill ok">LIMPIEZA LISTA</span>` : `<span class="pill crit">SIN FECHA</span>`,
        subHtml, completada: yaRegistrada, lazyUnidad: yaRegistrada ? null : u, panelUnidad: u,
        expandHtml: yaRegistrada ? registrarLimpiezaHtml(u, partialD, []) : null,
        expandAbierto: yaRegistrada,
      });
      if (yaRegistrada) completadasHoy.push(html); else pend.push(html);
    });
    return pend.length
      ? tituloSeccion('Profunda sin fecha para hacerla', 'Vencida y sin check-out esta semana — hay que decidir cuándo entrar') + pend.join('')
      : '';
  })();

  // LIMPIEZA PROFUNDA DE HOY (24/07/2026): el motor de las 6 AM anotó una profunda PENDIENTE.
  const profHoy = ((j && j.profundas) || []).filter(p => p.fecha === (j && j.hoy) &&
    ['PENDIENTE', 'REALIZADA', 'RECHAZADA'].includes(String(p.estado || '').toUpperCase()));
  const profPorU = {};
  profHoy.forEach(p => { profPorU[String(p.unidad).toUpperCase()] = String(p.estado || '').toUpperCase(); });
  const uProf = Object.keys(profPorU);
  const seccionProfundaHoy = (() => {
    if (!uProf.length) return '';
    const pend = [];
    uProf.forEach(u => {
      const est = profPorU[u];
      // Mismo criterio que Domingo: "NO hecha" sigue sin resolverse para el admin (el propio texto
      // dice "a coordinar con el admin") — no se archiva, se queda visible hasta que se confirme.
      const hecho = est === 'REALIZADA', noHecho = est === 'RECHAZADA', resuelto = hecho;
      const pillHtml = hecho ? `<span class="pill ok">✓ CONFIRMADA</span>` : noHecho ? `<span class="pill crit">NO HECHA</span>` : `<span class="pill warn">PENDIENTE</span>`;
      const botones = est === 'PENDIENTE'
        ? `<div class="fila-oscura" style="margin-top:8px">
             <button class="btn-oscuro" data-prof-si="${esc(u)}">Confirmo limpieza</button>
             <button class="btn-oscuro" data-prof-no="${esc(u)}">No confirmo limpieza</button>
           </div>`
        : `<div class="fila-oscura" style="margin-top:8px">
             <button class="btn-oscuro btn-respondido" disabled>${hecho ? '✓ Confirmada' : '✓ Reportada'}</button>
             <button class="btn-oscuro btn-cancelar" data-prof-cancelar="${esc(u)}">Cancelar</button>
           </div>`;
      const estadoTxt = hecho ? '✅ Limpieza profunda confirmada' : noHecho ? 'Reportada como NO hecha — a coordinar con el admin' : '⏳ Hoy toca limpieza profunda — confirma si la hiciste';
      const html = notifCard({
        id: 'prof-' + idSlugUnidad(u), avatar: monograma(u), titulo: esc(u), pillHtml, completada: resuelto,
        expandHtml: `<div class="sub">${estadoTxt}</div>${botones}<div class="sub oculto" data-prof-msg="${esc(u)}" style="margin-top:8px"></div>`,
      });
      if (resuelto) completadasHoy.push(html); else pend.push(html);
    });
    return pend.length
      ? tituloSeccion('Limpieza profunda de hoy', 'El sistema la coordinó para hoy — confirma si la hiciste o no') + pend.join('')
      : '';
  })();

  const seccionCompletadas = completadasHoy.length
    ? tituloSeccion('Completadas hoy', 'Ya resueltas — se quedan aquí, nunca desaparecen') + completadasHoy.join('')
    : '';

  // RECORDATORIO DE CLAVES FALTANTES (28/07/2026, pedido del dueño): persiste en HOY — sin swipe, sin
  // botón de descartar — hasta que alguien cargue la clave desde Editar unidad. Sin esto, ENVIAR CLAVES
  // y el early check-in fallan en silencio (_enviarCodigoAcceso_ solo deja un ⚠️ en el log). Solo la ve
  // admin puro (mismo gate que `sinClaves` en api.js — un CoHost no puede cargarla aunque la vea).
  const seccionSinClaves = (jOk && j.sinClaves && j.sinClaves.length)
    ? `<div class="tarjeta" style="border-color:var(--crit)">
        <div class="tarjeta-fila"><span class="quien">🔑 Faltan claves de acceso</span></div>
        <div class="sub" style="margin-top:4px">Sin esto el bot no puede mandar el código al huésped: ${j.sinClaves.map(esc).join(', ')}.</div>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          ${j.sinClaves.map(u => `<button class="btn-chico" data-ir-editar-clave="${esc(u)}">Cargar ${esc(u)}</button>`).join('')}
        </div>
      </div>`
    : '';

  // Orden POR PRIORIDAD (regla del dueño 24/07): lo más urgente al TOPE; lo ya resuelto ("Completadas
  // hoy") justo antes de lo puramente informativo (Novedades, El bot hoy, agenda).
  render(
    hero(fHoy ? fHoy + ' · la misma agenda de las 6 AM' : null) +
    `<div class="cuerpo-vista">
      ${seccionSinClaves}
      ${seccionConversaciones}
      ${seccionManana}
      ${seccionMov}
      ${seccionProfundaHoy}
      ${sinWa.length ? seccionSinWa : ''}
      ${domHtml}
      ${seccionVencidas}
      ${seccionCompletadas}
      ${seccionNovedades}
      ${seccionBot}
      ${sinWa.length ? '' : seccionSinWa}
      <div id="agenda-sec">${agendaSeccionHTML(null, true)}</div>
    </div>`);
  // Parte H — EL NOMBRE SIEMPRE ABRE MENSAJES. Un solo bloque para TODOS los nombres de la pantalla
  // (check-ins, check-outs, sin WhatsApp, domingo, novedades, conversaciones recientes): los pinta
  // tituloChat con [data-ir-msj]. stopPropagation para no arrastrar al acordeón ni al swipe de fondo.
  document.querySelectorAll('[data-ir-msj]').forEach(b => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    irMensajesDe(b.dataset.irMsj, b.dataset.irMsjNom);
  }));
  // Conversaciones recientes: la tarjeta ENTERA navega (no solo el nombre) — es su única acción.
  document.querySelectorAll('[data-conv]').forEach(card => card.addEventListener('click', (ev) => {
    if (ev.target.closest('button')) return;   // el ✕ (y el propio nombre-link) se manejan aparte
    const c = conversaciones[+card.dataset.conv];
    if (c) irMensajesDe(c.h.codigo, c.h.huesped);
  }));
  document.querySelectorAll('[data-conv-ocultar]').forEach(b => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const c = conversaciones[+b.dataset.convOcultar];
    if (!c) return;
    estado.hechasLocal[c.key] = 1;
    localStorage.setItem('pms_tareas_hechas', JSON.stringify(estado.hechasLocal));
    vistaTareas();
  }));
  // Novedades: tocar la tarjeta abre el chat de ese huésped (el ✕ y el swipe ya hacen stopPropagation).
  // Parte N: con la búsqueda ampliada activa (`nb`) el índice es sobre `nb.items`, no `novVisibles` —
  // las tarjetas de resultado no tienen swipe, así que nunca chocan con `data-swipe-nov`/`data-nov-ocultar`.
  document.querySelectorAll('[data-nov-chat]').forEach(card => card.addEventListener('click', (ev) => {
    if (ev.target.closest('button')) return;
    if (card.dataset.noTap) return;            // venía de un deslizamiento, no de un toque
    const lista = nb ? nb.items : novVisibles;
    const n = lista[+card.dataset.novChat];
    if (n) irMensajesDe(n.codigo, n.huesped);
  }));
  // Lupa: revela/oculta los chips de rango. Búsqueda: pide action:'buscarNovedades' con dias=7/15/30 y
  // reemplaza SOLO el contenido de la sección (mismas tarjetas); "Volver a lo de hoy" restaura
  // bot.novedades sin pedir nada de nuevo.
  const btnLupa = document.getElementById('nov-lupa');
  if (btnLupa) btnLupa.addEventListener('click', () => { estado.novBuscarAbierto = !estado.novBuscarAbierto; vistaTareas(); });
  document.querySelectorAll('[data-nov-dias]').forEach(b => b.addEventListener('click', () => novBuscarIr(+b.dataset.novDias)));
  const btnNovReintentar = document.querySelector('[data-nov-reintentar]');
  if (btnNovReintentar && nb) btnNovReintentar.addEventListener('click', () => novBuscarIr(nb.dias));
  const btnNovVolver = document.getElementById('nov-volver');
  if (btnNovVolver) btnNovVolver.addEventListener('click', () => { estado.novBuscar = null; estado.novBuscarAbierto = false; vistaTareas(); });
  document.querySelectorAll('[data-reintentar]').forEach(b => b.addEventListener('click', () => vistaTareas()));
  document.querySelectorAll('[data-ir-editar-clave]').forEach(b =>
    b.addEventListener('click', () => { estado.uniSel = b.dataset.irEditarClave; estado.cfgTab = 'datos'; irTab('unidades'); }));
  engancharAgendaZoom();
  // La agenda llega por detrás y solo rellena SU sección (no re-pinta HOY entera).
  agProm.then(ag => {
    const cont = document.getElementById('agenda-sec');
    if (!cont) return;                       // el usuario ya cambió de pestaña
    if (ag && !ag.error && ag.img) guardarAgendaLS(ag);
    cont.innerHTML = agendaSeccionHTML(ag, false);
    engancharAgendaZoom();
  }).catch(() => {});

  // Acordeón EN EL SITIO: tocar el resumen abre/cierra su panel. Si trae `data-lazy-unidad` y todavía
  // no se pidió, se carga la primera vez que se abre (mismo costo que antes al entrar a la pantalla
  // aparte). Los controles internos (checkbox, botón, input…) no deben disparar el toggle.
  document.querySelectorAll('[data-notif-toggle]').forEach(res => res.addEventListener('click', (ev) => {
    if (ev.target.closest('input,button,textarea,a,select,label')) return;
    const id = res.dataset.notifToggle;
    const panel = document.getElementById(id);
    if (!panel) return;
    const abrir = panel.classList.contains('oculto');
    panel.classList.toggle('oculto');
    const chev = res.querySelector('.notif-chev');
    if (chev) chev.classList.toggle('abierto', abrir);
    const lazyU = res.dataset.lazyUnidad;
    if (abrir && lazyU && !cargados[id]) cargarPanelLimpieza(id, lazyU, panel);
  }));
  // Paneles que ya nacieron con contenido (los ya sabidos "completados" — checklist de limpieza) se
  // cablean apenas se pintan, sin esperar a que alguien los toque.
  document.querySelectorAll('[data-panel-unidad][data-panel-listo="1"]').forEach(p => {
    cargados[p.dataset.panelUnidad] = true;
    engancharPanelLimpieza(p.dataset.panelUnidad, p);
  });

  // Domingo: SI / NO / CANCELAR. El servidor recalcula la fecha y comprueba que ese domingo entre
  // alguien; los tres avisan al admin por WhatsApp — también la cancelación. Repinta HOY entera desde
  // el servidor (mismo patrón de siempre): el verde no depende de ninguna variable local.
  const DOM_SEL = '[data-dom-si],[data-dom-no],[data-dom-cancelar]';
  const responderDomingo = async (unidad, respuesta, btn) => {
    const msg = btn.closest('.notif-expand').querySelector('[data-dom-msg]');
    const previo = btn.textContent;
    document.querySelectorAll(DOM_SEL).forEach(b => { b.disabled = true; });
    btn.textContent = 'Enviando…';
    try {
      const r = await apiPost({ apiAction: 'confirmarDomingo', unidad, fecha: (j.domingo || {}).fecha, respuesta });
      if (!r.ok) throw new Error(r.error || 'No se pudo guardar');
      estado.cache = {};
      vistaTareas();
    } catch (e) {
      if (msg) { msg.textContent = '⚠️ ' + e.message; msg.style.color = 'var(--crit)'; msg.classList.remove('oculto'); }
      document.querySelectorAll(DOM_SEL).forEach(b => { b.disabled = false; });
      btn.textContent = previo;
    }
  };
  document.querySelectorAll('[data-dom-si]').forEach(b =>
    b.addEventListener('click', () => responderDomingo(b.dataset.domSi, 'SI', b)));
  document.querySelectorAll('[data-dom-no]').forEach(b =>
    b.addEventListener('click', () => responderDomingo(b.dataset.domNo, 'NO', b)));
  document.querySelectorAll('[data-dom-cancelar]').forEach(b =>
    b.addEventListener('click', () => responderDomingo(b.dataset.domCancelar, 'CANCELAR', b)));
  // Profunda de hoy: Confirmo / No confirmo / Cancelar — mismo patrón que Domingo.
  const PROF_SEL = '[data-prof-si],[data-prof-no],[data-prof-cancelar]';
  const responderProfunda = async (unidad, accion, btn) => {
    const pm = btn.closest('.notif-expand').querySelector('[data-prof-msg]');
    const previo = btn.textContent;
    document.querySelectorAll(PROF_SEL).forEach(b => { b.disabled = true; });
    btn.textContent = 'Enviando…';
    try {
      const r = await apiPost({ apiAction: accion, unidad });
      if (!r.ok) throw new Error(r.error || 'No se pudo guardar');
      estado.cache = {};
      vistaTareas();
    } catch (e) {
      if (pm) { pm.textContent = '⚠️ ' + e.message; pm.style.color = 'var(--crit)'; pm.classList.remove('oculto'); }
      document.querySelectorAll(PROF_SEL).forEach(b => { b.disabled = false; });
      btn.textContent = previo;
    }
  };
  document.querySelectorAll('[data-prof-si]').forEach(b =>
    b.addEventListener('click', () => responderProfunda(b.dataset.profSi, 'confirmarProfunda', b)));
  document.querySelectorAll('[data-prof-no]').forEach(b =>
    b.addEventListener('click', () => responderProfunda(b.dataset.profNo, 'rechazarProfunda', b)));
  document.querySelectorAll('[data-prof-cancelar]').forEach(b =>
    b.addEventListener('click', () => responderProfunda(b.dataset.profCancelar, 'cancelarProfunda', b)));
  // REINTENTAR (22/07): insiste por WhatsApp a quien limpia esa unidad para que reconsidere el
  // domingo. NO repinta la vista: la respuesta la da ella en SU app.
  document.querySelectorAll('[data-reint-dom]').forEach(b => b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const msg = $('#nov-msg');
    const previo = b.textContent;
    b.disabled = true; b.textContent = 'Enviando…';
    const pinta = (txt, color) => {
      if (!msg) return;
      msg.textContent = txt; msg.style.color = color; msg.classList.remove('oculto');
    };
    try {
      const r = await apiPost({ apiAction: 'reintentarDomingo', unidad: b.dataset.reintDom, fecha: b.dataset.reintFecha });
      if (!r.ok) throw new Error(r.error || 'No se pudo enviar');
      pinta(`✅ Le volvimos a preguntar a ${r.persona}${r.restantes === 0 ? ' (último intento)' : ''}. Cuando responda en su app, la agenda se actualiza sola.`, 'var(--good)');
      b.classList.add('btn-respondido');
      b.textContent = '✓ Enviado';
    } catch (e) {
      pinta('⚠️ ' + e.message, 'var(--crit)');
      b.disabled = false; b.textContent = previo;
    }
  }));
  // Sin WhatsApp: guardar número — C3 (28/07/2026) doble confirmación (botonConfirmable) en vez de
  // guardar directo al tocar Guardar. Captura persistida (estado.hechasLocal 'wa:') para que la
  // tarjeta quede visible EN ESTA MISMA SECCIÓN (ya no salta a Completadas hoy, ver sinWaDoneHtml).
  sinWa.forEach((r, i) => {
    const idConf = 'wa-guardar-' + i;
    const btn = document.querySelector(`[data-conf-btn="${idConf}"]`), fila = document.querySelector(`[data-conf-fila="${idConf}"]`);
    if (!btn || !fila) return;
    const inp = document.querySelector(`[data-wa="${i}"]`), msg = document.querySelector(`[data-wa-msg="${i}"]`);
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const num = (inp.value || '').replace(/[^\d+]/g, '');
      if (num.replace(/\D/g, '').length < 9) { msg.textContent = 'Escribe un número válido (09… o +593…).'; msg.style.color = 'var(--crit)'; return; }
      btn.classList.add('oculto'); fila.classList.remove('oculto');
    });
    fila.querySelector(`[data-conf-no="${idConf}"]`).addEventListener('click', (ev) => { ev.stopPropagation(); fila.classList.add('oculto'); btn.classList.remove('oculto'); });
    fila.querySelector(`[data-conf-si="${idConf}"]`).addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const num = (inp.value || '').replace(/[^\d+]/g, '');
      const si = fila.querySelector(`[data-conf-si="${idConf}"]`);
      si.disabled = true; si.textContent = 'Guardando…';
      try {
        const res = await apiPost({ apiAction: 'setWhatsappHuesped', unidad: r.unidad, codigo: r.codigo, whatsapp: num });
        if (!res.ok) throw new Error(res.error || '');
        msg.textContent = '✅ Guardado — el bot ya puede atenderlo.'; msg.style.color = 'var(--good)';
        estado.hechasLocal['wa:' + (r.codigo || (r.unidad + '|' + i))] = { unidad: r.unidad, huesped: r.huesped, whatsapp: num, fecha: hoyLocalIso(0), ts: Date.now() };
        localStorage.setItem('pms_tareas_hechas', JSON.stringify(estado.hechasLocal));
        estado.cache = {};
        setTimeout(() => vistaTareas(), 800);
      } catch (e) {
        msg.textContent = 'No se pudo guardar (' + e.message + ').'; msg.style.color = 'var(--crit)';
        si.disabled = false; si.textContent = 'Sí, confirmar';
        fila.classList.add('oculto'); btn.classList.remove('oculto');
      }
    });
  });
  document.querySelectorAll('[data-copiar]').forEach(b => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    copiarTexto(b, sinWa[+b.dataset.copiar].textoAirbnb);
  }));
  // Novedades: deslizar a la izquierda para descartar (mismo mecanismo que las aprobaciones de clave en
  // MENSAJES) + botón ✕ como alternativa sin gesto táctil. Solo horizontal: si el dedo va más en
  // vertical, se suelta para no secuestrar el scroll de la lista.
  const descartarNov = (n) => {
    estado.hechasLocal[novKey(n)] = 1;
    localStorage.setItem('pms_tareas_hechas', JSON.stringify(estado.hechasLocal));
    vistaTareas();
  };
  document.querySelectorAll('[data-swipe-nov]').forEach(caja => {
    const frente = caja.querySelector('.swipe-frente');
    let x0 = null, y0 = null, dx = 0, activo = false;
    frente.addEventListener('touchstart', (ev) => {
      x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; dx = 0; activo = false;
      frente.style.transition = 'none';
    }, { passive: true });
    frente.addEventListener('touchmove', (ev) => {
      if (x0 === null) return;
      const nx = ev.touches[0].clientX - x0, ny = ev.touches[0].clientY - y0;
      if (!activo && Math.abs(nx) < Math.abs(ny)) { x0 = null; return; }
      activo = true;
      dx = Math.min(0, nx);
      frente.style.transform = `translateX(${dx}px)`;
    }, { passive: true });
    frente.addEventListener('touchend', () => {
      if (x0 === null) { frente.style.transform = ''; return; }
      frente.style.transition = 'transform .18s ease';
      const n = novVisibles[+caja.dataset.swipeNov];
      // Parte H: desde que la tarjeta NAVEGA al tocarla, un deslizamiento no puede además contar como
      // tap. Se marca la tarjeta y el handler de [data-nov-chat] la ignora por un instante.
      if (activo) { frente.dataset.noTap = '1'; setTimeout(() => { delete frente.dataset.noTap; }, 350); }
      if (dx < -90) { frente.style.transform = 'translateX(-110%)'; setTimeout(() => descartarNov(n), 160); }
      else frente.style.transform = '';
      x0 = null;
    });
  });
  document.querySelectorAll('[data-nov-ocultar]').forEach(b => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    descartarNov(novVisibles[+b.dataset.novOcultar]);
  }));
  actualizarBadgeTareas();
}

// Novedades → lupa de búsqueda ampliada (Parte N, 29/07/2026): acción EXPLÍCITA del usuario (nunca
// automática) — pide action:'buscarNovedades' con dias=7/15/30 al backend (_apiBuscarNovedades_ en
// api.js, que amplía la ventana de las MISMAS 6-7 fuentes de _apiNovedades_) y guarda el resultado en
// `estado.novBuscar` para que vistaTareas lo pinte. Mismo patrón que el resto de HOY (domingo/profunda/
// sin-WhatsApp): re-renderizar la vista entera con `vistaTareas()` en vez de tocar el DOM a mano — es
// barato porque `api({action:'limpieza'|'tareasbot'})` ya está en caché de esta sesión.
async function novBuscarIr(dias) {
  estado.novBuscar = { dias, cargando: true, items: [], error: null };
  if (estado.tab === 'tareas') vistaTareas();
  try {
    const r = await api({ action: 'buscarNovedades', dias }, false);
    if (r && !r.error) estado.novBuscar = { dias, cargando: false, items: r.novedades || [], error: null };
    else estado.novBuscar = { dias, cargando: false, items: [], error: (r && r.error) || 'No se pudo buscar' };
  } catch (e) {
    estado.novBuscar = { dias, cargando: false, items: [], error: String((e && e.message) || e) };
  }
  if (estado.tab === 'tareas') vistaTareas();
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
  const detalle = del.map(p => {
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
  // C6 (28/07): la lista completa (hasta 9 líneas) ocupaba mucho espacio y competía con el chat real.
  // Se reduce a UN semáforo agregado — detalle completo queda a un toque, sin perder información.
  const off = del.filter(p => p.estado === 'switch_off').length;
  const activo = del.filter(p => p.estado === 'enviado' || p.estado === 'programado').length;
  const luz = off ? 'crit' : (activo ? 'ok' : 'warn');
  const icono = off ? '🔴' : (activo ? '🟢' : '🟡');
  const resumenTxt = off ? `${off} apagado${off === 1 ? '' : 's'}` : (activo ? `${activo} activo${activo === 1 ? '' : 's'}` : `${del.length} pendiente${del.length === 1 ? '' : 's'}`);
  return `<div class="hilo-bot-resumen" data-bot-resumen>
    <span class="pill ${luz}">${icono} Bot · ${resumenTxt}</span>
    <span class="hilo-bot-ver">Ver detalle ▾</span>
  </div>
  <div class="hilo-bot-detalle oculto">${detalle}</div>`;
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
  const norm = normNombre;   // Parte H: normalizador compartido con hiloDeEvento (arriba)
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
  // Parte H (29/07/2026): una reseña 5★ es SIEMPRE de un huésped que ya se fue, o sea de un hilo
  // "pasado" (oculto por defecto). El tag ⭐ existía pero NADIE lo veía nunca. Un 5★ de los últimos 7
  // días —la MISMA ventana con que _apiNovedades_ (api.js) la muestra en HOY— mantiene su hilo VISIBLE:
  // mientras la novedad esté viva en HOY, su conversación se puede abrir sin buscarla.
  const limResenaIso = hoyLocalIso(-7);
  const cincoReciente = h => !!(h.resena && h.resena.estrellas >= 5 && (h.resena.fecha || '') >= limResenaIso);
  const esPasado = h => (h.co || '') < hoyMsjIso && !cincoReciente(h);
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
    // C7 (28/07): reseña recibida + estado del seguimiento del descuento, dentro del hilo — antes no
    // había NINGÚN rastro de la reseña real acá (solo el switch de configuración DESCUENTO_5E). El
    // pill compacto va en el resumen (se ve sin abrir el hilo); el detalle, como burbuja del hilo.
    // Parte H (29/07/2026): COMPACTO — "⭐ 5" y no cinco emojis repetidos, que en el resumen del hilo
    // empujaban la fecha fuera de la línea. Es la marca PERSISTENTE de la reseña: se ve sin abrir el
    // hilo, para siempre (una reseña no caduca como caduca una novedad de HOY).
    const resenaPill = h.resena ? `<span class="pill ${h.resena.estrellas >= 5 ? 'ok' : 'warn'}">⭐ ${esc(h.resena.estrellas)}</span>` : '';
    const resenaHtml = h.resena ? `
      <div class="burbuja-resena">
        <div class="meta">${'⭐'.repeat(Math.round(h.resena.estrellas)) || h.resena.estrellas} Reseña recibida${h.resena.fecha ? ' · ' + fBonita(h.resena.fecha) : ''}</div>
        ${h.resena.estrellas >= 5 ? `<div class="sub" style="margin-top:2px">${h.resena.descuentoEnviado ? '✅ Descuento enviado al huésped' : '⏳ Descuento pendiente de enviar'}</div>` : ''}
      </div>` : '';
    return `<div class="tarjeta tocable hilo${eH.inactivo ? ' inactivo' : ''}" data-hilo="${i}"${esPasado(h) ? ' data-pasado="1" style="display:none"' : ''} data-buscar="${esc(norm(h.huesped + ' ' + h.unidad))}">
      <div class="fila-unidad">${monograma(h.unidad)}
        <div class="resto">
          <div class="tarjeta-fila"><h3>${esc(h.huesped || 'Huésped')}</h3>${resenaPill}<span class="sub">${esc((h.ultimoTs || '').slice(5, 16))}</span></div>
          <div class="sub">${semDot(eH.luz) + (eH.txt ? esc(eH.txt) + ' · ' : '') + (h.ci && h.co ? fBonita(h.ci) + '–' + fBonita(h.co) + ' · ' : '') + esc(h.unidad)}</div>
          <div class="sub hilo-preview">${esc(preview)}${ult.texto && ult.texto.length > 64 ? '…' : ''}</div>
        </div>
      </div>
      ${legendaBot(h, pend)}
      <div class="hilo-mensajes oculto">${burbujas}${resenaHtml}${actividadDe(h)}${responder}</div>
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
    if (ev.target.closest('.hilo-responder') || ev.target.closest('.hilo-bot-resumen')) return;   // escribir/enviar/ver-detalle-bot NO pliegan el hilo
    // Parte H: en cuanto el usuario abre o cierra un hilo A MANO, toma el control — el foco que traía
    // desde HOY se suelta, para que el repintado silencioso no le vuelva a abrir el hilo que cerró.
    estado.mensajesFoco = null;
    card.querySelector('.hilo-mensajes').classList.toggle('oculto');
    card.querySelector('.hilo-preview').classList.toggle('oculto');
  }));
  // C6: el semáforo del bot se expande aparte, sin abrir/cerrar el hilo de mensajes completo.
  document.querySelectorAll('[data-bot-resumen]').forEach(res => res.addEventListener('click', (ev) => {
    ev.stopPropagation();
    res.nextElementSibling.classList.toggle('oculto');
  }));
  // Salto 💬 desde UNIDADES: abrir la conversación de ese huésped y bajar hasta ella. Si no tiene
  // hilo (sin mensajes aún), se deja su nombre en el buscador — la lista vacía lo dice sola.
  // Parte H (29/07/2026): el foco YA NO se consume acá (antes `estado.mensajesFoco = null` en la
  // primera línea). Vive hasta que el usuario SALE de la pestaña (irTab) o colapsa el hilo a mano —
  // si no, el primer repintado silencioso (SWR) volvía a cerrar el hilo recién abierto desde HOY.
  const foco = estado.mensajesFoco;
  if (foco) {
    const iFoco = hilos.findIndex(h => h.codigo && h.codigo === foco.codigo);
    const card = iFoco >= 0 ? document.querySelector(`[data-hilo="${iFoco}"]`) : null;
    if (card) {
      // Un hilo PASADO (checkout ya ocurrido — el caso típico de una reseña 5★) nace con
      // display:none. Sin esto el link "funcionaba" pero no mostraba absolutamente nada.
      card.style.display = '';
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
      // Semáforo: queda verde hasta que escriba otra respuesta (al tipear vuelve a ser una acción).
      b.classList.add('btn-respondido'); b.disabled = false; b.textContent = '✓ Enviado';
      ta.addEventListener('input', () => {
        b.classList.remove('btn-respondido'); b.textContent = '📨 Responder por WhatsApp';
      }, { once: true });
      return;
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
      // Semáforo: el par se colapsa a UN botón verde. "Descartar" se va porque el WhatsApp ya salió
      // y dejarlo ahí ofrecería deshacer algo que no se puede deshacer.
      b.classList.add('btn-respondido');
      b.textContent = '✓ Claves enviadas';
      const desc = document.querySelector(`[data-aprobar-ocultar="${i}"]`);
      if (desc) desc.remove();
      const pill = b.closest('.tarjeta') && b.closest('.tarjeta').querySelector('.pill');
      if (pill) { pill.className = 'pill ok'; pill.textContent = 'CLAVES ENVIADAS'; }
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

/* ---------- Vista: FOTOS (el "+" central de la tabbar, TODOS los roles — atajo al inventario) ---------- */
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
      <div class="sub" style="margin-bottom:10px">Elige la unidad. En la pantalla siguiente tomas la foto, escribes en 3 palabras qué pasó y, si es una factura, la marcas como gasto (se lee el monto solo y se reparte entre las unidades que elijas).</div>
      ${cards || '<div class="vacio">No hay unidades visibles para tu usuario.</div>'}
    </div>`);
  document.querySelectorAll('[data-foto-u]').forEach(el =>
    el.addEventListener('click', () => vistaInventario(el.dataset.fotoU)));
}

/* ---------- Vista: REPORTES (réplica del reporte mensual de marca) ---------- */
/* T7.2 (corrección del dueño): línea gris con totales, chips ROJOS de unidad, y pestañas POR UNIDAD
 * con la info ya desplegada — espejo de lo que el bot envía por
 * WhatsApp: Reporte Operativo (default; serie COMPLETA de admins) y Reporte Mensual (SOLO lo que
 * recibe el propietario — sin botón de envío desde el 26/07/2026, no había propietarios externos
 * reales usándolo). Siempre del mes en curso — sin nav de mes; el
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
  // Fusión 28/07/2026 (pedido del dueño): "Reporte Operativo" y "Reporte Mensual" eran casi el mismo
  // reporte dos veces (calendario del mes actual y el marcador eran literalmente la misma imagen en
  // ambos) — ahora es uno solo, 'operativo'. Mismo día: 3ra pestaña 'egresos' (limpieza personal +
  // gastos por factura, trasladados desde la tarjeta LIMPIEZAS que antes vivía en Ingresos).
  if (['operativo', 'ingresos', 'egresos', 'limpieza'].indexOf(estado.repVista) === -1) estado.repVista = 'operativo';

  // Consolidado del mes: totales para la línea gris + ingresos por unidad para ordenar los chips.
  const g = await api({ action: 'reporteglobal', anio: A, mes: M });
  if (g.error) throw new Error(g.error);
  const k = g.kpis || {};
  const mesTit = MES[M - 1][0].toUpperCase() + MES[M - 1].slice(1);

  let lista = [...(g.unidades || [])];
  if (!lista.length) lista = (estado.yo.unidades || []).map(u => ({ unidad: u, ingresos: 0 }));
  // El selector "ordenar por" se retiró de REPORTES (28/07/2026, pedido del dueño): mismo criterio que
  // UNIDADES (22/07/2026) — las unidades van siempre alfabéticas, sin selector que estorbe.
  lista.sort((a, b) => a.unidad.localeCompare(b.unidad));
  if (!estado.repUnidad || estado.repUnidad === '*' || !lista.some(f => f.unidad === estado.repUnidad)) {
    estado.repUnidad = (lista[0] || {}).unidad || '';
  }
  const U = estado.repUnidad, vista = estado.repVista;

  const chips = lista.map(f =>
    `<button class="chipu ${f.unidad === U ? 'sel' : ''}" data-rep-unidad="${esc(f.unidad)}">${esc(f.unidad)}</button>`).join('');
  const nU = g.nUnidades || lista.length;

  render(
    hero(`${mesTit} ${A} · $${Number(k.ingresos || 0).toFixed(2)} ingresos · ${k.ocupacion || 0}% ocupación · $${k.revpar || 0} RevPAR · ${nU} unidad${nU === 1 ? '' : 'es'}`) +
    `<div class="cuerpo-vista">
      <div class="rep-barra ${vista === 'limpieza' ? 'oculto' : ''}">
        <div class="rep-chips">${chips}</div>
      </div>
      <div class="chips subtabs">
        <button class="chip ${vista === 'operativo' ? 'activo' : ''}" data-rep-vista="operativo">Operativo</button>
        <button class="chip ${vista === 'ingresos' ? 'activo' : ''}" data-rep-vista="ingresos">Ingresos</button>
        <button class="chip ${vista === 'egresos' ? 'activo' : ''}" data-rep-vista="egresos">Egresos</button>
        <button class="chip ${vista === 'limpieza' ? 'activo' : ''}" data-rep-vista="limpieza">Limpieza</button>
      </div>
      <div id="rep-cont"></div>
      ${vista === 'limpieza' ? '' : glosarioReportes()}
    </div>`);

  document.querySelectorAll('[data-rep-unidad]').forEach(c =>
    c.addEventListener('click', () => { estado.repUnidad = c.dataset.repUnidad; irTab('reportes'); }));
  const selChip = document.querySelector('.chipu.sel');
  if (selChip) selChip.scrollIntoView({ block: 'nearest', inline: 'center' });
  document.querySelectorAll('[data-rep-vista]').forEach(b =>
    b.addEventListener('click', () => { estado.repVista = b.dataset.repVista; irTab('reportes'); }));

  // La pestaña activa carga sola, sin bloquear los controles de arriba (el shell ya es usable).
  if (vista === 'ingresos') cargarReporteIngresos(U);
  else if (vista === 'egresos') cargarReporteEgresos(U);
  else if (vista === 'limpieza') cargarReporteLimpieza();
  else cargarReportePng(U);
}

/* Los PNG del CRM viven en Drive con URL uc?export=download (perfecta para WhatsApp/YCloud), pero
 * Chrome NO pinta en <img> respuestas con Content-Disposition: attachment. Para mostrarlas en la app
 * se reescribe al endpoint thumbnail (sirve la imagen inline, mismo archivo público). */
function imgDrive(url) {
  const m = String(url || '').match(/drive\.google\.com\/uc\?[^"']*id=([\w-]+)/);
  return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w2000' : url;
}

/* PRECARGA al entrar (22/07/2026): en segundo plano se calientan TODAS las unidades visibles — no
 * solo la primera, que era lo que dejaba con lag cualquier otro chip. Favoritas ★ primero (es lo que
 * las pestañas abren por defecto). Por unidad:
 *   · el DETALLE (`unidad`) — check-ins/check-outs — para TODOS los roles;
 *   · si ve ingresos: la serie del REPORTE fusionado, y sus PNG (no el marcador nativo) con
 *     new Image(), que el service worker deja en pms-img-v1.
 * Con el cerebro D1 cada pedido es ~0.2 s. Secuencial a propósito (no dispara 20 fetches a la vez
 * contra Apps Script si D1 falla) y con catch mudo: nada bloquea ni se ve. */
function precalentarReportes() {
  if (!estado.yo) return;
  const unis = (estado.yo.unidades || []).slice().sort((a, b) => String(a).localeCompare(String(b)));
  if (!unis.length) return;
  const veIng = !!estado.yo.veIngresos;
  const enCalma = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 8000 }) : setTimeout(fn, 3000));
  enCalma(async () => {
    for (const U of unis) {
      try {
        // El DETALLE va primero y para TODOS los roles: es la sección de check-ins/check-outs de
        // UNIDADES, lo que hacía esperar al cambiar de chip. Limpieza también entra acá (no ve
        // reportes, pero sí el detalle de sus unidades).
        await api({ action: 'unidad', unidad: U });
        if (!veIng) continue;
        const j = await api({ action: 'reportepng', unidad: U });
        // im.datos = marcador nativo (sin imagen que precargar, se pinta con los números crudos).
        if (j && !j.error) (j.imagenes || []).forEach(im => { if (!im.datos) new Image().src = imgDrive(im.url); });
      } catch (e) { /* la siguiente unidad igual se intenta */ }
    }
  });
}

/* REPORTES fusionado (28/07/2026, antes eran dos pestañas — Operativo y Mensual — que se solapaban
 * casi por completo: el calendario del mes actual y el marcador eran literalmente la misma imagen en
 * ambas). Llena #rep-cont con la serie POR UNIDAD, espejo de lo que el bot manda por WhatsApp
 * (reportepng → _serieReporteUnidadUrls_ en reportes.js del CRM: calendarios actual+próximo, ingresos
 * año-vs-año, RevPAR diario, marcador nativo) + resumen en texto + nota. */
async function cargarReportePng(U) {
  const cont = $('#rep-cont');
  if (!cont) return;
  const mi = ++repReq;   // toda carga nueva (aun de caché) invalida las respuestas en vuelo

  cont.innerHTML = `<div class="sub" style="margin:2px 4px 8px">Unidad ${esc(U)} · la serie completa que el bot envía por WhatsApp</div>
    <div id="rep-hojas"><div class="vacio">⏳ Cargando las gráficas de ${esc(U)}…<br><span class="sub">Se pre-generan de madrugada. Si aún no están listas, la primera vez tarda ~20-30 segundos.</span></div></div>`;

  // CON caché (22/07/2026): antes iba con `false` — "son respuestas pesadas y por sesión basta" —
  // y eso apagaba localStorage Y el cerebro D1, así que al cerrar la app se perdía TODO y las
  // gráficas volvían a tardar. El payload real son ~5 URLs + títulos (≈1 KB): lo que pesa son los
  // PNG, y esos los guarda el service worker. Ahora manda api(): memoria → localStorage → red, con
  // stale-while-revalidate (pinta la serie de ayer al instante y se repinta sola con la del día).
  let j;
  try { j = await api({ action: 'reportepng', unidad: U }); }
  catch (e) { j = { error: e.message }; }
  if (mi !== repReq || estado.tab !== 'reportes') return;   // el usuario ya pidió otra cosa
  const hojas = $('#rep-hojas');
  if (!hojas) return;
  if (j.error) { hojas.innerHTML = `<div class="vacio">⚠️ ${esc(j.error)}</div>`; return; }
  // El marcador trae `.datos` en vez de imagen — se pinta como componente nativo (barras verticales
  // legibles, número real) en vez de la imagen QuickChart.
  const imgs = (j.imagenes || []).map(im => im.datos
    ? `${tituloSeccion(esc(im.titulo))}<div class="tarjeta">${marcadorNativo(im.datos)}</div>`
    : `${tituloSeccion(esc(im.titulo))}
      <a href="${esc(im.url)}" target="_blank" rel="noopener"><img class="rep-img" src="${esc(imgDrive(im.url))}" alt="${esc(im.titulo)}"></a>`
  ).join('');
  const resumen = String(j.resumen || '').replace(/\*/g, '');
  const propCta = (j.propietario && j.propietario.tieneWa)
    ? `<button id="op-enviar" class="chip">📤 Enviar PDF al propietario${j.propietario.nombre ? ' (' + esc(j.propietario.nombre) + ')' : ''}</button>`
    : `<div class="sub">Para enviar el PDF, configura el propietario en <a href="#" class="enlace-wa" data-ir-prop-unidad>Unidades → Datos y configuración</a>.</div>`;
  hojas.innerHTML = `${imgs || '<div class="vacio">No se generaron gráficas — reintenta en un momento.</div>'}
    ${resumen ? `<div class="tarjeta"><div class="sub" style="white-space:pre-line">${esc(resumen)}</div></div>` : ''}
    ${j.nota ? `<div class="tarjeta"><div class="sub">${esc(j.nota)}</div></div>` : ''}
    <div class="tarjeta">${propCta}<div id="op-msg" class="sub oculto" style="margin-top:6px"></div></div>`;

  const avisoOp = (txt, esError) => {
    const el = $('#op-msg'); if (!el) return;
    el.textContent = txt; el.style.color = esError ? 'var(--crit)' : 'var(--good)'; el.classList.remove('oculto');
  };
  const bEnviarOp = $('#op-enviar');
  if (bEnviarOp) bEnviarOp.addEventListener('click', async () => {
    bEnviarOp.disabled = true; const txtOrig = bEnviarOp.textContent; bEnviarOp.textContent = 'Enviando…';
    try {
      const r = await apiPost({ apiAction: 'enviarOperativoProp', unidad: U });
      if (!r.ok) throw new Error(r.error === 'sin_propietario' ? 'la unidad no tiene WhatsApp de propietario' : (r.error || 'error'));
      avisoOp('✅ Enviado a ' + (r.propietario || 'propietario') + '.');
      bEnviarOp.textContent = txtOrig;
    } catch (e) { avisoOp('No se pudo enviar (' + e.message + ').', true); bEnviarOp.textContent = txtOrig; }
    finally { bEnviarOp.disabled = false; }
  });
  document.querySelectorAll('[data-ir-prop-unidad]').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault(); estado.uniSel = U; estado.cfgTab = 'datos'; irTab('unidades');
  }));
}

// Marcador del mes NATIVO (28/07/2026, reemplaza la imagen QuickChart en la app — sigue existiendo
// como PNG para WhatsApp, ver cfgMarcadorMesStr_ en reportes.js). 4 barras verticales con la base
// semánticamente correcta de cada una (no todas sobre "reservas" como la versión QuickChart vieja):
// reseñas/profundas sobre checkouts del mes, 5★ sobre reseñas recibidas, WhatsApp sobre reservas.
// El tag muestra el NÚMERO REAL, nunca el % — el % solo define la altura de la barra.
function marcadorNativo(d) {
  const pct = (n, base) => base > 0 ? Math.min(100, Math.round((n || 0) / base * 100)) : 0;
  const checkouts = d.limpiezas || 0;
  const barras = [
    { n: d.resenasTotal, base: checkouts, lbl: 'Reseñas', ico: '📝', color: 'var(--brand)' },
    { n: d.cinco, base: d.resenasTotal, lbl: '5 estrellas', ico: '⭐', color: 'var(--good)' },
    { n: d.profundas, base: checkouts, lbl: 'Profundas', ico: '🧽', color: 'var(--warn)' },
    { n: d.waCon, base: d.reservas, lbl: 'WhatsApp', ico: '💬', color: 'var(--good)' },
  ];
  const cols = barras.map(b => {
    const h = Math.max(6, pct(b.n, b.base));
    return `<div class="marc-col">
      <div class="marc-tag"><span class="marc-tag-ico">${b.ico}</span>${b.n || 0}</div>
      <div class="marc-pista"><div class="marc-barra" style="height:${h}%;background:${b.color}"></div></div>
      <div class="marc-lbl">${b.lbl}</div>
    </div>`;
  }).join('');
  const ocup = d.ocupCuenca != null ? `Ocupación ${Math.round(d.ocupUnidad || 0)}% vs Cuenca ${Math.round(d.ocupCuenca)}%`
    : (d.ocupUnidad != null ? `Ocupación ${Math.round(d.ocupUnidad)}%` : '');
  return `<div class="sub" style="margin-bottom:6px">${d.reservas || 0} reservas · ${checkouts} check-outs${ocup ? ' · ' + ocup : ''}</div>
    <div class="marc-barras">${cols}</div>`;
}

/* INGRESOS (28/07/2026): lista de PAGOS que Airbnb depositó ese mes — una fila por payout (fecha +
 * cuántas reservas venían adentro + monto), NUNCA un desglose por huésped. SOLO admins/CEO dueño
 * (mismo gate que el resto de REPORTES; el backend además re-valida con _puedePedirReporteUnidad_).
 * REGLA DEL DUEÑO: el mes que cuenta es el mes del PAGO (action `ingresos` en el CRM agrupa por
 * fecha_payout), NO el checkout de la reserva que lo originó — "se cobra la administración por el
 * pago hecho efectivo ese mes; si sale el siguiente mes, el cobro se deriva al siguiente mes". El %
 * de administración es PORCENTAJE_ADMIN_<u> en CONFIGURACION (config-driven, no hardcodeado por
 * unidad). El propietario (nombre/WhatsApp) vive en FICHA_UNIDAD y se edita en Datos y configuración,
 * ya inline en Unidades: si falta, el botón lleva ahí en vez de bloquear. (Parte O v2, 29/07/2026: se
 * quitó el campo de Observaciones de este reporte — esa nota queda SOLO para las fotos de UNIDAD.) */
async function cargarReporteIngresos(U) {
  const cont = $('#rep-cont');
  if (!cont) return;
  const mi = ++repReq;
  const hoy = new Date();
  if (!estado.repIngAnio) estado.repIngAnio = hoy.getFullYear();
  if (!estado.repIngMes) estado.repIngMes = hoy.getMonth() + 1;
  const A = estado.repIngAnio, M = estado.repIngMes;
  const mesTit = MES[M - 1][0].toUpperCase() + MES[M - 1].slice(1);

  cont.innerHTML = `
    <div class="rep-barra">
      <button id="ing-prev" class="chip">◀</button>
      <div class="sub" style="flex:1;text-align:center">${mesTit} ${A} · por fecha de pago</div>
      <button id="ing-next" class="chip">▶</button>
    </div>
    <div id="ing-cont"><div class="vacio">⏳ Cargando ingresos de ${esc(U)}…</div></div>`;

  $('#ing-prev').addEventListener('click', () => {
    let m = M - 1, a = A; if (m < 1) { m = 12; a--; }
    estado.repIngMes = m; estado.repIngAnio = a; irTab('reportes');
  });
  $('#ing-next').addEventListener('click', () => {
    let m = M + 1, a = A; if (m > 12) { m = 1; a++; }
    estado.repIngMes = m; estado.repIngAnio = a; irTab('reportes');
  });

  let j;
  try { j = await api({ action: 'ingresos', unidad: U, anio: A, mes: M }); }
  catch (e) { j = { error: e.message }; }
  if (mi !== repReq || estado.tab !== 'reportes') return;
  const ingCont = $('#ing-cont');
  if (!ingCont) return;
  if (j.error) { ingCont.innerHTML = `<div class="vacio">⚠️ ${esc(j.error)}</div>`; return; }

  // Tabla de PAGOS (28/07/2026, corrección del dueño): INGRESOS es la lista de PAYOUTS que Airbnb
  // depositó ese mes — una fila por depósito (fecha + cuántas reservas venían adentro + monto), NUNCA
  // un desglose por huésped fijo en la tabla. El mes que cuenta es el mes del PAGO, no el checkout.
  // Detalle SIEMPRE visible (Parte O v2, 29/07/2026, corregido tras verlo en vivo): cada fila de pago
  // muestra debajo, sin tocar nada, de qué reservas viene ese depósito — la MISMA info ya reconciliada
  // del correo (huésped/estadía/monto), la "verdad única", no un dato nuevo.
  const filaDetalle = (d, i) => `
    <tr class="fila-detalle ${i % 2 ? 'fila-par' : 'fila-impar'}">
      <td></td><td colspan="2">↳ ${esc(d.huesped)} · ${fBonita(d.checkin)}-${fBonita(d.checkout)}</td><td>$${d.monto.toFixed(2)}</td>
    </tr>`;
  const filaPago = (p, i) => `
    <tr class="fila-pago ${i % 2 ? 'fila-par' : 'fila-impar'}">
      <td>${i + 1}</td>
      <td>${fBonita(p.fechaPago)}</td>
      <td>${p.cantidadReservas}</td>
      <td>$${p.monto.toFixed(2)}</td>
    </tr>
    ${(p.detalle || []).map((d) => filaDetalle(d, i)).join('')}`;
  const pagos = j.pagos || [];
  const pagosHtml = pagos.length ? pagos.map(filaPago).join('') : `<tr><td colspan="4" class="vacio">Sin payouts recibidos este mes.</td></tr>`;

  // Sin ningún payout este mes, el backend igual rechaza el envío (fail-closed) — pero deshabilitarlo
  // acá evita el viaje redondo y deja claro POR QUÉ no se puede mandar todavía.
  const sinPagos = !pagos.length;
  const propCta = (j.propietario && j.propietario.tieneWa)
    ? `<button id="ing-enviar" class="chip" ${sinPagos ? 'disabled title="Sin payouts recibidos este mes"' : ''}>📤 Enviar PDF al propietario${j.propietario.nombre ? ' (' + esc(j.propietario.nombre) + ')' : ''}</button>`
    : `<div class="sub">Para enviar el PDF, configura el propietario en <a href="#" class="enlace-wa" data-ir-prop-unidad>Unidades → Datos y configuración</a>.</div>`;

  // Encabezado tipo factura (Parte O v2, 29/07/2026, pedido del dueño): SIN logo — solo el membrete
  // "1242BNB" en rojo marca — y SOLO Unidad/Administrador (Propietario se retiró de acá: ya vive en el
  // botón "Enviar PDF al propietario" de abajo). Administrador = auth.nombre (tu propio nombre editado
  // en Mis Datos → Tus datos), no un texto fijo por unidad — quien mira este reporte YA ES el admin de
  // esta unidad (gate _puedePedirReporteUnidad_).
  const facturaHead = `
    <div class="tarjeta factura-head">
      <div class="factura-top">
        <div class="factura-marca">1242BNB</div>
        <div class="factura-num">Reporte de ingresos<br><b>${mesTit} ${A}</b></div>
      </div>
      <div class="factura-linea"></div>
      <div class="factura-partes">
        <div class="factura-parte"><div class="k">Unidad</div><div class="v">${esc(U)}</div></div>
        <div class="factura-parte" style="text-align:right"><div class="k">Administrador</div><div class="v">${esc(j.admin || '—')}</div></div>
      </div>
    </div>`;

  ingCont.innerHTML = `
    ${facturaHead}
    ${j.sinColumnaPayout ? `<div class="tarjeta"><div class="sub" style="color:var(--crit)">⚠️ Todavía no le ha llegado NINGÚN payout a esta unidad — el TOTAL de abajo es $0 real, no un error. No envíes el PDF al propietario hasta que haya al menos un payout registrado.</div></div>` : ''}
    ${j.descartadas ? `<div class="tarjeta"><div class="sub" style="color:var(--crit)">⚠️ ${j.descartadas} payout(s) con monto o fecha ilegible se excluyeron del total — revisa la hoja de ${esc(U)} antes de cobrar.</div></div>` : ''}
    <div class="tarjeta" style="overflow-x:auto">
      <table class="tabla-ingresos" style="width:100%;border-collapse:collapse">
        <thead><tr><th>No.</th><th>Fecha de pago</th><th>Reservas</th><th>Monto</th></tr></thead>
        <tbody>${pagosHtml}</tbody>
      </table>
    </div>
    <div class="tarjeta">
      <table class="tabla-total">
        <tr><td>TOTAL</td><td>$${j.total.toFixed(2)}</td></tr>
        <tr><td>${j.pctAdmin}% ADMINISTRACIÓN <button id="ing-pct-edit" class="pct-edit" title="Editar porcentaje">✎</button></td><td>$${j.montoAdmin.toFixed(2)}</td></tr>
      </table>
      <div id="ing-pct-caja" class="oculto" style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <input class="campo" id="ing-pct-input" type="number" min="0" max="100" step="0.1" value="${j.pctAdmin}" style="width:90px;margin:0">
        <button id="ing-pct-guardar" class="chip">Guardar %</button>
      </div>
      <div id="ing-pct-msg" class="sub oculto" style="margin-top:6px"></div>
    </div>
    <div class="tarjeta">
      ${propCta}
      <div class="doc-botones">
        <button id="ing-export" class="chip">⬇ Exportar / Compartir</button>
      </div>
      <div id="ing-msg" class="sub oculto" style="margin-top:8px"></div>
    </div>`;

  const aviso = (txt, esError) => {
    const el = $('#ing-msg'); if (!el) return;
    el.textContent = txt; el.style.color = esError ? 'var(--crit)' : 'var(--good)'; el.classList.remove('oculto');
  };

  const bEnviar = $('#ing-enviar');
  if (bEnviar) bEnviar.addEventListener('click', async () => {
    bEnviar.disabled = true; const txtOrig = bEnviar.textContent; bEnviar.textContent = 'Enviando…';
    try {
      const r = await apiPost({ apiAction: 'enviarIngresosProp', unidad: U, anio: A, mes: M });
      if (!r.ok) throw new Error(r.error === 'sin_propietario' ? 'la unidad no tiene WhatsApp de propietario' : (r.error || 'error'));
      aviso('✅ Enviado a ' + (r.propietario || 'propietario') + '.');
      bEnviar.textContent = txtOrig;
    } catch (e) { aviso('No se pudo enviar (' + e.message + ').', true); bEnviar.textContent = txtOrig; }
    finally { bEnviar.disabled = false; }
  });

  const bExport = $('#ing-export');
  if (bExport) bExport.addEventListener('click', async () => {
    bExport.disabled = true; const txtOrig = bExport.textContent; bExport.textContent = 'Generando…';
    try {
      const r = await apiPost({ apiAction: 'ingresosPdfUrl', unidad: U, anio: A, mes: M });
      if (!r.ok) throw new Error(r.error || 'error');
      if (navigator.share) await navigator.share({ title: 'Reporte de ingresos ' + U, url: r.url });
      else window.open(r.url, '_blank');
    } catch (e) { if (e.name !== 'AbortError') aviso('No se pudo exportar (' + e.message + ').', true); }
    finally { bExport.disabled = false; bExport.textContent = txtOrig; }
  });

  document.querySelectorAll('[data-ir-prop-unidad]').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault(); estado.uniSel = U; estado.cfgTab = 'datos'; irTab('unidades');
  }));

  // % de administración editable inline (mismo patrón EDITAR-revela-caja de CLAVES_TEXTO en
  // Datos y configuración: toggle .oculto, sin modal). Guarda vía el mismo editarUnidad que ya usa el
  // editor completo — un solo endpoint para el % en toda la app, nunca dos fuentes de verdad.
  const avisoPct = (txt, esError) => {
    const el = $('#ing-pct-msg'); if (!el) return;
    el.textContent = txt; el.style.color = esError ? 'var(--crit)' : 'var(--good)'; el.classList.remove('oculto');
  };
  const bPctEdit = $('#ing-pct-edit');
  if (bPctEdit) bPctEdit.addEventListener('click', () => {
    $('#ing-pct-caja').classList.toggle('oculto');
    if (!$('#ing-pct-caja').classList.contains('oculto')) $('#ing-pct-input').focus();
  });
  const bPctGuardar = $('#ing-pct-guardar');
  if (bPctGuardar) bPctGuardar.addEventListener('click', async () => {
    bPctGuardar.disabled = true;
    try {
      const r = await apiPost({ apiAction: 'editarUnidad', unidad: U, porcentajeAdmin: $('#ing-pct-input').value });
      if (!r.ok) throw new Error(r.error || 'error');
      invalidarClave({ action: 'ingresos', unidad: U, anio: A, mes: M });
      invalidarClave({ action: 'unidadeditar', unidad: U });
      avisoPct('✅ % guardado.');
      cargarReporteIngresos(U);
    } catch (e) { avisoPct('No se pudo guardar (' + e.message + ').', true); }
    finally { bPctGuardar.disabled = false; }
  });
}

/* EGRESOS (28/07/2026, pestaña nueva de REPORTES): limpieza (personal, tarifa entre semana/fin de
 * semana — tarjeta trasladada tal cual desde Ingresos, porque es un gasto, no un ingreso) + gastos
 * registrados por factura (foto+Gemini vía WhatsApp "gasto <U>", _facturaGastoDesdeBot_ en el CRM) +
 * TOTAL EGRESOS tabulado. Mes propio (independiente del mes de Ingresos). Sin cantidad/precio unitario
 * por gasto: Gemini solo extrae monto+proveedor+items en texto libre, así que la lista va plana. */
async function cargarReporteEgresos(U) {
  const cont = $('#rep-cont');
  if (!cont) return;
  const mi = ++repReq;
  const hoy = new Date();
  if (!estado.repEgrAnio) estado.repEgrAnio = hoy.getFullYear();
  if (!estado.repEgrMes) estado.repEgrMes = hoy.getMonth() + 1;
  const A = estado.repEgrAnio, M = estado.repEgrMes;
  const mesTit = MES[M - 1][0].toUpperCase() + MES[M - 1].slice(1);

  cont.innerHTML = `
    <div class="rep-barra">
      <button id="egr-prev" class="chip">◀</button>
      <div class="sub" style="flex:1;text-align:center">${mesTit} ${A}</div>
      <button id="egr-next" class="chip">▶</button>
    </div>
    <div id="egr-cont"><div class="vacio">⏳ Cargando egresos de ${esc(U)}…</div></div>`;

  $('#egr-prev').addEventListener('click', () => {
    let m = M - 1, a = A; if (m < 1) { m = 12; a--; }
    estado.repEgrMes = m; estado.repEgrAnio = a; irTab('reportes');
  });
  $('#egr-next').addEventListener('click', () => {
    let m = M + 1, a = A; if (m > 12) { m = 1; a++; }
    estado.repEgrMes = m; estado.repEgrAnio = a; irTab('reportes');
  });

  let j;
  try { j = await api({ action: 'egresos', unidad: U, anio: A, mes: M }); }
  catch (e) { j = { error: e.message }; }
  if (mi !== repReq || estado.tab !== 'reportes') return;
  const egrCont = $('#egr-cont');
  if (!egrCont) return;
  if (j.error) { egrCont.innerHTML = `<div class="vacio">⚠️ ${esc(j.error)}</div>`; return; }

  const L = j.limpiezas || { activo: false, entreSemana: 0, finde: 0, costoSemana: 0, costoFinde: 0, total: 0 };
  const DIAS_CHIP = [['LUN', 'L'], ['MAR', 'M'], ['MIE', 'M'], ['JUE', 'J'], ['VIE', 'V'], ['SAB', 'S'], ['DOM', 'D']];
  const diasFindeSel = j.diasFindeLimpieza || ['DOM'];

  const gastos = (j.gastos && j.gastos.lista) || [];
  const filaGasto = (g, i) => `
    <tr class="tocable ${i % 2 ? 'fila-par' : 'fila-impar'}" data-gasto="${i}">
      <td>${i + 1}</td>
      <td>${fBonita(g.fecha)}</td>
      <td>${esc(g.item || '(sin descripción)')}</td>
      <td>$${Number(g.monto).toFixed(2)}</td>
    </tr>
    <tr class="oculto ${i % 2 ? 'fila-par' : 'fila-impar'}" data-gasto-detalle="${i}"><td></td><td colspan="3">
      <div class="sub">${esc(g.quien || '')}${g.url ? ' · <a class="enlace-wa" target="_blank" rel="noopener" href="' + esc(g.url) + '">recibo ↗</a>' : ''}</div>
    </td></tr>`;
  const gastosHtml = gastos.length ? gastos.map(filaGasto).join('') : `<tr><td colspan="4" class="vacio">Sin gastos registrados este mes.</td></tr>`;

  const totalGastos = (j.gastos && j.gastos.total) || 0;
  const sinEgresos = !gastos.length && !(L.activo && L.total > 0);
  const propCta = (j.propietario && j.propietario.tieneWa)
    ? `<button id="egr-enviar" class="chip" ${sinEgresos ? 'disabled title="Sin egresos registrados este mes"' : ''}>📤 Enviar PDF al propietario${j.propietario.nombre ? ' (' + esc(j.propietario.nombre) + ')' : ''}</button>`
    : `<div class="sub">Para enviar el PDF, configura el propietario en <a href="#" class="enlace-wa" data-ir-prop-unidad>Unidades → Datos y configuración</a>.</div>`;

  egrCont.innerHTML = `
    <div class="tarjeta">
      <div class="switch-fila">
        <span style="flex:1;min-width:0"><span class="quien" style="font-weight:800">🧹 Limpiezas</span><br>
          <span class="sub">${L.activo ? `${L.entreSemana} entre semana + ${L.finde} fin de semana = $${L.total.toFixed(2)} este mes` : 'Apagado — no se cuenta el gasto de limpieza en este reporte'}</span></span>
        <label class="toggle"><input type="checkbox" id="egr-limp-on" ${L.activo ? 'checked' : ''}><span class="track"></span></label>
      </div>
      <div id="egr-limp-caja" class="${L.activo ? '' : 'oculto'}" style="margin-top:10px">
        <label class="campo-label">Costo entre semana ($)</label>
        <input class="campo" id="egr-limp-semana" type="number" min="0" step="0.01" value="${L.costoSemana}">
        <label class="campo-label">Costo fin de semana ($)</label>
        <input class="campo" id="egr-limp-finde" type="number" min="0" step="0.01" value="${L.costoFinde}">
        <label class="campo-label">Días que cuentan como fin de semana</label>
        <div class="chips" id="egr-limp-dias">
          ${DIAS_CHIP.map(d => `<button type="button" class="chip ${diasFindeSel.indexOf(d[0]) !== -1 ? 'activo' : ''}" data-dia="${d[0]}">${d[1]}</button>`).join('')}
        </div>
        <button id="egr-limp-guardar" class="btn btn-mini" style="margin-top:8px">Guardar limpieza</button>
      </div>
      <div id="egr-limp-msg" class="sub oculto" style="margin-top:6px"></div>
    </div>
    <div class="tarjeta" style="overflow-x:auto">
      ${tituloSeccion('Gastos', 'por factura, registrados desde WhatsApp')}
      <table class="tabla-ingresos" style="width:100%;border-collapse:collapse">
        <thead><tr><th>No.</th><th>Fecha</th><th>Descripción</th><th>Monto</th></tr></thead>
        <tbody>${gastosHtml}</tbody>
      </table>
    </div>
    <div class="tarjeta">
      <table class="tabla-total">
        <tr><td>Limpieza (personal)</td><td>$${L.total.toFixed(2)}</td></tr>
        <tr><td>Gastos</td><td>$${totalGastos.toFixed(2)}</td></tr>
        <tr><td>TOTAL EGRESOS</td><td>$${(L.total + totalGastos).toFixed(2)}</td></tr>
      </table>
    </div>
    <div class="tarjeta">${propCta}<div id="egr-msg" class="sub oculto" style="margin-top:8px"></div></div>`;

  document.querySelectorAll('[data-gasto]').forEach(fila => fila.addEventListener('click', () => {
    const det = document.querySelector(`[data-gasto-detalle="${fila.dataset.gasto}"]`);
    if (det) det.classList.toggle('oculto');
  }));

  const aviso = (txt, esError) => {
    const el = $('#egr-msg'); if (!el) return;
    el.textContent = txt; el.style.color = esError ? 'var(--crit)' : 'var(--good)'; el.classList.remove('oculto');
  };

  const bEnviar = $('#egr-enviar');
  if (bEnviar) bEnviar.addEventListener('click', async () => {
    bEnviar.disabled = true; const txtOrig = bEnviar.textContent; bEnviar.textContent = 'Enviando…';
    try {
      const r = await apiPost({ apiAction: 'enviarEgresosProp', unidad: U, anio: A, mes: M });
      if (!r.ok) throw new Error(r.error === 'sin_propietario' ? 'la unidad no tiene WhatsApp de propietario' : (r.error || 'error'));
      aviso('✅ Enviado a ' + (r.propietario || 'propietario') + '.');
      bEnviar.textContent = txtOrig;
    } catch (e) { aviso('No se pudo enviar (' + e.message + ').', true); bEnviar.textContent = txtOrig; }
    finally { bEnviar.disabled = false; }
  });

  document.querySelectorAll('[data-ir-prop-unidad]').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault(); estado.uniSel = U; estado.cfgTab = 'datos'; irTab('unidades');
  }));

  // LIMPIEZAS: switch revela costos + días (mismo patrón que ya usaba esta tarjeta en Ingresos, solo
  // con ids egr-* para no chocar si algún día ambas tarjetas coexisten en el DOM).
  const avisoLimp = (txt, esError) => {
    const el = $('#egr-limp-msg'); if (!el) return;
    el.textContent = txt; el.style.color = esError ? 'var(--crit)' : 'var(--good)'; el.classList.remove('oculto');
  };
  const chkLimpOn = $('#egr-limp-on');
  if (chkLimpOn) chkLimpOn.addEventListener('change', () => {
    $('#egr-limp-caja').classList.toggle('oculto', !chkLimpOn.checked);
  });
  document.querySelectorAll('#egr-limp-dias [data-dia]').forEach(b =>
    b.addEventListener('click', () => b.classList.toggle('activo')));
  const bLimpGuardar = $('#egr-limp-guardar');
  if (bLimpGuardar) bLimpGuardar.addEventListener('click', async () => {
    bLimpGuardar.disabled = true;
    try {
      const diasSel = Array.from(document.querySelectorAll('#egr-limp-dias [data-dia].activo')).map(b => b.dataset.dia);
      const r = await apiPost({
        apiAction: 'editarUnidad', unidad: U,
        limpiezasOn: chkLimpOn.checked,
        costoLimpiezaSemana: $('#egr-limp-semana').value,
        costoLimpiezaFinde: $('#egr-limp-finde').value,
        diasFindeLimpieza: diasSel
      });
      if (!r.ok) throw new Error(r.error || 'error');
      invalidarClave({ action: 'egresos', unidad: U, anio: A, mes: M });
      invalidarClave({ action: 'unidadeditar', unidad: U });
      avisoLimp('✅ Limpieza guardada.');
      cargarReporteEgresos(U);
    } catch (e) { avisoLimp('No se pudo guardar (' + e.message + ').', true); }
    finally { bLimpGuardar.disabled = false; }
  });
}

/* LIMPIEZA (29/07/2026, pedido del dueño): 4ta pestaña de REPORTES — métricas del EQUIPO de limpieza,
 * NO de una unidad (por eso la barra de chips de unidad se oculta arriba, en vistaReportes). Fuente
 * real: action reporteLimpieza → _apiReporteLimpieza_ → _metricasEquipoLimpieza_ (reportes.js) sobre
 * LIMPIEZA_CHECKS, que solo existe desde el 20/07/2026 — no hay dato de limpiezas de antes (j.desde lo
 * aclara al pie). "Hora promedio" es cuándo se TOCÓ el botón LIMPIEZA COMPLETADA en la app, no el
 * minuto exacto en que se terminó de limpiar — se rotula "Hora prom.*" con la nota abajo, nunca en
 * silencio. El "rendimiento por persona" reusa el marcador nativo (.marc-barras, mismas clases que
 * cargarReportePng) pero con el AJUSTE de área del backend (2A/4A/6A cuentan 0.5): se muestran ambos
 * números (ajustado y crudo) para no insinuar un ranking simplista que compare peras con manzanas. */
async function cargarReporteLimpieza() {
  const cont = $('#rep-cont');
  if (!cont) return;
  const mi = ++repReq;
  const hoy = new Date();
  if (!estado.repLimpAnio) estado.repLimpAnio = hoy.getFullYear();
  if (!estado.repLimpMes) estado.repLimpMes = hoy.getMonth() + 1;
  const A = estado.repLimpAnio, M = estado.repLimpMes;
  const mesTit = MES[M - 1][0].toUpperCase() + MES[M - 1].slice(1);

  cont.innerHTML = `
    <div class="rep-barra">
      <button id="limp-prev" class="chip">◀</button>
      <div class="sub" style="flex:1;text-align:center">${mesTit} ${A}</div>
      <button id="limp-next" class="chip">▶</button>
    </div>
    <div id="limp-cont"><div class="vacio">⏳ Cargando métricas del equipo de limpieza…</div></div>`;

  $('#limp-prev').addEventListener('click', () => {
    let m = M - 1, a = A; if (m < 1) { m = 12; a--; }
    estado.repLimpMes = m; estado.repLimpAnio = a; irTab('reportes');
  });
  $('#limp-next').addEventListener('click', () => {
    let m = M + 1, a = A; if (m > 12) { m = 1; a++; }
    estado.repLimpMes = m; estado.repLimpAnio = a; irTab('reportes');
  });

  let j;
  try { j = await api({ action: 'reporteLimpieza', anio: A, mes: M }); }
  catch (e) { j = { error: e.message }; }
  if (mi !== repReq || estado.tab !== 'reportes') return;
  const limpCont = $('#limp-cont');
  if (!limpCont) return;
  if (j.error) { limpCont.innerHTML = `<div class="vacio">⚠️ ${esc(j.error)}</div>`; return; }

  const semanas = j.semanas || [];
  const maxSemana = Math.max(1, ...semanas.map(s => s.total));
  const colsSemana = semanas.map(s => {
    const h = Math.max(6, Math.round(s.total / maxSemana * 100));
    return `<div class="marc-col">
      <div class="marc-tag">${s.total}</div>
      <div class="marc-pista"><div class="marc-barra" style="height:${h}%;background:var(--brand)"></div></div>
      <div class="marc-lbl">${esc(s.inicio)}</div>
    </div>`;
  }).join('');

  const personas = j.personas || [];
  const maxAj = Math.max(1, ...personas.map(p => p.ajustado));
  const colsPersona = personas.map(p => {
    const h = Math.max(6, Math.round(p.ajustado / maxAj * 100));
    return `<div class="marc-col">
      <div class="marc-tag">${p.ajustado.toFixed(1)}</div>
      <div class="marc-pista"><div class="marc-barra" style="height:${h}%;background:var(--brand)"></div></div>
      <div class="marc-lbl">${esc(p.nombre)}<br><span class="sub" style="font-size:.6rem">${p.total} crudo</span></div>
    </div>`;
  }).join('');

  const mediaArea = j.unidadesMediaArea || [];

  limpCont.innerHTML = `
    <div class="tarjeta">
      <div class="kpis">
        <div><div class="n">${j.totalMes || 0}</div><div class="l">Limpiezas el mes</div></div>
        <div><div class="n">${j.promedioDiario || 0}</div><div class="l">Promedio/día</div></div>
        <div><div class="n">${j.domingos || 0}</div><div class="l">En domingo</div></div>
        <div><div class="n">${j.horaPromedio || '—'}</div><div class="l">Hora prom.*</div></div>
      </div>
      <div class="sub" style="margin-top:8px">*Hora en que se REGISTRÓ la limpieza (botón LIMPIEZA COMPLETADA en la app) — no hay un dato del minuto exacto en que se terminó de limpiar; es la mejor aproximación disponible.</div>
    </div>
    <div class="tarjeta">
      ${tituloSeccion('Unidades por semana', 'semana anclada al lunes')}
      ${colsSemana ? `<div class="marc-barras">${colsSemana}</div>` : '<div class="vacio">Sin limpiezas registradas este mes.</div>'}
    </div>
    <div class="tarjeta">
      ${tituloSeccion('Rendimiento del equipo', 'ajustado por área — no es solo cantidad cruda')}
      ${mediaArea.length ? `<div class="sub" style="margin-bottom:6px">★ ${esc(mediaArea.join('/'))} cuentan como 0.5: son la mitad de área que el resto de las unidades "-A".</div>` : ''}
      ${colsPersona ? `<div class="marc-barras">${colsPersona}</div>` : '<div class="vacio">Sin registros de limpieza este mes.</div>'}
    </div>
    <div class="tarjeta"><div class="sub">${esc(j.desde || '')}</div></div>`;
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

/* ---------- Vista: MIS DATOS (pestaña 👤, T9 + C5+C8) ---------- */
async function vistaCuenta() {
  setTitulo('Mis datos');
  // C5+C8 (28/07/2026): pestaña única para los 3 roles — nombre/WhatsApp propios (antes vistaMisDatos,
  // solo CoHost/limpieza) + apariencia/notificaciones/equipo/salud/salir (antes acá mismo, alcanzable
  // solo por ABRIR MI CUENTA). TODO lo de una unidad (switches, claves, checklist) vive ahora dentro
  // de Unidades → EDITAR UNIDAD, no acá.
  // Los 2 pedidos EN PARALELO; "me" se refresca por si otro admin cambió los switches generales.
  const yoPrevio = estado.yo || {};
  const seraAdmin = yoPrevio.rol === 'ceo_admin' || yoPrevio.rol === 'admin';
  const [meF, eqRaw, ggRaw] = await Promise.all([
    api({ action: 'me' }).catch(() => null),
    seraAdmin ? api({ action: 'equipo' }, false).catch(() => null) : Promise.resolve(null),
    // Parte L (29/07/2026): grupos de reparto de gastos — solo admin puro (config financiera).
    seraAdmin ? api({ action: 'gruposgastos' }, false).catch(() => null) : Promise.resolve(null),
  ]);
  if (meF && !meF.error) estado.yo = meF;
  const yo = estado.yo;
  const puedeEscribir = yo.rol === 'ceo_admin' || yo.rol === 'admin';
  const grupos = (ggRaw && !ggRaw.error && ggRaw.grupos) ? ggRaw.grupos : [];
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
      <div class="sub" style="margin-top:12px">Solo aparece quien trabaja en <b>tus unidades</b>, más quien todavía no tiene ninguna asignada. La <b>cédula</b> es su acceso a la app: entra con sus <b>últimos 4 dígitos</b>.</div>
      <div id="eq-msg" class="sub oculto" style="text-align:center;margin-top:6px"></div>
    </div>`
    : `<div class="tarjeta"><div class="sub">El directorio del equipo lo edita el administrador.</div></div>`;
  // Parte L (29/07/2026) — grupos de reparto de gastos ("2A+4A+6A", "5A+7A"): tarjeta con los chips
  // .chipu de la unidad (mismo componente que Reportes/Unidades) + acordeón "Editar" con el multi-select
  // de unidades PROPIAS, mismo patrón visual/interacción que filaPersona() (Equipo) arriba. El backend
  // (_apiSetGrupoGastos_) rechaza cualquier unidad ajena, así que este selector solo ofrece las tuyas.
  const filaGrupoGastos = (g) => `
    <div class="eq-persona" data-id="${g.id}">
      <div class="eq-cabecera">
        <span style="flex:1;min-width:0;display:flex;gap:6px;flex-wrap:wrap">
          ${g.unidades.map(u => `<span class="chipu sel">${esc(u)}</span>`).join('')}
        </span>
        <button class="btn-oscuro gg-editar" style="flex:none;padding:8px 14px">Editar</button>
      </div>
      <div class="eq-detalle oculto">
        <label class="campo-label">Unidades del grupo</label>
        <div class="chips gg-chips">
          ${(yo.unidades || []).map(u => `<button type="button" class="chipu ${g.unidades.indexOf(u) !== -1 ? 'sel' : ''}" data-uni="${esc(u)}">${esc(u)}</button>`).join('')}
        </div>
        <div class="fila-oscura" style="margin-top:10px">
          <button class="btn btn-mini gg-guardar" style="flex:1">Guardar</button>
          <button class="btn secundario btn-mini gg-borrar" style="flex:none;width:auto;padding:9px 14px">Borrar</button>
        </div>
      </div>
    </div>`;
  const formNuevoGrupo = () => `
    <div class="eq-persona gg-nuevo" data-id="">
      <div class="tarjeta-fila"><h3 style="font-size:.95rem">Nuevo grupo</h3></div>
      <div class="chips gg-chips">
        ${(yo.unidades || []).map(u => `<button type="button" class="chipu" data-uni="${esc(u)}">${esc(u)}</button>`).join('')}
      </div>
      <button class="btn btn-mini gg-guardar" style="margin-top:10px">Crear grupo</button>
    </div>`;
  const gruposGastosHtml = puedeEscribir ? `
    <div class="tarjeta">
      <button class="btn btn-mini" id="gg-mas" style="margin-bottom:10px">＋ Crear grupo</button>
      <div id="gg-lista">${grupos.map(filaGrupoGastos).join('') || '<div class="vacio">Sin grupos todavía</div>'}</div>
      <div class="sub" style="margin-top:12px">Un grupo agrupa unidades que reparten un mismo gasto (ej. una factura de mantenimiento compartida). Al subir una factura —desde la app (📷 → "¿Es una factura?") o por WhatsApp— el reparto viene pre-marcado con este grupo y se divide en partes iguales; siempre puedes cambiarlo antes de guardar.</div>
      <div id="gg-msg" class="sub oculto" style="text-align:center;margin-top:6px"></div>
    </div>` : '';
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
      ${puedeEscribir ? tituloSeccion('Preferencias de Gastos', 'Grupos de unidades que reparten gastos entre sí') : ''}
      ${gruposGastosHtml}
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
        <div class="sub" style="margin-top:2px">Encendido: Huésped→Bot→CoHost→Limpieza. Apagado (default): Huésped→Bot→Limpieza. El admin lo ve todo en MENSAJES + notificaciones. Cada unidad puede sobreescribirlo en Unidades → EDITAR UNIDAD.</div>
        <div class="switch-fila" style="margin-top:12px">
          <span class="quien" style="font-weight:800">Aviso a huéspedes (comando "aviso")</span>
          <label class="toggle"><input type="checkbox" id="tg-aviso" ${yo.avisoHuespedGlobal === true ? 'checked' : ''}><span class="track"></span></label>
        </div>
        <div class="sub" style="margin-top:2px">Apagado (default): el comando "aviso &lt;unidad/edificio&gt; &lt;texto&gt;" no envía nada hasta prender esto Y tener aprobada la plantilla <i>aviso_huesped</i> en YCloud.</div>
        <div class="sub" style="margin-top:8px">ℹ️ Cada unidad puede sobreescribir sus etapas de mensajería en <b>Unidades → EDITAR UNIDAD</b>.</div>
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
  $('#mis-guardar').addEventListener('click', async () => {
    const btn = $('#mis-guardar'), msg = $('#mis-msg');
    const nombre = $('#mis-nombre').value.trim(), whatsapp = $('#mis-wa').value.replace(/\D/g, '');
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      const r = await apiPost({ apiAction: 'setMisDatos', nombre, whatsapp });
      if (!r.ok) throw new Error(r.error || 'No se pudo guardar');
      // El nombre se pinta en el saludo de UNIDADES y acá mismo: hay que refrescar `me` de verdad,
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
  comprobarSalud(true);   // las 3 luces (async; pinta #salud-caja cuando llega)
  engancharPush();  // el bloque de push vive SOLO acá (T6.1); la pestaña Notificación es puro feed
  // Switches generales de mensajería (UI optimista; si el POST falla, se revierte el toggle).
  [['#tg-mensajeria', 'mensajeria', 'mensajeriaAuto'], ['#tg-copia', 'copiaAdmin', 'msgCopiaAdmin'], ['#tg-cohost', 'cohost', 'cohostGlobal'], ['#tg-aviso', 'avisoHuesped', 'avisoHuespedGlobal']].forEach(([sel, clave, campo]) => {
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
  // Parte L (29/07/2026) — Preferencias de Gastos: mismo guard `dataset.listo` que engancharEquipo (se
  // vuelve a llamar al insertar el formulario de alta, y así no se duplican listeners).
  const ggMsg = (txt, ok) => {
    const m = $('#gg-msg');
    if (m) { m.textContent = txt; m.style.color = ok ? 'var(--good)' : 'var(--crit)'; m.classList.remove('oculto'); }
  };
  const engancharGruposGastos = () => {
    document.querySelectorAll('.gg-editar').forEach(b => {
      if (b.dataset.listo) return;
      b.dataset.listo = '1';
      b.addEventListener('click', () => {
        const caja = b.closest('.eq-persona');
        const det = caja.querySelector('.eq-detalle');
        det.classList.toggle('oculto');
        b.textContent = det.classList.contains('oculto') ? 'Editar' : 'Cerrar';
      });
    });
    // Multi-select de unidades: mismo toggle que los chips de días de Egresos (click alterna .sel).
    document.querySelectorAll('.gg-chips [data-uni]').forEach(b => {
      if (b.dataset.listo) return;
      b.dataset.listo = '1';
      b.addEventListener('click', () => b.classList.toggle('sel'));
    });
    document.querySelectorAll('.gg-guardar').forEach(b => {
      if (b.dataset.listo) return;
      b.dataset.listo = '1';
      b.addEventListener('click', async () => {
        const caja = b.closest('.eq-persona');
        const unidades = Array.from(caja.querySelectorAll('.gg-chips [data-uni].sel')).map(x => x.dataset.uni);
        if (!unidades.length) { ggMsg('Selecciona al menos una unidad.', false); return; }
        const textoOrig = b.textContent;
        b.disabled = true; b.textContent = 'Guardando…';
        try {
          const payload = { apiAction: 'setGrupoGastos', unidades };
          if (caja.dataset.id) payload.id = +caja.dataset.id;
          const r = await apiPost(payload);
          if (!r.ok) throw new Error(r.error || 'error');
          invalidarGruposGastos();
          ggMsg('✓ Grupo guardado.', true);
          vistaCuenta();
        } catch (e) {
          ggMsg('No se pudo guardar (' + e.message + ').', false);
          b.disabled = false; b.textContent = textoOrig;
        }
      });
    });
    // Borrar: manda unidades:[] — el backend limpia el valor y conserva la clave (no recicla el id).
    document.querySelectorAll('.gg-borrar').forEach(b => {
      if (b.dataset.listo) return;
      b.dataset.listo = '1';
      b.addEventListener('click', async () => {
        const caja = b.closest('.eq-persona');
        if (!confirm('¿Borrar este grupo de reparto de gastos?')) return;
        b.disabled = true; b.textContent = 'Borrando…';
        try {
          const r = await apiPost({ apiAction: 'setGrupoGastos', id: +caja.dataset.id, unidades: [] });
          if (!r.ok) throw new Error(r.error || 'error');
          invalidarGruposGastos();
          ggMsg('✓ Grupo borrado.', true);
          vistaCuenta();
        } catch (e) {
          ggMsg(e.message, false);
          b.disabled = false; b.textContent = 'Borrar';
        }
      });
    });
  };
  if (puedeEscribir) {
    engancharGruposGastos();
    const bGgMas = $('#gg-mas');
    if (bGgMas) bGgMas.addEventListener('click', () => {
      if (document.querySelector('#gg-lista .gg-nuevo')) return;   // un alta a la vez
      const div = document.createElement('div');
      div.innerHTML = formNuevoGrupo();
      $('#gg-lista').prepend(div.firstElementChild);
      engancharGruposGastos();
    });
  }
  // Vista "Equipo por unidad" (solo admins): CEO/admin + CoHost + limpieza de cada unidad.
  if (puedeEscribir) (async () => {
    const cont = $('#eq-unidad');
    if (!cont) return;
    try {
      const j = await api({ action: 'equipoporunidad' });
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
  // (Los switches por unidad —bot/reportes/mensajería/claves/checklist— viven en Unidades → EDITAR UNIDAD.)
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
    // Parte J (29/07/2026): avatar rojo marca con las iniciales, reemplaza al 👤 genérico. Mismo punto
    // donde se puebla el resto del header tras el login.
    const avatarEl = $('#btn-cuenta'); if (avatarEl) avatarEl.textContent = iniciales(yo.nombre);
    // Salud siempre a la vista: primera comprobación al entrar + refresco cada 10 min (la acción
    // `salud` está cacheada 60 s en el servidor; el ping del webhook es un GET barato).
    comprobarSalud(false);
    if (!estado.saludTimer) estado.saludTimer = setInterval(() => comprobarSalud(false), 600000);
    // Cabecera: arriba-izquierda va el PERFIL (rol) del usuario, FIJO — el nombre de la vista ya
    // vive en el wordmark del hero rojo, así no se repite.
    // La appbar muestra el TÍTULO de la vista (negro bold, izquierda) — el rol vive en Configuración.
    // Parte J (29/07/2026): el tab central "+" (data-tab="mas") ya es SIEMPRE el atajo a fotos, para
    // TODOS los roles (antes solo se transformaba así para CoHost/limpieza, tomando el slot de
    // Reportes) — ya no hace falta transformarlo por rol. Lo que cambia por rol es Reportes: dato
    // financiero, CoHost/limpieza no lo ven, así que su tab se OCULTA del todo (no se transforma).
    if (yo.rol === 'cohost' || yo.rol === 'limpieza') {
      const rep = document.querySelector('.tab[data-tab="reportes"]');
      if (rep) rep.classList.add('oculto');
    }
    // C4 (28/07/2026): limpieza NO configura unidades (eso es solo admin/CoHost, ver C5+C8) — su slot
    // "Unidades" se transforma en "Agenda": la semana completa de limpieza, en texto, como vista
    // PRINCIPAL (no el PNG de respaldo que ya muestra HOY). CoHost conserva Unidades sin cambios.
    if (yo.rol === 'limpieza') {
      const uniBtn = document.querySelector('.tab[data-tab="unidades"]');
      if (uniBtn) {
        uniBtn.dataset.tab = 'agenda';
        uniBtn.innerHTML = '<span class="tab-icono">📅</span>Agenda';
      }
    }
    // C5+C8 (28/07/2026): "Config" (switches por unidad) se retiró como pestaña propia — ese contenido
    // vive ahora DENTRO de Unidades, junto al editor de cada unidad (solo admin/CoHost lo alcanzan, vía
    // el botón EDITAR UNIDAD — mismo gate de siempre). Parte J (29/07/2026): "Mis datos" se retiró TAMBIÉN
    // de la tabbar (index.html) — el avatar de la esquina ya hace exactamente lo mismo (abre vistaCuenta()).
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
  // 👤 CUENTA arriba a la izquierda (T9): atajo directo a lo mismo que la pestaña Mis datos de abajo
  // (logout, apariencia, push, equipo…) — útil desde cualquier vista sin bajar a la tabbar.
  $('#btn-cuenta').addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('activo'));
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
