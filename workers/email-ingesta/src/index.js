import PostalMime from 'postal-mime';
import {
  parseDatos_, clasificarPorDestino_, pasaGuardSubject_,
  extraerCodigoCancel_, extraerFechasModif_, extraerNombreModif_,
  parsearPayout_, headerValue_
} from './parser.js';

// Cuánto texto plano crudo se manda al endpoint (fallback de resolución de unidad por palabra
// clave en el cuerpo — _airUnidadKeyword_ en codigo.js). 4000 caracteres cubre de sobra el
// encabezado del correo de Airbnb donde vive el nombre del anuncio.
const BODY_RAW_MAX = 4000;
const OUTBOX_TTL_DIAS = 3;
const OUTBOX_PREFIX = 'pend:';

// Fallback SOLO si postal-mime no trae parte text/plain (Airbnb normalmente sí la manda, pero no
// está garantizado). parseDatos_ depende POR COMPLETO de los saltos de línea (\nLlegada,
// \n+Identidad verificada, etc.) — colapsarlos a espacios destruye el parseo en silencio.
export function bodyPlano(parsed) {
  if (parsed.text) return parsed.text;
  if (parsed.html) {
    return String(parsed.html)
      .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&amp;/gi, '&')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return '';
}

// Arma UN correo lógico {to,subject,body,date,msgId,xTemplate,xLocale} a partir de un `parsed`
// de postal-mime ya resuelto (el envolvente si no hay adjunto, o el original re-parseado si sí).
function _correoDe_(parsed, message) {
  const to = (message.to || (parsed.to && parsed.to[0] && parsed.to[0].address) || '').toLowerCase();
  const fecha = parsed.date ? new Date(parsed.date) : new Date();
  return {
    to,
    subject: parsed.subject || '',
    body: bodyPlano(parsed),
    date: isNaN(fecha) ? new Date() : fecha,
    msgId: parsed.messageId || (message.headers && message.headers.get('message-id')) || '',
    // X-Template/X-Locale: SOLO los usa el tipo 'payout' (discriminador robusto en vez de un regex
    // de asunto, y para saber el orden de fecha M/D vs D/M — ver parser.js:_fechaPayout_).
    // parsed.headers (postal-mime) es la MISMA fuente que usan los tests dorados (parsearFixture en
    // eml.test.mjs), a diferencia de message.headers (solo existe en el Worker real, no en tests).
    xTemplate: headerValue_(parsed.headers, 'x-template'),
    xLocale: headerValue_(parsed.headers, 'x-locale')
  };
}

// "Reenviar como adjunto" (Gmail): el .eml original viaja INTACTO como adjunto message/rfc822, en
// vez de citado en el cuerpo de un mensaje nuevo. Se re-parsea CADA UNO para usar SUS headers reales
// (X-Template/X-Locale de Airbnb) — el mensaje envolvente (de quien reenvía) nunca los tiene, y sin
// esto un payout reenviado así se leería como si lo hubiera mandado quien reenvía, no Airbnb.
// Gmail permite seleccionar VARIOS correos en la bandeja y reenviarlos como adjunto EN UNO SOLO
// (28/07/2026, para poder ponerse al día con un mes entero de payouts de una sola vez) — por eso
// se procesan TODOS los adjuntos message/rfc822 encontrados, no solo el primero. Si no hay ninguno
// (correo normal, sin reenvío), se procesa el envolvente tal cual, como antes.
async function parsearCorreos(message) {
  const raw = await new Response(message.raw).arrayBuffer();
  const envolvente = await PostalMime.parse(raw, { forceRfc822Attachments: true });
  const embebidos = (envolvente.attachments || []).filter(function (a) { return a.mimeType === 'message/rfc822' && a.content; });
  if (!embebidos.length) return [_correoDe_(envolvente, message)];
  const correos = [];
  for (const emb of embebidos) {
    try { correos.push(_correoDe_(await PostalMime.parse(emb.content), message)); }
    catch (e) { console.error('re-parseo de adjunto message/rfc822 falló:', e); }
  }
  return correos.length ? correos : [_correoDe_(envolvente, message)];
}

// Arma el payload por tipo — SOLO lo que el endpoint no puede derivar solo. La resolución de
// unidad (necesita la lista viva de unidades) y la regla anti-downgrade de modificaciones se
// quedan en Apps Script a propósito (ver cabecera de parser.js).
function armarPayload(tipo, email) {
  const fechaCorreoISO = email.date.toISOString();
  const bodyRaw = email.body.slice(0, BODY_RAW_MAX);
  const base = { apiAction: 'ingestaCorreo', tipo, msgId: email.msgId, subject: email.subject, fechaCorreoISO, bodyRaw };

  if (tipo === 'cancelacion') {
    // El original (codigo.js:1149-1150) SOLO busca el código en el asunto. El fallback al cuerpo
    // puede matchear un HM ajeno (promo, "reserva de nuevo") — se manda igual pero MARCADO para
    // que el endpoint lo trate con más recelo antes de cancelar una fila.
    const codigoAsunto = extraerCodigoCancel_(email.subject);
    const codigo = codigoAsunto || extraerCodigoCancel_(email.body);
    return { ...base, codigoCancel: codigo, codigoDeBody: !codigoAsunto && !!codigo };
  }
  if (tipo === 'modificacion') {
    return { ...base, nombreModif: extraerNombreModif_(email.subject), fechasModif: extraerFechasModif_(email.body) };
  }
  if (tipo === 'payout') {
    return { ...base, payout: parsearPayout_(email.body, email.xLocale) };
  }
  // reserva / resena5 / resenaBaja: mismo parser (parseDatos_ ya distingue reserva vs reseña por
  // las etiquetas que encuentra en el cuerpo — igual que hace procesarLabel_ hoy).
  const datos = parseDatos_({ date: email.date, subject: email.subject, body: email.body });
  return { ...base, datos };
}

// Apps Script responde HTTP 200 INCLUSO cuando doPost explota (página HTML de error) — mirar solo
// r.ok no detecta un fallo real del endpoint. _ingestaCorreo_ (F2) debe devolver JSON {ok:true};
// cualquier otra cosa (HTML, {ok:false}) se trata como fallo y cae al reintento por OUTBOX.
async function enviarAlEndpoint(env, payload) {
  const r = await fetch(env.INGESTA_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // igual que doPost del bot: evita el preflight OPTIONS
    body: JSON.stringify({ ...payload, s: env.INGESTA_SECRET })
  });
  if (!r.ok) throw new Error('endpoint HTTP ' + r.status);
  const texto = await r.text();
  let json;
  try { json = JSON.parse(texto); } catch (err) { throw new Error('endpoint respondió no-JSON: ' + texto.slice(0, 200)); }
  if (!json || json.ok !== true) throw new Error('endpoint respondió ok:false — ' + (json && json.error || texto.slice(0, 200)));
  return json;
}

async function encolarReintento(env, payload) {
  const key = OUTBOX_PREFIX + Date.now() + ':' + Math.random().toString(36).slice(2);
  await env.OUTBOX.put(key, JSON.stringify({ payload, intentos: 0, creado: Date.now() }));
}

export default {
  // Handler de Cloudflare Email Routing. NUNCA usa message.setReject() (bounces repetidos hacen
  // que Gmail deshabilite el reenvío) ni message.forward() (riesgo de bucle: reenviaría al mismo
  // inbox que ya reenvía acá). Si algo falla, el correo se queda intacto en Gmail (con su label)
  // y este handler solo reintenta el POST vía OUTBOX — nunca pierde el correo original.
  async email(message, env, ctx) {
    let correos;
    try {
      correos = await parsearCorreos(message);
    } catch (err) {
      console.error('parseo MIME falló:', err);
      return; // el correo sigue en Gmail con su label; nada que reintentar sin datos parseados
    }

    // Normalmente 1 solo correo lógico; > 1 cuando Gmail reenvió VARIOS seleccionados como adjunto
    // en un solo mensaje (ver parsearCorreos) — cada uno se clasifica y despacha por separado, así
    // que si UNO falla los demás no se pierden (cada cual encola su propio reintento).
    for (const email of correos) {
      const tipo = clasificarPorDestino_(email.to);
      if (!tipo) { console.error('destino no reconocido:', email.to); continue; }
      if (!pasaGuardSubject_(tipo, email.subject, email.xTemplate)) { console.log('guard descartó [' + tipo + ']: ' + email.subject); continue; }

      const payload = armarPayload(tipo, email);
      try {
        await enviarAlEndpoint(env, payload);
      } catch (err) {
        // Concatenado a propósito (no como 2do arg): Cloudflare Observability serializa un Error
        // como 2do argumento de console.error mostrando SOLO el stack (ubicación), sin .message —
        // así el motivo real (ej. "endpoint respondió ok:false — denegado") queda visible en la lista.
        console.error('POST al endpoint falló, encolando reintento [' + payload.subject + ']: ' + (err && err.message || err));
        ctx.waitUntil(encolarReintento(env, payload));
      }
    }
  },

  // Cron cada 10 min: reintenta lo que quedó en OUTBOX. Purga con aviso lo que lleva > 3 días
  // fallando (mismo TTL de red que el resto del proyecto usa para colas de reintento).
  async scheduled(event, env, ctx) {
    const list = await env.OUTBOX.list({ prefix: OUTBOX_PREFIX });
    for (const item of list.keys) {
      const raw = await env.OUTBOX.get(item.name);
      if (!raw) continue;
      const entry = JSON.parse(raw);
      const edadDias = (Date.now() - entry.creado) / 86400000;
      if (edadDias > OUTBOX_TTL_DIAS) {
        console.error('OUTBOX purgado por antigüedad (>' + OUTBOX_TTL_DIAS + 'd), correo perdido para reingesta automática:', entry.payload.subject);
        await env.OUTBOX.delete(item.name);
        continue;
      }
      try {
        await enviarAlEndpoint(env, entry.payload);
        await env.OUTBOX.delete(item.name);
      } catch (err) {
        entry.intentos = (entry.intentos || 0) + 1;
        await env.OUTBOX.put(item.name, JSON.stringify(entry));
      }
    }
  }
};
