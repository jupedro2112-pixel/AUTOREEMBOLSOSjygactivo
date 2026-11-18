/**
 * periodRanges.js — Rangos de fecha en hora de ARGENTINA (UTC-3) para los períodos
 * de reembolso: ayer, semana pasada (lunes a domingo) y mes pasado.
 *
 * Estas funciones vivían dentro de `jugaygana.js`, pero son PURAS: no dependen de
 * ninguna plataforma externa, sólo del calendario. Se movieron acá tal cual en la
 * migración a 1girox para que el cliente viejo pueda borrarse sin arrastrarlas.
 *
 * ⚠️ La zona horaria está FIJA en America/Argentina/Buenos_Aires a propósito: los
 * períodos de reembolso los define el owner en hora argentina, y el server puede
 * correr en UTC (AWS). Si esto usara la hora del server, el corte del día se
 * desplazaría 3 horas y el reembolso "de ayer" incluiría parte de anteayer.
 *
 * Cada función devuelve epochs en segundos (compatibilidad con el código que ya los
 * consumía) más los strings de fecha que se usan para armar los `periodKey` únicos
 * de RefundClaim — de ahí que NO se puedan cambiar sin romper la idempotencia de los
 * reclamos ya guardados.
 */

const AR_TZ = 'America/Argentina/Buenos_Aires';

function _formatter() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: AR_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

/** Devuelve {y, m, d} (strings con ceros a la izquierda) de una fecha, en hora argentina. */
function _partsOf(formatter, date) {
  const p = formatter.formatToParts(date);
  return {
    y: p.find((x) => x.type === 'year').value,
    m: p.find((x) => x.type === 'month').value,
    d: p.find((x) => x.type === 'day').value
  };
}

/**
 * Ayer, de 00:00:00 a 23:59:59 hora argentina.
 * @returns {{fromEpoch:number, toEpoch:number, dateStr:string}}
 */
function getYesterdayRangeArgentinaEpoch() {
  const formatter = _formatter();
  const today = _partsOf(formatter, new Date());

  const todayLocal = new Date(`${today.y}-${today.m}-${today.d}T00:00:00-03:00`);
  const yesterdayLocal = new Date(todayLocal.getTime() - 24 * 60 * 60 * 1000);
  const y = _partsOf(formatter, yesterdayLocal);

  const from = new Date(`${y.y}-${y.m}-${y.d}T00:00:00-03:00`);
  const to = new Date(`${y.y}-${y.m}-${y.d}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(from.getTime() / 1000),
    toEpoch: Math.floor(to.getTime() / 1000),
    dateStr: `${y.y}-${y.m}-${y.d}`
  };
}

/**
 * Hoy, de 00:00:00 a 23:59:59 hora argentina.
 * @returns {{fromEpoch:number, toEpoch:number, dateStr:string}}
 */
function getTodayRangeArgentinaEpoch() {
  const formatter = _formatter();
  const t = _partsOf(formatter, new Date());

  const from = new Date(`${t.y}-${t.m}-${t.d}T00:00:00-03:00`);
  const to = new Date(`${t.y}-${t.m}-${t.d}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(from.getTime() / 1000),
    toEpoch: Math.floor(to.getTime() / 1000),
    dateStr: `${t.y}-${t.m}-${t.d}`
  };
}

/**
 * La semana pasada completa: lunes 00:00:00 a domingo 23:59:59, hora argentina.
 * @returns {{fromEpoch:number, toEpoch:number, fromDateStr:string, toDateStr:string}}
 */
function getLastWeekRangeArgentinaEpoch() {
  const formatter = _formatter();
  const t = _partsOf(formatter, new Date());
  const todayLocal = new Date(`${t.y}-${t.m}-${t.d}T00:00:00-03:00`);

  // getDay(): 0 = domingo. El domingo cuenta como el último día de la semana que
  // termina, no como el primero de la siguiente — por eso el 6.
  const dayOfWeek = todayLocal.getDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const thisMonday = new Date(todayLocal.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  const lastMonday = new Date(thisMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lastSunday = new Date(lastMonday.getTime() + 6 * 24 * 60 * 60 * 1000);

  const mon = _partsOf(formatter, lastMonday);
  const sun = _partsOf(formatter, lastSunday);

  const from = new Date(`${mon.y}-${mon.m}-${mon.d}T00:00:00-03:00`);
  const to = new Date(`${sun.y}-${sun.m}-${sun.d}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(from.getTime() / 1000),
    toEpoch: Math.floor(to.getTime() / 1000),
    fromDateStr: `${mon.y}-${mon.m}-${mon.d}`,
    toDateStr: `${sun.y}-${sun.m}-${sun.d}`
  };
}

/**
 * El mes pasado completo: día 1 00:00:00 al último día 23:59:59, hora argentina.
 * @returns {{fromEpoch:number, toEpoch:number, fromDateStr:string, toDateStr:string}}
 */
function getLastMonthRangeArgentinaEpoch() {
  const formatter = _formatter();
  const p = formatter.formatToParts(new Date());
  const yyyy = parseInt(p.find((x) => x.type === 'year').value, 10);
  const mm = parseInt(p.find((x) => x.type === 'month').value, 10);

  let lastMonth = mm - 1;
  let lastMonthYear = yyyy;
  if (lastMonth === 0) {
    lastMonth = 12;
    lastMonthYear = yyyy - 1;
  }

  // new Date(año, mes, 0) da el último día del mes anterior a `mes` (con mes 1-based
  // esto devuelve el último día de `lastMonth`). Cubre febrero y los bisiestos.
  const lastDayOfLastMonth = new Date(lastMonthYear, lastMonth, 0).getDate();
  const mStr = String(lastMonth).padStart(2, '0');

  const from = new Date(`${lastMonthYear}-${mStr}-01T00:00:00-03:00`);
  const to = new Date(`${lastMonthYear}-${mStr}-${lastDayOfLastMonth}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(from.getTime() / 1000),
    toEpoch: Math.floor(to.getTime() / 1000),
    fromDateStr: `${lastMonthYear}-${mStr}-01`,
    toDateStr: `${lastMonthYear}-${mStr}-${lastDayOfLastMonth}`
  };
}

module.exports = {
  getYesterdayRangeArgentinaEpoch,
  getTodayRangeArgentinaEpoch,
  getLastWeekRangeArgentinaEpoch,
  getLastMonthRangeArgentinaEpoch
};
