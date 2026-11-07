// =====================================================================
// MISIÓN SECUNDARIA: DRON ESPÍA
//
// Control del Dron Espía (sh:spy_remote):
//   - Tocar el ítem: lanza el dron (o lo recoge si ya está volando).
//   - Con el ítem en la mano el dron vuela hacia donde MIRAS.
//   - Agacharte = el dron se detiene (hover). Sin el ítem en la mano = hover.
//
// Objetivo: mantente a media distancia de los enemigos de Vektor / del Villano.
//   - Inteligencia sube si hay enemigos a <= 14 bloques.
//   - Alerta sube si te acercas a < 6 bloques; baja cuando te alejas.
//   - Alerta 100% = dron destruido. Inteligencia 100% = obtienes sh:intel_data.
//
// COMANDO: /give @s sh:spy_remote
// =====================================================================
import { world, system, ItemStack } from "@minecraft/server";

const SPY = "sh:dron_espia";
const CFG = Object.freeze({
  SPEED: 0.35,          // bloques por tick
  RANGE_MAX: 70,        // distancia máxima al jugador
  INTEL_R: 14,
  SPOT_R: 6,
  INTEL_GAIN: 5,        // por segundo y enemigo (máx. 3 enemigos)
  ALERT_UP: 25,         // por segundo si estás demasiado cerca
  ALERT_DOWN: 8,
});
const sessions = new Map(); // playerId -> { drone, intel, alert }

const valid = (e) => { try { e.location; return true; } catch (_) { return false; } };
const bar = (v) => { const n = Math.max(0, Math.min(10, Math.round(v / 10))); return "|".repeat(n) + "§8" + "|".repeat(10 - n); };

function endSession(p, id, msgKey) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try { if (valid(s.drone)) s.drone.remove(); } catch (_) { /* ya no existe */ }
  if (p) {
    try { p.camera.clear(); } catch (_) { /* sin cámara del dron */ }
    if (msgKey) p.sendMessage({ rawtext: [{ translate: msgKey }] });
  }
}

world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack?.typeId !== "sh:spy_remote") return;
  const p = ev.source;
  if (sessions.has(p.id)) { endSession(p, p.id, "sh.spy.recalled"); return; }
  const l = p.location;
  const drone = p.dimension.spawnEntity(SPY, { x: l.x, y: l.y + 2, z: l.z });
  drone.addTag("sh_spy");
  sessions.set(p.id, { drone, intel: 0, alert: 0, n: 0 });
  p.sendMessage({ rawtext: [{ translate: "sh.spy.launched" }] });
});

// Pilotaje (cada tick, solo mientras haya sesiones)
system.runInterval(() => {
  if (sessions.size === 0) return;
  for (const [id, s] of sessions) {
    const p = world.getAllPlayers().find((q) => q.id === id);
    if (!p || !valid(s.drone)) { endSession(p, id, p ? "sh.spy.lost" : null); continue; }
    try {
      const pos = s.drone.location;
      const holding = p.getComponent("minecraft:equippable")?.getEquipment("Mainhand")?.typeId === "sh:spy_remote";
      const d = p.getViewDirection();
      if (holding && !p.isSneaking) {
        const next = { x: pos.x + d.x * CFG.SPEED, y: pos.y + d.y * CFG.SPEED, z: pos.z + d.z * CFG.SPEED };
        const b = s.drone.dimension.getBlock(next);
        const far = Math.hypot(next.x - p.location.x, next.y - p.location.y, next.z - p.location.z) > CFG.RANGE_MAX;
        if (b && b.isAir && !far) {
          s.drone.teleport(next, { facingLocation: { x: next.x + d.x, y: next.y + d.y, z: next.z + d.z } });
        }
      }
      if (holding) { // intenta ver a través del dron (si la cámara libre no está disponible, se ignora)
        try { p.camera.setCamera("minecraft:free", { location: { x: pos.x, y: pos.y + 0.3, z: pos.z }, facingLocation: { x: pos.x + d.x, y: pos.y + d.y + 0.3, z: pos.z + d.z } }); } catch (_) { /* nada */ }
      } else { try { p.camera.clear(); } catch (_) { /* nada */ } }

      s.n++;
      if (s.n % 20 !== 0) continue; // lógica de inteligencia: 1 vez por segundo
      const enemies = s.drone.dimension.getEntities({ location: pos, maxDistance: CFG.INTEL_R, families: ["sh_vektor", "sh_villain"], closest: 6 });
      let nearest = 99;
      for (const e of enemies) nearest = Math.min(nearest, Math.hypot(e.location.x - pos.x, e.location.y - pos.y, e.location.z - pos.z));
      if (enemies.length > 0) {
        s.intel = Math.min(100, s.intel + CFG.INTEL_GAIN * Math.min(3, enemies.length));
        s.alert = nearest < CFG.SPOT_R ? Math.min(100, s.alert + CFG.ALERT_UP) : Math.max(0, s.alert - CFG.ALERT_DOWN);
      } else s.alert = Math.max(0, s.alert - CFG.ALERT_DOWN * 2);

      p.onScreenDisplay.setTitle(" ", { fadeInDuration: 0, stayDuration: 25, fadeOutDuration: 5,
        subtitle: `§bIntel §3${bar(s.intel)} §cAlerta §4${bar(s.alert)}` });

      if (s.alert >= 100) {
        try { s.drone.dimension.spawnParticle("minecraft:huge_explosion_emitter", pos); } catch (_) { /* nada */ }
        endSession(p, id, "sh.spy.detected");
      } else if (s.intel >= 100) {
        const inv = p.getComponent("minecraft:inventory")?.container;
        const left = inv?.addItem(new ItemStack("sh:intel_data", 1));
        if (left) p.dimension.spawnItem(left, p.location);
        endSession(p, id, "sh.spy.complete");
      }
    } catch (e) { /* el dron salió de un chunk cargado: se reintenta */ }
  }
}, 1);

world.afterEvents.playerLeave.subscribe((ev) => endSession(null, ev.playerId, null));
