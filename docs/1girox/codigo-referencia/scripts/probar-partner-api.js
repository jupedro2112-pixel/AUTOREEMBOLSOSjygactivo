#!/usr/bin/env node
// =============================================================================
// probar-partner-api.js — radiografía de una instalación de la Partner API
// =============================================================================
// SOLO LECTURA: no crea jugadores, no mueve plata, no escribe en ninguna base.
// SIN DEPENDENCIAS: usa el fetch de Node 18+ (sirve en Tails, sin node_modules).
//
// Para qué: antes de mudar una página a jugaygana.io (o a cualquier copia de
// 1girox) hay que saber cómo está configurada ESA instalación. Este script
// responde las preguntas de CONOCIMIENTO-EN-PRODUCCION.md §14.
//
// USO
//   GIROX_API_URL=https://<host>/api/v1 GIROX_API_KEY=pk_xxx \
//     node docs/1girox/codigo-referencia/scripts/probar-partner-api.js
//
//   # además leer un jugador real (saldo, rollover, wager) y su netwin de 7 días:
//   ... node docs/1girox/codigo-referencia/scripts/probar-partner-api.js --player=juan123
//
//   # días del netwin (default 7, máximo 92):
//   ... --player=juan123 --days=30
//
// La key NUNCA se imprime (solo los últimos 4 caracteres).
// Consume 3 requests del cupo de 60/min (5 con --player).
// =============================================================================

'use strict';

const BASE = String(process.env.GIROX_API_URL || '').trim().replace(/\/+$/, '');
const KEY = String(process.env.GIROX_API_KEY || '').trim();
const TIMEOUT_MS = Number(process.env.GIROX_TIMEOUT_MS || 20000);

const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
  if (!m) { console.error(`Argumento desconocido: ${a}`); process.exit(2); }
  args[m[1]] = m[2] === undefined ? true : m[2];
}
for (const k of Object.keys(args)) {
  if (!['player', 'days', 'help'].includes(k)) { console.error(`Argumento desconocido: --${k}`); process.exit(2); }
}
if (args.help) {
  console.log('Uso: GIROX_API_URL=... GIROX_API_KEY=... node probar-partner-api.js [--player=usuario] [--days=7]');
  process.exit(0);
}
if (!BASE || !KEY) {
  console.error('Faltan GIROX_API_URL y/o GIROX_API_KEY en el entorno.');
  process.exit(2);
}
if (typeof fetch !== 'function') {
  console.error('Hace falta Node 18 o superior (fetch nativo).');
  process.exit(2);
}

async function call(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const resp = await fetch(BASE + path, {
      method,
      headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch (_) { /* no es JSON */ }
    return { status: resp.status, json, text, ms: Date.now() - started, retryAfter: resp.headers.get('retry-after') };
  } catch (e) {
    return { status: 0, json: null, text: '', ms: Date.now() - started, netError: e.name === 'AbortError' ? 'timeout' : (e.cause && e.cause.code) || e.message };
  } finally {
    clearTimeout(timer);
  }
}

const errCode = (r) => (r.json && ((r.json.error && r.json.error.code) || r.json.code)) || null;
const errMsg = (r) => (r.json && ((r.json.error && r.json.error.message) || r.json.message)) || (r.text || '').slice(0, 160);
const line = (label, value) => console.log(`  ${String(label).padEnd(34)} ${value}`);
const list = (a) => (Array.isArray(a) && a.length ? a.join(', ') : '(vacío)');
const yn = (v) => (v === true ? 'SÍ' : v === false ? 'NO' : '(la API no lo informa)');

/** "YYYY-MM-DD HH:mm:ss" en hora de Argentina (el huso en que la plataforma evalúa el rango). */
function fmtAR(d) {
  const o = { timeZone: 'America/Argentina/Buenos_Aires' };
  return `${d.toLocaleDateString('en-CA', o)} ${d.toLocaleTimeString('en-GB', { ...o, hour12: false })}`;
}

(async () => {
  let problems = 0;
  console.log('════════════════════════════════════════════════════════════');
  console.log(' Partner API — radiografía (solo lectura)');
  console.log('════════════════════════════════════════════════════════════');
  line('Base URL', BASE);
  line('API key', `…${KEY.slice(-4)} (${KEY.startsWith('pk_') ? 'formato pk_ OK' : '⚠️ no empieza con pk_'})`);

  // 1) PING: un jugador que no existe tiene que dar 404 player_not_found.
  console.log('\n[1] Conexión y key');
  const probe = 'zz_probe_' + Date.now().toString(36).slice(-8);
  const p = await call('GET', `/players/${probe}`);
  if (p.status === 404 || errCode(p) === 'player_not_found') {
    line('Resultado', `✅ responde y la key es válida (HTTP ${p.status}, ${p.ms} ms)`);
  } else if (p.status === 401) {
    problems++;
    line('Resultado', `❌ 401 ${errCode(p) || ''} — ${errMsg(p)}`);
    line('', 'La key fue rechazada: o es de OTRA instalación (cada una tiene su Base URL),');
    line('', 'o está inactiva/regenerada, o tiene whitelist de IPs (ip_not_allowed).');
  } else if (p.status === 0) {
    problems++;
    line('Resultado', `❌ sin respuesta (${p.netError}) — revisar la Base URL / DNS / red`);
  } else if (!p.json) {
    problems++;
    line('Resultado', `❌ HTTP ${p.status} y la respuesta NO es JSON — esa URL no es la Partner API`);
    line('', (p.text || '').replace(/\s+/g, ' ').slice(0, 120));
  } else {
    problems++;
    line('Resultado', `⚠️ inesperado: HTTP ${p.status} ${errCode(p) || ''} — ${errMsg(p)}`);
  }
  if (problems) { console.log('\nSin conexión válida no se sigue.'); process.exit(1); }

  // 2) CONFIG del sitio
  console.log('\n[2] Configuración del sitio (GET /config)');
  const c = await call('GET', '/config');
  if (c.status !== 200 || !c.json) {
    problems++;
    line('Resultado', `❌ HTTP ${c.status} ${errCode(c) || ''} — ${errMsg(c)}`);
  } else {
    const cfg = c.json;
    const ro = cfg.rollover || {};
    const bo = cfg.bonus || {};
    const wa = cfg.wager || {};
    line('Motor de bonos (bonus_engine)', cfg.bonus_engine || '(no informado = clásico)');
    line('Rollover habilitado', yn(ro.enabled));
    line('  multiplicadores de CARGA', list(ro.multipliers));
    line('Bonos habilitados', yn(bo.enabled));
    line('  bono SUELTO (POST /bonus)', yn(bo.standalone_enabled));
    line('  multiplicadores de BONO', list(bo.multipliers));
    line('  ¿permite bono 0 (regalo directo)?', Array.isArray(bo.multipliers) ? (bo.multipliers.map(Number).includes(0) ? 'SÍ' : 'NO → los regalos irán por depósito libre') : '(sin lista)');
    line('  porcentajes cargados', list(bo.percents));
    line('  bono fijo mínimo / máximo', `${bo.fixed_min != null ? bo.fixed_min : '?'} / ${bo.fixed_max != null ? bo.fixed_max : '?'}  (0 = sin límite)`);
    line('  ¿bonos a reclamar? (claim_required)', yn(bo.claim_required));
    line('Wager (saldo promocional)', yn(wa.enabled));
    line('  ¿se puede cargar por API?', yn(wa.api_enabled));
    line('  tope por operación (api_max)', wa.api_max != null ? `${wa.api_max}  (0 = sin tope)` : '?');
    const rules = Array.isArray(bo.auto_rules) ? bo.auto_rules : [];
    line('Reglas automáticas del agente', rules.length ? `${rules.length} ⚠️ un /deposit sin params de bono las HEREDA` : 'ninguna');
    for (const r of rules) {
      const what = r.mode === 'percent' ? `${r.percent}%` : `$${r.fixed_amount}`;
      console.log(`      - [${r.type}${r.scope ? '/' + r.scope : ''}] "${r.name}" ${what} x${r.multiplier}` +
        `${r.code ? ' código ' + r.code : ''}${r.cap ? ' tope $' + r.cap : ''}${r.ends_at ? ' hasta ' + r.ends_at : ''}`);
    }
    if (cfg.bonus_engine === 'unified') {
      console.log('  ⚠️ Motor UNIFICADO: el TIPO del bono adjunto a una carga lo decide el agente del jugador');
      console.log('     (player.bonus_mode). Nunca mandar wager_percent/wager_amount en el depósito.');
    }
  }

  // 3) AGENTES de la red
  console.log('\n[3] Agentes de la red (GET /agents)');
  const a = await call('GET', '/agents');
  if (a.status !== 200 || !a.json) {
    line('Resultado', `HTTP ${a.status} ${errCode(a) || ''} — ${errMsg(a)}`);
  } else {
    const agents = Array.isArray(a.json.agents) ? a.json.agents : [];
    line('Sub-agentes', agents.length ? String(agents.length) : '0 (la key no tiene agentes por debajo)');
    for (const ag of agents.slice(0, 40)) console.log(`      - ${ag.id}  ${ag.name}`);
    if (agents.length > 40) console.log(`      … y ${agents.length - 40} más`);
    if (agents.length) console.log('  ⚠️ La key master NO ve por API a los jugadores creados bajo un sub-agente: hace falta la key de cada uno.');
  }

  // 4) JUGADOR real (opcional)
  if (args.player && args.player !== true) {
    const u = String(args.player);
    console.log(`\n[4] Jugador "${u}" (GET /players/{u})`);
    const r = await call('GET', `/players/${encodeURIComponent(u)}`);
    if (r.status === 404) {
      line('Resultado', 'no existe O no es de esta key (la API no distingue los dos casos)');
    } else if (r.status !== 200 || !r.json || !r.json.player) {
      problems++;
      line('Resultado', `❌ HTTP ${r.status} ${errCode(r) || ''} — ${errMsg(r)}`);
    } else {
      const pl = r.json.player;
      const w = pl.wagering || null;
      line('id numérico', pl.id != null ? pl.id : '(no viene)');
      line('activo', yn(pl.active));
      line('balance (pesos)', pl.balance);
      line('DISPONIBLE para retirar', w && w.available != null ? w.available : `${pl.balance} (sin rollover: disponible = balance)`);
      if (w) {
        line('bloqueado por rollover', w.locked);
        line('  de eso, real / bono', `${w.locked_real != null ? w.locked_real : '?'} / ${w.bonus_locked != null ? w.bonus_locked : '?'}`);
        line('bonos sin reclamar', w.claimable_total != null ? w.claimable_total : 0);
        line('objetivos pendientes', Array.isArray(w.requirements) ? w.requirements.length : 0);
      }
      line('saldo promocional (wager)', pl.wager != null ? pl.wager : '(la API no lo manda: feat apagado)');
      if (pl.bonus_mode) line('bonus_mode (motor unificado)', pl.bonus_mode);
      line('creado', pl.created_at || '?');

      const days = Math.max(1, Math.min(92, Number(args.days) || 7));
      const to = new Date();
      const from = new Date(to.getTime() - days * 86400000);
      console.log(`\n[5] Netwin de los últimos ${days} días (GET /players/{u}/stats)`);
      const s = await call('GET', `/players/${encodeURIComponent(u)}/stats?from=${encodeURIComponent(fmtAR(from))}&to=${encodeURIComponent(fmtAR(to))}`);
      if (s.status !== 200 || !s.json) {
        problems++;
        line('Resultado', `❌ HTTP ${s.status} ${errCode(s) || ''} — ${errMsg(s)}`);
      } else {
        const t = s.json.totals || {};
        const cats = s.json.categories || {};
        const b = s.json.bonus || {};
        line('rango (hora AR)', `${s.json.from} → ${s.json.to}`);
        line('apostado / pagado', `${t.wagered} / ${t.payout}`);
        line('netwin TOTAL', `${t.netwin}  ${Number(t.netwin) > 0 ? '(el jugador PERDIÓ)' : Number(t.netwin) < 0 ? '(el jugador GANÓ)' : ''}`);
        line('  casino / sports', `${cats.casino ? cats.casino.netwin : '?'} / ${cats.sports ? cats.sports.netwin : '?'}`);
        line('bono otorgado / aún bloqueado', `${b.granted != null ? b.granted : '(no viene)'} / ${b.still_locked != null ? b.still_locked : '(no viene)'}`);
      }
    }
  } else {
    console.log('\n[4] Jugador: (omitido) — agregá --player=usuario para leer saldo, rollover, wager y netwin.');
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(problems ? ` Terminó con ${problems} problema(s).` : ' Terminó sin problemas. Nada fue modificado.');
  console.log('════════════════════════════════════════════════════════════');
  process.exit(problems ? 1 : 0);
})().catch((e) => { console.error('Error inesperado:', e && e.message ? e.message : e); process.exit(1); });
