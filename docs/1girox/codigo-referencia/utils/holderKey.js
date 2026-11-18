/**
 * holderKey.js — identidad del TITULAR de un comprobante (ESPEC §B.2, 2026-09-16).
 * Normaliza el nombre que leyó la IA (`titular_origen`) para cruzarlo entre
 * cuentas: sin acentos, mayúsculas, sin puntuación, espacios colapsados.
 * Mínimo 2 palabras y 8 letras: "JUAN" o "SA" no identifican a nadie (evita
 * falsos positivos). Misma función en todos lados (server + tests).
 */
function holderKey(name) {
  const k = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (k.length < 8 || k.split(' ').length < 2) return null;
  return k;
}
module.exports = { holderKey };
