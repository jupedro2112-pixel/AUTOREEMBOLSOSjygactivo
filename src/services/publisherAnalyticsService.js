/**
 * Analítica de clientes por publicista.
 *
 * Segmenta a los usuarios atribuidos a cada publicista (User.acquisitionCampaign
 * → Campaign.publisher) según su actividad de cargas (colección Transaction,
 * type='deposit', permanente). Calcula métricas de salud, clientes valiosos y
 * un score de efectividad para rankear publicistas.
 *
 * Segmentos (basados en la ÚLTIMA carga del cliente, desde hoy):
 *   - active  : última carga hace ≤ 7 días
 *   - atRisk  : última carga hace 8–21 días (se está yendo)
 *   - lost    : última carga hace > 21 días (alguna vez cargó)
 *   - never   : 0 cargas históricas
 * Marcadores transversales:
 *   - new       : registrado hace ≤ 7 días
 *   - highTicket: promedio de carga ≥ $30.000
 *   - loyal     : ≥ 5 cargas
 *
 * Fuente de datos: Transaction (deposits/withdrawals). Se excluyen los regalos
 * (metadata.source in install_bonus / welcome_gift) del cómputo de cargas reales.
 */
const { User, Transaction, Campaign } = require('../models');

// === Umbrales de negocio (confirmados con el owner) ===
const ACTIVE_DAYS = 7;        // ≤7d desde última carga = activo
const AT_RISK_DAYS = 21;      // 8–21d = en riesgo; >21d = perdido
const NEW_DAYS = 7;           // registrado hace ≤7d = nuevo
const HIGH_TICKET_ARS = 30000; // promedio de carga ≥ $30.000 = ticket alto
const LOYAL_MIN_DEPOSITS = 5;  // ≥5 cargas = cliente fiel/fuerte
const GIFT_SOURCES = ['install_bonus', 'welcome_gift'];
const DAY_MS = 24 * 60 * 60 * 1000;

// Cuántos clientes devolver por segmento en el detalle (ordenados por total
// cargado desc). El ranking no devuelve listas, sólo conteos.
const CLIENTS_PER_SEGMENT_CAP = 100;

/**
 * Carga las estadísticas de cargas/retiros por username.
 * @param {string[]|null} usernames  si es null, agrega TODA la colección
 *   (para el ranking global); si es un array, filtra por esos usernames.
 * @returns {{ depByUser: Object, witByUser: Object }}
 */
async function _loadTxStats(usernames) {
  const depMatch = {
    type: 'deposit',
    $or: [
      { 'metadata.source': { $exists: false } },
      { 'metadata.source': { $nin: GIFT_SOURCES } }
    ]
  };
  const witMatch = { type: 'withdrawal' };
  if (Array.isArray(usernames)) {
    depMatch.username = { $in: usernames };
    witMatch.username = { $in: usernames };
  }

  const [depAgg, witAgg] = await Promise.all([
    Transaction.aggregate([
      { $match: depMatch },
      { $group: { _id: '$username', total: { $sum: '$amount' }, count: { $sum: 1 }, last: { $max: '$timestamp' } } }
    ]),
    Transaction.aggregate([
      { $match: witMatch },
      { $group: { _id: '$username', total: { $sum: '$amount' } } }
    ])
  ]);

  const depByUser = Object.create(null);
  for (const d of depAgg) depByUser[d._id] = d;
  const witByUser = Object.create(null);
  for (const w of witAgg) witByUser[w._id] = w.total;
  return { depByUser, witByUser };
}

function _classifySegment(count, daysSinceLast) {
  if (count === 0) return 'never';
  if (daysSinceLast <= ACTIVE_DAYS) return 'active';
  if (daysSinceLast <= AT_RISK_DAYS) return 'atRisk';
  return 'lost';
}

function _emptyAcc(publisher) {
  return {
    publisher,
    totalClients: 0,
    deposits: 0,
    withdrawals: 0,
    depositCount: 0,
    newCount: 0,
    highTicketCount: 0,
    loyalCount: 0,
    counts: { active: 0, atRisk: 0, lost: 0, never: 0 },
    // listas (sólo se llenan en el modo detalle de un publicista)
    clients: { active: [], atRisk: [], lost: [], never: [] },
    highTicket: [],
    loyal: []
  };
}

function _finalizeMetrics(acc) {
  const depositors = acc.counts.active + acc.counts.atRisk + acc.counts.lost;
  const retentionRate = depositors > 0 ? acc.counts.active / depositors : 0;
  const conversionRate = acc.totalClients > 0 ? depositors / acc.totalClients : 0;
  const avgTicket = acc.depositCount > 0 ? acc.deposits / acc.depositCount : 0;
  const ticketScore = Math.min(avgTicket / 50000, 1); // cap a $50k
  const netRevenue = acc.deposits - acc.withdrawals;
  // Score 0–100: 40% retención de quienes cargaron + 30% conversión a carga +
  // 30% fuerza del ticket promedio. Explica "qué tan bueno es el publicista".
  const score = Math.round(40 * retentionRate + 30 * conversionRate + 30 * ticketScore);
  return {
    publisher: acc.publisher,
    totalClients: acc.totalClients,
    depositors,
    active: acc.counts.active,
    atRisk: acc.counts.atRisk,
    lost: acc.counts.lost,
    never: acc.counts.never,
    newClients: acc.newCount,
    highTicketCount: acc.highTicketCount,
    loyalCount: acc.loyalCount,
    deposits: acc.deposits,
    withdrawals: acc.withdrawals,
    netRevenue,
    avgTicket: Math.round(avgTicket),
    retentionRate: Math.round(retentionRate * 100),   // %
    conversionRate: Math.round(conversionRate * 100),  // %
    score
  };
}

/**
 * Núcleo: clasifica clientes y agrupa por publicista.
 * @param {string|null} publisherFilter  si se da, sólo analiza ese publicista
 *   (y devuelve listas de clientes). Si es null, analiza todos (ranking, sin listas).
 */
async function _analyze(publisherFilter = null) {
  const campQuery = publisherFilter ? { publisher: publisherFilter } : {};
  const campaigns = await Campaign.find(campQuery).select('code publisher').lean();
  if (campaigns.length === 0) return new Map();

  const publisherByCode = Object.create(null);
  const codes = [];
  for (const c of campaigns) {
    publisherByCode[c.code] = c.publisher;
    codes.push(c.code);
  }

  const users = await User.find({ acquisitionCampaign: { $in: codes } })
    .select('username acquisitionCampaign createdAt lastLogin acquisitionSource')
    .lean();
  if (users.length === 0) return new Map();

  // Para un solo publicista filtramos las TX por sus usernames (chico). Para el
  // ranking global agregamos toda la colección y joineamos en memoria (evita un
  // $in gigante).
  const usernames = publisherFilter ? users.map(u => u.username) : null;
  const { depByUser, witByUser } = await _loadTxStats(usernames);

  const now = Date.now();
  const detail = !!publisherFilter;
  const pubMap = new Map();

  for (const u of users) {
    const publisher = publisherByCode[u.acquisitionCampaign] || 'Sin publicista';
    if (!pubMap.has(publisher)) pubMap.set(publisher, _emptyAcc(publisher));
    const acc = pubMap.get(publisher);

    const dep = depByUser[u.username];
    const total = dep ? dep.total : 0;
    const count = dep ? dep.count : 0;
    const last = dep ? dep.last : null;
    const avg = count > 0 ? total / count : 0;
    const wit = witByUser[u.username] || 0;
    const daysSinceLast = last ? (now - new Date(last).getTime()) / DAY_MS : null;
    const isNew = (now - new Date(u.createdAt).getTime()) / DAY_MS <= NEW_DAYS;
    const segment = _classifySegment(count, daysSinceLast);
    const highTicket = avg >= HIGH_TICKET_ARS;
    const loyal = count >= LOYAL_MIN_DEPOSITS;

    acc.totalClients++;
    acc.deposits += total;
    acc.withdrawals += wit;
    acc.depositCount += count;
    acc.counts[segment]++;
    if (isNew) acc.newCount++;
    if (highTicket) acc.highTicketCount++;
    if (loyal) acc.loyalCount++;

    if (detail) {
      const clientObj = {
        username: u.username,
        totalDeposited: Math.round(total),
        depositCount: count,
        avgTicket: Math.round(avg),
        withdrawals: Math.round(wit),
        netRevenue: Math.round(total - wit),
        lastDeposit: last,
        daysSinceLastDeposit: daysSinceLast == null ? null : Math.floor(daysSinceLast),
        lastLogin: u.lastLogin || null,
        isNew,
        highTicket,
        loyal,
        source: u.acquisitionSource || 'organic'
      };
      acc.clients[segment].push(clientObj);
      if (highTicket) acc.highTicket.push(clientObj);
      if (loyal) acc.loyal.push(clientObj);
    }
  }
  return pubMap;
}

/**
 * Ranking de todos los publicistas por score (mejor → peor).
 * @returns {Array<metrics>}
 */
async function getRanking() {
  const pubMap = await _analyze(null);
  const rows = Array.from(pubMap.values()).map(_finalizeMetrics);
  rows.sort((a, b) => b.score - a.score || b.netRevenue - a.netRevenue);
  return rows;
}

/**
 * Análisis detallado de UN publicista: métricas + listas de clientes por segmento.
 * @returns {{ metrics, segments, highTicket, loyal } | null}
 */
async function getPublisherAnalysis(publisher) {
  const pubMap = await _analyze(publisher);
  const acc = pubMap.get(publisher);
  if (!acc) return null;

  // Ordenar cada lista por total cargado desc y capar.
  const byTotalDesc = (a, b) => b.totalDeposited - a.totalDeposited;
  const cap = (arr) => arr.sort(byTotalDesc).slice(0, CLIENTS_PER_SEGMENT_CAP);

  return {
    metrics: _finalizeMetrics(acc),
    segments: {
      active: cap(acc.clients.active),
      atRisk: cap(acc.clients.atRisk),
      lost: cap(acc.clients.lost),
      never: cap(acc.clients.never)
    },
    highTicket: cap(acc.highTicket),
    loyal: cap(acc.loyal),
    thresholds: {
      activeDays: ACTIVE_DAYS,
      atRiskDays: AT_RISK_DAYS,
      newDays: NEW_DAYS,
      highTicketArs: HIGH_TICKET_ARS,
      loyalMinDeposits: LOYAL_MIN_DEPOSITS
    }
  };
}

/**
 * Devuelve los usernames de un segmento de un publicista — para mandar push de
 * recuperación. Recalcula server-side (no confía en una lista del cliente).
 * @param {string} publisher
 * @param {'active'|'atRisk'|'lost'|'never'} segment
 * @returns {Promise<string[]>}
 */
async function getSegmentUsernames(publisher, segment) {
  const valid = ['active', 'atRisk', 'lost', 'never'];
  if (!valid.includes(segment)) return [];
  const pubMap = await _analyze(publisher);
  const acc = pubMap.get(publisher);
  if (!acc) return [];
  return acc.clients[segment].map(c => c.username);
}

module.exports = {
  getRanking,
  getPublisherAnalysis,
  getSegmentUsernames,
  // Exportados por si se quieren testear / ajustar
  ACTIVE_DAYS,
  AT_RISK_DAYS,
  HIGH_TICKET_ARS,
  LOYAL_MIN_DEPOSITS
};
