// =====================================================================
// SUPERHERO ADD-ON  v0.6.0  |  Bedrock 1.21.130+  |  @minecraft/server 2.0.0
// Optimizado para móviles: un solo bucle (cada 2 ticks), estados en
// pool, consultas de entidades limitadas y cada 10 ticks.
//
// CONTROLES (móvil)
//  - Núcleo de Concentración (sh:focus_core): MANTENER = cargar,
//    SOLTAR = salir disparado hacia donde miras.
//  - Núcleo Cronal (sh:chrono_core): tocar = cambia estado de tiempo (0-3).
//  - Correr (sprint): súper velocidad. Sobre agua = correr sobre el agua.
//    Pared de frente a velocidad normal = correr HACIA ARRIBA.
//    Pared a un costado (en el aire) = correr de LADO (izq. o der.).
//    Pared a velocidad máxima = destruye el muro.
//    REGLA: NUNCA se corre hacia abajo. Para bajar: agacharse (descenso
//    lento) o soltar el sprint y lanzarse.
//  - Vuelo (si está desbloqueado o en Ira): saltar en el aire para despegar.
//    Saltar = subir, agacharse = bajar, correr = avanzar hacia la mirada.
//
// COMANDOS DE PRUEBA (chat):
//  /scriptevent sh:powers on|off     /scriptevent sh:unlock flight|none
//  /scriptevent sh:time 0|1|2|3      /scriptevent sh:karma -20
//  /scriptevent sh:rage              /scriptevent sh:energy
//  /scriptevent sh:status
// =====================================================================
import { world, system, BlockVolume } from "@minecraft/server";
import { tierOf, emitTierChanged, push } from "./shared.js";
import "./entities.js"; // Amigo + Villano Eléctrico
import "./suits.js";    // Bio-Armadura + trajes
import "./city.js";     // Ciudad 2048x2048 (generación por demanda)
import "./wear.js";     // Desgaste del Traje Urbano + bolsa de materiales
import "./spy.js";      // Misión secundaria: dron espía

/* ------------------------------ CONFIG ------------------------------ */
const CFG = Object.freeze({
  TICK_STEP: 2,
  ENERGY_MAX: 100,
  ENERGY_REGEN: 0.6,      // por paso
  FLY_DRAIN: 0.8,
  WALL_DRAIN: 0.6,
  CHARGE_MAX_TICKS: 60,
  LAUNCH_COST: 25,
  LAUNCH_H: 2.2,
  LAUNCH_V: 1.2,
  SPEED_AMP: 4,
  WATER_LIFT: 0.12,
  WALL_LIFT: 0.42,
  WALL_MAX_STEPS: 40,
  WALL_SIDE_PUSH: 0.35,   // avance lateral por la pared
  WALL_SIDE_LIFT: 0.10,   // compensa la gravedad (siempre >= 0)
  FLY_THRUST: 0.9,
  FLY_LIFT: 0.35,
  FLY_HOVER: 0.06,
  DESTROY_ENABLED: true,
  DESTROY_SPEED: 0.5,     // bloques/tick horizontales
  SMASH_RADIUS: 1,        // 3x3x3
  TIME_RADIUS: 20,
  TIME_MAX_ENTITIES: 24,  // tope por consulta (móviles)
  CRIT_MULT: 2,           // estado de tiempo 1: daño extra (x2 = +100%)
  RAGE_MAX: 100,
  RAGE_PER_DAMAGE: 6,
  RAGE_DURATION: 300,     // ticks (15 s)
  AURA_PARTICLE: "minecraft:dragon_breath_trail", // temporal -> sh:aura (RP)
});

const NON_AFFECTED = ["minecraft:player", "minecraft:item", "minecraft:xp_orb", "minecraft:arrow"];
const UNBREAKABLE = [
  "minecraft:bedrock", "minecraft:barrier", "minecraft:command_block",
  "minecraft:chain_command_block", "minecraft:repeating_command_block",
  "minecraft:structure_block", "minecraft:end_portal_frame", "minecraft:reinforced_deepslate",
];

/* ------------------------- POOL DE ESTADOS -------------------------- */
class Pool {
  constructor(factory, reset) { this.f = factory; this.r = reset; this.free = []; }
  acquire() { return this.free.pop() ?? this.f(); }
  release(o) { this.r(o); this.free.push(o); }
}
const freshState = () => ({
  powers: false, flightUnlocked: false, flying: false,
  energy: CFG.ENERGY_MAX, charging: false, charge: 0, launchUntil: 0,
  rage: 0, rageActive: false, rageTicks: 0, rageMult: 1,
  timeMode: 0, wallSteps: 0, wallMode: 0, lastSmash: -999, lastKarmaHit: -999,
  n: 0, karma: 0, tier: "NEUTRAL",
});
const statePool = new Pool(freshState, (s) => Object.assign(s, freshState()));
const states = new Map();

function getState(p) {
  let s = states.get(p.id);
  if (!s) {
    s = statePool.acquire();
    s.powers = p.getDynamicProperty("sh_powers") === true;
    s.flightUnlocked = p.getDynamicProperty("sh_flight") === true;
    const k = p.getDynamicProperty("sh_karma");
    s.karma = typeof k === "number" ? k : 0;
    s.tier = tierOf(s.karma);
    states.set(p.id, s);
  }
  return s;
}

/* ------------------------------ KARMA ------------------------------- */
function addKarma(p, s, amount) {
  const prev = s.tier;
  s.karma = Math.max(-100, Math.min(100, s.karma + amount));
  s.tier = tierOf(s.karma);
  p.setDynamicProperty("sh_karma", s.karma);
  if (prev !== s.tier) {
    p.sendMessage({ rawtext: [{ translate: "sh.karma.changed" }, { text: " " }, { translate: `sh.karma.tier.${s.tier}` }] });
    emitTierChanged(p, s.tier, s.karma);
  }
}

/* ------------------------------ UTILES ------------------------------ */
function solidAt(dim, x, y, z) { const b = dim.getBlock({ x, y, z }); return !!b && b.isSolid; }
// Empuje de pared: la componente vertical NUNCA es negativa.
function pushWall(p, dx, dz, h, v) { push(p, dx, dz, h, Math.max(0, v)); }
const bar = (v, max, len = 10) => {
  const n = Math.max(0, Math.min(len, Math.round((v / max) * len)));
  return "|".repeat(n) + "§8" + "|".repeat(len - n);
};
function fx(p, id, dur, amp) { p.addEffect(id, dur, { amplifier: amp, showParticles: false }); }

function slowWorld(p, amp, dur) {
  const list = p.dimension.getEntities({
    location: p.location, maxDistance: CFG.TIME_RADIUS,
    excludeTypes: NON_AFFECTED, closest: CFG.TIME_MAX_ENTITIES,
  });
  for (const e of list) { try { fx(e, "slowness", dur, amp); } catch (_) { /* sin efectos */ } }
}
function aura(p) {
  try { p.dimension.spawnParticle(CFG.AURA_PARTICLE, { x: p.location.x, y: p.location.y + 1, z: p.location.z }); } catch (_) { /* aún sin partícula */ }
}

/* ------------------------------- IRA -------------------------------- */
function startRage(p, s) {
  s.rageActive = true;
  s.rageTicks = CFG.RAGE_DURATION;
  s.rageMult = 2 + Math.floor(Math.random() * 3); // x2, x3 o x4
  const d = CFG.RAGE_DURATION;
  fx(p, "strength", d, s.rageMult + 1);
  fx(p, "speed", d, s.rageMult + 2);
  fx(p, "resistance", d, 3);
  slowWorld(p, 255, 30);
  p.onScreenDisplay.setTitle({ rawtext: [{ translate: "sh.hud.rage_start", with: [String(s.rageMult)] }] });
}
function endRage(p, s) {
  s.rageActive = false; s.rage = 0; s.rageTicks = 0;
  if (s.flying && !s.flightUnlocked) stopFlying(p, s, true); // caída libre
  p.sendMessage({ rawtext: [{ translate: "sh.hud.rage_end" }] });
}

world.afterEvents.entityHurt.subscribe((ev) => {
  const victim = ev.hurtEntity;
  const src = ev.damageSource?.damagingEntity;

  if (victim.typeId === "minecraft:player") {
    const s = getState(victim);
    if (s.powers && !s.rageActive) {
      s.rage = Math.min(CFG.RAGE_MAX, s.rage + ev.damage * CFG.RAGE_PER_DAMAGE);
      if (s.rage >= CFG.RAGE_MAX) startRage(victim, s);
    }
  }

  if (src?.typeId === "minecraft:player" && victim.typeId !== "minecraft:player") {
    const s = getState(src);
    if (!s.powers) return;
    try {
      const hp = victim.getComponent("minecraft:health");
      if (!hp) return;
      if (s.rageActive) {
        if (victim.hasTag("sh_boss")) { if (hp.currentValue > 1) hp.setCurrentValue(1); }
        else victim.kill();
      } else if (s.timeMode === 1) {
        hp.setCurrentValue(Math.max(0, hp.currentValue - ev.damage * (CFG.CRIT_MULT - 1)));
      }
    } catch (_) { /* entidad ya muerta */ }
  }
});

/* ------------------------------ VUELO ------------------------------- */
function stopFlying(p, s, depleted) {
  s.flying = false;
  if (depleted) {
    try { p.removeEffect("slow_falling"); } catch (_) { /* nada */ }
    p.onScreenDisplay.setActionBar({ rawtext: [{ translate: "sh.hud.energy_depleted" }] });
  }
}

/* ------------------------ CARGA / IMPULSO --------------------------- */
world.afterEvents.itemStartUse.subscribe((ev) => {
  if (ev.itemStack?.typeId !== "sh:focus_core") return;
  const s = getState(ev.source);
  if (!s.powers) return;
  s.charging = true; s.charge = 0;
});
function releaseCharge(ev) {
  if (ev.itemStack?.typeId !== "sh:focus_core") return;
  const p = ev.source, s = getState(p);
  if (!s.charging) return;
  s.charging = false;
  const power = s.charge / CFG.CHARGE_MAX_TICKS;
  s.charge = 0;
  if (power < 0.15 || s.energy < CFG.LAUNCH_COST * power) return;
  const d = p.getViewDirection();
  s.energy -= CFG.LAUNCH_COST * power;
  push(p, d.x, d.z, CFG.LAUNCH_H * power, d.y * CFG.LAUNCH_V * power + 0.15);
  s.launchUntil = system.currentTick + 30;
  p.playSound("random.explode", { volume: 0.4, pitch: 1.6 });
}
world.afterEvents.itemReleaseUse.subscribe(releaseCharge);
world.afterEvents.itemStopUse.subscribe(releaseCharge);

world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack?.typeId !== "sh:chrono_core") return;
  const s = getState(ev.source);
  if (!s.powers) return;
  s.timeMode = (s.timeMode + 1) % 4;
  ev.source.sendMessage({ rawtext: [{ translate: `sh.hud.time_mode.${s.timeMode}` }] });
});

/* ------------------------- DESTRUCCIÓN LOCAL ------------------------ */
function smash(p, s, hx, hz, tick) {
  const l = p.location, r = CFG.SMASH_RADIUS;
  const cx = Math.floor(l.x + hx * 1.6), cy = Math.floor(l.y), cz = Math.floor(l.z + hz * 1.6);
  const vol = new BlockVolume({ x: cx - r, y: cy, z: cz - r }, { x: cx + r, y: cy + 2, z: cz + r });
  p.dimension.fillBlocks(vol, "minecraft:air", { blockFilter: { excludeTypes: UNBREAKABLE }, ignoreChunkBoundErrors: true });
  try { p.dimension.spawnParticle("minecraft:huge_explosion_emitter", { x: cx + 0.5, y: cy + 1, z: cz + 0.5 }); } catch (_) { /* nada */ }
  s.lastSmash = tick;
  if (tick - s.lastKarmaHit > 40) { s.lastKarmaHit = tick; addKarma(p, s, -1); } // el daño al entorno cuesta karma
}

/* ---------------------------- BUCLE PRINCIPAL ----------------------- */
function tickPlayer(p, s, tick) {
  s.n++;
  const slow = s.n % 5 === 0; // cada 10 ticks
  const loc = p.location, vel = p.getVelocity(), view = p.getViewDirection();
  const hSpeed = Math.hypot(vel.x, vel.z);
  const hl = Math.hypot(view.x, view.z) || 1;
  const hx = view.x / hl, hz = view.z / hl;
  const dim = p.dimension;
  let drained = false;

  // Ira
  if (s.rageActive) {
    s.rageTicks -= CFG.TICK_STEP;
    if (s.rageTicks <= 0) endRage(p, s);
    else if (slow) { slowWorld(p, 255, 30); aura(p); }
  }
  // Estados de tiempo
  if (slow && !s.rageActive && s.timeMode) {
    if (s.timeMode === 1) { slowWorld(p, 5, 30); fx(p, "slowness", 30, 1); }
    else if (s.timeMode === 2) { slowWorld(p, 255, 30); fx(p, "speed", 30, 8); fx(p, "haste", 30, 3); }
    // timeMode 3: solo visual (cámara/FOV/animación) -> RP + cámara, pendiente
  }
  // Carga
  if (s.charging) { s.charge = Math.min(s.charge + CFG.TICK_STEP, CFG.CHARGE_MAX_TICKS); drained = true; }

  // Detección de pared: delante, izquierda, derecha
  const wallAhead = solidAt(dim, loc.x + hx * 0.9, loc.y + 1, loc.z + hz * 0.9);
  const wallLeft = solidAt(dim, loc.x + hz * 0.7, loc.y + 1, loc.z - hx * 0.7);
  const wallRight = solidAt(dim, loc.x - hz * 0.7, loc.y + 1, loc.z + hx * 0.7);
  const onWall = wallAhead || wallLeft || wallRight;
  const sliding = onWall && !p.isOnGround && vel.y < -0.08 && !s.flying;

  // Súper velocidad (sin bonus mientras se cae pegado a una pared)
  if (p.isSprinting && !sliding) fx(p, "speed", 10, CFG.SPEED_AMP);

  // Correr sobre agua
  if (p.isSprinting && hSpeed > 0.3) {
    const b = dim.getBlock({ x: loc.x, y: loc.y - 0.2, z: loc.z });
    if (b?.typeId === "minecraft:water") push(p, 0, 0, 0, CFG.WATER_LIFT);
  }

  // Paredes: arriba (de frente) o de lado (izq./der., en el aire). Nunca abajo.
  s.wallMode = 0;
  if (p.isOnGround) s.wallSteps = 0;
  if (p.isSprinting && !p.isSneaking && !s.flying) {
    const fast = hSpeed >= CFG.DESTROY_SPEED || tick < s.launchUntil;
    const canWall = s.energy > 0 && s.wallSteps < CFG.WALL_MAX_STEPS;
    if (wallAhead) {
      if (CFG.DESTROY_ENABLED && fast && tick - s.lastSmash > 10) smash(p, s, hx, hz, tick);
      else if (!fast && canWall) {
        pushWall(p, hx, hz, 0.05, CFG.WALL_LIFT);
        s.wallMode = 1;
      }
    } else if ((wallLeft || wallRight) && !p.isOnGround && canWall) {
      pushWall(p, hx, hz, CFG.WALL_SIDE_PUSH, CFG.WALL_SIDE_LIFT);
      s.wallMode = 2;
    }
    if (s.wallMode) { s.wallSteps++; s.energy -= CFG.WALL_DRAIN; drained = true; }
  }
  // Bajar por la pared: solo despacio (agachado o sprint sin impulso) -> descenso lento
  if (onWall && !p.isOnGround && s.wallMode === 0 && !s.flying && (p.isSneaking || p.isSprinting)) {
    fx(p, "slow_falling", 10, 0);
  }

  // Vuelo
  const canFly = s.flightUnlocked || s.rageActive;
  if (canFly && !s.flying && p.isJumping && !p.isOnGround && s.energy > 10) {
    s.flying = true;
    p.onScreenDisplay.setActionBar({ rawtext: [{ translate: "sh.hud.flight_on" }] });
  }
  if (s.flying) {
    if (!canFly) stopFlying(p, s, true);
    else if (s.energy <= 0) stopFlying(p, s, true);
    else if (p.isOnGround && !p.isJumping) stopFlying(p, s, false);
    else {
      fx(p, "slow_falling", 10, 0);
      let lift = CFG.FLY_HOVER;
      if (p.isJumping) lift = CFG.FLY_LIFT; else if (p.isSneaking) lift = -CFG.FLY_LIFT * 0.6;
      if (p.isSprinting) push(p, view.x, view.z, CFG.FLY_THRUST, view.y * CFG.FLY_THRUST * 0.8 + lift);
      else push(p, 0, 0, 0, lift);
      s.energy -= p.isSprinting ? CFG.FLY_DRAIN * 2 : CFG.FLY_DRAIN;
      drained = true;
    }
  }

  // Energía
  if (!drained) s.energy += CFG.ENERGY_REGEN;
  s.energy = Math.max(0, Math.min(CFG.ENERGY_MAX, s.energy));

  // HUD (cada 10 ticks)
  if (slow) {
    let t = `§5E §d${bar(s.energy, CFG.ENERGY_MAX)} §cIra §4${bar(s.rage, CFG.RAGE_MAX)}`;
    if (s.rageActive) t += ` §6x${s.rageMult}`;
    if (s.charging) t += ` §bCarga §3${bar(s.charge, CFG.CHARGE_MAX_TICKS)}`;
    if (s.timeMode) t += ` §9T${s.timeMode}`;
    p.onScreenDisplay.setActionBar(t);
  }
}

let errCount = 0;
system.runInterval(() => {
  const tick = system.currentTick;
  for (const p of world.getAllPlayers()) {
    const s = getState(p);
    if (!s.powers) continue;
    try { tickPlayer(p, s, tick); }
    catch (e) { if (errCount++ < 5) console.warn(`[Superhero] ${e}`); }
  }
}, CFG.TICK_STEP);

/* ----------------------- CICLO DE VIDA DEL JUGADOR ------------------- */
world.afterEvents.playerSpawn.subscribe((ev) => {
  if (ev.initialSpawn) return;
  const s = getState(ev.player); // respawn tras morir: limpia estado transitorio
  s.rageActive = false; s.rage = 0; s.flying = false; s.charging = false; s.timeMode = 0; s.energy = CFG.ENERGY_MAX;
});
world.afterEvents.playerLeave.subscribe((ev) => {
  const s = states.get(ev.playerId);
  if (s) { statePool.release(s); states.delete(ev.playerId); }
});

/* ------------------------ COMANDOS DE PRUEBA ------------------------- */
system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (!ev.id.startsWith("sh:")) return;
  const p = ev.sourceEntity;
  if (p?.typeId !== "minecraft:player") return;
  const s = getState(p), arg = ev.message.trim();
  switch (ev.id) {
    case "sh:powers": s.powers = arg !== "off"; p.setDynamicProperty("sh_powers", s.powers); break;
    case "sh:unlock": s.flightUnlocked = arg === "flight"; p.setDynamicProperty("sh_flight", s.flightUnlocked); break;
    case "sh:time": s.timeMode = Math.max(0, Math.min(3, parseInt(arg) || 0)); break;
    case "sh:karma": addKarma(p, s, parseInt(arg) || 0); break;
    case "sh:rage": s.powers = true; startRage(p, s); break;
    case "sh:energy": s.energy = CFG.ENERGY_MAX; break;
    case "sh:emp": // pulso electromagnético: apaga energía, aura y vuelo
      s.energy = 0; s.charging = false;
      if (s.rageActive) endRage(p, s);
      if (s.flying) stopFlying(p, s, true);
      break;
    case "sh:status":
      p.sendMessage(`powers=${s.powers} flight=${s.flightUnlocked} karma=${s.karma} (${s.tier}) time=${s.timeMode} energy=${Math.round(s.energy)}`);
      break;
  }
});

console.warn("[Superhero] v0.6.0 cargado");
