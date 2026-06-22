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
 * y las devoluciones de retiros rechazados (metadata.source in install_bonus /
 * welcome_gift / payout_refund) del cómputo de cargas reales.
 */
const { User, Transaction, Campaign, InfluencerStory, CampaignClick } = require('../models');

// === Umbrales de negocio (confirmados con el owner) ===
const ACTIVE_DAYS = 7;        // ≤7d desde última carga = activo
const AT_RISK_DAYS = 21;      // 8–21d = en riesgo; >21d = perdido
const NEW_DAYS = 7;           // registrado hace ≤7d = nuevo
const HIGH_TICKET_ARS = 30000; // promedio de carga ≥ $30.000 = ticket alto
const LOYAL_MIN_DEPOSITS = 5;  // ≥5 cargas = cliente fiel/fuerte
const GIFT_SOURCES = ['install_bonus', 'welcome_gift', 'payout_refund'];
const DAY_MS = 24 * 60 * 60 * 1000;

// Cuántos clientes devolver por segmento en el detalle (ordenados por total
// cargado desc). El ranking no devuelve listas, sólo conteos.
const CLIENTS_PER_SEGMENT_CAP = 100;

// === Ranking de influencers por historias (score combinado balanceado) ===
// Pesos (owner 2026-06-22): ROAS 35% + retención de fieles 30% + ticket 20% + CPC 15%.
// Cada métrica se normaliza a 0..1 con un tope fijo y se combina. Score 0..100.
const INF_SCORE_WEIGHTS = { roas: 0.35, loyal: 0.30, ticket: 0.20, cpc: 0.15 };
const INF_ROAS_CAP = 2;        // ROAS neto 2x = puntaje máximo de rentabilidad
const INF_TICKET_CAP = 50000;  // ticket promedio $50.000 = puntaje máximo
const INF_CPC_CAP = 2000;      // costo por click ≥ $2.000 = puntaje 0 (más barato = mejor)

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

  // Nombres conocidos (sembrar buckets en cero aunque no tengan clientes aún) y
  // mapa influencer→campaignCode (para que la UI pueda pedir las historias).
  const knownInfluencers = new Set();
  const codeByInfluencer = Object.create(null);
  for (const c of campaigns) {
    for (const inf of (c.influencers || [])) {
      if (inf && inf.name) {
        knownInfluencers.add(inf.name);
        if (!codeByInfluencer[inf.name]) codeByInfluencer[inf.name] = c.code;
      }
    }
  }

  const users = await User.find({ acquisitionCampaign: { $in: codes } })
    .select('username acquisitionInfluencer acquisitionCampaign createdAt').lean();

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
    if (name !== 'Sin influencer' && !codeByInfluencer[name]) {
      codeByInfluencer[name] = u.acquisitionCampaign;
    }

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
    .map(m => ({ influencer: m.publisher, campaignCode: codeByInfluencer[m.publisher] || null, ...m }));
  // Orden: más facturación neta primero, luego más registrados.
  rows.sort((a, b) => b.netRevenue - a.netRevenue || b.registered - a.registered);

  return { publisher, influencers: rows };
}

/**
 * Seguimiento por HISTORIA de un influencer: costo, registros, clientes, ROAS.
 *
 * Atribución por ventana horaria: las historias se ordenan por `postedAt` asc y
 * cada una se queda con los usuarios (acquisitionCampaign=code, acquisitionInfluencer
 * =influencer) cuyo `createdAt` cae en [postedAt_i, postedAt_{i+1}). La última se
 * queda con todo hasta ahora. Los usuarios creados ANTES de la 1ra historia van a
 * un bucket `before` aparte (no ensucia el ROAS de las historias).
 *
 * Por historia computa (cargas = lifetime de la cohorte, sin regalos):
 *   - registros (usuarios), clientes (cargaron ≥1), depositCount
 *   - deposits (bruto), withdrawals, net, ftdCount, ftdAmount (1ra carga)
 *   - cpaPerRegistro = costo / registros, cpaPerCliente = costo / clientes
 *   - roasNet = net / costo, roasGross = deposits / costo
 * Los umbrales de "rentable" (ROAS objetivo, CPA objetivo) se aplican en el front
 * para que el owner los pueda mover sin recalcular.
 *
 * @param {string} campaignCode
 * @param {string} influencer
 */
async function getInfluencerStoryAnalysis(campaignCode, influencer) {
  const code = String(campaignCode || '').toUpperCase().trim();
  const name = String(influencer || '').trim();
  if (!code || !name) return null;

  const campaign = await Campaign.findOne({ code }).select('publisher').lean();
  if (!campaign) return null;

  const stories = await InfluencerStory.find({ campaignCode: code, influencer: name })
    .sort({ postedAt: 1 }).lean();

  const users = await User.find({ acquisitionCampaign: code, acquisitionInfluencer: name })
    .select('username createdAt').lean();
  const usernames = users.map(u => u.username);

  // Cargas (sin regalos) y retiros de toda la vida de esos usuarios. Guardamos
  // también la ÚLTIMA carga por usuario (para "cliente activo" = cargó ≤7d).
  const depByUser = Object.create(null);
  const witByUser = Object.create(null);
  if (usernames.length) {
    const deposits = await Transaction.find({
      type: 'deposit',
      username: { $in: usernames },
      $or: [
        { 'metadata.source': { $exists: false } },
        { 'metadata.source': { $nin: GIFT_SOURCES } }
      ]
    }).select('username amount timestamp').sort({ timestamp: 1 }).lean();
    for (const tx of deposits) {
      const a = tx.amount || 0;
      let d = depByUser[tx.username];
      if (!d) { depByUser[tx.username] = { total: a, count: 1, first: a, last: tx.timestamp }; }
      else { d.total += a; d.count += 1; d.last = tx.timestamp; } // sorted asc → last = más reciente
    }
    const witAgg = await Transaction.aggregate([
      { $match: { type: 'withdrawal', username: { $in: usernames } } },
      { $group: { _id: '$username', total: { $sum: '$amount' } } }
    ]);
    for (const w of witAgg) witByUser[w._id] = w.total;
  }

  // Clicks de la campaña (CampaignClick es por campaña, no por influencer, y
  // tiene TTL de 90 días). Se atribuyen a cada historia por ventana horaria,
  // igual que los usuarios. Para historias de +90 días puede no haber clicks.
  const clickMs = [];
  try {
    const clicks = await CampaignClick.find({ campaignCode: code }).select('clickedAt').lean();
    for (const c of clicks) if (c.clickedAt) clickMs.push(new Date(c.clickedAt).getTime());
  } catch (_) { /* sin clicks disponibles */ }

  const now = Date.now();
  const activeCutoff = now - ACTIVE_DAYS * DAY_MS;

  const mkBucket = () => ({ registros: 0, clientes: 0, depositCount: 0, deposits: 0, withdrawals: 0, ftdCount: 0, ftdAmount: 0, loyalCount: 0, activeCount: 0, clicks: 0 });
  const buckets = stories.map(() => mkBucket());
  const before = mkBucket();
  const postedMs = stories.map(s => new Date(s.postedAt).getTime());

  // Índice de la última historia cuyo postedAt <= ts (-1 = antes de todas).
  const assignIndex = (ts) => {
    let idx = -1;
    for (let i = 0; i < postedMs.length; i++) {
      if (postedMs[i] <= ts) idx = i; else break;
    }
    return idx;
  };

  for (const u of users) {
    const idx = assignIndex(new Date(u.createdAt).getTime());
    const b = idx === -1 ? before : buckets[idx];
    const dep = depByUser[u.username];
    b.registros += 1;
    if (dep && dep.count > 0) {
      b.clientes += 1;
      b.depositCount += dep.count;
      b.deposits += dep.total;
      b.ftdCount += 1;
      b.ftdAmount += dep.first;
      if (dep.count >= LOYAL_MIN_DEPOSITS) b.loyalCount += 1;           // cliente fiel (≥5 cargas)
      if (dep.last && new Date(dep.last).getTime() >= activeCutoff) b.activeCount += 1; // sigue activo (cargó ≤7d)
    }
    b.withdrawals += (witByUser[u.username] || 0);
  }

  // Clicks por ventana de historia.
  for (const cm of clickMs) {
    const idx = assignIndex(cm);
    const b = idx === -1 ? before : buckets[idx];
    b.clicks += 1;
  }

  const finalize = (b, story, i) => {
    const cost = story ? (story.cost || 0) : 0;
    const net = b.deposits - b.withdrawals;
    return {
      storyId: story ? story.id : null,
      number: story ? (i + 1) : null,
      postedAt: story ? story.postedAt : null,
      label: story ? (story.label || '') : '',
      cost,
      registros: b.registros,
      clientes: b.clientes,
      depositCount: b.depositCount,
      deposits: Math.round(b.deposits),
      withdrawals: Math.round(b.withdrawals),
      net: Math.round(net),
      ftdCount: b.ftdCount,
      ftdAmount: Math.round(b.ftdAmount),
      // Conversión registro→cliente (cargó al menos una vez).
      conversionRate: b.registros > 0 ? b.clientes / b.registros : null,
      // Retención: clientes fieles (≥5 cargas) y clientes que siguen activos (cargaron ≤7d).
      loyalCount: b.loyalCount,
      loyalRate: b.clientes > 0 ? b.loyalCount / b.clientes : null,
      activeCount: b.activeCount,
      activeRate: b.clientes > 0 ? b.activeCount / b.clientes : null,
      avgTicket: b.depositCount > 0 ? Math.round(b.deposits / b.depositCount) : null,
      clicks: b.clicks,
      cpc: b.clicks > 0 ? Math.round(cost / b.clicks) : null,
      cpaPerRegistro: b.registros > 0 ? Math.round(cost / b.registros) : null,
      cpaPerCliente: b.clientes > 0 ? Math.round(cost / b.clientes) : null,
      roasNet: cost > 0 ? net / cost : null,
      roasGross: cost > 0 ? b.deposits / cost : null
    };
  };

  const storyRows = stories.map((s, i) => finalize(buckets[i], s, i));
  const beforeRow = before.registros > 0 ? finalize(before, null, -1) : null;

  const totals = storyRows.reduce((t, r) => {
    t.cost += r.cost; t.registros += r.registros; t.clientes += r.clientes;
    t.depositCount += r.depositCount; t.deposits += r.deposits;
    t.withdrawals += r.withdrawals; t.net += r.net;
    t.ftdCount += r.ftdCount; t.ftdAmount += r.ftdAmount;
    t.loyalCount += r.loyalCount; t.activeCount += r.activeCount; t.clicks += r.clicks;
    return t;
  }, { cost: 0, registros: 0, clientes: 0, depositCount: 0, deposits: 0, withdrawals: 0, net: 0, ftdCount: 0, ftdAmount: 0, loyalCount: 0, activeCount: 0, clicks: 0 });
  totals.conversionRate = totals.registros > 0 ? totals.clientes / totals.registros : null;
  totals.loyalRate = totals.clientes > 0 ? totals.loyalCount / totals.clientes : null;
  totals.activeRate = totals.clientes > 0 ? totals.activeCount / totals.clientes : null;
  totals.avgTicket = totals.depositCount > 0 ? Math.round(totals.deposits / totals.depositCount) : null;
  totals.cpc = totals.clicks > 0 ? Math.round(totals.cost / totals.clicks) : null;
  totals.cpaPerRegistro = totals.registros > 0 ? Math.round(totals.cost / totals.registros) : null;
  totals.cpaPerCliente = totals.clientes > 0 ? Math.round(totals.cost / totals.clientes) : null;
  totals.roasNet = totals.cost > 0 ? totals.net / totals.cost : null;
  totals.roasGross = totals.cost > 0 ? totals.deposits / totals.cost : null;

  return {
    campaignCode: code,
    publisher: campaign.publisher,
    influencer: name,
    stories: storyRows,
    before: beforeRow,
    totals
  };
}

// Puntaje 0..100 de un influencer a partir de sus totales (historias).
// Score combinado balanceado: ROAS 35% + retención de fieles 30% + ticket 20% + CPC 15%.
// Cada componente se normaliza a 0..1 con topes fijos (ver constantes INF_*).
function _influencerScore(totals) {
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const roasNet = (totals.roasNet == null) ? 0 : totals.roasNet;
  const roasScore = clamp01(roasNet / INF_ROAS_CAP);
  const loyalScore = clamp01(totals.loyalRate || 0);
  const ticketScore = clamp01((totals.avgTicket || 0) / INF_TICKET_CAP);
  // CPC: más barato = mejor. Si no hay clicks (TTL 90d), queda neutro (0.5) para
  // no castigar injustamente a historias viejas sin dato de clicks.
  const cpcScore = (totals.cpc == null || totals.clicks === 0)
    ? 0.5
    : clamp01(1 - (totals.cpc / INF_CPC_CAP));
  const w = INF_SCORE_WEIGHTS;
  const score = 100 * (w.roas * roasScore + w.loyal * loyalScore + w.ticket * ticketScore + w.cpc * cpcScore);
  return {
    score: Math.round(score),
    components: {
      roasScore: Math.round(roasScore * 100),
      loyalScore: Math.round(loyalScore * 100),
      ticketScore: Math.round(ticketScore * 100),
      cpcScore: Math.round(cpcScore * 100)
    }
  };
}

/**
 * Ranking de influencers de UNA campaña, de mejor a peor, por score combinado
 * (ROAS, retención de fieles, ticket promedio, costo por click). Reúsa
 * getInfluencerStoryAnalysis por influencer y agrega su score + métricas clave.
 *
 * Incluye a todos los influencers conocidos de la campaña (Campaign.influencers)
 * y a cualquier `acquisitionInfluencer` presente en usuarios atribuidos.
 * @param {string} campaignCode
 */
async function getInfluencerStoriesRanking(campaignCode) {
  const code = String(campaignCode || '').toUpperCase().trim();
  if (!code) return null;
  const campaign = await Campaign.findOne({ code }).select('publisher influencers').lean();
  if (!campaign) return null;

  // Nombres de influencer: los de la lista de la campaña + los presentes en users.
  const fromList = (campaign.influencers || []).map(i => i.name).filter(Boolean);
  const fromUsers = await User.distinct('acquisitionInfluencer', { acquisitionCampaign: code, acquisitionInfluencer: { $ne: null } });
  const seen = new Set();
  const names = [];
  for (const n of [...fromList, ...fromUsers]) {
    const k = String(n || '').trim();
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    names.push(k);
  }

  const rows = [];
  for (const name of names) {
    const a = await getInfluencerStoryAnalysis(code, name);
    if (!a) continue;
    const t = a.totals || {};
    const { score, components } = _influencerScore(t);
    rows.push({
      influencer: name,
      storiesCount: (a.stories || []).length,
      registros: t.registros || 0,
      clientes: t.clientes || 0,
      conversionRate: t.conversionRate,
      loyalCount: t.loyalCount || 0,
      loyalRate: t.loyalRate,
      activeCount: t.activeCount || 0,
      activeRate: t.activeRate,
      avgTicket: t.avgTicket,
      cost: Math.round(t.cost || 0),
      deposits: Math.round(t.deposits || 0),
      net: Math.round(t.net || 0),
      clicks: t.clicks || 0,
      cpc: t.cpc,
      roasNet: t.roasNet,
      roasGross: t.roasGross,
      score,
      scoreComponents: components
    });
  }

  rows.sort((a, b) => (b.score - a.score) || ((b.net || 0) - (a.net || 0)));

  return {
    campaignCode: code,
    publisher: campaign.publisher,
    weights: INF_SCORE_WEIGHTS,
    caps: { roas: INF_ROAS_CAP, ticket: INF_TICKET_CAP, cpc: INF_CPC_CAP },
    influencers: rows
  };
}

/**
 * Lista paginada de los usuarios atribuidos a un (campaña, influencer) con sus
 * stats de cargas/retiros. Sirve para que el admin revise quién quedó bajo cada
 * influencer y corrija errores de asignación. Devuelve también la lista de
 * influencers de la campaña (para el desplegable de reasignación).
 *
 * @param {string} campaignCode
 * @param {string} influencer
 * @param {number} page
 * @param {number} perPage
 */
async function getInfluencerUsers(campaignCode, influencer, page = 1, perPage = 20) {
  const code = String(campaignCode || '').toUpperCase().trim();
  const name = String(influencer || '').trim();
  if (!code || !name) return null;

  const campaign = await Campaign.findOne({ code }).select('publisher influencers').lean();
  if (!campaign) return null;

  const baseQuery = { acquisitionCampaign: code, acquisitionInfluencer: name };
  const total = await User.countDocuments(baseQuery);
  const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
  const users = await User.find(baseQuery)
    .select('id username createdAt acquisitionInfluencer')
    .sort({ createdAt: -1 })
    .skip((page - 1) * perPage)
    .limit(perPage)
    .lean();

  const usernames = users.map(u => u.username);
  const { depByUser, witByUser } = await _loadTxStats(usernames.length ? usernames : []);

  const rows = users.map(u => {
    const dep = depByUser[u.username];
    const deposits = dep ? dep.total : 0;
    const depositCount = dep ? dep.count : 0;
    const withdrawals = witByUser[u.username] || 0;
    return {
      id: u.id,
      username: u.username,
      createdAt: u.createdAt,
      influencer: u.acquisitionInfluencer || null,
      deposits: Math.round(deposits),
      depositCount,
      withdrawals: Math.round(withdrawals),
      net: Math.round(deposits - withdrawals)
    };
  });

  return {
    campaignCode: code,
    publisher: campaign.publisher,
    influencer: name,
    availableInfluencers: (campaign.influencers || []).map(i => ({ name: i.name, isActive: i.isActive !== false })),
    users: rows,
    total,
    page,
    totalPages,
    perPage
  };
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
  getInfluencerStoryAnalysis,
  getInfluencerStoriesRanking,
  getInfluencerUsers,
  // Exportados por si se quieren testear / ajustar
  ACTIVE_DAYS,
  AT_RISK_DAYS,
  HIGH_TICKET_ARS,
  LOYAL_MIN_DEPOSITS
};
