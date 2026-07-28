// Port literal (JS puro sobre strings) de codigo.js del CRM 1242BNB — SIN cambios de lógica.
// Fuente: C:\Users\sukov\Documents\crm-appsscript\codigo.js (líneas 132-600, 945-965, 1016-1113,
// 1608-1614). Cualquier divergencia respecto al original debe ser deliberada y comentada.
//
// Qué NO se porta a propósito (se queda en el endpoint de Apps Script, que tiene la lista viva
// de unidades): _airUnidad_ / _airUnidadKeyword_ / normalizeUnit_ / getUnits_ / _UNITS_CACHE.
// Este módulo entrega `anuncio` (texto crudo) + `bodyRaw`; el endpoint resuelve la unidad.
//
// Reimplementado (no existe en el Worker): Utilities.formatDate con TZ — Ecuador no tiene DST,
// así que un offset fijo UTC-5 es exacto (mismo patrón que hoyEcuador() en la PWA).

// Basura típica de un "nombre de huésped" mal parseado (URLs, params, ids largos): se descarta.
export const RE_NOMBRE_BASURA = /[&=\[\]<>]|https?:|euid|utm_|\d{5,}/i;

// Ecuador (America/Guayaquil) = UTC-5 fijo, sin horario de verano.
export function formatDateEc(date, pattern) {
  const t = new Date(date.getTime() - 5 * 3600 * 1000); // corre el reloj a hora Ecuador, luego lee en UTC
  const yyyy = t.getUTCFullYear();
  const MM = String(t.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(t.getUTCDate()).padStart(2, '0');
  if (pattern === 'yyyy-MM-dd') return `${yyyy}-${MM}-${dd}`;
  if (pattern === 'dd/MM/yyyy') return `${dd}/${MM}/${yyyy}`;
  throw new Error('formatDateEc: patrón no soportado: ' + pattern);
}

export function mesNum_(txt) {
  const t = String(txt).trim().toLowerCase().slice(0, 3);
  const M = { jan: 1, ene: 1, feb: 2, mar: 3, apr: 4, abr: 4, may: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, oct: 10, nov: 11, dec: 12, dic: 12 };
  return M[t] || 0;
}

export function parseDMY_(s) {
  if (Object.prototype.toString.call(s) === '[object Date]' && !isNaN(s)) {
    return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  }
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
}

export function noches_(ini, fin) {
  const a = parseDMY_(ini), b = parseDMY_(fin);
  if (!a || !b) return '';
  return Math.round((b - a) / 86400000);
}

// Extrae una fecha "día mes" (ES) o "mes día" (EN) de un trozo y la devuelve DD/MM/YYYY.
export function _airFecha_(seg, fechaCorreo) {
  if (!seg) return '';
  let dia = 0, mes = 0;
  let m = seg.match(/(\d{1,2})\s+(?:de\s+)?([A-Za-zÁÉÍÓÚáéíóú]{3,})\.?/);  // ES: 18 sept
  if (m && mesNum_(m[2])) { dia = +m[1]; mes = mesNum_(m[2]); }
  if (!mes) {
    const m2 = seg.match(/([A-Za-zÁÉÍÓÚáéíóú]{3,})\.?\s+(\d{1,2})/);        // EN: Jun 27
    if (m2 && mesNum_(m2[1])) { dia = +m2[2]; mes = mesNum_(m2[1]); }
  }
  if (!dia || !mes) return '';
  const anioCorreo = +fechaCorreo.slice(0, 4), mesCorreo = +fechaCorreo.slice(5, 7);
  const anio = (mes < mesCorreo) ? anioCorreo + 1 : anioCorreo;
  return ('0' + dia).slice(-2) + '/' + ('0' + mes).slice(-2) + '/' + anio;
}

// Convierte un importe de Airbnb a número. Maneja formato ES "1.234,56" y EN "1,234.56".
export function _airNum_(s) {
  s = String(s == null ? '' : s).replace(/[^\d.,]/g, '');
  if (!s) return '';
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > -1 && ld > -1) { s = (lc > ld) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''); }
  else if (lc > -1) { s = s.replace(/\./g, '').replace(',', '.'); }
  const n = parseFloat(s);
  return isNaN(n) ? '' : n;
}

// Fecha DD/MM/YYYY de una reseña: respeta el año explícito del correo; si falta, asume pasado.
export function _fResena_(dia, mes, anio, fechaCorreo) {
  if (!dia || !mes) return '';
  if (!anio) {
    const anioCorreo = +fechaCorreo.slice(0, 4), mesCorreo = +fechaCorreo.slice(5, 7);
    anio = (mes > mesCorreo) ? anioCorreo - 1 : anioCorreo;
  }
  return ('0' + dia).slice(-2) + '/' + ('0' + mes).slice(-2) + '/' + anio;
}

// Rango de fechas de un correo de reseña: "Jun 20 – 21" / "Jun 30 – Jul 2" / "Jun 21 – 22, 2026"
// (EN) o "20 jun – 21" (ES).
export function _airRangoResena_(b, fechaCorreo) {
  let m = b.match(/\b([A-Za-z]{3,})\.?\s+(\d{1,2})\s*[–—-]\s*(?:([A-Za-z]{3,})\.?\s+)?(\d{1,2})(?:,?\s*(\d{4}))?\b/); // EN: mes día
  if (m && mesNum_(m[1])) return { ini: _fResena_(+m[2], mesNum_(m[1]), +m[5] || 0, fechaCorreo), fin: _fResena_(+m[4], mesNum_(m[3] || m[1]), +m[5] || 0, fechaCorreo) };
  m = b.match(/\b(\d{1,2})\s+([A-Za-zÁÉÍÓÚáéíóú]{3,})\.?\s*[–—-]\s*(\d{1,2})(?:\s+(?:de\s+)?([A-Za-zÁÉÍÓÚáéíóú]{3,}))?(?:[,\s]+(?:de\s+)?(\d{4}))?/i); // ES: día mes
  if (m && mesNum_(m[2])) return { ini: _fResena_(+m[1], mesNum_(m[2]), +m[5] || 0, fechaCorreo), fin: _fResena_(+m[3], mesNum_(m[4] || m[2]), +m[5] || 0, fechaCorreo) };
  return { ini: '', fin: '' };
}

// Devuelve un trozo del texto desde la primera etiqueta encontrada (acota la búsqueda).
export function _airSeg_(texto, etiquetas, largo) {
  for (let i = 0; i < etiquetas.length; i++) {
    const idx = texto.search(new RegExp(etiquetas[i], 'i'));
    if (idx >= 0) return texto.substr(idx, largo || 60);
  }
  return '';
}

export function extraerCodigoCancel_(txt) {
  const m = String(txt).match(/(?:Reservation|Reserva)\s+([A-Z0-9]{8,12})\b/);
  if (m) return m[1];
  const m2 = String(txt).match(/\b(HM[A-Z0-9]{8})\b/);
  return m2 ? m2[1] : '';
}

export function extraerFechasModif_(body) {
  const b = String(body).replace(/[\u2013\u2014]/g, '-');
  let mo = b.match(/Original Dates\s+(.+?)\s*-\s*(.+?)\s*(?:\r|\n|Requested)/i);
  let mr = b.match(/Requested Dates\s+(.+?)\s*-\s*(.+?)\s*(?:\r|\n|If you)/i);
  if (!(mo && mr)) {
    mo = b.match(/Fechas originales\s+(.+?)\s*-\s*(.+?)\s*(?:\r|\n|Fechas solicitadas)/i);
    mr = b.match(/Fechas solicitadas\s+(.+?)\s*-\s*(.+?)\s*(?:\r|\n|Si )/i);
  }
  if (!(mo && mr)) return null;
  const oi = fechaTextoADMY_(mo[1]), of = fechaTextoADMY_(mo[2]);
  const ri = fechaTextoADMY_(mr[1]), rf = fechaTextoADMY_(mr[2]);
  if (oi && of && ri && rf) return { oi, of, ri, rf };
  return null;
}

export function extraerNombreModif_(subj) {
  const m = subj.match(/^(.+?)\s+wants to change/i) || subj.match(/^(.+?)\s+quiere modificar/i)
         || subj.match(/^(.+?)\s+quiere hacer un cambio/i);
  return m ? m[1].trim() : '';
}

export function fechaTextoADMY_(s) {
  s = String(s).trim();
  let m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) { const mm = mesNum_(m[1]); if (mm) return ('0' + (+m[2])).slice(-2) + '/' + ('0' + mm).slice(-2) + '/' + m[3]; }
  m = s.match(/^(\d{1,2})\s+de\s+([A-Za-z]{3,})\.?\s+de\s+(\d{4})$/i);
  if (m) { const mm = mesNum_(m[2]); if (mm) return ('0' + (+m[1])).slice(-2) + '/' + ('0' + mm).slice(-2) + '/' + m[3]; }
  return '';
}

// Parser principal de correos de Airbnb (reservas y reseñas). NO llama a ninguna API, NO resuelve
// unidad (eso lo hace el endpoint de Apps Script con la lista viva de unidades — ver cabecera).
export function parseDatos_(email) {
  const fechaCorreo = formatDateEc(email.date, 'yyyy-MM-dd');
  const b = String(email.body || '');
  const s = String(email.subject || '');

  // Código de confirmación (HM + 8). Primero junto a su etiqueta; si no, el primero del cuerpo.
  let codigo = '';
  const mc = b.match(/(?:C[oó]digo de confirmaci[oó]n|Confirmation code)[\s\S]{0,40}?(HM[A-Z0-9]{6,})/i) || b.match(/\b(HM[A-Z0-9]{8,})\b/);
  if (mc) codigo = mc[1].toUpperCase();

  // Huésped: nombre antes de "Identidad verificada"/"Identity verified"; si no, del asunto.
  let huesped = '';
  const msu = s.match(/(?:Reserva confirmada:?|Reservation confirmed[\s\-–]+)\s*(.+?)\s+(?:llega|arrives)/i);
  if (msu) huesped = msu[1].trim();
  if (!huesped) {
    const mrv = s.match(/^\s*[¡¿]?\s*(.+?)\s+wrote you a review/i)
             || s.match(/^\s*[¡¿]?\s*(.+?)\s+left a [1-5][\s-]*star review/i)
             || s.match(/^\s*[¡¿]?\s*(.+?)\s+(?:te ha dejado|te dej[oó]|escribi[oó])/i)
             || b.match(/Find out what (.+?) wrote/i)
             || b.match(/Descubre lo que (.+?) escribi/i)
             || b.match(/^\s*(.+?)\s+rated their stay/im);
    if (mrv) huesped = mrv[1].trim();
  }
  if (!huesped) {
    const mh = b.match(/([A-Za-zÁÉÍÓÚáéíóúñÑ][A-Za-zÁÉÍÓÚáéíóúñÑ .'’-]{1,48}?)\s*\n+\s*(?:Identidad verificada|Identity verified)/i);
    if (mh) huesped = mh[1].trim();
  }
  if (RE_NOMBRE_BASURA.test(huesped)) huesped = '';

  // Anuncio: línea anterior al tipo de propiedad ("Casa/apto. entero" / "Entire ...").
  let anuncio = '';
  const ma = b.match(/([^\n]{3,80}?)\s*\n+\s*(?:Casa\/apto\. entero|Casa o apartamento entero|Entire\b)/i);
  if (ma) anuncio = ma[1].trim();

  // Fechas (DD/MM/YYYY). El año se infiere de la fecha del correo.
  let fecha_inicio = _airFecha_(_airSeg_(b, ['\\nLlegada', '\\nCheck\\s*-?\\s*in'], 70), fechaCorreo);
  let fecha_fin    = _airFecha_(_airSeg_(b, ['\\nSalida', '\\nCheck\\s*-?\\s*out'], 70), fechaCorreo);
  if (!fecha_inicio && !fecha_fin) {
    const rr = _airRangoResena_(b, fechaCorreo);
    fecha_inicio = rr.ini; fecha_fin = rr.fin;
  }

  // Viajeros: adultos + niños (+ bebés/mascotas para banderas).
  const segV = _airSeg_(b, ['Viajeros', 'Guests'], 120);
  const ad = (segV.match(/(\d+)\s*adult/i) || [])[1];
  const ni = (segV.match(/(\d+)\s*(?:ni[ñn]|child|menor)/i) || [])[1];
  const be = (segV.match(/(\d+)\s*(?:beb|infant)/i) || [])[1];
  const num_huespedes = (parseInt(ad || 0, 10) + parseInt(ni || 0, 10)) || '';
  const ninos = ((+ni > 0) || (+be > 0)) ? 'Si' : 'No';
  const mascotas = /mascota|pet\b/i.test(segV) ? 'Si' : 'No';

  // Importes: ingresos_brutos = "Total (USD)" del viajero; tarifa_limpieza = "Gastos de limpieza".
  const mt = b.match(/Total \(USD\)[\s\S]{0,20}?([\d.,]+)/i);
  const ingresos_brutos = mt ? _airNum_(mt[1]) : '';
  const ml = b.match(/(?:Gastos de limpieza|Cleaning fee)[\s\S]{0,20}?([\d.,]+)/i);
  const tarifa_limpieza = ml ? _airNum_(ml[1]) : '';

  // Estrellas (solo reseñas). Reserva = null.
  let estrellas = '';
  const me = s.match(/([1-5])[\s-]*(?:estrella|star)/i) || b.match(/([1-5])[\s-]*(?:estrella|star)/i);
  if (me) estrellas = +me[1]; else if (/★{5}|⭐{5}/.test(b)) estrellas = 5;

  return {
    codigo_confirmacion: codigo || null,
    huesped: huesped || null,
    anuncio: anuncio || null,
    fecha_inicio: fecha_inicio || null,
    fecha_fin: fecha_fin || null,
    num_huespedes: num_huespedes === '' ? null : num_huespedes,
    ninos,
    mascotas,
    ingresos_brutos: ingresos_brutos === '' ? null : ingresos_brutos,
    tarifa_limpieza: tarifa_limpieza === '' ? null : tarifa_limpieza,
    estrellas: estrellas === '' ? null : estrellas
  };
}

// Clasificación por dirección de envelope (message.to en el Worker) — refleja la tabla de la
// sección 1 del plan. Guards de asunto EXACTAMENTE iguales a los que ya aplican los 5 filtros
// de Gmail (defensa en profundidad: si un filtro se desconfigura, el Worker igual no confunde tipos).
export function clasificarPorDestino_(to) {
  const t = String(to || '').toLowerCase();
  if (t.startsWith('reservas@')) return 'reserva';
  if (t.startsWith('cancelaciones@')) return 'cancelacion';
  if (t.startsWith('modificaciones@')) return 'modificacion';
  if (t.startsWith('cinco@')) return 'resena5';
  if (t.startsWith('mejorable@')) return 'resenaBaja';
  if (t.startsWith('payouts@')) return 'payout';
  return '';
}

// Los mismos 3 filtros de codigo.js:1185-1187 (procesarLabel_) — ahí se aplican a TODOS los
// labels, incluidas las reseñas, no solo a reservas.
function pasaFiltroAjenos_(s) {
  return !/message sent|mensaje enviado/i.test(s) && !/booking\.com/i.test(s) && !/your .*(trip|reservation)|booking request sent|airbnb receipt|reservation confirmed for /i.test(s)
    // Recordatorio de Airbnb pidiendo AL ANFITRIÓN reseñar al huésped (no es una reseña recibida)
    // — empieza con "Deja una evaluación"/"Leave a review" en vez del nombre del huésped. Hallazgo
    // 27/07 (correo real "Deja una evaluación sobre el grupo de Alejandro" colado en "<5").
    && !/^\s*(?:Deja una evaluaci[oó]n|Leave a review)/i.test(s);
}

// PAYOUT_TEMPLATE = valor real de X-Template en los 2 correos de ejemplo (uno en inglés, uno en
// español) — idéntico en ambos, a diferencia del asunto (que trae el monto variable y cambia de
// idioma/palabra: "payout" vs "cobro"). Es el discriminador robusto; el asunto NO se usa para payout.
export const PAYOUT_TEMPLATE = 'PAYMENTS_HOST_PAYOUT_SENT_BASE_2025';

// `xTemplate` solo aplica a tipo 'payout' (3er parámetro opcional; el resto de tipos lo ignora).
export function pasaGuardSubject_(tipo, subject, xTemplate) {
  const s = String(subject || '');
  if (tipo === 'reserva' || tipo === 'resena5' || tipo === 'resenaBaja') return pasaFiltroAjenos_(s);
  if (tipo === 'cancelacion') return /Canceled: Reservation|Cancelada: Reserva/i.test(s);
  if (tipo === 'modificacion') return /wants to change|quiere modificar|quiere hacer un cambio/i.test(s);
  if (tipo === 'payout') return String(xTemplate || '') === PAYOUT_TEMPLATE;
  return true;
}

// Busca un header por nombre (case-insensitive) en el array `headers` que devuelve postal-mime
// (`{key, originalKey, value}`, `key` ya en minúsculas). '' si no está.
export function headerValue_(headers, nombre) {
  const k = String(nombre).toLowerCase();
  const h = (headers || []).find(function (x) { return x.key === k; });
  return h ? h.value : '';
}

// Fecha 'M/D/YYYY' (X-Locale 'en') o 'D/M/YYYY' (X-Locale 'es') -> ISO 'yyyy-MM-dd' (Regla de Oro
// #6). Confirmado con los 2 correos reales: la MISMA plantilla de Airbnb cambia el ORDEN de fecha
// según el idioma, así que sin `locale` el resultado sería ambiguo (y erróneo la mitad de las
// veces). Si `locale` no es 'en' ni 'es' exactamente, devuelve null en vez de adivinar.
export function _fechaPayout_(s, locale) {
  if (locale !== 'en' && locale !== 'es') return null;
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const x = +m[1], y = +m[2], anio = m[3];
  const mes = locale === 'en' ? x : y, dia = locale === 'en' ? y : x;
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return anio + '-' + String(mes).padStart(2, '0') + '-' + String(dia).padStart(2, '0');
}

// Extrae las reservas pagadas del cuerpo de un correo de payout (X-Template PAYOUT_TEMPLATE).
// Reconoce el bloque repetido de 4 párrafos (bodyPlano ya separa por líneas en blanco):
//   <huésped>   $<monto neto> USD
//   <categoría> • <checkin> - <checkout>          (categoría: "Home"/"Alojamiento"/"Resolution Payout")
//   <anuncio> (<ID numérico del anuncio — el mismo AIRBNB_ID_<u> de CONFIGURACION>)
//   <código de confirmación>
// Se detiene en la línea de deducción ("Airbnb   -$X USD", comisión de Western Union u otra) y NO
// la cuenta como reserva. Valida la suma de montos netos MENOS esa deducción contra "Total
// paid/pagado": si no cuadra, `totalCuadra:false` — el llamador debe tratar el correo con
// desconfianza (revisión humana) en vez de escribir montos sin ese chequeo de integridad.
// Las líneas "Resolution Payout" SÍ se devuelven (llevan `esEstadia:false`) pero el llamador no
// debe intentar casarlas contra una fila de reserva por checkout — no tienen una.
export function parsearPayout_(body, locale) {
  const parrafos = String(body || '').split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean);
  const filas = [];
  let deduccion = 0;
  for (let i = 0; i < parrafos.length; i++) {
    const m1 = parrafos[i].match(/^(.+?)\s{2,}(-?)\$([\d.,]+)\s*USD$/);
    if (!m1) continue;
    const nombre = m1[1].trim(), esNegativo = m1[2] === '-', monto = _airNum_(m1[3]);
    if (nombre === 'Airbnb' && esNegativo) { deduccion += (monto || 0); continue; } // comisión, no reserva
    const m2 = parrafos[i + 1] && parrafos[i + 1].match(/^(.+?)•\s*([\d/]{1,10})\s*-\s*([\d/]{1,10})$/);
    const m3 = parrafos[i + 2] && parrafos[i + 2].match(/^(.+?)\s*\((\d+)\)$/);
    // Exige prefijo 'HM' (mismo formato de código de confirmación que el resto del proyecto, ej.
    // extraerCodigoCancel_) en vez de aceptar cualquier alfanumérico de 8-12 — abarata descartar un
    // falso positivo (texto de marketing que por casualidad calza los 4 párrafos del patrón).
    const m4 = parrafos[i + 3] && parrafos[i + 3].match(/^(HM[A-Z0-9]{6,10})$/);
    if (!m2 || !m3 || !m4) continue; // bloque incompleto — se ignora, nunca se inventa un dato
    const categoria = m2[1].trim();
    filas.push({
      huesped: nombre,
      // Preserva el signo: un reembolso/ajuste negativo NO es "Airbnb"+negativo (eso ya se separó
      // arriba como deducción), pero igual puede venir negativo -- forzarlo a positivo corrompería
      // el monto de esa reserva. El chequeo totalCuadra es la red de seguridad si esto descuadra.
      montoNeto: esNegativo ? -monto : monto,
      categoria: categoria,
      esEstadia: /^(Home|Alojamiento)$/i.test(categoria),
      checkin: _fechaPayout_(m2[2], locale),
      checkout: _fechaPayout_(m2[3], locale),
      anuncio: m3[1].trim(),
      airbnbId: m3[2],
      codigo_confirmacion: m4[1]
    });
    i += 3; // salta las 3 líneas restantes del bloque (el for ya suma 1 más)
  }
  const mTotal = String(body || '').match(/Total (?:paid|pagado):\s*\$([\d.,]+)\s*USD/i);
  const totalDeclarado = mTotal ? _airNum_(mTotal[1]) : null;
  const sumaNeta = +(filas.reduce(function (acc, f) { return acc + (f.montoNeto || 0); }, 0) - deduccion).toFixed(2);
  return {
    filas: filas,
    deduccion: +deduccion.toFixed(2),
    totalDeclarado: totalDeclarado,
    totalCuadra: totalDeclarado != null && Math.abs(sumaNeta - totalDeclarado) < 0.01
  };
}
