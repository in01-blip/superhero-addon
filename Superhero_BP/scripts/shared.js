// Utilidades compartidas entre módulos (evita imports circulares con main.js)

/* ------------------------------ KARMA ------------------------------- */
// Tiers discretos: el mundo (NPCs, eventos) solo consulta el tier.
export function tierOf(v) {
  if (v <= -60) return "VILLAIN_EXTREME";
  if (v <= -20) return "VILLAIN_MILD";
  if (v < 20) return "NEUTRAL";
  if (v < 60) return "HERO_MILD";
  return "HERO_EXTREME";
}
// Lectura perezosa desde las dynamic properties del jugador (cero estado en NPCs).
export function getTier(player) {
  const k = player.getDynamicProperty("sh_karma");
  return tierOf(typeof k === "number" ? k : 0);
}

const tierListeners = [];
export function onKarmaTierChanged(fn) { tierListeners.push(fn); }
export function emitTierChanged(player, tier, karma) {
  for (const fn of tierListeners) fn(player, tier, karma);
}

/* ---------------------------- KNOCKBACK ----------------------------- */
// applyImpulse no funciona sobre jugadores -> applyKnockback.
// 2.x: (VectorXZ, vertical). Fallback a la firma antigua por seguridad.
let legacyKnockback = false;
export function push(p, dx, dz, h, v) {
  const len = Math.hypot(dx, dz) || 1;
  try {
    if (!legacyKnockback) p.applyKnockback({ x: (dx / len) * h, z: (dz / len) * h }, v);
    else p.applyKnockback(dx / len, dz / len, h, v);
  } catch (e) {
    if (!legacyKnockback) {
      legacyKnockback = true;
      try { p.applyKnockback(dx / len, dz / len, h, v); } catch (_) { /* ignorar */ }
    }
  }
}
