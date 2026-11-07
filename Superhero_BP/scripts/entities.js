// =====================================================================
// ENTIDADES: sh:amigo (Operador de Radio) y sh:villano_electrico (jefe)
// Sin estado en las entidades: el karma se lee del jugador bajo demanda.
//
// COMANDOS:
//   /summon sh:amigo            /summon sh:villano_electrico
//   /scriptevent sh:radio cameras | enemy | low_energy | tier.NEUTRAL ...
// =====================================================================
import { world, system, EntityDamageCause } from "@minecraft/server";
import { getTier, onKarmaTierChanged, push } from "./shared.js";

const AMIGO = "sh:amigo";
const VILLAIN = "sh:villano_electrico";
const DIMS = ["overworld", "nether", "the_end"];

const BOSS = Object.freeze({
  SCAN: 10,            // ticks entre revisiones
  FLASH_CD: 120,       // ticks entre Golpes Flash
  FLASH_MIN: 5,        // distancia mínima para usar Flash
  FLASH_MAX: 24,
  FLASH_DMG: 8,
  TELEGRAPH: 8,        // aviso (chispas) antes del golpe
  EMP_CD: 400,
  EMP_RADIUS: 16,
  EMP_HP: 0.5,         // usa EMP bajo el 50% de vida
});

/* ----------------------------- RADIO / AMIGO ------------------------ */
function radio(p, key) {
  p.sendMessage({ rawtext: [
    { text: "§8[Radio] " }, { translate: "sh.npc.amigo.name" },
    { text: "§r: " }, { translate: `sh.radio.${key}` },
  ] });
}
// El Amigo comenta cuando cambia tu reputación (anticipa la ruta de traición).
onKarmaTierChanged((p, tier) => radio(p, `tier.${tier}`));

const talkCd = new Map(); // playerId -> tick
world.afterEvents.playerInteractWithEntity.subscribe((ev) => {
  if (ev.target.typeId !== AMIGO) return;
  const now = system.currentTick;
  if (now - (talkCd.get(ev.player.id) ?? -999) < 20) return; // evita doble disparo
  talkCd.set(ev.player.id, now);
  ev.player.sendMessage({ rawtext: [
    { translate: "sh.npc.amigo.name" }, { text: "§r: " },
    { translate: `sh.npc.amigo.${getTier(ev.player)}` },
  ] });
});
world.afterEvents.playerLeave.subscribe((ev) => talkCd.delete(ev.playerId));

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== "sh:radio" || ev.sourceEntity?.typeId !== "minecraft:player") return;
  radio(ev.sourceEntity, ev.message.trim() || "cameras");
});

/* --------------------------- VILLANO ELÉCTRICO ---------------------- */
world.afterEvents.entitySpawn.subscribe((ev) => {
  if (ev.entity.typeId !== VILLAIN && ev.entity.typeId !== "sh:super_soldado") return; // mini-jefes también
  try { ev.entity.addTag("sh_boss"); } catch (_) { /* main.js lo usa para "vida mínima" en Ira */ }
});

const bossState = new Map(); // entityId -> { flash, emp, taunted }
const seen = new Set();
let errs = 0;

function spark(dim, loc) {
  try { dim.spawnParticle("minecraft:electric_spark_particle", { x: loc.x, y: loc.y + 1, z: loc.z }); } catch (_) { /* nada */ }
}

// Golpe Flash: aviso con chispas -> aparece detrás del jugador y golpea.
function flash(dim, v, p) {
  spark(dim, v.location);
  p.playSound("ambient.weather.lightning.impact", { volume: 0.6, pitch: 1.4 });
  system.runTimeout(() => {
    try {
      const d = p.getViewDirection();
      const hl = Math.hypot(d.x, d.z) || 1;
      const pl = p.location;
      const to = { x: pl.x - (d.x / hl) * 1.6, y: pl.y, z: pl.z - (d.z / hl) * 1.6 };
      v.teleport(to, { dimension: dim, facingLocation: pl });
      spark(dim, to);
      p.applyDamage(BOSS.FLASH_DMG, { cause: EntityDamageCause.entityAttack, damagingEntity: v });
      push(p, pl.x - to.x, pl.z - to.z, 1.4, 0.5);
    } catch (_) { /* jugador o jefe ya no existen */ }
  }, BOSS.TELEGRAPH);
}

// EMP: ciega, frena y vacía la energía del jugador (evento sh:emp en main.js).
function emp(dim, v, st) {
  st.emp = BOSS.EMP_CD;
  for (const p of dim.getPlayers({ location: v.location, maxDistance: BOSS.EMP_RADIUS })) {
    if (p.hasTag("sh_bio")) { // Resistencia Elemental: la Bio-Armadura absorbe el pulso
      p.sendMessage({ rawtext: [{ translate: "sh.boss.emp_resisted" }] });
      continue;
    }
    p.addEffect("blindness", 80, { amplifier: 0, showParticles: false });
    p.addEffect("slowness", 60, { amplifier: 2, showParticles: false });
    try { p.runCommand("scriptevent sh:emp"); } catch (_) { /* sin poderes */ }
    p.onScreenDisplay.setTitle({ rawtext: [{ translate: "sh.boss.emp" }] });
    p.playSound("random.explode", { volume: 0.8, pitch: 0.6 });
  }
  try { dim.spawnParticle("minecraft:huge_explosion_emitter", v.location); } catch (_) { /* nada */ }
}

function tickBoss(dim, v, st) {
  if (st.flash > 0) st.flash -= BOSS.SCAN;
  if (st.emp > 0) st.emp -= BOSS.SCAN;

  const loc = v.location;
  const near = dim.getPlayers({ location: loc, maxDistance: BOSS.FLASH_MAX, closest: 1 });
  if (near.length === 0) return;
  const p = near[0];

  spark(dim, loc); // aura eléctrica (solo si hay jugador cerca)

  if (!st.taunted) {
    st.taunted = true;
    p.sendMessage({ rawtext: [
      { text: "§b" }, { translate: "entity.sh:villano_electrico.name" },
      { text: "§r: " }, { translate: "sh.dlg.act2.sc4.villano_01" },
    ] });
  }

  const hp = v.getComponent("minecraft:health");
  if (hp && st.emp <= 0 && hp.currentValue <= hp.effectiveMax * BOSS.EMP_HP) { emp(dim, v, st); return; }

  const pl = p.location;
  const dist = Math.hypot(pl.x - loc.x, pl.z - loc.z);
  if (st.flash <= 0 && dist >= BOSS.FLASH_MIN) { st.flash = BOSS.FLASH_CD; flash(dim, v, p); }
}

system.runInterval(() => {
  seen.clear();
  for (const id of DIMS) {
    const dim = world.getDimension(id);
    for (const v of dim.getEntities({ type: VILLAIN })) {
      seen.add(v.id);
      let st = bossState.get(v.id);
      if (!st) { st = { flash: 0, emp: 0, taunted: false }; bossState.set(v.id, st); }
      try { tickBoss(dim, v, st); }
      catch (e) { if (errs++ < 5) console.warn(`[Superhero/boss] ${e}`); }
    }
  }
  for (const k of bossState.keys()) if (!seen.has(k)) bossState.delete(k);
}, BOSS.SCAN);
