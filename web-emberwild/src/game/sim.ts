import { BIOMES, DAY_TICKS, ITEMS, footprintOf, ORIGINS, PARTY_MAX, PERSONALITIES, SHOP_STOCK, SPECIES, WORLD_SIZE } from "./data";
import { founderLineage, getMonsterFootprint, rollGenome, wildGenotypeFromSeed } from "./genetics";
import { engage, groundTick, initField, isHostile, partyCombatTurn, partyMonAt, wildCombatTurn } from "./combat";
import { getFactions } from "./factions";
import { discoverFeature, emptyKnowledge, ensureKnowledge, markRoute, updateKnowledge } from "./knowledge";
import { addLog, compass } from "./log";
import { createMonster, displayName, grantXp, performSynthesis, rollMutations, rollPersonality, statOf } from "./monster";
import { advanceReproduction, canReproduce, makeReproProfile, maturityFor, rollReproMode } from "./reproduction";
import { seesTile } from "./perception";
import { Rng, clamp, hash2, hash3, hashString } from "./rng";
import type { Disposition, GameState, ItemId, Monster, OriginId, WeatherId, WildCreature } from "./types";
import { SEASONS, type Feature, type World, getWorld, seasonIndex, seedFromText, timeOf } from "./world";

export { addLog, compass } from "./log";
export { sightRadius } from "./perception";

export const CHUNK = 16;
const LOAD_R = 3;
const SIM_R = 30;
export const SAVE_VERSION = 12;
export const PEN_MAX = 30;
export const INN_COST = 12;

const cheb = (ax: number, ay: number, bx: number, by: number): number => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/** Every tile a creature's body covers (huge creatures sweep 2×2). */
const coverOf = (c: WildCreature): [number, number][] => {
  const fp = footprintOf(SPECIES[c.speciesId]);
  const out: [number, number][] = [];
  for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) out.push([c.x + dx, c.y + dy]);
  return out;
};
const occAdd = (occ: Map<number, string>, c: WildCreature): void => {
  for (const [tx, ty] of coverOf(c)) occ.set(ty * WORLD_SIZE + tx, c.id);
};
const occDel = (occ: Map<number, string>, c: WildCreature): void => {
  for (const [tx, ty] of coverOf(c)) {
    const k = ty * WORLD_SIZE + tx;
    if (occ.get(k) === c.id) occ.delete(k);
  }
};

/* --------------------------------- New game --------------------------------- */

export function previewStarter(seedText: string, speciesId: string): Monster {
  const seed = seedFromText(seedText);
  const temp = { uidSeq: 0, tick: 0 } as GameState;
  return createMonster(temp, speciesId, 5, { seed: hash2(seed, hashString(speciesId), 7), origin: "Starter", mutations: [] });
}

export function newGame(seedText: string, name: string, origin: OriginId, scarf: string, starter: Monster): GameState {
  const seed = seedFromText(seedText);
  const world = getWorld(seed);
  const start = world.startPoint();
  const o = ORIGINS[origin];
  const state: GameState = {
    version: SAVE_VERSION,
    seedText: seedText.trim().toUpperCase(),
    seed,
    tick: 7 * 12,
    player: { name: name.trim() || "Rook", origin, scarf, x: start.x, y: start.y, gold: o.gold, homeX: start.x, homeY: start.y, homeName: start.name, fx: start.x, fy: start.y },
    party: [],
    pen: [],
    bag: { ...o.bag },
    creatures: {},
    loadedChunks: [],
    removed: {},
    depleted: {},
    log: [],
    logSeq: 0,
    seen: {},
    tamed: {},
    regions: {},
    lastWeather: "clear",
    lastRegion: "",
    lastNation: "",
    stats: { steps: 0, battles: 0, tamed: 0, synthesized: 0, foraged: 0 },
    field: {},
    orders: {},
    aggr: {},
    skillQ: {},
    target: null,
    ground: {},
    fighters: {},
    uidSeq: 1,
    knowledge: emptyKnowledge(),
  };
  const mon: Monster = { ...starter, uid: "m1", origin: `Raised in ${start.name}`, bond: 60, bornTick: 0 };
  state.party.push(mon);
  initField(state);
  state.seen[mon.speciesId] = true;
  state.tamed[mon.speciesId] = true;
  state.lastRegion = world.regionName(start.x, start.y);
  state.lastWeather = world.weather(start.x, start.y, state.tick).id;
  // the home nation is known from the first day
  const homeNat = getFactions(seed).nationAt(start.x, start.y);
  if (homeNat) {
    state.lastNation = homeNat.id;
    state.knowledge.nationsSeen[homeNat.id] = 1;
    addLog(state, `${start.name} answers to ${homeNat.title}.`, "system");
  }
  addLog(state, `Day 1, ${SEASONS[0]}. You set out from ${start.name} with ${displayName(mon)} at your side.`, "system");
  addLog(state, `World seed ${state.seedText}. Every hill, river and creature here will always be where it is now.`, "system");
  loadChunks(state);
  ensureKnowledge(state);
  const home = world.tile(start.x, start.y).feature;
  if (home) discoverFeature(state, home, false);
  updateKnowledge(state);
  return state;
}

/* ---------------------------------- Chunks ---------------------------------- */

const removedRecently = (state: GameState, id: string, days = 3): boolean => {
  const r = state.removed[id];
  return r !== undefined && state.tick - r < DAY_TICKS * days;
};

export function creatureAt(state: GameState, x: number, y: number): WildCreature | null {
  for (const id in state.creatures) {
    const c = state.creatures[id];
    if (c.x === x && c.y === y) return c;
    // multi-tile creatures (Large 2×2, Huge 3×3) block every tile of their body
    const fp = footprintOf(SPECIES[c.speciesId]);
    if (fp > 1 && x >= c.x && x < c.x + fp && y >= c.y && y < c.y + fp) return c;
  }
  return null;
}

const DANGER_BONUS: Partial<Record<string, number>> = { gloomwood: 3, mountain: 2, desert: 1, snow: 2, marsh: 1, tundra: 1 };

export function dangerLevel(world: World, x: number, y: number, biome: string, h: number): number {
  const s = world.startPoint();
  const d = Math.hypot(x - s.x, y - s.y);
  return clamp(1 + Math.floor(d / 70) + (d > 60 ? DANGER_BONUS[biome] ?? 0 : 0) + (h % 3), 1, 50);
}

function makeCreature(id: string, speciesId: string, x: number, y: number, level: number, h: number, alpha: boolean): WildCreature {
  const sp = SPECIES[speciesId];
  const rng = new Rng(h);
  const personality = rollPersonality(rng);
  const a = sp.aggression + PERSONALITIES[personality].aggression + (alpha ? 0.3 : 0);
  const r = rng.next();
  const disposition: Disposition = r < a ? "aggressive" : r < a + 0.22 ? "skittish" : r < a + 0.6 ? "curious" : "calm";
  return {
    id, speciesId, level, x, y, homeX: x, homeY: y, hpFrac: 1,
    satiety: Math.round(40 + rng.next() * 55), disposition, activity: "Wandering", personality,
    geneSeed: rng.int(1, 2_000_000_000),
    // explicit genotype is authoritative; geneSeed remains for legacy migration
    genes: rollGenome(rng, speciesId),
    gen: 1,
    lineageId: founderLineage(id),
    repro: makeReproProfile(rollReproMode(rng, speciesId), level, 0),
    calmUntil: 0, alpha, affection: 0, stalking: false,
  };
}

/** True when a footprint-sized area (2×2 for huge creatures) is open ground with no creatures. */
function fitsFootprint(state: GameState, world: World, x: number, y: number, fp: number): boolean {
  for (let dy = 0; dy < fp; dy++) {
    for (let dx = 0; dx < fp; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (!world.inBounds(tx, ty)) return false;
      const t = world.tile(tx, ty);
      if (!BIOMES[t.biome].passable || t.feature || world.siteAt(tx, ty)?.wall) return false;
      if (creatureAt(state, tx, ty) || (tx === state.player.x && ty === state.player.y)) return false;
      // party monsters are bodies on the map: nothing spawns inside them
      if (partyMonAt(state, tx, ty)) return false;
    }
  }
  return true;
}

/** How far a minion strays from its alpha before turning back, and how far it will chase an intruder. */
const PACK_LEASH = 5;
const PACK_GUARD_R = 6;

/** Spawns a lair's alpha and its loyal pack: a handful of the same species defending their master. */
export function spawnLairPack(state: GameState, world: World, f: Feature): void {
  const id = `l:${f.x}:${f.y}`;
  if (!f.speciesId || state.creatures[id] || removedRecently(state, id, 5)) return;
  const h = hash2(state.seed ^ 0x1a17, f.x, f.y);
  const lv = dangerLevel(world, f.x, f.y, world.tile(f.x, f.y).biome, 2) + 3;
  const fp = footprintOf(SPECIES[f.speciesId]);
  // the lair's own feature tile is den floor, and big bodies anchor toward the den's heart so they fit
  const off = Math.floor((fp - 1) / 2);
  const ax = f.x - off;
  const ay = f.y - off;
  const fitsDen = (x: number, y: number): boolean => {
    for (let dy = 0; dy < fp; dy++) {
      for (let dx = 0; dx < fp; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        if (!world.inBounds(tx, ty)) return false;
        const t = world.tile(tx, ty);
        if (!BIOMES[t.biome].passable || (t.feature && !(tx === f.x && ty === f.y)) || world.siteAt(tx, ty)?.wall) return false;
        if (creatureAt(state, tx, ty) || (tx === state.player.x && ty === state.player.y)) return false;
        if (partyMonAt(state, tx, ty)) return false;
      }
    }
    return true;
  };
  if (!fitsDen(ax, ay)) return;
  state.creatures[id] = makeCreature(id, f.speciesId, ax, ay, lv, h, true);
  // the pack: 3–5 den-mates ringed around their master, a level or two below
  const n = 3 + ((h >>> 7) % 3);
  const ring: [number, number][] = [];
  for (let r = 1; r <= 3; r++) {
    let cx = f.x - r;
    let cy = f.y - r;
    for (const [sx, sy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      for (let k = 0; k < 2 * r; k++) {
        ring.push([cx, cy]);
        cx += sx;
        cy += sy;
      }
    }
  }
  const rot = (h >>> 11) % ring.length;
  const ordered = [...ring.slice(rot), ...ring.slice(0, rot)];
  let viable = 0;
  for (const [mx, my] of ordered) {
    if (viable >= n) break;
    if (!fitsDen(mx, my)) continue;
    const mid = `${id}:${viable++}`;
    if (state.creatures[mid] || removedRecently(state, mid, 5)) continue;
    const m = makeCreature(mid, f.speciesId, mx, my, Math.max(1, lv - 1 - ((h >>> (13 + viable)) % 2)), hash2(state.seed ^ 0x6a6b, f.x * 7 + viable, f.y * 3 + viable), false);
    m.pack = id;
    m.disposition = "aggressive";
    state.creatures[mid] = m;
  }
}

function spawnChunk(state: GameState, world: World, cx: number, cy: number): void {
  for (let i = 0; i < 7; i++) {
    const h = hash3(state.seed ^ 0x5eed, cx, cy, i);
    const x = cx * CHUNK + (h % CHUNK);
    const y = cy * CHUNK + ((h >>> 8) % CHUNK);
    if (!world.inBounds(x, y)) continue;
    const t = world.tile(x, y);
    const b = BIOMES[t.biome];
    if (!b.passable || t.feature || world.siteAt(x, y)?.wall) continue;
    if (((h >>> 16) & 1023) / 1024 > b.density * 0.45) continue;
    const id = `c:${cx}:${cy}:${i}`;
    if (removedRecently(state, id) || state.creatures[id]) continue;
    const sp = world.pickSpecies(t.biome, hash3(state.seed ^ 0x5bec, cx, cy, i));
    if (!sp) continue;
    if (creatureAt(state, x, y) || (x === state.player.x && y === state.player.y)) continue;
    const fp = footprintOf(SPECIES[sp]);
    if (fp > 1 && !fitsFootprint(state, world, x, y, fp)) continue;
    const lv = dangerLevel(world, x, y, t.biome, h >>> 22);
    state.creatures[id] = makeCreature(id, sp, x, y, lv, h, false);
  }
  for (const f of world.featuresNear(cx * CHUNK + 8, cy * CHUNK + 8, 8)) {
    if (f.kind !== "lair" || !f.speciesId) continue;
    if (Math.floor(f.x / CHUNK) !== cx || Math.floor(f.y / CHUNK) !== cy) continue;
    spawnLairPack(state, world, f);
  }
}

export function loadChunks(state: GameState): void {
  const world = getWorld(state.seed);
  const pcx = Math.floor(state.player.x / CHUNK);
  const pcy = Math.floor(state.player.y / CHUNK);
  const want = new Set<string>();
  for (let dy = -LOAD_R; dy <= LOAD_R; dy++) for (let dx = -LOAD_R; dx <= LOAD_R; dx++) want.add(`${pcx + dx},${pcy + dy}`);
  const loaded = new Set(state.loadedChunks);
  for (const k of want) {
    if (loaded.has(k)) continue;
    const [cx, cy] = k.split(",").map(Number);
    if (cx < 0 || cy < 0) continue;
    spawnChunk(state, world, cx, cy);
  }
  const keep: string[] = [];
  const drop = new Set<string>();
  for (const k of loaded) {
    if (want.has(k)) continue;
    const [cx, cy] = k.split(",").map(Number);
    if (cheb(cx, cy, pcx, pcy) <= LOAD_R + 1) keep.push(k);
    else drop.add(k);
  }
  if (drop.size) {
    for (const id in state.creatures) {
      const c = state.creatures[id];
      if (drop.has(`${Math.floor(c.homeX / CHUNK)},${Math.floor(c.homeY / CHUNK)}`)) delete state.creatures[id];
    }
  }
  state.loadedChunks = [...want, ...keep];
}

/* -------------------------------- Simulation -------------------------------- */

export function isAwake(c: WildCreature, hour: number, weather: WeatherId): boolean {
  const sp = SPECIES[c.speciesId];
  if (c.satiety < 18) return true;
  let awake: boolean;
  if (sp.activity === "diurnal") awake = hour >= 6 && hour < 20;
  else if (sp.activity === "nocturnal") awake = hour >= 19 || hour < 6;
  else awake = (hour >= 4 && hour < 10) || (hour >= 16 && hour < 24);
  if (awake && weather === "storm" && !c.alpha && c.personality !== "brave") return false;
  return awake;
}

const isPredatorOf = (a: WildCreature, b: WildCreature): boolean => {
  const sa = SPECIES[a.speciesId];
  const sb = SPECIES[b.speciesId];
  if (a.speciesId === b.speciesId || b.alpha) return false;
  if (sa.diet === "carnivore" || (sa.diet === "omnivore" && a.satiety < 25)) return sa.size >= sb.size && a.level + 2 >= b.level;
  return false;
};

function simWildlife(state: GameState, world: World, safe: boolean): void {
  const time = timeOf(state.tick);
  const px = state.player.x;
  const py = state.player.y;
  const weather = world.weather(px, py, state.tick).id;
  const occ = new Map<number, string>();
  const near: WildCreature[] = [];
  for (const id in state.creatures) {
    const c = state.creatures[id];
    occAdd(occ, c);
    if (cheb(c.x, c.y, px, py) <= SIM_R) near.push(c);
  }
  // party monsters are bodies on the map: creatures path around them
  for (const m of state.party) {
    const pos = state.field[m.uid];
    if (!pos) continue;
    const fp = getMonsterFootprint(m);
    for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) occ.set((pos.y + dy) * WORLD_SIZE + pos.x + dx, `p:${m.uid}`);
  }
  const onHamlet = world.tile(px, py).feature?.kind === "hamlet";

  const canEnter = (c: WildCreature, x: number, y: number): boolean => {
    const sp = SPECIES[c.speciesId];
    const fp = footprintOf(sp);
    for (let dy = 0; dy < fp; dy++) {
      for (let dx = 0; dx < fp; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        if (!world.inBounds(tx, ty)) return false;
        if (tx === px && ty === py) return false;
        const o = occ.get(ty * WORLD_SIZE + tx);
        if (o && o !== c.id) return false;
        const t = world.tile(tx, ty);
        if (t.biome === "deep" || t.biome === "peak") return false;
        if ((t.biome === "sea" || t.biome === "lake") && !sp.swims) return false;
        if (t.biome === "river" && sp.fears === "water" && !sp.traits.includes("flutter")) return false;
        if (t.feature?.kind === "hamlet") return false;
        if (world.siteAt(tx, ty)?.wall) return false;
      }
    }
    return true;
  };
  const moveTo = (c: WildCreature, x: number, y: number): void => {
    occDel(occ, c);
    c.x = x;
    c.y = y;
    occAdd(occ, c);
  };
  const stepToward = (c: WildCreature, tx: number, ty: number, away: boolean): boolean => {
    const cur = Math.hypot(tx - c.x, ty - c.y);
    let best: [number, number] | null = null;
    let bestD = cur;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = c.x + dx;
        const ny = c.y + dy;
        if (!canEnter(c, nx, ny)) continue;
        const d = Math.hypot(tx - nx, ty - ny);
        if (away ? d > bestD : d < bestD) {
          bestD = d;
          best = [nx, ny];
        }
      }
    }
    if (best) moveTo(c, best[0], best[1]);
    return !!best;
  };

  for (const c of near) {
    if (!state.creatures[c.id]) continue;
    const sp = SPECIES[c.speciesId];
    const rng = new Rng(hash3(state.seed, state.tick, hashString(c.id), 0x51));
    c.satiety = Math.max(0, c.satiety - 0.3);
    if (c.hpFrac < 1) c.hpFrac = Math.min(1, c.hpFrac + 0.004);
    if (c.satiety <= 0) {
      c.hpFrac -= 0.01;
      if (c.hpFrac <= 0) {
        state.removed[c.id] = state.tick;
        delete state.creatures[c.id];
        occDel(occ, c);
        if (cheb(c.x, c.y, px, py) <= 10) addLog(state, `A starving ${sp.name} collapses ${compass(c.x - px, c.y - py)} and does not rise.`, "bad");
        continue;
      }
    }
    const tile = world.tile(c.x, c.y);
    const cost = BIOMES[tile.biome].cost;
    const speed = Math.min(0.85, 0.28 + sp.base.agi / 34) / (sp.traits.includes("flutter") ? 1 : Math.max(1, cost * 0.75));
    const moves = rng.next() < speed;
    const ccov = coverOf(c);
    const dPlayer = Math.min(...ccov.map(([tx, ty]) => cheb(tx, ty, px, py)));
    // distance to the nearest party body (party monsters are real combatants)
    let dParty = 99;
    for (const m of state.party) {
      const pos = state.field[m.uid];
      if (!pos || m.hp <= 0) continue;
      const fp = getMonsterFootprint(m);
      for (let oy = 0; oy < fp; oy++) for (let ox = 0; ox < fp; ox++) for (const [tx, ty] of ccov) dParty = Math.min(dParty, cheb(tx, ty, pos.x + ox, pos.y + oy));
    }

    if (!isAwake(c, time.hour, weather)) {
      c.activity = weather === "storm" && sp.activity !== "nocturnal" ? "Sheltering from the storm" : "Sleeping";
      c.stalking = false;
      if (dPlayer <= 1 && c.disposition === "aggressive" && rng.chance(0.08)) c.activity = "Stirring";
      continue;
    }

    let threat: WildCreature | null = null;
    for (const o of near) {
      if (o === c || !state.creatures[o.id]) continue;
      if (cheb(o.x, o.y, c.x, c.y) <= 4 && isPredatorOf(o, c) && o.satiety < 50) {
        threat = o;
        break;
      }
    }
    if (threat) {
      c.activity = `Fleeing from a ${SPECIES[threat.speciesId].name}`;
      if (rng.chance(0.85)) stepToward(c, threat.x, threat.y, true);
      continue;
    }

    // pack life: loyal minions defend their alpha and keep to its side
    if (c.pack) {
      const alpha = state.creatures[c.pack];
      if (!alpha) {
        // the alpha has fallen: loyalty ends, the minion scatters
        c.pack = undefined;
        c.disposition = "skittish";
        c.calmUntil = Math.max(c.calmUntil, state.tick + 240);
        c.stalking = false;
        c.activity = "Scattering";
        continue;
      }
      const dAlpha = cheb(c.x, c.y, alpha.x, alpha.y);
      let ix = px;
      let iy = py;
      let ad = cheb(alpha.x, alpha.y, px, py);
      for (const m of state.party) {
        const pos = state.field[m.uid];
        if (!pos || m.hp <= 0) continue;
        const d = cheb(alpha.x, alpha.y, pos.x, pos.y);
        if (d < ad) {
          ad = d;
          ix = pos.x;
          iy = pos.y;
        }
      }
      const alphaFight = alpha.stalking || !!state.fighters[alpha.id];
      if ((alphaFight || ad <= 2) && c.satiety > 10) {
        c.stalking = true;
        c.activity = "Guarding its alpha";
        if (dAlpha > PACK_GUARD_R) {
          if (moves) stepToward(c, alpha.x, alpha.y, false);
        } else if (cheb(c.x, c.y, ix, iy) <= 1) {
          if (!safe) wildCombatTurn(state, world, c, occ);
        } else if (moves || rng.chance(0.4)) stepToward(c, ix, iy, false);
        continue;
      }
      if (dAlpha > PACK_LEASH) {
        c.activity = "Loyal to its alpha";
        if (moves) stepToward(c, alpha.x, alpha.y, false);
        continue;
      }
    }

    let sight = time.night ? (sp.traits.includes("night_eyes") ? 6 : 3) : 5;
    if (weather === "fog" || weather === "sandstorm") sight -= 2;
    if (state.player.origin === "ranger") sight -= 1;
    const calm = c.calmUntil > state.tick;
    const disp: Disposition = calm ? "calm" : c.disposition;

    if (dPlayer <= sight && !onHamlet) {
      if (disp === "aggressive" && (c.satiety < 70 || c.alpha || c.personality === "fierce" || c.personality === "brave")) {
        if (!c.stalking) {
          c.stalking = true;
          addLog(state, `A ${c.alpha ? "great " : ""}${sp.name} has noticed you ${compass(c.x - px, c.y - py)}. ${c.satiety < 40 ? "It looks hungry." : "Its hackles rise."}`, "bad");
          // the alpha commands its pack much like the player commands their monsters
          if (c.alpha) {
            let called = 0;
            for (const o of near) {
              if (o.pack === c.id && state.creatures[o.id]) {
                o.stalking = true;
                called++;
              }
            }
            if (called) addLog(state, `The great ${sp.name} bellows a command — its pack closes in around you!`, "bad");
          }
        }
        c.activity = "Stalking you";
        if (dPlayer <= 1 || dParty <= 1) {
          if (!safe) wildCombatTurn(state, world, c, occ);
          continue;
        }
        if (c.alpha && cheb(c.x, c.y, c.homeX, c.homeY) > 5) {
          stepToward(c, c.homeX, c.homeY, false);
          c.activity = "Guarding its lair";
        } else if (moves || rng.chance(0.4)) stepToward(c, px, py, false);
        continue;
      }
      c.stalking = false;
      if (disp === "skittish") {
        c.activity = "Keeping its distance";
        if (dPlayer <= 3 && moves) stepToward(c, px, py, true);
        continue;
      }
      if (disp === "curious" && dPlayer > 2 && c.satiety > 30) {
        c.activity = "Watching you";
        if (moves && rng.chance(0.5)) stepToward(c, px, py, false);
        continue;
      }
      if (disp === "curious") c.activity = "Watching you";
    } else c.stalking = false;

    if (c.satiety < 45) {
      const diet = sp.diet;
      if (diet === "carnivore" || (diet === "omnivore" && c.satiety < 25)) {
        let prey: WildCreature | null = null;
        let pd = 7;
        for (const o of near) {
          if (o === c || !state.creatures[o.id]) continue;
          const d = cheb(o.x, o.y, c.x, c.y);
          if (d < pd && isPredatorOf(c, o)) {
            prey = o;
            pd = d;
          }
        }
        if (prey) {
          const pname = SPECIES[prey.speciesId].name;
          c.activity = `Hunting a ${pname}`;
          if (pd <= 1) {
            prey.hpFrac -= 0.3 + rng.next() * 0.35;
            if (prey.hpFrac <= 0) {
              state.removed[prey.id] = state.tick;
              delete state.creatures[prey.id];
              occDel(occ, prey);
              c.satiety = Math.min(100, c.satiety + 60);
              if (cheb(c.x, c.y, px, py) <= 12) addLog(state, `${compass(c.x - px, c.y - py).replace(/^to the/, "Off to the")}, a ${sp.name} catches a ${pname}. The struggle is brief.`, "event");
            } else if (cheb(c.x, c.y, px, py) <= 8 && rng.chance(0.4)) {
              addLog(state, `A ${sp.name} lunges at a ${pname}, which tears free and bolts.`, "event");
            }
          } else if (moves || rng.chance(0.5)) stepToward(c, prey.x, prey.y, false);
          continue;
        }
      }
      const item = world.forage(c.x, c.y, state.tick, state.depleted);
      if (item && ITEMS[item].diets.includes(diet)) {
        c.satiety = Math.min(100, c.satiety + 35);
        state.depleted[`${c.x},${c.y}`] = state.tick;
        c.activity = `Eating ${ITEMS[item].name.toLowerCase()}`;
        continue;
      }
      c.activity = diet === "carnivore" ? "Prowling for prey" : "Foraging";
      if (moves) {
        const dx = rng.int(-1, 1);
        const dy = rng.int(-1, 1);
        if ((dx || dy) && cheb(c.x + dx, c.y + dy, c.homeX, c.homeY) <= 14 && canEnter(c, c.x + dx, c.y + dy)) moveTo(c, c.x + dx, c.y + dy);
      }
      continue;
    }

    if (c.satiety > 75 && rng.chance(0.003) && !c.alpha && !c.pack) {
      let mate: WildCreature | null = null;
      let count = 0;
      for (const o of near) {
        if (o.speciesId !== c.speciesId || o === c || o.alpha || o.pack) continue;
        if (cheb(o.x, o.y, c.x, c.y) <= 8) count++;
        if (cheb(o.x, o.y, c.x, c.y) <= 1 && o.satiety > 70) mate = o;
      }
      if (mate && count < 4 && canReproduce(c, mate, state.tick).ok) {
        for (let dy = -1; dy <= 1; dy++) {
          let done = false;
          for (let dx = -1; dx <= 1; dx++) {
            if (canEnter(c, c.x + dx, c.y + dy)) {
              const id = `b:${state.tick}:${hashString(c.id) % 9973}`;
              const baby = makeCreature(id, c.speciesId, c.x + dx, c.y + dy, Math.max(1, Math.min(c.level, mate.level) - 2), hash3(state.seed, state.tick, c.x, c.y), false);
              baby.homeX = c.homeX;
              baby.homeY = c.homeY;
              baby.disposition = rng.chance(0.6) ? "curious" : "skittish";
              state.creatures[id] = baby;
              occAdd(occ, baby);
              c.satiety -= 30;
              mate.satiety -= 30;
              if (cheb(c.x, c.y, px, py) <= 12) addLog(state, `A pair of ${sp.name} nuzzle together. A tiny ${sp.name} tumbles into the world ${compass(c.x - px, c.y - py)}.`, "good");
              done = true;
              break;
            }
          }
          if (done) break;
        }
        c.activity = "Tending its young";
        continue;
      }
    }

    const leash = c.alpha ? 3 : 10;
    if (cheb(c.x, c.y, c.homeX, c.homeY) > leash) {
      c.activity = c.alpha ? "Returning to its lair" : "Heading home";
      if (moves) stepToward(c, c.homeX, c.homeY, false);
      continue;
    }
    if ((weather === "rain" || weather === "storm") && sp.element === "fire") {
      c.activity = "Sheltering from the rain";
      continue;
    }
    if (c.personality === "lazy" && rng.chance(0.6)) {
      c.activity = "Lazing about";
      continue;
    }
    if (c.activity !== "Watching you") c.activity = c.alpha ? "Guarding its lair" : rng.chance(0.3) ? "Grooming" : "Wandering";
    if (moves && rng.chance(0.6)) {
      const dx = rng.int(-1, 1);
      const dy = rng.int(-1, 1);
      if ((dx || dy) && cheb(c.x + dx, c.y + dy, c.homeX, c.homeY) <= leash && canEnter(c, c.x + dx, c.y + dy)) moveTo(c, c.x + dx, c.y + dy);
    }
  }
}

const PHASE_TEXT: Record<string, string> = {
  Dawn: "Dawn breaks. Birdsong rises, tentative at first.",
  Day: "The sun climbs high and warm.",
  Dusk: "The sun dips low. Shadows stretch long across the land.",
  Night: "Night falls. Something calls out in the dark, and something else answers.",
};

const WEATHER_TEXT: Record<WeatherId, string> = {
  clear: "The sky clears.",
  cloudy: "Clouds gather overhead.",
  rain: "Rain begins to fall.",
  storm: "Thunder rolls. A storm breaks overhead.",
  snow: "Snow begins to drift down.",
  fog: "Fog creeps in, thick and grey.",
  sandstorm: "A wall of sand howls across the dunes.",
};

/** Advances the world clock tick by tick, running wildlife and live combat. */
export function advance(state: GameState, ticks: number, safe = false): void {
  const world = getWorld(state.seed);
  for (let i = 0; i < ticks; i++) {
    const prev = timeOf(state.tick);
    const prevSeason = seasonIndex(state.tick);
    state.tick += 1;
    const time = timeOf(state.tick);
    for (const m of [...state.party]) {
      const before = m.satiety;
      m.satiety = Math.max(0, m.satiety - 0.08);
      if (before >= 25 && m.satiety < 25) addLog(state, `${displayName(m)}'s stomach growls. It needs to eat.`, "bad");
      if (m.satiety <= 0 && state.tick % 12 === 0 && m.hp > 1) m.hp -= 1;
    }
    if (prev.phase !== time.phase) addLog(state, PHASE_TEXT[time.phase], "weather");
    if (state.tick % DAY_TICKS === 0) {
      for (const k in state.removed) if (state.tick - state.removed[k] > DAY_TICKS * 6) delete state.removed[k];
      for (const k in state.depleted) if (!k.startsWith("ruin:") && state.tick - state.depleted[k] > DAY_TICKS * 3) delete state.depleted[k];
    }
    if (seasonIndex(state.tick) !== prevSeason) addLog(state, `${SEASONS[seasonIndex(state.tick)]} arrives. The land shifts with it.`, "system");
    if (state.tick % 4 === 0) {
      const w = world.weather(state.player.x, state.player.y, state.tick).id;
      if (w !== state.lastWeather) {
        const txt = w === "clear" && (state.lastWeather === "rain" || state.lastWeather === "storm") ? "The rain eases. The air smells of wet earth." : WEATHER_TEXT[w];
        addLog(state, txt, "weather");
        state.lastWeather = w;
      }
    }
    simWildlife(state, world, safe);
    // reproductive state follows simulation time: cooldowns tick down, development completes
    advanceReproduction(state);
    // the party fights back, follows orders and trails the player every tick
    partyCombatTurn(state, world, safe);
    groundTick(state, world);
  }
  updateKnowledge(state);
}

/** Can the player personally observe this tile right now (perception, not memory)? */
export function canSee(state: GameState, x: number, y: number): boolean {
  return seesTile(state, x, y);
}

/* --------------------------------- Actions ---------------------------------- */

export interface ActionResult {
  ok: boolean;
  /** A creature id the player bumped into (inspect it). */
  bumped?: string | null;
  /** A creature id now engaged in live combat (select + battle music). */
  engaged?: string | null;
}

const RESULT_NONE: ActionResult = { ok: false };
const RESULT_OK: ActionResult = { ok: true };

export function partyCanFight(state: GameState): boolean {
  return state.party.some((m) => m.hp > 0);
}

export function movePlayer(state: GameState, dx: number, dy: number): ActionResult {
  const world = getWorld(state.seed);
  const nx = state.player.x + dx;
  const ny = state.player.y + dy;
  if (!world.inBounds(nx, ny)) return RESULT_NONE;
  const sp = world.siteAt(nx, ny);
  if (sp?.wall) {
    addLog(
      state,
      sp.kind === "lair"
        ? "The den wall is too sheer to climb. There must be another way in."
        : sp.kind === "hamlet"
          ? "The hut wall blocks your way. Try the doorway."
          : "An old wall blocks your way. Parts of it have crumbled, though.",
      "info",
    );
    return RESULT_NONE;
  }
  const t = world.tile(nx, ny);
  if (!BIOMES[t.biome].passable) {
    addLog(state, t.biome === "peak" ? "The peak is sheer ice. You can't climb it." : "The water is too deep to cross.", "info");
    return RESULT_NONE;
  }
  const c = creatureAt(state, nx, ny);
  if (c) {
    const hostile = isHostile(state, c);
    if (!hostile) {
      const sp = SPECIES[c.speciesId];
      state.seen[c.speciesId] = true;
      addLog(state, `The ${sp.name} is in your way. It ${c.activity === "Sleeping" ? "is fast asleep" : c.disposition === "skittish" ? "flinches" : "tilts its head at you"}.`, "info");
      return { ...RESULT_NONE, bumped: c.id };
    }
    if (!partyCanFight(state)) {
      addLog(state, "Your monsters are too hurt to fight. Rest first.", "bad");
      return { ...RESULT_NONE, bumped: c.id };
    }
    engage(state, c.id, false);
    return { ok: true, engaged: c.id };
  }
  state.player.fx = state.player.x;
  state.player.fy = state.player.y;
  state.player.x = nx;
  state.player.y = ny;
  state.stats.steps += 1;
  markRoute(state);
  const region = world.regionName(nx, ny);
  if (region !== state.lastRegion) {
    state.lastRegion = region;
    addLog(state, `You enter the ${region} lands.`, "system");
  }
  // crossing a border teaches whose land this is
  const nat = getFactions(state.seed).nationAt(nx, ny);
  const nid = nat?.id ?? "";
  if (nid !== state.lastNation) {
    state.lastNation = nid;
    if (nat) {
      const learned = !state.knowledge.nationsSeen[nat.id];
      state.knowledge.nationsSeen[nat.id] = 1;
      addLog(state, learned ? `You have entered ${nat.title}.` : `You cross back into ${nat.title}.`, "system");
    } else addLog(state, "You leave all banners behind — unclaimed wilds.", "system");
  }
  if (t.feature) {
    const f = t.feature;
    const msg: Record<string, string> = {
      hamlet: `You arrive at ${f.name}. Smoke curls from the chimneys and a dog barks once.`,
      ruin: `You stand among the ${f.name}. The stones are cold, even in the sun.`,
      shrine: `The ${f.name} hums softly. Two roots twist around a mossy altar.`,
      lair: `You've found a ${f.name}. Bones and tufts of fur litter the ground.`,
    };
    addLog(state, msg[f.kind], "event");
  } else if (t.biome === "river" && state.stats.steps % 3 === 0) addLog(state, "You wade through the cold water.", "info");
  loadChunks(state);
  advance(state, BIOMES[t.biome].cost);
  return RESULT_OK;
}

export function waitTurn(state: GameState, ticks = 1): ActionResult {
  advance(state, ticks);
  return RESULT_OK;
}

export function forageHere(state: GameState): ActionResult {
  const world = getWorld(state.seed);
  const { x, y } = state.player;
  const item = world.forage(x, y, state.tick, state.depleted);
  if (!item) {
    addLog(state, "You search the ground but find nothing worth taking.", "info");
  } else {
    const n = state.player.origin === "herbalist" && item === "herb" ? 2 : 1 + (hash2(state.seed, state.tick, x) % 4 === 0 ? 1 : 0);
    state.bag[item] = (state.bag[item] ?? 0) + n;
    state.depleted[`${x},${y}`] = state.tick;
    state.stats.foraged += n;
    addLog(state, `You gather ${n > 1 ? `${n}× ` : ""}${ITEMS[item].name}.`, "good");
  }
  return waitTurn(state, 2);
}

function pickFoodFor(state: GameState, mon: Monster): ItemId | null {
  const sp = SPECIES[mon.speciesId];
  if ((state.bag[sp.likes] ?? 0) > 0 && ITEMS[sp.likes].food > 0) return sp.likes;
  let best: ItemId | null = null;
  let bestFood = 0;
  for (const [id, n] of Object.entries(state.bag) as [ItemId, number][]) {
    if (!n || id === "tonic" || (id === "ore" && sp.diet !== "lithovore")) continue;
    const it = ITEMS[id];
    if (!it.diets.includes(sp.diet)) continue;
    if (it.food > bestFood) {
      best = id;
      bestFood = it.food;
    }
  }
  return best;
}

/** Feeds or doses a party/pen monster with an item. */
export function useItemOn(state: GameState, mon: Monster, item: ItemId): string {
  if ((state.bag[item] ?? 0) <= 0) return "You don't have any.";
  const it = ITEMS[item];
  const sp = SPECIES[mon.speciesId];
  const name = displayName(mon);
  const maxHp = statOf(mon, "hp");
  state.bag[item] = (state.bag[item] ?? 0) - 1;
  if (item === "tonic") {
    mon.hp = Math.min(maxHp, mon.hp + it.heal);
    return `${name} drinks the Hearth Tonic and looks much better. (+${it.heal} HP)`;
  }
  const dietOk = it.diets.includes(sp.diet);
  if (!dietOk && it.heal <= 0) {
    state.bag[item] = (state.bag[item] ?? 0) + 1;
    return `${name} sniffs the ${it.name.toLowerCase()} and turns away. (${sp.diet})`;
  }
  const liked = sp.likes === item;
  const food = Math.round(it.food * (dietOk ? 1 : 0.4));
  mon.satiety = Math.min(100, mon.satiety + food);
  let heal = it.heal;
  let line = `${name} ${liked ? "devours" : dietOk ? "eats" : "reluctantly nibbles"} the ${it.name.toLowerCase()}`;
  if (item === "mushroom" && state.player.origin !== "herbalist" && hash2(state.seed, state.tick, mon.level) % 6 === 0) {
    heal = -5;
    line += ". It disagrees with it badly. (-5 HP)";
  } else {
    line += liked ? " happily! (Bond +6)" : ".";
    if (liked) mon.bond = Math.min(100, mon.bond + 6);
    else if (dietOk) mon.bond = Math.min(100, mon.bond + 1);
  }
  mon.hp = clamp(mon.hp + heal, 0, maxHp);
  if (mon.hp === 0) mon.hp = 1;
  return line;
}

export function campRest(state: GameState, hours: number): ActionResult {
  const world = getWorld(state.seed);
  if (world.tile(state.player.x, state.player.y).biome === "river") {
    addLog(state, "You can't make camp in the middle of a river.", "info");
    return RESULT_NONE;
  }
  const nuts = state.bag.nuts ?? 0;
  if (nuts > 0) {
    state.bag.nuts = 0;
    state.bag.roasted_nuts = (state.bag.roasted_nuts ?? 0) + nuts;
    addLog(state, `You build a small fire and roast ${nuts} handful${nuts > 1 ? "s" : ""} of nuts. The smell carries.`, "good");
  } else addLog(state, "You build a small fire and settle in.", "info");
  const rate = state.player.origin === "wanderer" ? 0.12 : 0.08;
  for (let h = 0; h < hours; h++) {
    advance(state, 12);
    for (const m of state.party) {
      const max = statOf(m, "hp");
      if (m.hp > 0 || h >= 3) m.hp = Math.min(max, Math.max(m.hp, 0) + Math.ceil(max * rate));
    }
    if (partyCanFight(state)) {
      const raider = Object.values(state.creatures).find(
        (o) => o.disposition === "aggressive" && o.calmUntil <= state.tick && cheb(o.x, o.y, state.player.x, state.player.y) <= 2 && isAwake(o, timeOf(state.tick).hour, world.weather(state.player.x, state.player.y, state.tick).id),
      );
      if (raider) {
        addLog(state, "You wake to snapping twigs. Something has found your camp!", "bad");
        engage(state, raider.id, true);
        return { ok: true, engaged: raider.id };
      }
    }
  }
  for (const m of state.party) {
    if (m.satiety < 55) {
      const food = pickFoodFor(state, m);
      if (food) addLog(state, useItemOn(state, m, food), "good");
      else addLog(state, `${displayName(m)} looks at you hungrily. You have nothing it can eat.`, "bad");
    }
  }
  addLog(state, `You break camp, rested. (${hours}h)`, "system");
  return RESULT_OK;
}

export function hoursUntilDawn(tick: number): number {
  const t = timeOf(tick);
  const h = t.hour;
  return h < 6 ? 6 - h : 24 - h + 6;
}

export function innRest(state: GameState): string {
  if (state.player.gold < INN_COST) return "You can't afford a room.";
  state.player.gold -= INN_COST;
  advance(state, hoursUntilDawn(state.tick) * 12, true);
  for (const m of [...state.party, ...state.pen]) {
    m.hp = statOf(m, "hp");
    m.satiety = Math.max(m.satiety, 85);
  }
  addLog(state, "You sleep soundly at the inn. Your monsters are fed, healed and fussed over.", "good");
  return "Rested at the inn.";
}

export function buyItem(state: GameState, item: ItemId): string {
  const price = Math.ceil(ITEMS[item].value * 1.5);
  if (state.player.gold < price) return "Not enough gold.";
  state.player.gold -= price;
  state.bag[item] = (state.bag[item] ?? 0) + 1;
  return `Bought ${ITEMS[item].name} for ${price}g.`;
}

export function sellItem(state: GameState, item: ItemId): string {
  if ((state.bag[item] ?? 0) <= 0) return "Nothing to sell.";
  state.bag[item] = (state.bag[item] ?? 0) - 1;
  state.player.gold += ITEMS[item].value;
  return `Sold ${ITEMS[item].name} for ${ITEMS[item].value}g.`;
}

export { SHOP_STOCK };

export function searchRuin(state: GameState): ActionResult {
  const world = getWorld(state.seed);
  const f = world.tile(state.player.x, state.player.y).feature;
  if (!f || f.kind !== "ruin") return RESULT_NONE;
  const key = `ruin:${f.x},${f.y}`;
  if (state.depleted[key] !== undefined) {
    addLog(state, "You've already picked these ruins clean. Only dust and old echoes remain.", "info");
    return RESULT_NONE;
  }
  state.depleted[key] = state.tick;
  const rng = new Rng(hash2(state.seed ^ 0x2017, f.x, f.y));
  const gold = rng.int(15, 45);
  state.player.gold += gold;
  const loot: ItemId = rng.pick(["tonic", "ore", "honeycomb", "tonic", "ore"] as ItemId[]);
  state.bag[loot] = (state.bag[loot] ?? 0) + 1;
  addLog(state, `Beneath a cracked flagstone you find ${gold} gold and ${ITEMS[loot].name}.`, "good");
  if (rng.chance(0.4)) {
    const sp = rng.pick(["hollowcrow", "gloamoth", "cragjaw"]);
    const id = `g:${f.x}:${f.y}`;
    const lv = dangerLevel(world, f.x, f.y, "gloomwood", 1) + 1;
    const c = makeCreature(id, sp, f.x, f.y, lv, rng.int(1, 1e9), false);
    c.disposition = "aggressive";
    state.creatures[id] = c;
    addLog(state, `Something that was sleeping in the dark wakes up. A ${SPECIES[sp].name} unfolds from the shadows!`, "bad");
    if (partyCanFight(state)) {
      engage(state, id, true);
      return { ok: true, engaged: id };
    }
  }
  advance(state, 6);
  return RESULT_OK;
}

/** Offer food to an adjacent wild creature. May calm it, or win it over. */
export function offerFood(state: GameState, creatureId: string, item: ItemId): ActionResult {
  const c = state.creatures[creatureId];
  if (!c || (state.bag[item] ?? 0) <= 0) return RESULT_NONE;
  const sp = SPECIES[c.speciesId];
  const it = ITEMS[item];
  if (c.pack && state.creatures[c.pack]) {
    addLog(state, `The ${sp.name} looks to its alpha and refuses your offering.`, "info");
    advance(state, 1);
    return RESULT_OK;
  }
  state.bag[item] = (state.bag[item] ?? 0) - 1;
  state.seen[c.speciesId] = true;
  const liked = sp.likes === item;
  const dietOk = it.diets.includes(sp.diet);
  if (!dietOk) {
    addLog(state, `You toss the ${sp.name} some ${it.name.toLowerCase()}. It sniffs it and ignores it.`, "info");
    if (c.disposition === "aggressive" && c.calmUntil <= state.tick && partyCanFight(state)) {
      addLog(state, `The ${sp.name} takes it as an insult!`, "bad");
      engage(state, c.id, true);
      return { ok: true, engaged: c.id };
    }
    advance(state, 1);
    return RESULT_OK;
  }
  const gain = (liked ? 38 : 18) + (c.satiety < 40 ? 12 : 0) + (PERSONALITIES[c.personality].tame * 100) - (c.alpha ? 15 : 0);
  c.affection = Math.min(120, c.affection + Math.max(4, Math.round(gain)));
  c.satiety = Math.min(100, c.satiety + it.food);
  c.calmUntil = state.tick + 72;
  c.stalking = false;
  if (liked) addLog(state, `The ${sp.name} gobbles the ${it.name.toLowerCase()} and looks up at you, hopeful. It loves these!`, "good");
  else addLog(state, `The ${sp.name} eats the ${it.name.toLowerCase()} warily, watching you.`, "info");
  const rare = sp.rarity === "rare" || sp.rarity === "legendary";
  if (c.affection >= 100 && !c.alpha && !rare) {
    const mon = wildToMonster(state, c);
    mon.bond = 45;
    mon.origin = `Befriended with ${it.name.toLowerCase()}`;
    const where = recruit(state, mon);
    state.removed[c.id] = state.tick;
    delete state.creatures[c.id];
    state.tamed[c.speciesId] = true;
    state.stats.tamed += 1;
    addLog(state, `The ${sp.name} decides to follow you. ${where}`, "good");
  } else if (c.affection >= 60) addLog(state, `The ${sp.name} edges closer. (Affection ${c.affection}/100)`, "good");
  advance(state, 1);
  return RESULT_OK;
}

export function wildToMonster(state: GameState, c: WildCreature): Monster {
  const world = getWorld(state.seed);
  const gloom = world.tile(c.homeX, c.homeY).biome === "gloomwood";
  const mon = createMonster(state, c.speciesId, c.level, {
    seed: c.geneSeed,
    // the wild creature's explicit genotype and lineage carry over — taming invents no biology
    genes: c.genes ?? wildGenotypeFromSeed(c.geneSeed, c.speciesId),
    personality: c.personality,
    mutations: rollMutations(new Rng(c.geneSeed ^ 0x77), gloom),
    origin: `Tamed in the ${world.regionName(c.homeX, c.homeY)} lands`,
    generation: c.gen ?? 1,
    lineageId: c.lineageId ?? founderLineage(c.id),
    sex: c.repro?.mode,
  });
  // the wild creature's reproductive state carries over too (maturity re-derived from level)
  if (c.repro) mon.repro = { ...c.repro, maturity: maturityFor(mon.level) };
  mon.hp = Math.max(1, Math.round(statOf(mon, "hp") * c.hpFrac));
  mon.satiety = c.satiety;
  return mon;
}

/** Adds a monster to party or pen. Returns a description of where it went. */
export function recruit(state: GameState, mon: Monster): string {
  if (state.party.length < PARTY_MAX) {
    state.party.push(mon);
    return `${displayName(mon)} joins your party!`;
  }
  if (state.pen.length < PEN_MAX) {
    state.pen.push(mon);
    return `Your party is full, so ${displayName(mon)} heads to the pen at ${state.player.homeName}.`;
  }
  return `There's no room anywhere, so ${displayName(mon)} wanders off with a backward glance.`;
}

export function synthesize(state: GameState, aUid: string, bUid: string): Monster | null {
  const all = [...state.party, ...state.pen];
  const a = all.find((m) => m.uid === aUid);
  const b = all.find((m) => m.uid === bUid);
  if (!a || !b || a === b) return null;
  const child = performSynthesis(state, a, b);
  state.party = state.party.filter((m) => m !== a && m !== b);
  state.pen = state.pen.filter((m) => m !== a && m !== b);
  if (state.party.length < PARTY_MAX) state.party.push(child);
  else state.pen.push(child);
  state.seen[child.speciesId] = true;
  state.tamed[child.speciesId] = true;
  state.stats.synthesized += 1;
  addLog(state, `The shrine's roots draw ${displayName(a)} and ${displayName(b)} together in a rush of green light. When it fades, a new ${SPECIES[child.speciesId].name} blinks up at you.`, "good");
  advance(state, 12, true);
  return child;
}

export function releaseMonster(state: GameState, uid: string): void {
  const m = [...state.party, ...state.pen].find((x) => x.uid === uid);
  if (!m) return;
  if (state.party.length === 1 && state.party[0] === m) return;
  state.party = state.party.filter((x) => x !== m);
  state.pen = state.pen.filter((x) => x !== m);
  addLog(state, `You release ${displayName(m)}. It lingers a moment, then trots off into the wild.`, "info");
}

export function swapPartyPen(state: GameState, uid: string): string {
  const inParty = state.party.find((m) => m.uid === uid);
  if (inParty) {
    if (state.party.length <= 1) return "You need at least one monster with you.";
    if (state.pen.length >= PEN_MAX) return "The pen is full.";
    state.party = state.party.filter((m) => m !== inParty);
    state.pen.push(inParty);
    return `${displayName(inParty)} goes to the pen.`;
  }
  const inPen = state.pen.find((m) => m.uid === uid);
  if (inPen) {
    if (state.party.length >= PARTY_MAX) return "Your party is full.";
    state.pen = state.pen.filter((m) => m !== inPen);
    state.party.push(inPen);
    return `${displayName(inPen)} joins your party.`;
  }
  return "";
}

export function moveInParty(state: GameState, uid: string, dir: -1 | 1): void {
  const i = state.party.findIndex((m) => m.uid === uid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.party.length) return;
  const t = state.party[i];
  state.party[i] = state.party[j];
  state.party[j] = t;
}

export function grantXpLines(mon: Monster, amount: number): string[] {
  return grantXp(mon, amount);
}
