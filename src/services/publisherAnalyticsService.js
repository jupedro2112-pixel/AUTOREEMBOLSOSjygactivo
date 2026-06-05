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
  // "Cliente" = alguien que cargó al menos una vez. Los que nunca cargaron NO
  // cuentan como clientes (sólo como "registrados sin cargar", dato secundario).
  const clients = acc.counts.active + acc.counts.atRisk + acc.counts.lost; // = depositores
  const registered = acc.totalClients;          // todos los atribuidos (incluye sin cargar)
  const neverDeposited = acc.counts.never;       // registrados que todavía no cargaron
  const retentionRate = clients > 0 ? acc.counts.active / clients : 0;
  const conversionRate = registered > 0 ? clients / registered : 0; // registrados → clientes
  const avgTicket = acc.depositCount > 0 ? acc.deposits / acc.depositCount : 0;
  const ticketScore = Math.min(avgTicket / 50000, 1); // cap a $50k
  const netRevenue = acc.deposits - acc.withdrawals;
  // Score 0–100: 40% retención de clientes + 30% conversión (registrado→cliente)
  // + 30% fuerza del ticket promedio.
  const score = Math.round(40 * retentionRate + 30 * conversionRate + 30 * ticketScore);
  return {
    publisher: acc.publisher,
    clients,                 // <- "CLIENTES" mostrado = sólo los que cargaron
    registered,              // total atribuidos (para contexto)
    neverDeposited,          // registrados aún sin cargar (dato secundario)
    active: acc.counts.active,
    atRisk: acc.counts.atRisk,
    lost: acc.counts.lost,
    newClients: acc.newCount,
    highTicketCount: acc.highTicketCount,
    loyalCount: acc.loyalCount,
    deposits: acc.deposits,
    withdrawals: acc.withdrawals,
    depositCount: acc.depositCount,
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

/**
 * Desglose por INFLUENCER dentro de un publicista. Agrupa los usuarios
 * atribuidos al publicista por su `acquisitionInfluencer` (sub-etiqueta que pone
 * el publisher_admin al crear el usuario) y calcula las mismas métricas que el
 * análisis por publicista (clientes, cargas, retención, ticket, score…).
 *
 * - Los usuarios sin influencer (orgánicos del link, o creados antes de cargar
 *   la lista) caen en el bucket "Sin influencer".
 * - Se siembran TODOS los influencers conocidos de la campaña (aunque todavía no
 *   hayan traído clientes) para que aparezcan en cero.
 *
 * @param {string} publisher
 * @returns {{ publisher, influencers: Array<metrics & { influencer }> } | null}
 */
async function getInfluencerBreakdown(publisher) {
  const campaigns = await Campaign.find({ publisher }).select('code influencers').lean();
  if (campaigns.length === 0) return null;
  const codes = campaigns.map(c => c.code);

  // Nombres conocidos (sembrar buckets en cero aunque no tengan clientes aún).
  const knownInfluencers = new Set();
  for (const c of campaigns) {
    for (const inf of (c.influencers || [])) {
      if (inf && inf.name) knownInfluencers.add(inf.name);
    }
  }

  const users = await User.find({ acquisitionCampaign: { $in: codes } })
    .select('username acquisitionInfluencer createdAt').lean();

  const usernames = users.map(u => u.username);
  const { depByUser, witByUser } = await _loadTxStats(usernames.length ? usernames : []);

  const now = Date.now();
  const map = new Map();
  const ensure = (name) => {
    if (!map.has(name)) map.set(name, _emptyAcc(name));
    return map.get(name);
  };
  for (const n of knownInfluencers) ensure(n);

  for (const u of users) {
    const name = (u.acquisitionInfluencer && String(u.acquisitionInfluencer).trim()) || 'Sin influencer';
    const acc = ensure(name);

    const dep = depByUser[u.username];
    const total = dep ? dep.total : 0;
    const count = dep ? dep.count : 0;
    const last = dep ? dep.last : null;
    const avg = count > 0 ? total / count : 0;
    const wit = witByUser[u.username] || 0;
    const daysSinceLast = last ? (now - new Date(last).getTime()) / DAY_MS : null;
    const isNew = (now - new Date(u.createdAt).getTime()) / DAY_MS <= NEW_DAYS;
    const segment = _classifySegment(count, daysSinceLast);

    acc.totalClients++;
    acc.deposits += total;
    acc.withdrawals += wit;
    acc.depositCount += count;
    acc.counts[segment]++;
    if (isNew) acc.newCount++;
    if (avg >= HIGH_TICKET_ARS) acc.highTicketCount++;
    if (count >= LOYAL_MIN_DEPOSITS) acc.loyalCount++;
  }

  const rows = Array.from(map.values())
    .map(_finalizeMetrics)
    .map(m => ({ influencer: m.publisher, ...m }));
  // Orden: más facturación neta primero, luego más registrados.
  rows.sort((a, b) => b.netRevenue - a.netRevenue || b.registered - a.registered);

  return { publisher, influencers: rows };
}

// Argentina es UTC-3 todo el año (sin DST). Día ART de un timestamp UTC.
const ART_OFFSET_MS = 3 * 60 * 60 * 1000;
function _artDay(ts) {
  return new Date(new Date(ts).getTime() - ART_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Breakdown DIARIO de un publicista, enfocado en primera carga (FTD) y recargas
 * del mismo día de clientes nuevos.
 *
 * Por cada día (en hora Argentina) devuelve:
 *   - ftdCount / ftdAmount : clientes cuya PRIMERA carga histórica fue ese día,
 *     y la suma de esa primera carga. Es lo que se usa para el ROAS diario
 *     (FTD revenue vs. gasto de pauta de ese día).
 *   - totalDeposits / totalAmount : TODAS las cargas de ese día (de clientes
 *     de este publicista).
 *   - newReloadedClients : clientes nuevos (FTD ese día) que cargaron 2+ veces
 *     el MISMO día (ej: cargó a las 15hs y volvió a cargar a las 20hs).
 *   - newReloadDeposits / newReloadAmount : cuántas cargas de recarga (la 2da en
 *     adelante) hicieron esos clientes nuevos ese día, y su monto.
 *
 * @param {string} publisher
 * @param {string|null} fromStr  YYYY-MM-DD ART (default: hace 30 días)
 * @param {string|null} toStr    YYYY-MM-DD ART (default: hoy)
 */
async function getDailyBreakdown(publisher, fromStr = null, toStr = null) {
  const campaigns = await Campaign.find({ publisher }).select('code').lean();
  if (campaigns.length === 0) return null;
  const codes = campaigns.map(c => c.code);

  const users = await User.find({ acquisitionCampaign: { $in: codes } }).select('username').lean();
  const totalsEmpty = { ftdCount: 0, ftdAmount: 0, totalDeposits: 0, totalAmount: 0, newReloadedClients: 0, newReloadDeposits: 0, newReloadAmount: 0 };
  if (users.length === 0) return { publisher, from: fromStr, to: toStr, days: [], totals: totalsEmpty };
  const usernames = users.map(u => u.username);

  // Todas las cargas reales (sin regalos) de los clientes del publicista, asc.
  // Sin filtro de fecha: necesitamos la PRIMERA carga histórica de cada user
  // para saber en qué día fue "nuevo", aunque sea anterior al rango pedido.
  const deposits = await Transaction.find({
    type: 'deposit',
    username: { $in: usernames },
    $or: [
      { 'metadata.source': { $exists: false } },
      { 'metadata.source': { $nin: GIFT_SOURCES } }
    ]
  }).select('username amount timestamp').sort({ timestamp: 1 }).lean();

  const firstDepositDay = Object.create(null); // user → día ART de su 1ra carga histórica
  const perDay = new Map();
  const getDay = (day) => {
    if (!perDay.has(day)) {
      perDay.set(day, {
        date: day,
        totalDeposits: 0,
        totalAmount: 0,
        ftdCount: 0,
        ftdAmount: 0,
        // user → { count, total, first } de las cargas de clientes nuevos ESE día
        newClientDay: new Map()
      });
    }
    return perDay.get(day);
  };

  for (const tx of deposits) {
    const day = _artDay(tx.timestamp);
    const amount = tx.amount || 0;
    const acc = getDay(day);
    acc.totalDeposits++;
    acc.totalAmount += amount;

    const isFirstEver = firstDepositDay[tx.username] === undefined;
    if (isFirstEver) {
      firstDepositDay[tx.username] = day;
      acc.ftdCount++;
      acc.ftdAmount += amount;
    }

    // ¿Esta carga es de un cliente cuya FTD fue este mismo día? (cliente nuevo del día)
    if (firstDepositDay[tx.username] === day) {
      const m = acc.newClientDay;
      const prev = m.get(tx.username);
      if (!prev) m.set(tx.username, { count: 1, total: amount, first: amount });
      else { prev.count++; prev.total += amount; }
    }
  }

  // Finalizar cada día.
  const rows = [];
  for (const acc of perDay.values()) {
    let newReloadedClients = 0, newReloadDeposits = 0, newReloadAmount = 0;
    for (const stat of acc.newClientDay.values()) {
      if (stat.count >= 2) {
        newReloadedClients++;
        newReloadDeposits += (stat.count - 1);
        newReloadAmount += (stat.total - stat.first);
      }
    }
    rows.push({
      date: acc.date,
      ftdCount: acc.ftdCount,
      ftdAmount: Math.round(acc.ftdAmount),
      totalDeposits: acc.totalDeposits,
      totalAmount: Math.round(acc.totalAmount),
      newReloadedClients,
      newReloadDeposits,
      newReloadAmount: Math.round(newReloadAmount)
    });
  }

  // Rango por defecto: últimos 30 días.
  const todayArt = _artDay(Date.now());
  const defFrom = _artDay(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const from = fromStr || defFrom;
  const to = toStr || todayArt;

  const filtered = rows.filter(r => r.date >= from && r.date <= to).sort((a, b) => b.date.localeCompare(a.date));

  const totals = filtered.reduce((t, r) => {
    t.ftdCount += r.ftdCount; t.ftdAmount += r.ftdAmount;
    t.totalDeposits += r.totalDeposits; t.totalAmount += r.totalAmount;
    t.newReloadedClients += r.newReloadedClients;
    t.newReloadDeposits += r.newReloadDeposits; t.newReloadAmount += r.newReloadAmount;
    return t;
  }, { ...totalsEmpty });

  return { publisher, from, to, days: filtered, totals };
}

module.exports = {
  getRanking,
  getPublisherAnalysis,
  getSegmentUsernames,
  getDailyBreakdown,
  getInfluencerBreakdown,
  // Exportados por si se quieren testear / ajustar
  ACTIVE_DAYS,
  AT_RISK_DAYS,
  HIGH_TICKET_ARS,
  LOYAL_MIN_DEPOSITS
};
