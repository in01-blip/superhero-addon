// =====================================================================
// DESGASTE DEL TRAJE URBANO + BOLSA DE MATERIALES
//
// La ropa común (sh:urban_*) no aguanta la súper velocidad: se desgasta al
// correr rápido y al recibir golpes, rayos o fuego. Al llegar a 0 se rompe.
// Esto empuja al jugador a cambiar de ropa en el piso franco y a conseguir
// el Traje Táctico (piezas de drones / Súper Soldados).
//
// Bolsa de materiales: cargar muchas piezas te vuelve más lento.
// =====================================================================
import { world, system, EquipmentSlot } from "@minecraft/server";

const URBAN = {
  "sh:urban_helmet": EquipmentSlot.Head,
  "sh:urban_chest": EquipmentSlot.Chest,
  "sh:urban_legs": EquipmentSlot.Legs,
  "sh:urban_boots": EquipmentSlot.Feet,
};
const WEAR = Object.freeze({
  SPRINT: 1,          // por segundo corriendo rápido
  SPRINT_SPEED: 0.45, // bloques/tick
  HIT_MIN: 1,         // golpes normales: daño / 2, mínimo 1
  FIRE_LIGHTNING: 15, // fuego o rayo
  HAUL_MIN: 10,       // peso mínimo para "bolsa pesada"
});
const HEAVY = new Set(["lightning", "fire", "fireTick", "lava", "magma"]);

function applyWear(p, amount) {
  const eq = p.getComponent("minecraft:equippable");
  if (!eq) return;
  for (const slot of Object.values(URBAN)) {
    const item = eq.getEquipment(slot);
    if (!item || !(item.typeId in URBAN)) continue;
    const dur = item.getComponent("minecraft:durability");
    if (!dur) continue;
    const before = dur.damage, max = dur.maxDurability;
    dur.damage = Math.min(max, before + amount);
    if (dur.damage >= max) {
      eq.setEquipment(slot, undefined);
      try { p.dimension.spawnParticle("minecraft:large_explosion", p.location); } catch (_) { /* nada */ }
      p.sendMessage({ rawtext: [{ translate: "sh.wear.broken" }, { text: " " }, { translate: `item.${item.typeId}` }] });
      continue;
    }
    if (before < max * 0.5 && dur.damage >= max * 0.5) p.sendMessage({ rawtext: [{ translate: "sh.wear.half" }, { text: " " }, { translate: `item.${item.typeId}` }] });
    else if (before < max * 0.85 && dur.damage >= max * 0.85) p.sendMessage({ rawtext: [{ translate: "sh.wear.almost" }, { text: " " }, { translate: `item.${item.typeId}` }] });
    eq.setEquipment(slot, item); // devuelve la copia con la durabilidad nueva
  }
}

function haulWeight(p) {
  const inv = p.getComponent("minecraft:inventory")?.container;
  if (!inv) return 0;
  let w = 0;
  for (let i = 0; i < inv.size; i++) {
    const it = inv.getItem(i);
    if (!it) continue;
    if (it.typeId === "sh:drone_part") w += it.amount;
    else if (it.typeId === "sh:soldier_plate") w += it.amount * 2;
  }
  return w;
}

// Cada segundo: desgaste por correr rápido + bolsa de materiales
system.runInterval(() => {
  for (const p of world.getAllPlayers()) {
    if (p.getDynamicProperty("sh_powers") === true && p.isSprinting) {
      const v = p.getVelocity();
      if (Math.hypot(v.x, v.z) >= WEAR.SPRINT_SPEED) { try { applyWear(p, WEAR.SPRINT); } catch (_) { /* nada */ } }
    }
    const heavy = haulWeight(p) >= WEAR.HAUL_MIN;
    if (heavy) {
      try { p.addEffect("slowness", 40, { amplifier: 0, showParticles: false }); } catch (_) { /* nada */ }
      if (!p.hasTag("sh_hauling")) { p.addTag("sh_hauling"); p.sendMessage({ rawtext: [{ translate: "sh.wear.haul_on" }] }); }
    } else if (p.hasTag("sh_hauling")) {
      p.removeTag("sh_hauling"); p.sendMessage({ rawtext: [{ translate: "sh.wear.haul_off" }] });
    }
  }
}, 20);

// Golpes, rayos y fuego dañan la ropa
world.afterEvents.entityHurt.subscribe((ev) => {
  const p = ev.hurtEntity;
  if (p.typeId !== "minecraft:player" || p.getDynamicProperty("sh_powers") !== true) return;
  const amount = HEAVY.has(ev.damageSource.cause) ? WEAR.FIRE_LIGHTNING : Math.max(WEAR.HIT_MIN, Math.round(ev.damage / 2));
  try { applyWear(p, amount); } catch (_) { /* nada */ }
});
