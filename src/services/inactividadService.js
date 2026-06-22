'use strict';
// =====================================================================
// inactividadService — motor de RECUPERACIÓN DE INACTIVOS (único motor de
// bonos automáticos del sistema).
//
// Escalera por días SIN CARGAR (última carga real del usuario, no último
// ingreso): cuando un usuario supera los días de un paso, le manda el push
// de ese paso y crea el PromoBonus correspondiente.
//
// REGLAS DE NEGOCIO (decisión del owner 2026-06-21):
//   - Solo se le da bono a la gente INACTIVA = no carga hace >= 7 días.
//   - El bono % se capea a 30% MÁXIMO (sin importar la config).
//   - La vigencia se capea a 2 HORAS MÁXIMO (después el botón de reclamo
//     desaparece solo, porque el PromoBonus vence).
//   - La gente ACTIVA (cargó hace < 7 días) NO recibe bonos automáticos:
//     solo notificaciones de enganche (motor de encuesta, sin bono).
//
// El fireKey incluye el día de la última carga: si el usuario vuelve a
// cargar y se ausenta de nuevo, la escalera arranca limpia.
//
// El motor DUERME salvo que la config tenga isActive === true.
// =====================================================================

// Topes duros de negocio (no se pueden superar por config).
const MAX_BONUS_PERCENT = 30;
const MAX_VIGENCIA_HORAS = 2;
// Regalo de reactivación de TICKET ALTO: monto fijo máximo (no es bono %).
const MAX_REGALO_TICKET_ALTO = 3000;
// Cargas "de verdad": se excluyen regalos/bonos/devoluciones (no son carga del cliente).
const GIFT_SOURCES = ['install_bonus', 'welcome_gift', 'payout_refund'];

function _diaArt(d) {
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// Mes ART (YYYY-MM) — para que el regalo de ticket alto salga "de vez en cuando"
// (máximo una vez por mes calendario por cliente).
function _mesArt(d) {
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 7);
}

// tick — lo llama el cron del server.
// deps: { cfg, models:{User,InactividadFire,PromoBonus,Transaction}, sendPushFn, logger, now }
async function tick(deps) {
  const cfg = deps.cfg;
  const logger = deps.logger || console;
  if (!cfg || cfg.isActive !== true) return { skipped: 'inactive' };

  // Normalizamos los pasos y aplicamos el tope de 30% al % de cada bono.
  const pasos = (cfg.pasos || [])
    .filter(function (p) { return p && Number(p.dias) > 0; })
    .map(function (p) {
      return {
        dias: Number(p.dias),
        tipo: (p.tipo === 'regalo') ? 'regalo' : 'bono',
        percent: Math.min(MAX_BONUS_PERCENT, Math.max(0, Number(p.percent) || 0)),
        montoARS: Number(p.montoARS) || 0
      };
    })
    .sort(function (a, b) { return a.dias - b.dias; });
  if (!pasos.length) return { skipped: 'no-steps' };

  const now = deps.now || new Date();
  const User = deps.models.User;
  const InactividadFire = deps.models.InactividadFire;
  const PromoBonus = deps.models.PromoBonus;
  const Transaction = deps.models.Transaction;
  if (!Transaction) { logger.error('[inactividad] falta el modelo Transaction'); return { skipped: 'no-transaction-model' }; }

  // Vigencia del bono, capeada a 2h.
  const vigHoras = Math.min(MAX_VIGENCIA_HORAS, Math.max(0.5, Number(cfg.bonoVigenciaHoras) || MAX_VIGENCIA_HORAS));

  // Regalo de reactivación TICKET ALTO (opcional, "muy de vez en cuando"): a los
  // clientes de ticket alto que dejaron de cargar, un regalo de monto fijo ($3.000
  // máx), 1 vez por mes como máximo. Se reclama con soporte (push), no es bono %.
  const rta = cfg.regaloTicketAlto || {};
  const rtaEnabled = rta.enabled === true;
  const rtaDias = Math.max(1, Number(rta.dias) || 14);
  const rtaMonto = Math.min(MAX_REGALO_TICKET_ALTO, Math.max(1, Number(rta.montoARS) || MAX_REGALO_TICKET_ALTO));
  const rtaMinTicket = Math.max(0, Number(rta.minTicketARS) || 30000);
  const rtaVigHoras = Math.min(168, Math.max(1, Number(rta.vigenciaHoras) || 48)); // regalo: hasta 7 días para reclamar con soporte

  // Cutoff de la agregación = el menor umbral en juego (pasos o regalo ticket alto).
  const aggMinDias = rtaEnabled ? Math.min(pasos[0].dias, rtaDias) : pasos[0].dias;
  const cutoff = new Date(now.getTime() - aggMinDias * 86400000);

  // INACTIVO = su última CARGA real fue hace >= cutoff (no por último ingreso).
  // Una sola agregación: última carga, total y cantidad por usuario (para el
  // ticket promedio que define "ticket alto").
  let lastDeps;
  try {
    lastDeps = await Transaction.aggregate([
      { $match: {
        type: 'deposit',
        $or: [
          { 'metadata.source': { $exists: false } },
          { 'metadata.source': { $nin: GIFT_SOURCES } }
        ]
      } },
      { $group: { _id: '$username', last: { $max: '$timestamp' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $match: { last: { $lte: cutoff } } }
    ]);
  } catch (e) {
    logger.error('[inactividad] error agregando últimas cargas: ' + e.message);
    return { fired: 0 };
  }
  if (!lastDeps.length) return { fired: 0 };

  const lastByName = new Map(lastDeps.map(function (d) {
    return [String(d._id), { last: d.last, avgTicket: d.count > 0 ? (d.total / d.count) : 0 }];
  }));
  const names = lastDeps.map(function (d) { return d._id; }).filter(Boolean);

  // Traer los usuarios (id, plan, estado). Excluir solo_reembolsos / inactivos / bloqueados.
  const users = await User.find(
    {
      username: { $in: names },
      notificationPlan: { $ne: 'solo_reembolsos' },
      isActive: { $ne: false },
      isBlocked: { $ne: true }
    },
    { username: 1, id: 1 }
  ).limit(5000).lean();

  let fired = 0;
  for (const u of users) {
    if (!u || !u.username) continue;
    const info = lastByName.get(String(u.username));
    if (!info || !info.last) continue;
    const lastDep = info.last;
    const uname = String(u.username).toLowerCase();
    const dias = Math.floor((now - new Date(lastDep)) / 86400000);

    // Regalo TICKET ALTO (1 vez por mes máx): si está habilitado y el cliente es
    // de ticket alto e inactivo ≥ rtaDias, le damos el regalo en lugar del bono %
    // de este tick. Se entrega por push (reclamo con soporte) + queda registrado.
    if (rtaEnabled && dias >= rtaDias && info.avgTicket >= rtaMinTicket) {
      const giftKey = 'rta|' + uname + '|' + _mesArt(now);
      let claimed = true;
      try {
        await InactividadFire.create({
          fireKey: giftKey, username: uname, stepDias: rtaDias,
          tipo: 'regalo', percent: 0, montoARS: rtaMonto, firedAt: now
        });
      } catch (e) { claimed = false; } // ya recibió el regalo este mes
      if (claimed) {
        try {
          const title = '🎁 ¡Un regalo de $' + rtaMonto.toLocaleString('es-AR') + ' para vos!';
          const body = 'Te extrañamos. Como sos un cliente VIP, te dejamos un regalo de $' + rtaMonto.toLocaleString('es-AR') + '. Volvé y reclamalo con soporte.';
          await deps.sendPushFn(User, title, body, { kind: 'regalo_ticket_alto' }, { username: u.username });
          await PromoBonus.create({
            id: 'rta-' + giftKey,
            userId: u.id || null,
            username: uname,
            percent: 0,
            montoFijoARS: rtaMonto,
            sourceRuleCode: 'regalo_ticket_alto',
            sourceRuleName: 'Reactivación ticket alto · regalo',
            activatedAt: now,
            expiresAt: new Date(now.getTime() + rtaVigHoras * 3600 * 1000),
            status: 'active'
          });
          fired++;
        } catch (e) {
          logger.error('[inactividad] regalo ticket alto error ' + u.username + ': ' + e.message);
        }
        continue; // este tick recibió el regalo; no le damos también el bono %
      }
      // claimed=false → ya tuvo el regalo este mes; sigue al bono % normal.
    }

    // Paso aplicable = el de mayor .dias que el usuario ya superó.
    let paso = null;
    for (const p of pasos) { if (dias >= p.dias) paso = p; }
    if (!paso) continue;

    const fireKey = uname + '|' + _diaArt(new Date(lastDep)) + '|' + paso.dias;

    // Claim atómico: si el fireKey ya existe, ya se disparó este paso.
    try {
      await InactividadFire.create({
        fireKey: fireKey, username: uname, stepDias: paso.dias,
        tipo: paso.tipo || 'bono', percent: paso.percent || 0,
        montoARS: paso.montoARS || 0, firedAt: now
      });
    } catch (e) {
      continue; // ya disparado
    }

    try {
      const isRegalo = (paso.tipo === 'regalo');
      const montoARS = paso.montoARS || 0;
      const percent = Math.min(MAX_BONUS_PERCENT, paso.percent || 0);
      const title = isRegalo
        ? '🎁 ¡Te regalamos $' + montoARS.toLocaleString('es-AR') + '!'
        : '🎁 ¡Bono del ' + percent + '% para vos!';
      const body = isRegalo
        ? 'Hace ' + paso.dias + ' días que no cargás. Volvé y reclamá tu regalo de $' + montoARS.toLocaleString('es-AR') + ' con soporte.'
        : 'Hace ' + paso.dias + ' días que no cargás. Te dejamos un bono del ' + percent + '% para tu próxima carga — ¡dura 2 horas!';

      // 1) Push al usuario.
      await deps.sendPushFn(User, title, body,
        { kind: 'inactividad', step: String(paso.dias) },
        { username: u.username });

      // 2) PromoBonus (bono % o regalo de monto fijo). Vigencia capeada a 2h.
      const expiresAt = new Date(now.getTime() + vigHoras * 3600 * 1000);
      await PromoBonus.create({
        id: 'inact-' + fireKey,
        userId: u.id || null,
        username: uname,
        percent: isRegalo ? 0 : (percent || MAX_BONUS_PERCENT),
        montoFijoARS: isRegalo ? montoARS : 0,
        sourceRuleCode: 'inactividad',
        sourceRuleName: 'Recuperación · ' + paso.dias + ' días sin cargar',
        activatedAt: now,
        expiresAt: expiresAt,
        status: 'active'
      });
      fired++;
    } catch (e) {
      logger.error('[inactividad] error con ' + u.username + ': ' + e.message);
    }
  }
  return { fired: fired };
}

module.exports = { tick: tick, MAX_BONUS_PERCENT: MAX_BONUS_PERCENT, MAX_VIGENCIA_HORAS: MAX_VIGENCIA_HORAS };
