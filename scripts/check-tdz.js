#!/usr/bin/env node
/**
 * check-tdz.js — chequeo ESTÁTICO de la trampa de TDZ en server.js (#187).
 *
 * En Tails no hay node_modules, así que no se puede arrancar el server: `node
 * --check` valida sintaxis pero NO detecta "Cannot access 'X' before
 * initialization". Ese error tumbó el deploy del 2026-09-16 (un bloque de nivel
 * superior usaba `bonusRollover` antes de su `require`).
 *
 * Qué mira: para cada `const|let NOMBRE = require(...)` de nivel superior (sin
 * indentación) busca usos de NOMBRE (`NOMBRE.` / `NOMBRE(`) en líneas de nivel
 * superior ANTERIORES. Un uso dentro de una función se ejecuta después y no
 * cuenta; un uso de nivel superior (asignaciones, llamadas sueltas, `app.*`)
 * sí. También avisa si hay rutas `app.*` con middleware antes del
 * `const authMiddleware`.
 *
 *   node scripts/check-tdz.js   → exit 1 si encuentra algo
 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'server.js');
const lines = fs.readFileSync(file, 'utf8').split('\n');

let problems = 0;
const decl = new Map(); // name → line (1-based)
lines.forEach((l, i) => {
  const m = l.match(/^(?:const|let)\s+(?:\{\s*[\w:\s,]+\}|(\w+))\s*=\s*require\(/);
  if (!m) return;
  if (m[1]) decl.set(m[1], i + 1);
  else {
    const inner = l.match(/^(?:const|let)\s+\{([^}]+)\}/)[1];
    inner.split(',').forEach((p) => {
      const alias = p.split(':').pop().trim();
      if (alias) decl.set(alias, i + 1);
    });
  }
});
// Depth 0 = nivel superior. Se aproxima contando llaves fuera de strings/comentarios
// de línea; alcanza para server.js (código, no minificado).
let depth = 0;
lines.forEach((l, i) => {
  const ln = i + 1;
  const code = l.replace(/\/\/.*$/, '');
  if (depth === 0 && !/^\s*(\/\/|\*|\/\*)/.test(l)) {
    for (const [name, at] of decl) {
      if (ln >= at) continue;
      const re = new RegExp('(^|[^\\w.$])' + name + '\\s*[.(\\[]');
      if (re.test(code) && !new RegExp('^(const|let|var)\\s+' + name + '\\b').test(code)) {
        problems++;
        console.log(`❌ L${ln}: usa \`${name}\` a nivel superior, pero su require está en L${at} (TDZ → el server no arranca)`);
      }
    }
  }
  for (const ch of code) { if (ch === '{') depth++; else if (ch === '}') depth = Math.max(0, depth - 1); }
});

const authAt = lines.findIndex((l) => /^const authMiddleware\b/.test(l)) + 1;
lines.forEach((l, i) => {
  if (i + 1 < authAt && /^app\.(get|post|put|delete)\(.*(authMiddleware|adminMiddleware|depositorMiddleware|withdrawerMiddleware)/.test(l)) {
    problems++;
    console.log(`❌ L${i + 1}: ruta con middleware antes de \`const authMiddleware\` (L${authAt})`);
  }
});

console.log(problems ? `\n❌ ${problems} problema(s) de orden de declaración` : `✅ server.js: sin usos antes de su require (${decl.size} requires de nivel superior) y sin rutas antes de authMiddleware (L${authAt})`);
process.exit(problems ? 1 : 0);
