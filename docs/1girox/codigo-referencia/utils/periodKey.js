/**
 * Utilidad: clave de período mensual
 * Convierte fechas en claves tipo "2026-04"
 */

/**
 * Obtener clave del período actual (mes actual)
 * @returns {string} e.g. "2026-04"
 */
function getCurrentPeriodKey() {
  const now = new Date();
  return formatPeriodKey(now.getFullYear(), now.getMonth() + 1);
}

/**
 * Obtener clave del período anterior
 * @returns {string} e.g. "2026-03"
 */
function getPreviousPeriodKey() {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-based: current month - 1
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  return formatPeriodKey(year, month);
}

/**
 * Formatear clave de período
 * @param {number} year
 * @param {number} month 1-based
 * @returns {string}
 */
function formatPeriodKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Obtener rango de fechas para un periodKey — EN HORA DE ARGENTINA.
 *
 * ⚠️ FIX 2026-07-31: antes usaba `new Date(year, month-1, 1, 0,0,0,0)`, que
 * construye la fecha en la hora LOCAL DEL PROCESO. En producción el server corre en
 * UTC, así que "1 de julio 00:00" era en realidad "30 de junio 21:00" hora argentina:
 * el período de comisiones arrancaba 3 horas antes y terminaba 3 horas antes, y esas
 * 3 horas se contaban en DOS meses distintos (una vez de más y otra de menos).
 *
 * Ahora las fechas se anclan explícitamente al huso argentino (-03:00), que es el que
 * usa el negocio y también el que usa 1girox para evaluar los rangos de sus reportes
 * de netwin. Así el mes que liquidamos es exactamente el mes que ve el owner.
 *
 * @param {string} periodKey e.g. "2026-04"
 * @returns {{ fromEpoch: number, toEpoch: number, fromDate: Date, toDate: Date }}
 */
function getPeriodRange(periodKey) {
  const [year, month] = periodKey.split('-').map(Number);
  const mm = String(month).padStart(2, '0');
  // Día 0 del mes siguiente = último día de este mes. Se calcula en UTC para que no
  // dependa del huso del server (sólo se usa el número del día).
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  // Argentina no aplica horario de verano desde 2009, así que el offset es fijo -03:00.
  const fromDate = new Date(`${year}-${mm}-01T00:00:00-03:00`);
  const toDate = new Date(`${year}-${mm}-${String(lastDay).padStart(2, '0')}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(fromDate.getTime() / 1000),
    toEpoch: Math.floor(toDate.getTime() / 1000),
    fromDate,
    toDate
  };
}

/**
 * Nombre legible de un period key en formato MM/YYYY
 * @param {string} periodKey
 * @returns {string} e.g. "04/2026"
 */
function getPeriodLabel(periodKey) {
  const [year, month] = periodKey.split('-').map(Number);
  return `${String(month).padStart(2, '0')}/${year}`;
}

/**
 * Obtener clave del período siguiente a un periodKey dado
 * @param {string} periodKey e.g. "2026-04"
 * @returns {string} e.g. "2026-05"
 */
function getNextPeriodKey(periodKey) {
  const [year, month] = periodKey.split('-').map(Number);
  if (month === 12) {
    return formatPeriodKey(year + 1, 1);
  }
  return formatPeriodKey(year, month + 1);
}

/**
 * Nombre legible del período siguiente en español
 * @param {string} periodKey
 * @returns {string} e.g. "mayo 2026"
 */
function getNextPeriodLabel(periodKey) {
  return getPeriodLabel(getNextPeriodKey(periodKey));
}

module.exports = {
  getCurrentPeriodKey,
  getPreviousPeriodKey,
  formatPeriodKey,
  getPeriodRange,
  getPeriodLabel,
  getNextPeriodKey,
  getNextPeriodLabel
};
