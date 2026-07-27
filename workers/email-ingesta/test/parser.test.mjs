// Golden tests SINTÉTICOS (verifican el port hoy, sin esperar los .eml reales del dueño).
// Cuando el dueño exporte los 8-10 correos reales ("Mostrar original" en Gmail → .eml), agregar
// test/fixtures/*.eml + test/eml.test.mjs que los parsee con postal-mime y compare contra los
// datos reales que ya están en el Sheet para esas reservas — ESE es el test que de verdad cierra
// el riesgo "texto plano de Cloudflare vs GmailApp.getPlainBody()" (ver plan, sección 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDatos_, mesNum_, noches_, parseDMY_, _airNum_, _airFecha_, _airRangoResena_,
  extraerCodigoCancel_, extraerFechasModif_, extraerNombreModif_, fechaTextoADMY_,
  clasificarPorDestino_, pasaGuardSubject_, formatDateEc
} from '../src/parser.js';

test('formatDateEc: offset fijo UTC-5, sin DST', () => {
  // 2026-07-26T04:30:00Z (UTC) = 2026-07-25 23:30 en Ecuador
  const d = new Date('2026-07-26T04:30:00Z');
  assert.equal(formatDateEc(d, 'yyyy-MM-dd'), '2026-07-25');
  assert.equal(formatDateEc(d, 'dd/MM/yyyy'), '25/07/2026');
});

test('_airNum_: formato ES vs EN', () => {
  assert.equal(_airNum_('1.234,56'), 1234.56);
  assert.equal(_airNum_('1,234.56'), 1234.56);
  assert.equal(_airNum_('102.02'), 102.02);
  assert.equal(_airNum_(''), '');
});

test('mesNum_ / parseDMY_ / noches_', () => {
  assert.equal(mesNum_('Jun'), 6);
  assert.equal(mesNum_('sept'), 9); // slice(0,3) toma "sep" de cualquier variante más larga
  assert.equal(mesNum_('sep'), 9);
  assert.equal(mesNum_('xyz'), 0);
  const d = parseDMY_('25/07/2026');
  assert.equal(d.getFullYear(), 2026); assert.equal(d.getMonth(), 6); assert.equal(d.getDate(), 25);
  assert.equal(noches_('25/07/2026', '28/07/2026'), 3);
});

test('parseDatos_: reserva confirmada en español', () => {
  const body = [
    'María Fernández',
    'Identidad verificada',
    '',
    'Apartamento 2A Suite Mall del Río Luxury w/breakfast/parking',
    'Casa/apto. entero',
    '',
    'Llegada',
    '25 jul. de 2026',
    'Salida',
    '28 jul. de 2026',
    '',
    'Viajeros',
    '2 adultos, 1 niño',
    '',
    'Código de confirmación',
    'HM8X7K2P9Q',
    '',
    'Total (USD)',
    '450.00',
    'Gastos de limpieza',
    '35.00'
  ].join('\n');
  const p = parseDatos_({ date: new Date('2026-07-10T12:00:00Z'), subject: 'Reserva confirmada: María Fernández llega el 25 jul.', body });
  assert.equal(p.codigo_confirmacion, 'HM8X7K2P9Q');
  assert.equal(p.huesped, 'María Fernández');
  assert.equal(p.fecha_inicio, '25/07/2026');
  assert.equal(p.fecha_fin, '28/07/2026');
  assert.equal(p.num_huespedes, 3);
  assert.equal(p.ninos, 'Si');
  assert.equal(p.ingresos_brutos, 450);
  assert.equal(p.tarifa_limpieza, 35);
});

test('parseDatos_: reservation confirmed en inglés', () => {
  const body = [
    'John Smith',
    'Identity verified',
    '',
    '6A Confy Room Alto Mall Terrace w/private parking',
    'Entire home',
    '',
    'Check-in',
    'Aug 3',
    'Check-out',
    'Aug 6',
    '',
    'Guests',
    '2 adults',
    '',
    'Confirmation code',
    'HMAB12CD34',
    '',
    'Total (USD)',
    '1,234.56'
  ].join('\n');
  const p = parseDatos_({ date: new Date('2026-07-15T12:00:00Z'), subject: 'Reservation confirmed - John Smith arrives Aug 3', body });
  assert.equal(p.codigo_confirmacion, 'HMAB12CD34');
  assert.equal(p.huesped, 'John Smith');
  assert.equal(p.fecha_inicio, '03/08/2026');
  assert.equal(p.fecha_fin, '06/08/2026');
  assert.equal(p.ingresos_brutos, 1234.56);
});

test('parseDatos_: reseña 5 estrellas (rango EN)', () => {
  const body = 'Find out what Ana López wrote about their stay, Jun 20 – 21';
  const p = parseDatos_({ date: new Date('2026-06-25T12:00:00Z'), subject: 'Ana López left a 5-star review!', body });
  assert.equal(p.huesped, 'Ana López');
  assert.equal(p.estrellas, 5);
  assert.equal(p.fecha_inicio, '20/06/2026');
  assert.equal(p.fecha_fin, '21/06/2026');
});

test('parseDatos_: descarta nombre-basura (tracking/URL)', () => {
  const body = 'https://airbnb.com/x?euid=abc123456\nIdentidad verificada';
  const p = parseDatos_({ date: new Date(), subject: 'x', body });
  assert.equal(p.huesped, null);
});

test('extraerCodigoCancel_: ES y EN', () => {
  assert.equal(extraerCodigoCancel_('Cancelada: Reserva HM8X7K2P9Q'), 'HM8X7K2P9Q');
  assert.equal(extraerCodigoCancel_('Canceled: Reservation HMAB12CD34'), 'HMAB12CD34');
});

test('extraerFechasModif_ + extraerNombreModif_: EN', () => {
  const subj = 'John Smith wants to change reservation dates';
  const body = 'Original Dates\nAug 3, 2026 - Aug 6, 2026\nRequested Dates\nAug 5, 2026 - Aug 8, 2026\nIf you approve...';
  assert.equal(extraerNombreModif_(subj), 'John Smith');
  const f = extraerFechasModif_(body);
  assert.deepEqual(f, { oi: '03/08/2026', of: '06/08/2026', ri: '05/08/2026', rf: '08/08/2026' });
});

test('extraerFechasModif_ + extraerNombreModif_: ES', () => {
  const subj = 'María Fernández quiere modificar las fechas';
  const body = 'Fechas originales\n25 de jul. de 2026 - 28 de jul. de 2026\nFechas solicitadas\n26 de jul. de 2026 - 29 de jul. de 2026\nSi apruebas...';
  assert.equal(extraerNombreModif_(subj), 'María Fernández');
  const f = extraerFechasModif_(body);
  assert.deepEqual(f, { oi: '25/07/2026', of: '28/07/2026', ri: '26/07/2026', rf: '29/07/2026' });
});

test('_airFecha_ / _airRangoResena_: cruce de año diciembre-enero', () => {
  // Correo de diciembre, check-in "5 de ene." -> el año debe saltar al siguiente.
  assert.equal(_airFecha_('\nLlegada\n5 de ene. de 2027', '2026-12-20'), '05/01/2027');
  // Correo de enero, rango de estadía en diciembre -> el año debe retroceder al anterior.
  const r = _airRangoResena_('28 dic. – 30 dic.', '2027-01-05');
  assert.equal(r.ini, '28/12/2026');
  assert.equal(r.fin, '30/12/2026');
});

test('clasificarPorDestino_ + pasaGuardSubject_', () => {
  assert.equal(clasificarPorDestino_('reservas@parse.1242bnb.com'), 'reserva');
  assert.equal(clasificarPorDestino_('cancelaciones@parse.1242bnb.com'), 'cancelacion');
  assert.equal(clasificarPorDestino_('modificaciones@parse.1242bnb.com'), 'modificacion');
  assert.equal(clasificarPorDestino_('cinco@parse.1242bnb.com'), 'resena5');
  assert.equal(clasificarPorDestino_('mejorable@parse.1242bnb.com'), 'resenaBaja');
  assert.equal(clasificarPorDestino_('otra@parse.1242bnb.com'), '');

  assert.equal(pasaGuardSubject_('reserva', 'Reserva confirmada: X llega'), true);
  assert.equal(pasaGuardSubject_('reserva', 'Message sent to X'), false);
  assert.equal(pasaGuardSubject_('reserva', 'Your trip to Cuenca is confirmed'), false);
  assert.equal(pasaGuardSubject_('cancelacion', 'Cancelada: Reserva HM123'), true);
  assert.equal(pasaGuardSubject_('cancelacion', 'algo random'), false);
  assert.equal(pasaGuardSubject_('modificacion', 'X wants to change reservation'), true);
  // Hallazgo D (revisión Fable 26/07): las reseñas comparten el mismo guard de "ajenos" que
  // procesarLabel_ aplica a TODOS los labels (codigo.js:1185-1187), no solo a reservas.
  assert.equal(pasaGuardSubject_('resena5', 'X left a 5-star review!'), true);
  assert.equal(pasaGuardSubject_('resena5', 'Message sent to X'), false);
  assert.equal(pasaGuardSubject_('resenaBaja', 'Your trip to Cuenca is confirmed'), false);
});
