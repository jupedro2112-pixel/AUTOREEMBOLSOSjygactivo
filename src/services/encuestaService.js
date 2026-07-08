'use strict';
// =====================================================================
// encuestaService — motor de la estrategia "Encuesta" (Fase 2).
//
// Arma el calendario semanal por grupo (suave / normal / activo) y, cuando
// a un slot le toca su día y hora (ART), dispara el push. En los slots de
// bono además crea un PromoBonus por cada usuario del grupo.
//
// Reglas anti-saturación que garantiza el calendario:
//   - Máximo 1 push por día y por grupo.
//   - Bonos a las 18:00 ART (pico); incentivos a las 13:00 ART.
//   - El grupo "solo_reembolsos" nunca recibe marketing.
//
// El motor DUERME salvo que la config tenga isActive === true.
// =====================================================================

const DOW_NAME = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];

// Biblioteca de mensajes de incentivo (sin bono). Rotan por índice.
const INCENTIVO_MSGS = [
  { title: '🎰 Te estamos esperando', body: 'Entrá y probá tu suerte — hoy puede ser tu día.' },
  { title: '🔥 La ruleta diaria te espera', body: 'Tenés tu giro gratis del día sin usar. ¡Aprovechalo!' },
  { title: '💰 Revisá tus reembolsos', body: 'Fijate si tenés reembolsos para reclamar en la sala.' },
  { title: '⭐ ¿Cómo la venís pasando?', body: 'Entrá un rato, jugá y disfrutá de tus beneficios VIP.' },
  { title: '🎲 Un ratito de juego', body: 'Date una vuelta por la sala, te estamos esperando.' },
  { title: '🍀 Probá tu suerte hoy', body: 'Unas jugadas pueden cambiarte el día. Entrá ahora.' },
  { title: '🎁 Beneficios activos', body: 'Sos parte de la sala VIP. Vení a aprovechar lo tuyo.' }
];

function bonoMsg(percent) {
  return {
    title: '🎁 ¡Bono del ' + percent + '% para vos!',
    body: 'Activamos un bono del ' + percent + '% extra para tu próxima carga. Aprovechalo antes de que venza.'
  };
}

// Distribución de los días de bono en la semana (0=dom .. 6=sab).
function bonusDays(n) {
  if (n <= 0) return [];
  if (n === 1) return [4];           // jue
  if (n === 2) return [1, 4];        // lun, jue
  if (n === 3) return [1, 3, 5];     // lun, mie, vie
  if (n === 4) return [1, 2, 4, 6];  // lun, mar, jue, sab
  if (n === 5) return [1, 2, 3, 4, 5];
  if (n === 6) return [1, 2, 3, 4, 5, 6];
  return [1, 2, 3, 4, 5, 6, 0];
}

// Ventana de envío: 18:00 a 21:30 (ART), en pasos de media hora. Los
// pushes de la semana se reparten dentro de esta franja.
const VENTANA_HORARIA = [
  { hora: 18, minuto: 0 }, { hora: 18, minuto: 30 },
  { hora: 19, minuto: 0 }, { hora: 19, minuto: 30 },
  { hora: 20, minuto: 0 }, { hora: 20, minuto: 30 },
  { hora: 21, minuto: 0 }, { hora: 21, minuto: 30 }
];

// Calendario semanal de UN grupo: lista de slots
// {dow,dia,hora,minuto,horaTxt,type,percent,title,body}.
// Máximo 1 slot por día; los horarios se reparten en la ventana 18:00–21:30.
function cohortWeek(cohortCfg, cfg) {
  const slots = [];
  // DESACTIVADO (owner 2026-06-21): la encuesta ya NO reparte bonos. La gente
  // activa (la que vota un plan y usa la sala) recibe SOLO notificaciones de
  // enganche ("jugá, divertite, estamos cargando"). El único bono automático
  // sale del motor de inactividad (gente que no carga hace ≥7d, ≤30%, ≤2h).
  // Para reactivar los bonos de encuesta, volvé a poner `bonusDays(bonoN)`.
  const incN  = Math.max(0, Number(cohortCfg && cohortCfg.incentivosPorSemana) || 0);
  const bDays = [];
  const bSet = {};
  bDays.forEach(function (d) { bSet[d] = true; });
  const percents = (Array.isArray(cfg.bonoPercents) && cfg.bonoPercents.length) ? cfg.bonoPercents : [15, 30];

  bDays.forEach(function (dow, i) {
    // Tope 30% (decisión owner 2026-07-08): nunca más bonos automáticos de 50/100.
    const pct = Math.min(30, Number(percents[i % percents.length]) || 15);
    const m = bonoMsg(pct);
    slots.push({ dow: dow, dia: DOW_NAME[dow], type: 'bono', percent: pct, title: m.title, body: m.body });
  });

  // Días de incentivo: en orden de preferencia, salteando los días con bono.
  const incOrder = [2, 6, 3, 5, 0, 1, 4]; // mar, sab, mie, vie, dom, lun, jue
  let placed = 0, mi = 0;
  for (let i = 0; i < incOrder.length && placed < incN; i++) {
    const d = incOrder[i];
    if (bSet[d]) continue;
    const m = INCENTIVO_MSGS[mi % INCENTIVO_MSGS.length];
    slots.push({ dow: d, dia: DOW_NAME[d], type: 'incentivo', percent: 0, title: m.title, body: m.body });
    placed++; mi++;
  }

  slots.sort(function (a, b) {
    const oa = a.dow === 0 ? 7 : a.dow;
    const ob = b.dow === 0 ? 7 : b.dow;
    return oa - ob;
  });

  // Reparte los horarios en la ventana 18:00–21:30.
  const n = slots.length;
  slots.forEach(function (s, i) {
    const idx = n <= 1 ? 0 : Math.round(i * (VENTANA_HORARIA.length - 1) / (n - 1));
    const t = VENTANA_HORARIA[idx];
    s.hora = t.hora;
    s.minuto = t.minuto;
    s.horaTxt = (t.hora < 10 ? '0' + t.hora : t.hora) + ':' + (t.minuto < 10 ? '0' + t.minuto : t.minuto);
  });
  return slots;
}

// Calendario completo: { suave:[...], normal:[...], activo:[...], solo_reembolsos:[] }.
function weeklyCalendar(cfg) {
  cfg = cfg || {};
  const out = {};
  ['suave', 'normal', 'activo', 'solo_reembolsos'].forEach(function (k) {
    if (k === 'solo_reembolsos') { out[k] = []; return; }
    const cc = (cfg.cohorts && cfg.cohorts[k]) || { bonosPorSemana: 0, incentivosPorSemana: 0 };
    out[k] = cohortWeek(cc, cfg);
  });
  return out;
}

// Hora de Argentina (UTC-3, sin DST).
function artParts(now) {
  const art = new Date((now || new Date()).getTime() - 3 * 3600 * 1000);
  return {
    dow: art.getUTCDay(),
    hora: art.getUTCHours(),
    minuto: art.getUTCMinutes(),
    fecha: art.toISOString().slice(0, 10)
  };
}

// Clave de semana ISO (para que el slotKey arranque limpio cada semana).
function isoWeekKey(now) {
  const art = new Date((now || new Date()).getTime() - 3 * 3600 * 1000);
  const d = new Date(Date.UTC(art.getUTCFullYear(), art.getUTCMonth(), art.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return d.getUTCFullYear() + '-W' + (week < 10 ? '0' + week : String(week));
}

// tick — lo llama el cron del server cada ~5 min.
// deps: { cfg, models:{User,EncuestaFire,PromoBonus}, sendPushFn, logger, now }
async function tick(deps) {
  const cfg = deps.cfg;
  const logger = deps.logger || console;
  if (!cfg || cfg.isActive !== true) return { skipped: 'inactive' };

  const now = deps.now || new Date();
  const t = artParts(now);
  const cal = weeklyCalendar(cfg);
  const weekKey = isoWeekKey(now);
  const User = deps.models.User;
  const EncuestaFire = deps.models.EncuestaFire;
  const PromoBonus = deps.models.PromoBonus;
  let fired = 0;

  for (const cohort of ['suave', 'normal', 'activo']) {
    const slots = cal[cohort] || [];
    for (const slot of slots) {
      if (slot.dow !== t.dow || slot.hora !== t.hora) continue;
      // Ventana de media hora: el cron corre cada 5 min, el dedup por
      // slotKey garantiza que el slot se dispare una sola vez.
      const _sm = slot.minuto || 0;
      if (t.minuto < _sm || t.minuto >= _sm + 30) continue;
      const slotKey = weekKey + '-' + cohort + '-' + slot.dia + '-' + slot.type
        + (slot.percent ? '-' + slot.percent : '');

      // Claim atómico: si el unique index del slotKey rebota, ya lo tomó
      // otro tick (el cron corre cada 5 min dentro de la misma hora).
      let fireDoc;
      try {
        fireDoc = await EncuestaFire.create({
          slotKey: slotKey, cohort: cohort, type: slot.type, percent: slot.percent || 0,
          title: slot.title, body: slot.body, firedAt: now
        });
      } catch (e) {
        continue; // duplicado -> ya disparado esta semana
      }

      try {
        const data = { kind: 'encuesta', cohort: cohort, slotType: slot.type };
        if (slot.type === 'bono') data.bonoPercent = String(slot.percent);

        // 1) Push a todo el grupo.
        await deps.sendPushFn(User, slot.title, slot.body, data, { notificationPlan: cohort });

        // 2) Slot de bono: un PromoBonus por cada usuario del grupo.
        let bonosCreados = 0;
        let recipients = 0;
        if (slot.type === 'bono' && slot.percent > 0) {
          const users = await User.find({ notificationPlan: cohort }, { username: 1, id: 1 }).lean();
          recipients = users.length;
          const expiresAt = new Date(now.getTime() + (Number(cfg.bonoVigenciaHoras) || 48) * 3600 * 1000);
          const docs = users
            .filter(function (u) { return u && u.username; })
            .map(function (u) {
              return {
                id: 'enc-' + slotKey + '-' + String(u.username).toLowerCase(),
                userId: u.id || null,
                username: String(u.username).toLowerCase(),
                percent: Math.min(30, slot.percent), // tope 30% también acá (defensa en profundidad)
                sourceRuleCode: 'encuesta',
                sourceRuleName: 'Encuesta · grupo ' + cohort,
                activatedAt: now,
                expiresAt: expiresAt,
                status: 'active'
              };
            });
          if (docs.length) {
            try {
              const r = await PromoBonus.insertMany(docs, { ordered: false });
              bonosCreados = (r && r.length) || docs.length;
            } catch (e) {
              // ordered:false -> algunos pudieron rebotar por id duplicado;
              // el resto se insertó igual.
              bonosCreados = docs.length;
            }
          }
        }

        await EncuestaFire.updateOne(
          { _id: fireDoc._id },
          { $set: { recipients: recipients, bonosCreados: bonosCreados } }
        );
        fired++;
        logger.info('[encuesta] disparado ' + slotKey + ' (bonos=' + bonosCreados + ')');
      } catch (e) {
        logger.error('[encuesta] error disparando ' + slotKey + ': ' + e.message);
      }
    }
  }
  return { fired: fired };
}

module.exports = {
  weeklyCalendar: weeklyCalendar,
  tick: tick,
  INCENTIVO_MSGS: INCENTIVO_MSGS,
  artParts: artParts,
  isoWeekKey: isoWeekKey
};
