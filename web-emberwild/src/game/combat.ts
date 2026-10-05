/**
 * Live combat on the world map (Caves of Qud style).
 *
 * There is no separate battle arena: fighters are the wild creatures already on
 * the map and the party's monsters, standing on real terrain. Every world tick,
 * hostile creatures and party members act autonomously — closing distance,
 * striking with their best ready skill, ticking statuses, feeding and spreading
 * fire. All combat math (d20 vs DV, armor penetration, elemental multipliers,
 * crits) is ported verbatim from the former arena so the numbers are unchanged.
 *
 * Determinism: every roll for a combatant on a tick comes from a Rng seeded by
 * (world seed, tick, combatant id, purpose) — replays of the same actions
 * reproduce the same fight exactly.
 */
import { SKILLS, SPECIES, STATUSES, elementMult, footprintOf, type SkillDef } from "./data";
import { getMonsterFootprint } from "./genetics";
import { addLog, compass } from "./log";
import { createMonster, displayName, grantXp, rollMutations, statOf } from "./monster";
import { Rng, clamp, hash2, hash3, hashString } from "./rng";
import type { Aggression, BStatus, FieldOrder, GameState, GroundTile, ItemId, Monster, StatusId, Terrain, WildCreature } from "./types";
import { timeOf, type World, getWorld } from "./world";
import { loadChunks } from "./sim";

export const FLAMMABLE: Partial<Record<Terrain, number>> = { grass: 0.16, tallgrass: 0.32, flowers: 0.22, tree: 0.12, gloom: 0.08 };
export const BLOCKING: Terrain[] = ["tree", "rock", "wall", "woodwall"];

const WORLD_SIZE = 4096;
const PASSABLE_BIOMES = ["river", "beach", "meadow", "forest", "taiga", "gloomwood", "marsh", "steppe", "desert", "tundra", "snow", "hills", "mountain"];
const cheb = (ax: number, ay: number, bx: number, by: number): number => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/* --------------------------------- Terrain ---------------------------------- */

/** Derives the combat terrain (cover, gloom, fuel) for a world tile. */
export function biomeTerrain(biome: string, r: number): Terrain {
  switch (biome) {
    case "forest": return r < 0.13 ? "tree" : r < 0.3 ? "tallgrass" : r < 0.36 ? "flowers" : "grass";
    case "taiga": return r < 0.15 ? "tree" : r < 0.22 ? "rock" : r < 0.32 ? "snow" : "grass";
    case "gloomwood": return r < 0.14 ? "tree" : r < 0.55 ? "gloom" : r < 0.65 ? "tallgrass" : "grass";
    case "meadow": return r < 0.2 ? "flowers" : r < 0.38 ? "tallgrass" : r < 0.41 ? "rock" : "grass";
    case "marsh": return r < 0.48 ? "mud" : r < 0.66 ? "tallgrass" : "grass";
    case "beach": return r < 0.08 ? "rock" : "sand";
    case "steppe": return r < 0.3 ? "tallgrass" : r < 0.34 ? "rock" : "grass";
    case "desert": return r < 0.1 ? "rock" : "sand";
    case "tundra": return r < 0.3 ? "snow" : r < 0.38 ? "rock" : "grass";
    case "snow": return r < 0.1 ? "rock" : "snow";
    case "hills": return r < 0.12 ? "rock" : r < 0.3 ? "tallgrass" : r < 0.36 ? "flowers" : "grass";
    case "mountain": return r < 0.22 ? "rock" : r < 0.35 ? "snow" : "sand";
    case "sea": case "lake": case "deep": return "water";
    case "river": return r < 0.25 ? "mud" : r < 0.4 ? "tallgrass" : "grass";
    default: return "grass";
  }
}

/**
 * Effective terrain of a tile: a persisted overlay (ash, grown grass, ...) wins,
 * then landmark structures sampled 1:1, then biome-derived ground. Stable per
 * seed, so cover and fuel are the same on every visit.
 */
export function terrainAt(gs: GameState, x: number, y: number): Terrain {
  const g = gs.ground[`${x},${y}`];
  if (g?.t) return g.t;
  const world = getWorld(gs.seed);
  const sp = world.siteAt(x, y);
  if (sp) return sp.wall ? (sp.kind === "hamlet" ? "woodwall" : "wall") : sp.door ? "door" : sp.rubble ? "rubble" : "floor";
  const biome = world.tile(x, y).biome;
  return biomeTerrain(biome, hash2(gs.seed ^ 0x71e5, x, y) / 4294967296);
}

const ground = (gs: GameState, x: number, y: number): GroundTile => gs.ground[`${x},${y}`] ?? (gs.ground[`${x},${y}`] = {});

/* --------------------------------- Fighters --------------------------------- */

/** A combatant on the live map: a party monster or a wild creature. */
export interface Fighter {
  /** Party uid, or the wild creature id. */
  key: string;
  side: "party" | "wild";
  mon: Monster;
  x: number;
  y: number;
  fp: number;
  creatureId: string | null;
}

/** Builds the deterministic monster stats for a wild creature. */
export function wildMonster(gs: GameState, c: WildCreature): Monster {
  const world = getWorld(gs.seed);
  const gloom = world.tile(c.homeX, c.homeY).biome === "gloomwood";
  const temp = { uidSeq: 0, tick: gs.tick } as GameState;
  const m = createMonster(temp, c.speciesId, c.level, {
    seed: c.geneSeed,
    personality: c.personality,
    mutations: rollMutations(new Rng(c.geneSeed ^ 0x77), gloom),
    origin: "Wild",
  });
  m.uid = `w_${c.id}`;
  m.hp = Math.max(1, Math.round(statOf(m, "hp") * c.hpFrac));
  m.satiety = c.satiety;
  if (c.alpha) m.plus = 3;
  return m;
}

export const partyPos = (gs: GameState, uid: string): { x: number; y: number } => gs.field[uid] ?? { x: gs.player.x, y: gs.player.y };

export function partyFighter(gs: GameState, m: Monster): Fighter {
  const pos = partyPos(gs, m.uid);
  return { key: m.uid, side: "party", mon: m, x: pos.x, y: pos.y, fp: getMonsterFootprint(m), creatureId: null };
}

export function wildFighter(gs: GameState, c: WildCreature): Fighter {
  return { key: c.id, side: "wild", mon: wildMonster(gs, c), x: c.x, y: c.y, fp: footprintOf(SPECIES[c.speciesId]), creatureId: c.id };
}

/** True when (x, y) is inside the fighter's body. */
export const covers = (f: Fighter, x: number, y: number): boolean => x >= f.x && x < f.x + f.fp && y >= f.y && y < f.y + f.fp;

/** Chebyshev distance from a fighter's body (any covered tile) to a point. */
export function distToBody(f: Fighter, x: number, y: number): number {
  let d = 99;
  for (let dy = 0; dy < f.fp; dy++) for (let dx = 0; dx < f.fp; dx++) d = Math.min(d, cheb(f.x + dx, f.y + dy, x, y));
  return d;
}

/** Chebyshev distance between two fighters' bodies (edge to edge). */
export function bodyDist(a: Fighter, b: Fighter): number {
  let d = 99;
  for (let dy = 0; dy < b.fp; dy++) for (let dx = 0; dx < b.fp; dx++) d = Math.min(d, distToBody(a, b.x + dx, b.y + dy));
  return d;
}

/** Current HP of a fighter (party: mon.hp; wild: derived from hpFrac; 0 = down). */
export function hpOf(gs: GameState, f: Fighter): number {
  if (f.side === "party") return gs.party.find((m) => m.uid === f.key)?.hp ?? 0;
  const c = f.creatureId ? gs.creatures[f.creatureId] : null;
  return c ? Math.round(statOf(f.mon, "hp") * c.hpFrac) : 0;
}

const maxHpOf = (f: Fighter): number => statOf(f.mon, "hp");

/** The party monster whose body covers a tile, if any. */
export function partyMonAt(gs: GameState, x: number, y: number): Monster | null {
  for (const m of gs.party) {
    const pos = gs.field[m.uid];
    if (!pos) continue;
    const fp = getMonsterFootprint(m);
    if (x >= pos.x && x < pos.x + fp && y >= pos.y && y < pos.y + fp) return m;
  }
  return null;
}

const hasStatus = (gs: GameState, key: string, s: StatusId): boolean => (gs.fighters[key]?.statuses ?? []).some((x) => x.id === s);
const hasTrait = (f: Fighter, t: string): boolean => (SPECIES[f.mon.speciesId].traits as string[]).includes(t);

function addStatus(gs: GameState, f: Fighter, id: StatusId, turns: number): boolean {
  if (id === "burning" && (hasTrait(f, "sunborn") || hasStatus(gs, f.key, "soaked"))) return false;
  const st = gs.fighters[f.key] ?? (gs.fighters[f.key] = { statuses: [], cooldowns: {} });
  if (id === "soaked") st.statuses = st.statuses.filter((s) => s.id !== "burning");
  const ex = st.statuses.find((s) => s.id === id);
  if (ex) ex.turns = Math.max(ex.turns, turns);
  else st.statuses.push({ id, turns });
  pushFx(f.x, f.y, STATUSES[id].name, STATUSES[id].color, gs.tick);
  return true;
}

/** Statuses currently on a combatant (for UI chips). */
export function statusesOf(gs: GameState, key: string): BStatus[] {
  return gs.fighters[key]?.statuses ?? [];
}

/* ----------------------------------- FX ------------------------------------- */

export interface LiveFx {
  id: number;
  x: number;
  y: number;
  text: string;
  color: string;
  tick: number;
}

let fxSeq = 0;
const liveFx: LiveFx[] = [];

function pushFx(x: number, y: number, text: string, color: string, tick: number): void {
  fxSeq += 1;
  liveFx.push({ id: fxSeq, x, y, text, color, tick });
  if (liveFx.length > 24) liveFx.splice(0, liveFx.length - 24);
}

/** Damage/heal popups still on screen for the given tick. */
export function activeFx(tick: number): LiveFx[] {
  return liveFx.filter((f) => tick - f.tick <= 1);
}

/* ------------------------------- Damage/heal -------------------------------- */

function damage(gs: GameState, f: Fighter, amount: number, color = "#ff6b5a"): void {
  if (f.side === "party") {
    const m = gs.party.find((p) => p.uid === f.key);
    if (m) m.hp = Math.max(0, m.hp - amount);
  } else {
    const c = f.creatureId ? gs.creatures[f.creatureId] : null;
    if (c) c.hpFrac = Math.max(0, c.hpFrac - amount / maxHpOf(f));
  }
  pushFx(f.x, f.y, `-${amount}`, color, gs.tick);
}

function heal(gs: GameState, f: Fighter, amount: number): number {
  const max = maxHpOf(f);
  const cur = hpOf(gs, f);
  const got = Math.min(max, cur + amount) - cur;
  if (got > 0) {
    if (f.side === "party") {
      const m = gs.party.find((p) => p.uid === f.key);
      if (m) m.hp = cur + got;
    } else {
      const c = f.creatureId ? gs.creatures[f.creatureId] : null;
      if (c) c.hpFrac = (cur + got) / max;
    }
    pushFx(f.x, f.y, `+${got}`, "#7be08a", gs.tick);
  }
  return got;
}

/* ----------------------------- Combat math (ported) -------------------------- */

const statsFor = (f: Fighter) => ({ atk: statOf(f.mon, "atk"), def: statOf(f.mon, "def"), agi: statOf(f.mon, "agi"), wis: statOf(f.mon, "wis") });

/** Dodge value (d20 must meet it after bonuses). Ported from the arena. */
export function dvOf(gs: GameState, f: Fighter): number {
  const s = statsFor(f);
  let dv = 6 + Math.floor(s.agi / 4);
  if (terrainAt(gs, f.x, f.y) === "tallgrass") dv += 2;
  if (hasStatus(gs, f.key, "wary")) dv += 3;
  if (hasStatus(gs, f.key, "veiled")) dv += 4;
  if (hasStatus(gs, f.key, "stunned") || hasStatus(gs, f.key, "rooted")) dv -= 3;
  if (timeOf(gs.tick).night && hasTrait(f, "night_eyes")) dv += 3;
  return dv;
}

/** Armor value resisting penetration rolls. Ported from the arena. */
export function avOf(gs: GameState, f: Fighter): number {
  const s = statsFor(f);
  let av = Math.floor(s.def / 5);
  if (hasStatus(gs, f.key, "shelled")) av += 4;
  if (hasTrait(f, "stoneskin")) av += 2;
  if (hasTrait(f, "slick")) av += 1;
  return av;
}

export function moveRange(gs: GameState, f: Fighter): number {
  if (hasStatus(gs, f.key, "rooted") || hasStatus(gs, f.key, "stunned")) return 0;
  const agi = statOf(f.mon, "agi");
  return clamp(2 + Math.floor(agi / 9), 2, 5) - (hasStatus(gs, f.key, "slowed") ? 1 : 0);
}

export function lineOfSightLive(gs: GameState, x0: number, y0: number, x1: number, y1: number): boolean {
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  while (!(x === x1 && y === y1)) {
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
    if (x === x1 && y === y1) break;
    if (BLOCKING.includes(terrainAt(gs, x, y))) return false;
  }
  return true;
}

interface HitResult {
  hit: boolean;
  crit: boolean;
  roll: number;
  bonus: number;
  dv: number;
}

function hitBonusFor(gs: GameState, a: Fighter, d: Fighter, sk: SkillDef): number {
  let bonus = sk.acc + Math.floor(statOf(a.mon, "agi") / 5);
  if (hasStatus(gs, a.key, "blinded")) bonus -= 5;
  if (timeOf(gs.tick).night && hasTrait(a, "night_eyes")) bonus += 3;
  if (terrainAt(gs, a.x, a.y) === "gloom" && sk.element !== "shadow") bonus -= 2;
  const regalNear = a.side === "party"
    ? gs.party.some((o) => {
        if (o.uid === a.key) return false;
        const p = partyPos(gs, o.uid);
        return SPECIES[o.speciesId].traits.includes("regal") && cheb(a.x, a.y, p.x, p.y) <= 1;
      })
    : nearbyCreatures(gs, a.x, a.y, 2).some((o) => o.id !== a.key && SPECIES[o.speciesId].traits.includes("regal") && cheb(a.x, a.y, o.x, o.y) <= 1);
  if (regalNear) bonus += 1;
  const w = getWorld(gs.seed).weather(a.x, a.y, gs.tick).id;
  if (w === "fog" && cheb(a.x, a.y, d.x, d.y) > 1) bonus -= 2;
  return bonus;
}

/** All wild creatures within `r` tiles of a point. */
export function nearbyCreatures(gs: GameState, x: number, y: number, r: number): WildCreature[] {
  const out: WildCreature[] = [];
  for (const id in gs.creatures) {
    const c = gs.creatures[id];
    if (cheb(c.x, c.y, x, y) <= r) out.push(c);
  }
  return out;
}

/* ---------------------------------- RNG ------------------------------------- */

const rollRng = (gs: GameState, purpose: string): Rng => new Rng(hash3(gs.seed, gs.tick, hashString(purpose), 0x5157));
const rint = (rng: Rng, a: number, z: number): number => a + Math.floor(rng.next() * (z - a + 1));
const dice = (rng: Rng, n: number, s: number): number => {
  let t = 0;
  for (let i = 0; i < n; i++) t += rint(rng, 1, s);
  return t;
};

/* ------------------------------ Ground overlay ------------------------------- */

const ORTHO: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/** Ticks fire on the live map: spread, rain dousing, burn-out to ash. */
export function groundTick(gs: GameState, world: World): void {
  const raining = ["rain", "storm", "snow"].includes(world.weather(gs.player.x, gs.player.y, gs.tick).id);
  const rng = new Rng(hash3(gs.seed, gs.tick, 0xf1a, 7));
  const keys = Object.keys(gs.ground);
  if (!keys.length) return;
  const igniteKeys: [number, number][] = [];
  for (const k of keys) {
    const g = gs.ground[k];
    if (!g.fire) continue;
    const [x, y] = k.split(",").map(Number);
    for (const [dx, dy] of ORTHO) {
      const nx = x + dx;
      const ny = y + dy;
      if (gs.ground[`${nx},${ny}`]?.fire) continue;
      const p = (FLAMMABLE[terrainAt(gs, nx, ny)] ?? 0) * (raining ? 0.25 : 1);
      if (p > 0 && rng.next() < p) igniteKeys.push([nx, ny]);
    }
    g.fire -= 1;
    if (raining && rng.next() < 0.4) g.fire = 0;
    if ((g.fire ?? 0) <= 0) {
      delete g.fire;
      const t = terrainAt(gs, x, y);
      if (t !== "water" && t !== "rock" && t !== "sand" && t !== "snow") ground(gs, x, y).t = "ash";
    }
  }
  if (Object.keys(gs.ground).length >= 4000) return;
  for (const [x, y] of igniteKeys) {
    const g = ground(gs, x, y);
    if (g.fire) continue;
    g.fire = terrainAt(gs, x, y) === "tree" ? 4 : 2;
  }
}

function igniteTiles(gs: GameState, world: World, tiles: [number, number][]): void {
  const raining = ["rain", "storm"].includes(world.weather(gs.player.x, gs.player.y, gs.tick).id);
  const rng = new Rng(hash3(gs.seed, gs.tick, 0x16e, 3));
  let lit = 0;
  for (const [x, y] of tiles) {
    const t = terrainAt(gs, x, y);
    if (!FLAMMABLE[t] || ground(gs, x, y).fire) continue;
    if (raining && rng.next() > 0.3) continue;
    ground(gs, x, y).fire = t === "tree" ? 4 : 3;
    lit++;
  }
  if (lit) addLog(gs, lit > 1 ? "The undergrowth catches fire!" : "The grass catches fire.", "bad");
}

function douseTiles(gs: GameState, tiles: [number, number][]): void {
  let n = 0;
  for (const [x, y] of tiles) {
    const g = gs.ground[`${x},${y}`];
    if (g?.fire) {
      delete g.fire;
      n++;
    }
  }
  if (n) addLog(gs, "The flames hiss out.", "info");
}

/** Tiles a radius skill affects around a center point. */
function affectedTiles(gs: GameState, a: Fighter, sk: SkillDef, tx: number, ty: number): [number, number][] {
  if (sk.radius <= 0) return [[tx, ty]];
  const cx = sk.target === "self" ? a.x : tx;
  const cy = sk.target === "self" ? a.y : ty;
  const out: [number, number][] = [];
  for (let y = cy - sk.radius; y <= cy + sk.radius; y++) {
    for (let x = cx - sk.radius; x <= cx + sk.radius; x++) {
      if (!getWorld(gs.seed).inBounds(x, y)) continue;
      if (sk.target === "self" && x === cx && y === cy && !sk.heal) continue;
      out.push([x, y]);
    }
  }
  return out;
}

/* -------------------------------- Engagement --------------------------------- */

/** Creatures hostile toward the party right now (stalking, or aggressive and unrested). */
export const isHostile = (gs: GameState, c: WildCreature): boolean => c.stalking || (c.disposition === "aggressive" && c.calmUntil <= gs.tick);

/** True while any stalker is within `r` tiles — drives battle music and travel stops. */
export function engagedNear(gs: GameState, r = 8): boolean {
  for (const id in gs.creatures) {
    const c = gs.creatures[id];
    if (c.stalking && cheb(c.x, c.y, gs.player.x, gs.player.y) <= r) return true;
  }
  return false;
}

/** Marks a creature as the party's target. */
export function setTarget(gs: GameState, creatureId: string | null): void {
  const c = creatureId ? gs.creatures[creatureId] : null;
  gs.target = c ? creatureId : null;
  if (c) {
    gs.seen[c.speciesId] = true;
    addLog(gs, `You point out the ${SPECIES[c.speciesId].name} to your monsters.`, "info");
  }
}

/** Sets a party monster's standing order. */
export function setOrder(gs: GameState, uid: string, order: FieldOrder): void {
  const m = gs.party.find((p) => p.uid === uid);
  if (!m) return;
  gs.orders[uid] = order;
  const label = order === "follow" ? "will follow you" : order === "hold" ? "holds this ground" : "will attack your target";
  addLog(gs, `${displayName(m)} ${label}.`, "info");
}

/** A party monster's aggression; a missing entry means "neutral". */
export const aggrOf = (gs: GameState, uid: string): Aggression => gs.aggr[uid] ?? "neutral";

/** Sets a monster's temperament: passive fights only when ordered, neutral defends within 6, aggressive hunts hostiles within 10. */
export function setAggr(gs: GameState, uid: string, a: Aggression): void {
  const m = gs.party.find((p) => p.uid === uid);
  if (!m) return;
  gs.aggr[uid] = a;
  const label = a === "passive" ? "will only fight when ordered" : a === "aggressive" ? "hunts nearby hostiles on its own" : "defends itself and you";
  addLog(gs, `${displayName(m)} ${label}.`, "info");
}

/** Queues a skill order: the monster paths into range over later turns, then unleashes the skill. */
export function queueSkill(gs: GameState, uid: string, skillId: string, target: string): void {
  const m = gs.party.find((p) => p.uid === uid);
  if (!m || !SKILLS[skillId] || !m.skills.includes(skillId)) return;
  gs.skillQ[uid] = { skill: skillId, target };
  addLog(gs, `${displayName(m)} readies ${SKILLS[skillId].name}.`, "info");
}

/**
 * Starts a live engagement: the creature becomes hostile, nearby packmates join,
 * and the party focuses it. Replaces the old arena handoff entirely.
 */
export function engage(gs: GameState, creatureId: string, ambush: boolean): void {
  const c = gs.creatures[creatureId];
  if (!c) return;
  const world = getWorld(gs.seed);
  c.stalking = true;
  gs.stats.battles += 1;
  gs.target = creatureId;
  gs.seen[c.speciesId] = true;
  const pack: WildCreature[] = [];
  // loyal packmates always answer: the engaged creature's minions, or its alpha
  for (const id in gs.creatures) {
    const o = gs.creatures[id];
    if (o === c || pack.includes(o)) continue;
    if (!(c.alpha && o.pack === c.id) && !(c.pack && (o.id === c.pack || o.pack === c.pack))) continue;
    if (cheb(o.x, o.y, c.x, c.y) > 7 || o.activity === "Sleeping") continue;
    o.stalking = true;
    gs.seen[o.speciesId] = true;
    pack.push(o);
  }
  for (const id in gs.creatures) {
    const o = gs.creatures[id];
    if (o === c || pack.length >= 2) continue;
    if (cheb(o.x, o.y, c.x, c.y) > 3) continue;
    const join = o.speciesId === c.speciesId || (o.disposition === "aggressive" && o.calmUntil <= gs.tick);
    if (join && o.activity !== "Sleeping") pack.push(o);
  }
  for (const o of pack) {
    o.stalking = true;
    gs.seen[o.speciesId] = true;
  }
  const names = [c, ...pack].map((o) => `${o.alpha ? "a great " : "a "}${SPECIES[o.speciesId].name} (Lv ${o.level})`);
  const time = timeOf(gs.tick);
  const where = `${world.regionName(c.x, c.y)} lands${time.night ? ", at night" : ""}`;
  addLog(
    gs,
    ambush ? `Ambush! ${names.join(" and ")} burst${names.length > 1 ? "" : "s"} from cover. ${where}.` : `You engage ${names.join(" and ")}. ${where}.`,
    ambush ? "bad" : "combat",
  );
}

/* --------------------------------- Outcomes ---------------------------------- */

const DROPS: Record<string, [ItemId, number]> = { Beast: ["meat", 0.5], Bug: ["ore", 0.3], Spirit: ["honeycomb", 0.3], Slime: ["herb", 0.35], Bird: ["meat", 0.3], Dragon: ["ore", 0.8], Brute: ["meat", 0.55] };

const ITEM_NAME: Record<ItemId, string> = {
  berries: "Wild Berries", nuts: "Raw Nuts", roasted_nuts: "Roasted Nuts", fish: "River Fish", meat: "Gamey Meat",
  herb: "Bitterleaf", mushroom: "Ghostcap", cactus_fruit: "Cactus Fruit", honeycomb: "Honeycomb", ore: "Glintstone", tonic: "Hearth Tonic",
};

/** A wild creature falls: removes it and pays out XP, gold and drops. */
function killWild(gs: GameState, f: Fighter): void {
  const c = f.creatureId ? gs.creatures[f.creatureId] : null;
  if (!c) return;
  const sp = SPECIES[c.speciesId];
  let pool = Math.round(sp.xp * (0.6 + c.level * 0.5));
  if (gs.player.origin === "scholar") pool = Math.round(pool * 1.2);
  const fighters = gs.party.filter((m) => m.hp > 0).length;
  const share = Math.ceil(pool / Math.max(1, fighters * 0.75));
  const rng = rollRng(gs, `${c.id}:gold`);
  const gold = rint(rng, 1, 3) * c.level;
  const drop = DROPS[sp.family];
  let dropTxt = "";
  if (drop && rng.next() < drop[1]) {
    gs.bag[drop[0]] = (gs.bag[drop[0]] ?? 0) + 1;
    dropTxt = ` Found ${ITEM_NAME[drop[0]]}.`;
  }
  gs.removed[c.id] = gs.tick;
  delete gs.creatures[c.id];
  delete gs.fighters[c.id];
  if (gs.target === c.id) gs.target = null;
  for (const m of gs.party) {
    if (m.hp <= 0) continue;
    for (const l of grantXp(m, share)) addLog(gs, l, "good");
    m.bond = Math.min(100, m.bond + 2);
    m.wins += 1;
    m.satiety = Math.max(0, m.satiety - 4);
  }
  gs.player.gold += gold;
  pushFx(f.x, f.y, "KO", "#f2c14e", gs.tick);
  addLog(gs, `The ${sp.name} collapses! +${pool} XP${gold ? `, ${gold} gold` : ""}.${dropTxt}`, "good");
  if (c.alpha) {
    // the pack loses its master: loyalty ends and the survivors scatter
    for (const id in gs.creatures) {
      const o = gs.creatures[id];
      if (o.pack !== c.id) continue;
      o.pack = undefined;
      o.disposition = "skittish";
      o.calmUntil = gs.tick + 240;
      o.stalking = false;
    }
    addLog(gs, "The lair falls quiet. Its pack scatters into the wilds.", "event");
  }
}

/** A party monster faints: it stays where it fell until revived. */
function faintParty(gs: GameState, f: Fighter): void {
  const m = gs.party.find((p) => p.uid === f.key);
  if (!m) return;
  m.hp = 0;
  delete gs.skillQ[f.key];
  addLog(gs, `${displayName(m)} faints!`, "bad");
}

/** Whole party down: wake up at home, bandaged. */
function checkDefeat(gs: GameState, world: World): void {
  if (gs.party.some((m) => m.hp > 0)) return;
  const lost = Math.floor(gs.player.gold / 2);
  gs.player.gold -= lost;
  const region = world.regionName(gs.player.x, gs.player.y);
  gs.player.x = gs.player.homeX;
  gs.player.y = gs.player.homeY;
  gs.tick += 96;
  for (const m of gs.party) m.hp = Math.max(1, Math.round(statOf(m, "hp") * 0.3));
  gs.target = null;
  for (const k in gs.fighters) delete gs.fighters[k];
  for (const id in gs.creatures) {
    const c = gs.creatures[id];
    if (c.stalking) {
      c.stalking = false;
      c.calmUntil = gs.tick + 72;
    }
  }
  initField(gs);
  loadChunks(gs);
  addLog(gs, `You wake in ${gs.player.homeName}, bandaged. A farmer found you in the ${region} lands. ${lost ? `Your purse is ${lost} gold lighter.` : ""}`, "bad");
}

/* --------------------------------- Movement ---------------------------------- */

type Occ = Map<number, string>;

const occKey = (x: number, y: number): number => y * WORLD_SIZE + x;

/** Builds an occupancy map of wild bodies, party bodies and the player. */
export function buildOcc(gs: GameState, r: number): Occ {
  const occ: Occ = new Map();
  const px = gs.player.x;
  const py = gs.player.y;
  occ.set(occKey(px, py), "player");
  for (const id in gs.creatures) {
    const c = gs.creatures[id];
    if (cheb(c.x, c.y, px, py) > r) continue;
    const fp = footprintOf(SPECIES[c.speciesId]);
    for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) occ.set(occKey(c.x + dx, c.y + dy), c.id);
  }
  for (const m of gs.party) {
    const pos = gs.field[m.uid];
    if (!pos) continue;
    const fp = getMonsterFootprint(m);
    for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) occ.set(occKey(pos.x + dx, pos.y + dy), `p:${m.uid}`);
  }
  return occ;
}

const bodyBlocked = (occ: Occ, key: string, x: number, y: number, fp: number): boolean => {
  for (let dy = 0; dy < fp; dy++) {
    for (let dx = 0; dx < fp; dx++) {
      const o = occ.get(occKey(x + dx, y + dy));
      if (o && o !== key && o !== `p:${key}`) return true;
    }
  }
  return false;
};

/** One-step movement rules on the live map, matching world traversal. */
function canStep(gs: GameState, occ: Occ, who: string, fp: number, speciesId: string, x: number, y: number): boolean {
  const world = getWorld(gs.seed);
  const sp = SPECIES[speciesId];
  for (let dy = 0; dy < fp; dy++) {
    for (let dx = 0; dx < fp; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (!world.inBounds(tx, ty)) return false;
      if (tx === gs.player.x && ty === gs.player.y) return false;
      const t = world.tile(tx, ty);
      if (!PASSABLE_BIOMES.includes(t.biome)) return false;
      if (t.biome === "river" && sp.fears === "water" && !sp.traits.includes("flutter")) return false;
      if (world.siteAt(tx, ty)?.wall) return false;
      const isParty = who.startsWith("p:");
      if (t.feature?.kind === "hamlet") {
        // wild creatures never enter hamlets; party monsters follow you in
        if (!isParty) return false;
      }
    }
  }
  return !bodyBlocked(occ, who, x, y, fp);
}

function stepCost(gs: GameState, speciesId: string, x: number, y: number): number {
  const t = terrainAt(gs, x, y);
  const sp = SPECIES[speciesId];
  if (sp.traits.includes("flutter")) return 1;
  if (t === "mud") return 2;
  if (t === "snow" && !sp.traits.includes("frost_coat")) return 2;
  if (t === "water") return sp.swims ? 1 : 2;
  return 1;
}

/** BFS of tiles reachable this tick with movement cost. */
function reachable(gs: GameState, occ: Occ, f: Fighter): Map<number, number> {
  const out = new Map<number, number>();
  const range = moveRange(gs, f);
  out.set(occKey(f.x, f.y), 0);
  if (range <= 0) return out;
  const q: [number, number, number][] = [[f.x, f.y, 0]];
  const who = f.side === "party" ? `p:${f.key}` : f.key;
  while (q.length) {
    const [x, y, c] = q.shift() as [number, number, number];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!canStep(gs, occ, who, f.fp, f.mon.speciesId, nx, ny)) continue;
        const nc = c + stepCost(gs, f.mon.speciesId, nx, ny);
        if (nc > range) continue;
        const k = occKey(nx, ny);
        if ((out.get(k) ?? 99) <= nc) continue;
        out.set(k, nc);
        q.push([nx, ny, nc]);
      }
    }
  }
  return out;
}

function moveTo(gs: GameState, f: Fighter, x: number, y: number, occ: Occ): void {
  if (f.side === "party") {
    const m = gs.party.find((p) => p.uid === f.key);
    if (m) {
      const old = gs.field[m.uid];
      if (old) for (let dy = 0; dy < f.fp; dy++) for (let dx = 0; dx < f.fp; dx++) occ.delete(occKey(old.x + dx, old.y + dy));
      gs.field[m.uid] = { x, y };
      for (let dy = 0; dy < f.fp; dy++) for (let dx = 0; dx < f.fp; dx++) occ.set(occKey(x + dx, y + dy), `p:${m.uid}`);
    }
  } else {
    const c = f.creatureId ? gs.creatures[f.creatureId] : null;
    if (c) {
      for (let dy = 0; dy < f.fp; dy++) for (let dx = 0; dx < f.fp; dx++) occ.delete(occKey(c.x + dx, c.y + dy));
      c.x = x;
      c.y = y;
      for (let dy = 0; dy < f.fp; dy++) for (let dx = 0; dx < f.fp; dx++) occ.set(occKey(c.x + dx, c.y + dy), c.id);
    }
  }
  f.x = x;
  f.y = y;
  if (terrainAt(gs, x, y) === "water" && !hasStatus(gs, f.key, "soaked")) addStatus(gs, f, "soaked", 2);
}

/* ------------------------------- Turn engine --------------------------------- */

/** Start-of-action upkeep: terrain, statuses, cooldowns. Returns false when stunned. */
function startOfAction(gs: GameState, world: World, f: Fighter): boolean {
  const t = terrainAt(gs, f.x, f.y);
  if (gs.ground[`${f.x},${f.y}`]?.fire) addStatus(gs, f, "burning", 2);
  if (t === "water" && !hasStatus(gs, f.key, "soaked")) addStatus(gs, f, "soaked", 2);
  const st = gs.fighters[f.key] ?? (gs.fighters[f.key] = { statuses: [], cooldowns: {} });
  for (const s of [...st.statuses]) {
    if (s.id === "burning") damage(gs, f, dice(rollRng(gs, `${f.key}:burn`), 1, 4) + 1, "#e8742a");
    else if (s.id === "poisoned") damage(gs, f, dice(rollRng(gs, `${f.key}:poison`), 1, 3), "#8bc34a");
    if (hpOf(gs, f) <= 0) return false;
  }
  const w = world.weather(f.x, f.y, gs.tick).id;
  if (hasTrait(f, "photosynth") && !timeOf(gs.tick).night && w !== "storm") heal(gs, f, 2);
  if (hasTrait(f, "mossy_shell") && (w === "rain" || t === "grass" || t === "tallgrass")) heal(gs, f, 1);
  for (const k of Object.keys(st.cooldowns)) st.cooldowns[k] = Math.max(0, st.cooldowns[k] - 1);
  const stunned = hasStatus(gs, f.key, "stunned");
  st.statuses = st.statuses.map((s) => ({ ...s, turns: s.turns - 1 } as BStatus)).filter((s) => s.turns > 0);
  if (stunned) {
    addLog(gs, `${nameOf(gs, f)} is stunned and loses its turn.`, "info");
    return false;
  }
  return true;
}

export const nameOf = (gs: GameState, f: Fighter): string => (f.side === "wild" ? `the ${displayName(f.mon)}` : displayName(f.mon));
const capName = (gs: GameState, f: Fighter): string => {
  const n = nameOf(gs, f);
  return n.charAt(0).toUpperCase() + n.slice(1);
};

function elementalMult(gs: GameState, a: Fighter, d: Fighter, sk: SkillDef): number {
  let m = elementMult(sk.element, SPECIES[d.mon.speciesId].element);
  if (sk.element !== "neutral" && sk.element === SPECIES[a.mon.speciesId].element) m *= 1.2;
  if (sk.element === "fire" && hasTrait(a, "sunborn")) m *= 1.25;
  if (sk.element === "fire" && hasStatus(gs, d.key, "soaked")) m *= 0.5;
  if (sk.element === "frost" && hasStatus(gs, d.key, "soaked")) m *= 1.5;
  if (sk.element === "frost" && hasTrait(d, "frost_coat")) m *= 0.5;
  const w = getWorld(gs.seed).weather(a.x, a.y, gs.tick).id;
  if ((w === "rain" || w === "storm") && sk.element === "fire") m *= 0.75;
  if ((w === "rain" || w === "storm") && sk.element === "water") m *= 1.15;
  if (w === "snow" && sk.element === "frost") m *= 1.15;
  return m;
}

function rollHit(gs: GameState, a: Fighter, d: Fighter, sk: SkillDef): HitResult {
  const rng = rollRng(gs, `${a.key}:hit`);
  const roll = rint(rng, 1, 20);
  const bonus = hitBonusFor(gs, a, d, sk);
  const dv = dvOf(gs, d);
  const crit = roll === 20;
  const hit = crit || (roll !== 1 && roll + bonus >= dv);
  return { hit, crit, roll, bonus, dv };
}

/** Pure to-hit info (no RNG) — used by the inspect card and parity checks. */
export function hitInfo(gs: GameState, a: Fighter, d: Fighter, skillId: string): { bonus: number; dv: number; chance: number } {
  const sk = SKILLS[skillId];
  const bonus = hitBonusFor(gs, a, d, sk);
  const dv = dvOf(gs, d);
  let n = 1;
  for (let r = 2; r <= 19; r++) if (r + bonus >= dv) n++;
  return { bonus, dv, chance: n / 20 };
}

function strike(gs: GameState, world: World, a: Fighter, d: Fighter, skillId: string, aoe: boolean): void {
  // provocation: a calm wild struck (or swung at) by the party turns and fights back
  if (a.side === "party" && d.side === "wild" && d.creatureId) {
    const c = gs.creatures[d.creatureId];
    if (c && !c.stalking) {
      c.stalking = true;
      gs.seen[c.speciesId] = true;
      addLog(gs, `The ${SPECIES[c.speciesId].name} turns on you!`, "combat");
    }
  }
  const sk = SKILLS[skillId];
  const h = rollHit(gs, a, d, sk);
  const hitText = `[${h.roll}${h.bonus >= 0 ? "+" : ""}${h.bonus} vs DV ${h.dv}]`;
  if (!h.hit) {
    addLog(gs, `${capName(gs, a)} ${sk.verb} ${nameOf(gs, d)} but misses. ${hitText}`, "info");
    pushFx(d.x, d.y, "miss", "#c9b99a", gs.tick);
  } else {
    let total = 0;
    let pens = 0;
    if (sk.dice[0] > 0) {
      const rng = rollRng(gs, `${a.key}:dmg`);
      let pv = Math.floor(statOf(a.mon, "atk") / 4) + sk.pen + (h.crit ? 2 : 0);
      const av = avOf(gs, d);
      const mult = elementalMult(gs, a, d, sk) * (aoe ? 0.85 : 1);
      for (let set = 0; set < 4; set++) {
        let got = 0;
        for (let i = 0; i < 3; i++) if (rint(rng, 1, 10) - 2 + pv > av) got++;
        if (got === 0) break;
        pens += 1;
        const raw = (h.crit && pens === 1 ? sk.dice[0] * sk.dice[1] : dice(rng, sk.dice[0], sk.dice[1])) + Math.floor(statOf(a.mon, "atk") / 8);
        total += Math.max(1, Math.round(raw * mult));
        if (got < 3) break;
        pv -= 3;
      }
      const em = elementMult(sk.element, SPECIES[d.mon.speciesId].element);
      const effTxt = em > 1 ? " It's super effective!" : em < 1 ? " It's resisted." : "";
      if (pens === 0) {
        addLog(gs, `${capName(gs, a)} ${sk.verb} ${nameOf(gs, d)}, but fails to penetrate its armor. ${hitText} [AV ${av}]`, "info");
        pushFx(d.x, d.y, "0", "#c9b99a", gs.tick);
      } else {
        addLog(gs, `${h.crit ? "Critical! " : ""}${capName(gs, a)} ${sk.verb} ${nameOf(gs, d)}${pens > 1 ? ` (x${pens})` : ""} for ${total}.${effTxt} ${hitText}`, "combat");
        damage(gs, d, total);
        if (sk.drain) {
          const got = heal(gs, a, Math.ceil(total / 2));
          if (got) addLog(gs, `${capName(gs, a)} drinks in ${got} HP.`, "good");
        }
        if (sk.range <= 1 && hasTrait(d, "thorny") && !aoe) {
          const t = dice(rollRng(gs, `${a.key}:thorns`), 1, 3);
          addLog(gs, `${capName(gs, a)} is pricked by thorns. (${t})`, "info");
          damage(gs, a, t);
        }
      }
    } else addLog(gs, `${capName(gs, a)} ${sk.verb} ${nameOf(gs, d)}. ${hitText}`, "info");
    if (sk.status && hpOf(gs, d) > 0) {
      const [st, chance, turns] = sk.status;
      const p = clamp(chance * (1 + (statOf(a.mon, "wis") - statOf(d.mon, "wis")) / 40), 0.05, 0.95);
      if (rollRng(gs, `${a.key}:status`).next() < p && addStatus(gs, d, st, turns)) addLog(gs, `${capName(gs, d)} is ${STATUSES[st].name.toLowerCase()}!`, "info");
    }
  }
  if (sk.ignite) {
    const tiles = sk.radius > 0 ? affectedTiles(gs, a, sk, d.x, d.y) : [[d.x, d.y] as [number, number]];
    igniteTiles(gs, world, tiles);
  }
  if (sk.element === "water" || sk.element === "frost" || skillId === "cyclone") douseTiles(gs, affectedTiles(gs, a, sk, d.x, d.y));
  if (skillId === "overgrowth") {
    for (const [x, y] of affectedTiles(gs, a, sk, d.x, d.y)) {
      const t = terrainAt(gs, x, y);
      if (t === "grass" || t === "ash" || t === "sand") ground(gs, x, y).t = "tallgrass";
    }
  }
  if (hpOf(gs, d) <= 0) onDown(gs, d);
  if (hpOf(gs, a) <= 0) onDown(gs, a);
}

function onDown(gs: GameState, f: Fighter): void {
  if (f.side === "wild") killWild(gs, f);
  else faintParty(gs, f);
}

/** Executes a skill at a fighter target (or self) from the live map. */
function useSkill(gs: GameState, world: World, occ: Occ, a: Fighter, skillId: string, everyone: Fighter[], d: Fighter | null): void {
  const sk = SKILLS[skillId];
  const st = gs.fighters[a.key] ?? (gs.fighters[a.key] = { statuses: [], cooldowns: {} });
  st.cooldowns[skillId] = sk.cooldown + 1;
  if (sk.dash && d) {
    const who = a.side === "party" ? `p:${a.key}` : a.key;
    let best: [number, number] | null = null;
    let bd = 99;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = d.x + dx;
        const ny = d.y + dy;
        if ((!dx && !dy) || !canStep(gs, occ, who, a.fp, a.mon.speciesId, nx, ny)) continue;
        const dd = distToBody(a, nx, ny);
        if (dd < bd) {
          bd = dd;
          best = [nx, ny];
        }
      }
    }
    if (best) {
      const path: [number, number][] = [];
      let cx = a.x;
      let cy = a.y;
      while (cx !== best[0] || cy !== best[1]) {
        cx += Math.sign(best[0] - cx);
        cy += Math.sign(best[1] - cy);
        path.push([cx, cy]);
      }
      moveTo(gs, a, best[0], best[1], occ);
      if (sk.ignite) igniteTiles(gs, world, path);
    }
  }
  if (sk.target === "self" && sk.selfStatus) addStatus(gs, a, sk.selfStatus[0], sk.selfStatus[1]);
  if (sk.heal) {
    const amt = sk.heal + Math.floor(statOf(a.mon, "wis") / 2);
    const tiles = affectedTiles(gs, a, sk, a.x, a.y);
    const healed = sk.radius > 0
      ? everyone.filter((t) => t.side === a.side && hpOf(gs, t) > 0 && tiles.some(([x, y]) => covers(t, x, y)))
      : [d ?? a];
    if (sk.target === "self" && sk.radius > 0 && !healed.includes(a)) healed.push(a);
    for (const t of healed) {
      heal(gs, t, amt);
      if (skillId === "mend" || skillId === "bloom") {
        const s = gs.fighters[t.key];
        if (s) s.statuses = s.statuses.filter((x) => x.id !== "poisoned" && x.id !== "burning");
      }
    }
    addLog(gs, `${capName(gs, a)} ${sk.verb} ${sk.radius > 0 ? "its allies" : nameOf(gs, healed[0] ?? a)}.`, "good");
    if (sk.selfStatus && sk.target !== "self") addStatus(gs, a, sk.selfStatus[0], sk.selfStatus[1]);
    return;
  }
  if (sk.target === "self" && sk.radius === 0) {
    addLog(gs, `${capName(gs, a)} ${sk.verb}.`, "info");
    return;
  }
  if (!d) return;
  const tiles = affectedTiles(gs, a, sk, d.x, d.y);
  const victims = everyone.filter((t) => t.side !== a.side && hpOf(gs, t) > 0 && tiles.some(([x, y]) => covers(t, x, y)));
  if (sk.radius > 0 && victims.length === 0) addLog(gs, `${capName(gs, a)} ${sk.verb} empty ground.`, "info");
  for (const v of victims) strike(gs, world, a, v, skillId, sk.radius > 0);
}

/* ----------------------------------- AI -------------------------------------- */

interface Plan {
  x: number;
  y: number;
  skill: string | null;
  target: Fighter | null;
  flee: boolean;
}

const avgDice = (sk: SkillDef): number => (sk.dice[0] * (sk.dice[1] + 1)) / 2;

/** Ported arena planner: picks the best position + skill against these foes. */
function planFor(gs: GameState, occ: Occ, a: Fighter, foes: Fighter[], allies: Fighter[]): Plan {
  const reach = reachable(gs, occ, a);
  const hpFrac = hpOf(gs, a) / maxHpOf(a);
  const timid = a.side === "wild" && (a.mon.personality === "timid" || a.mon.personality === "gentle") && hpFrac < 0.3;
  if (timid) {
    let far: Plan = { x: a.x, y: a.y, skill: null, target: null, flee: true };
    let fd = -1;
    for (const k of reach.keys()) {
      const x = k % WORLD_SIZE;
      const y = Math.floor(k / WORLD_SIZE);
      const d = Math.min(...foes.map((f) => distToBody(f, x, y)));
      if (d > fd) {
        fd = d;
        far = { x, y, skill: null, target: null, flee: true };
      }
    }
    return far;
  }
  const st = gs.fighters[a.key] ?? (gs.fighters[a.key] = { statuses: [], cooldowns: {} });
  const ready = a.mon.skills.filter((s) => SKILLS[s] && (st.cooldowns[s] ?? 0) <= 0);
  let bestScore = -1;
  let bestPlan: Plan = { x: a.x, y: a.y, skill: null, target: null, flee: false };
  for (const [k, cost] of reach) {
    const px = k % WORLD_SIZE;
    const py = Math.floor(k / WORLD_SIZE);
    const tilePenalty = (gs.ground[`${px},${py}`]?.fire ? 6 : 0) + cost * 0.05;
    for (const sid of ready) {
      const sk = SKILLS[sid];
      if (sk.heal) {
        const hurt = allies.filter((al) => hpOf(gs, al) / maxHpOf(al) < 0.5);
        if (!hurt.length) continue;
        if (sk.radius > 0) {
          const n = allies.filter((al) => distToBody(al, px, py) <= sk.radius && hpOf(gs, al) < maxHpOf(al)).length;
          const sc = n * 6 - tilePenalty;
          if (sc > bestScore) {
            bestScore = sc;
            bestPlan = { x: px, y: py, skill: sid, target: null, flee: false };
          }
        } else {
          for (const al of hurt) {
            if (sk.target === "self" && al !== a) continue;
            if (sk.target === "ally" && distToBody(al, px, py) > sk.range) continue;
            const sc = 9 + (1 - hpOf(gs, al) / maxHpOf(al)) * 8 - tilePenalty;
            if (sc > bestScore) {
              bestScore = sc;
              bestPlan = { x: px, y: py, skill: sid, target: al, flee: false };
            }
          }
        }
        continue;
      }
      if (sk.target === "self" && sk.radius === 0) {
        const threatened = foes.some((f) => distToBody(f, px, py) <= 1);
        const sc = threatened && hpFrac < 0.6 ? 5 - tilePenalty : -1;
        if (sc > bestScore) {
          bestScore = sc;
          bestPlan = { x: px, y: py, skill: sid, target: null, flee: false };
        }
        continue;
      }
      if (sk.target === "self") {
        const hit = foes.filter((f) => distToBody(f, px, py) <= sk.radius);
        const sc = hit.reduce((acc, f) => acc + (avgDice(sk) + 2) * elementMult(sk.element, SPECIES[f.mon.speciesId].element), 0) * 0.9 + (sk.status ? hit.length * 2 : 0) - tilePenalty;
        if (hit.length && sc > bestScore) {
          bestScore = sc;
          bestPlan = { x: px, y: py, skill: sid, target: null, flee: false };
        }
        continue;
      }
      if (sk.target === "tile") {
        for (const f of foes) {
          if (distToBody(f, px, py) > sk.range || !lineOfSightLive(gs, px, py, f.x, f.y)) continue;
          const hit = foes.filter((o) => distToBody(o, f.x, f.y) <= sk.radius);
          const sc = hit.reduce((acc, o) => acc + (avgDice(sk) + 2) * elementMult(sk.element, SPECIES[o.mon.speciesId].element), 0) * 0.85 + (sk.status ? hit.length * 2 : 0) - tilePenalty;
          if (sc > bestScore) {
            bestScore = sc;
            bestPlan = { x: px, y: py, skill: sid, target: f, flee: false };
          }
        }
        continue;
      }
      for (const f of foes) {
        const d = distToBody(f, px, py);
        if (d > sk.range || d === 0) continue;
        if (sk.range > 1 && !lineOfSightLive(gs, px, py, f.x, f.y)) continue;
        const dmg = (avgDice(sk) + statOf(a.mon, "atk") / 8) * elementMult(sk.element, SPECIES[f.mon.speciesId].element);
        const kill = dmg >= hpOf(gs, f) ? 8 : 0;
        const statusVal = sk.status && !hasStatus(gs, f.key, sk.status[0]) ? 3 * sk.status[1] * 2 : 0;
        const sc = dmg + kill + statusVal + (1 - hpOf(gs, f) / maxHpOf(f)) * 3 - tilePenalty - (sk.cooldown > 0 && dmg < 1 && !statusVal ? 5 : 0);
        if (sc > bestScore) {
          bestScore = sc;
          bestPlan = { x: px, y: py, skill: sid, target: f, flee: false };
        }
      }
    }
  }
  if (bestPlan.skill) return bestPlan;
  let mv: Plan = { x: a.x, y: a.y, skill: null, target: null, flee: false };
  let md = 99;
  for (const k of reach.keys()) {
    const x = k % WORLD_SIZE;
    const y = Math.floor(k / WORLD_SIZE);
    const d = Math.min(...foes.map((f) => distToBody(f, x, y))) + (gs.ground[`${x},${y}`]?.fire ? 5 : 0);
    if (d < md) {
      md = d;
      mv = { x, y, skill: null, target: null, flee: false };
    }
  }
  return mv;
}

/** Runs one fighter's autonomous combat turn. */
function act(gs: GameState, world: World, occ: Occ, a: Fighter, foes: Fighter[], allies: Fighter[]): void {
  if (hpOf(gs, a) <= 0) return;
  if (!startOfAction(gs, world, a)) return;
  const plan = planFor(gs, occ, a, foes, allies);
  const moved = plan.x !== a.x || plan.y !== a.y;
  if (moved) moveTo(gs, a, plan.x, plan.y, occ);
  if (plan.flee) {
    if (a.side === "wild" && a.creatureId && foes.every((f) => distToBody(f, a.x, a.y) > 6)) {
      const c = gs.creatures[a.creatureId];
      if (c) {
        c.stalking = false;
        c.calmUntil = gs.tick + 72;
        c.disposition = "skittish";
        addLog(gs, `${capName(gs, a)} turns tail and flees!`, "info");
      }
    }
    return;
  }
  if (plan.skill) {
    useSkill(gs, world, occ, a, plan.skill, [...allies, ...foes], plan.target);
    return;
  }
  addLog(gs, `${capName(gs, a)} ${moved ? "advances" : "holds its ground"}.`, "info");
}

/* ---------------------------- Party and wild turns --------------------------- */

/** Healthy party fighters (fresh views over current field positions). */
function activeParty(gs: GameState): Fighter[] {
  return gs.party.filter((m) => m.hp > 0).map((m) => partyFighter(gs, m));
}

/** Hostile wild creatures near a point, as fighters. */
function hostileFoes(gs: GameState, x: number, y: number, r: number): Fighter[] {
  const out: Fighter[] = [];
  for (const id in gs.creatures) {
    const c = gs.creatures[id];
    if (!isHostile(gs, c)) continue;
    if (cheb(c.x, c.y, x, y) > r) continue;
    out.push(wildFighter(gs, c));
  }
  return out;
}

const distToPlayer = (x: number, y: number, fp: number, px: number, py: number): number => {
  let d = 99;
  for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) d = Math.min(d, cheb(x + dx, y + dy, px, py));
  return d;
};

/** Resolves a skill-order target key: a party uid or a wild creature id. */
function fighterByKey(gs: GameState, key: string, party: Fighter[]): Fighter | null {
  const p = party.find((o) => o.key === key);
  if (p) return p;
  const c = gs.creatures[key];
  return c ? wildFighter(gs, c) : null;
}

/** One turn of pursuit: steps to the reachable tile that closes on the target the most. */
function stepToward(gs: GameState, occ: Occ, f: Fighter, d: Fighter): void {
  const reach = reachable(gs, occ, f);
  let best: [number, number] | null = null;
  let bd = bodyDist(f, d);
  for (const k of reach.keys()) {
    const x = k % WORLD_SIZE;
    const y = Math.floor(k / WORLD_SIZE);
    if (x === f.x && y === f.y) continue;
    const dd = distToBody(d, x, y);
    if (dd < bd) {
      bd = dd;
      best = [x, y];
    }
  }
  if (best) moveTo(gs, f, best[0], best[1], occ);
}

/** Party monsters act: fight hostiles, follow orders, trail the player. */
export function partyCombatTurn(gs: GameState, world: World, safe: boolean): void {
  ensureField(gs);
  const party = activeParty(gs);
  if (!party.length) {
    checkDefeat(gs, world);
    return;
  }
  const occ = buildOcc(gs, 26);
  for (const f of party) {
    if (!gs.party.some((m) => m.uid === f.key && m.hp > 0)) continue;
    const allies = party.filter((o) => o !== f);
    const order: FieldOrder = gs.orders[f.key] ?? "follow";
    const aggr = aggrOf(gs, f.key);
    // 1. Queued skill order: path into range, then unleash — explicit orders override temperament.
    const q = gs.skillQ[f.key];
    if (q) {
      const mon = gs.party.find((m) => m.uid === f.key)!;
      const sk = SKILLS[q.skill];
      const d = sk ? fighterByKey(gs, q.target, party) : null;
      const st = gs.fighters[f.key] ?? (gs.fighters[f.key] = { statuses: [], cooldowns: {} });
      if (!sk || !d || !mon.skills.includes(q.skill) || hpOf(gs, d) <= 0) {
        delete gs.skillQ[f.key];
      } else if ((st.cooldowns[q.skill] ?? 0) > 0) {
        // still recharging — fall through to normal behavior this turn
      } else if (bodyDist(f, d) <= sk.range) {
        const everyone = [...allies];
        for (const id in gs.creatures) {
          const c = gs.creatures[id];
          if (cheb(c.x, c.y, d.x, d.y) <= sk.radius + 2 && !everyone.some((e) => e.key === id)) everyone.push(wildFighter(gs, c));
        }
        useSkill(gs, world, occ, f, q.skill, everyone, d);
        delete gs.skillQ[f.key];
        continue;
      } else {
        stepToward(gs, occ, f, d);
        continue;
      }
    }
    // 2. Auto-engage nearby hostiles — passive never starts, aggressive roams wider.
    const foes = safe || aggr === "passive" ? [] : hostileFoes(gs, f.x, f.y, aggr === "aggressive" ? 10 : 6);
    if (foes.length) {
      act(gs, world, occ, f, foes, allies);
      continue;
    }
    if (order === "hold") continue;
    if (order === "attack" && gs.target) {
      const c = gs.creatures[gs.target];
      if (c && cheb(c.x, c.y, f.x, f.y) <= 14) {
        act(gs, world, occ, f, [wildFighter(gs, c)], allies);
        continue;
      }
    }
    // follow: trail the player at arm's length
    const fp = f.fp;
    const dp = distToPlayer(f.x, f.y, fp, gs.player.x, gs.player.y);
    if (dp <= 1) continue;
    const reach = reachable(gs, occ, f);
    let best: [number, number] | null = null;
    let bd = dp;
    for (const k of reach.keys()) {
      const x = k % WORLD_SIZE;
      const y = Math.floor(k / WORLD_SIZE);
      const d = distToPlayer(x, y, fp, gs.player.x, gs.player.y);
      if (d < bd) {
        bd = d;
        best = [x, y];
      }
    }
    if (best) moveTo(gs, f, best[0], best[1], occ);
  }
  checkDefeat(gs, world);
}

/** A hostile wild creature's combat turn (called from the wildlife sim). */
export function wildCombatTurn(gs: GameState, world: World, c: WildCreature, occ: Occ): void {
  if (!gs.party.some((m) => m.hp > 0)) return;
  const f = wildFighter(gs, c);
  const foes = activeParty(gs).filter((p) => distToBody(p, f.x, f.y) <= 8);
  if (!foes.length) return;
  act(gs, world, occ, f, foes, []);
  c.stalking = true;
}

/**
 * Places the party beside the player on open ground (new game, migration,
 * waking up at home). Huge bodies scan outward for a fully clear footprint.
 */
export function initField(gs: GameState): void {
  gs.field = {};
  gs.orders = {};
  const world = getWorld(gs.seed);
  const occ = buildOcc(gs, 10);
  for (const m of gs.party) {
    const fp = getMonsterFootprint(m);
    gs.orders[m.uid] = "follow";
    let placed: { x: number; y: number } | null = null;
    seek: for (let r = 1; r <= 8 && !placed; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = gs.player.x + dx;
          const y = gs.player.y + dy;
          let ok = true;
          for (let oy = 0; oy < fp && ok; oy++) {
            for (let ox = 0; ox < fp; ox++) {
              const tx = x + ox;
              const ty = y + oy;
              if (!world.inBounds(tx, ty)) {
                ok = false;
                break;
              }
              if (!PASSABLE_BIOMES.includes(world.tile(tx, ty).biome) || world.siteAt(tx, ty)?.wall || (tx === gs.player.x && ty === gs.player.y) || occ.has(occKey(tx, ty))) {
                ok = false;
                break;
              }
            }
          }
          if (ok) {
            placed = { x, y };
            break seek;
          }
        }
      }
    }
    gs.field[m.uid] = placed ?? { x: gs.player.x, y: gs.player.y };
    const pos = gs.field[m.uid];
    for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) occ.set(occKey(pos.x + dx, pos.y + dy), `p:${m.uid}`);
  }
}

/** Ensures every party member has a field position; drops departed ones. */
export function ensureField(gs: GameState): void {
  const inParty = new Set(gs.party.map((m) => m.uid));
  for (const k of Object.keys(gs.field)) if (!inParty.has(k)) delete gs.field[k];
  for (const m of gs.party) {
    if (!gs.field[m.uid]) {
      initField(gs);
      return;
    }
  }
}
