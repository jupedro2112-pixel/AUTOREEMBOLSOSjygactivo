'use strict';
// =====================================================================
// inactividadService — motor de RECUPERACIÓN DE INACTIVOS.
//
// Escalera por días sin entrar (User.lastLogin): cuando un usuario
// supera los días de un paso, le manda el push de ese paso y crea el
// PromoBonus correspondiente (bono % o regalo de monto fijo).
//
// El fireKey incluye el día del último login: si el usuario vuelve y se
// ausenta de nuevo, la escalera arranca limpia.
//
// El motor DUERME salvo que la config tenga isActive === true.
// =====================================================================

function _diaArt(d) {
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// tick — lo llama el cron del server.
// deps: { cfg, models:{User,InactividadFire,PromoBonus}, sendPushFn, logger, now }
async function tick(deps) {
  const cfg = deps.cfg;
  const logger = deps.logger || console;
  if (!cfg || cfg.isActive !== true) return { skipped: 'inactive' };

  const pasos = (cfg.pasos || [])
    .filter(function (p) { return p && Number(p.dias) > 0; })
    .sort(function (a, b) { return a.dias - b.dias; });
  if (!pasos.length) return { skipped: 'no-steps' };

  const now = deps.now || new Date();
  const User = deps.models.User;
  const InactividadFire = deps.models.InactividadFire;
  const PromoBonus = deps.models.PromoBonus;

  const minDias = pasos[0].dias;
  const cutoff = new Date(now.getTime() - minDias * 86400000);

  // Inactivos: último login hace >= minDias. Se excluye solo_reembolsos.
  const users = await User.find(
    { lastLogin: { $lte: cutoff, $ne: null }, notificationPlan: { $ne: 'solo_reembolsos' } },
    { username: 1, id: 1, lastLogin: 1 }
  ).limit(5000).lean();

  let fired = 0;
  for (const u of users) {
    if (!u || !u.username || !u.lastLogin) continue;
    const dias = Math.floor((now - new Date(u.lastLogin)) / 86400000);

    // Paso aplicable = el de mayor .dias que el usuario ya superó.
    let paso = null;
    for (const p of pasos) { if (dias >= Number(p.dias)) paso = p; }
    if (!paso) continue;

    const uname = String(u.username).toLowerCase();
    const fireKey = uname + '|' + _diaArt(new Date(u.lastLogin)) + '|' + paso.dias;

    // Claim atómico: si el fireKey ya existe, ya se disparó este paso.
    try {
      await InactividadFire.create({
        fireKey: fireKey, username: uname, stepDias: paso.dias,
        tipo: paso.tipo || 'bono', percent: Number(paso.percent) || 0,
        montoARS: Number(paso.montoARS) || 0, firedAt: now
      });
    } catch (e) {
      continue; // ya disparado
    }

    try {
      const isRegalo = (paso.tipo === 'regalo');
      const montoARS = Number(paso.montoARS) || 0;
      const percent = Number(paso.percent) || 0;
      const title = isRegalo
        ? '🎁 ¡Te regalamos $' + montoARS.toLocaleString('es-AR') + '!'
        : '🎁 ¡Bono del ' + percent + '% para vos!';
      const body = isRegalo
        ? 'Te extrañamos. Volvé a la sala y reclamá tu regalo de $' + montoARS.toLocaleString('es-AR') + ' con soporte.'
        : 'Hace ' + paso.dias + ' días que no te vemos. Te dejamos un bono del ' + percent + '% para tu próxima carga.';

      // 1) Push al usuario.
      await deps.sendPushFn(User, title, body,
        { kind: 'inactividad', step: String(paso.dias) },
        { username: u.username });

      // 2) PromoBonus (bono % o regalo de monto fijo).
      const expiresAt = new Date(now.getTime() + (Number(cfg.bonoVigenciaHoras) || 72) * 3600 * 1000);
      await PromoBonus.create({
        id: 'inact-' + fireKey,
        userId: u.id || null,
        username: uname,
        percent: isRegalo ? 0 : (percent || 50),
        montoFijoARS: isRegalo ? montoARS : 0,
        sourceRuleCode: 'inactividad',
        sourceRuleName: 'Recuperación · ' + paso.dias + ' días',
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

module.exports = { tick: tick };
