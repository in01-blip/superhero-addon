// =====================================================================
// TRAJES: Bio-Armadura (se invoca "a voluntad") + Traje Táctico (ítems)
//
// Bio-Armadura: al activarla, las 4 piezas (sh:bio_*) reemplazan tu armadura.
// Lo que llevabas puesto se guarda en el inventario y se re-equipa al desactivar.
// Pasivo: Resistencia Elemental (reduce daño y aturdimiento eléctrico).
//
// CONTROLES: Núcleo de Mutación (sh:mutation_core) = alternar Bio-Armadura.
// COMANDOS:  /scriptevent sh:bio unlock | on | off
//            /give @s sh:tactical_helmet  (también _chest, _legs, _boots)
// =====================================================================
import { world, system, ItemStack, ItemLockMode, EquipmentSlot } from "@minecraft/server";

const BIO = [
  [EquipmentSlot.Head, "sh:bio_helmet"],
  [EquipmentSlot.Chest, "sh:bio_chest"],
  [EquipmentSlot.Legs, "sh:bio_legs"],
  [EquipmentSlot.Feet, "sh:bio_boots"],
];
const isBio = (item) => !!item && item.typeId.startsWith("sh:bio_");
const toggleCd = new Map();

function activateBio(p) {
  const eq = p.getComponent("minecraft:equippable");
  const inv = p.getComponent("minecraft:inventory")?.container;
  if (!eq || !inv) return;
  for (const [slot, id] of BIO) {
    const prev = eq.getEquipment(slot);
    if (prev && !isBio(prev)) {
      p.setDynamicProperty(`sh_prev_${slot}`, prev.typeId);
      const leftover = inv.addItem(prev); // mismo stack: conserva durabilidad
      if (leftover) p.dimension.spawnItem(leftover, p.location);
    } else {
      p.setDynamicProperty(`sh_prev_${slot}`, undefined);
    }
    const piece = new ItemStack(id, 1);
    piece.lockMode = ItemLockMode.slot;
    piece.keepOnDeath = true;
    eq.setEquipment(slot, piece);
  }
  p.addTag("sh_bio");
  p.sendMessage({ rawtext: [{ translate: "sh.suit.bio.on" }] });
}

function deactivateBio(p, silent = false) {
  const eq = p.getComponent("minecraft:equippable");
  const inv = p.getComponent("minecraft:inventory")?.container;
  if (!eq || !inv) return;
  for (const [slot] of BIO) {
    if (isBio(eq.getEquipment(slot))) eq.setEquipment(slot, undefined);
    const prevId = p.getDynamicProperty(`sh_prev_${slot}`);
    p.setDynamicProperty(`sh_prev_${slot}`, undefined);
    if (typeof prevId !== "string") continue;
    for (let i = 0; i < inv.size; i++) {
      const it = inv.getItem(i);
      if (it?.typeId === prevId) { eq.setEquipment(slot, it); inv.setItem(i, undefined); break; }
    }
  }
  // limpia piezas bio que hayan quedado sueltas en el inventario
  for (let i = 0; i < inv.size; i++) if (isBio(inv.getItem(i))) inv.setItem(i, undefined);
  p.removeTag("sh_bio");
  if (!silent) p.sendMessage({ rawtext: [{ translate: "sh.suit.bio.off" }] });
}

function toggleBio(p) {
  if (p.getDynamicProperty("sh_bio_unlocked") !== true) {
    p.sendMessage({ rawtext: [{ translate: "sh.suit.bio.locked" }] });
    return;
  }
  if (p.hasTag("sh_bio")) deactivateBio(p); else activateBio(p);
}

world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack?.typeId !== "sh:mutation_core") return;
  const now = system.currentTick;
  if (now - (toggleCd.get(ev.source.id) ?? -999) < 20) return;
  toggleCd.set(ev.source.id, now);
  toggleBio(ev.source);
});

// Resistencia Elemental pasiva (cada 2 s, solo jugadores con la Bio-Armadura)
system.runInterval(() => {
  for (const p of world.getAllPlayers()) {
    if (!p.hasTag("sh_bio")) continue;
    try { p.addEffect("resistance", 60, { amplifier: 1, showParticles: false }); } catch (_) { /* nada */ }
  }
}, 40);

// Al reaparecer tras morir: sale de la Bio-Armadura (las piezas se conservan por keepOnDeath)
world.afterEvents.playerSpawn.subscribe((ev) => {
  if (!ev.initialSpawn && ev.player.hasTag("sh_bio")) deactivateBio(ev.player, true);
});
world.afterEvents.playerLeave.subscribe((ev) => toggleCd.delete(ev.playerId));

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== "sh:bio" || ev.sourceEntity?.typeId !== "minecraft:player") return;
  const p = ev.sourceEntity, arg = ev.message.trim();
  if (arg === "unlock") { p.setDynamicProperty("sh_bio_unlocked", true); p.sendMessage({ rawtext: [{ translate: "sh.suit.bio.unlocked" }] }); }
  else if (arg === "on" && !p.hasTag("sh_bio")) activateBio(p);
  else if (arg === "off" && p.hasTag("sh_bio")) deactivateBio(p);
});
