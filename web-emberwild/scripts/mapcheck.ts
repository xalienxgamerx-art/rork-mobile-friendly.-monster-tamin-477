/* Headless sanity check for the knowledge/perception/mapview systems + live combat. */
import { discoveredList, ensureKnowledge, tileVisibility, anyExplored, exploredWorldCells, isRegionSeen } from "../src/game/knowledge";
import { aggrOf, avOf, dvOf, engage, hitInfo, initField, partyFighter, partyMonAt, queueSkill, setAggr, setOrder, setTarget, terrainAt, wildFighter } from "../src/game/combat";
import { advance, creatureAt, loadChunks, newGame, movePlayer, previewStarter, spawnLairPack, waitTurn } from "../src/game/sim";
import { BIOMES, SPECIES, footprintOf } from "../src/game/data";
import { Factions, getFactions, migrateFactionKnowledge } from "../src/game/factions";
import { GENE_KEYS, driftGenome, expressGene, getGeneGrade, getMonsterFootprint, inheritGene, migrateMonsterGenes, mutateDelta, mutateGene, sizeToFootprint } from "../src/game/genetics";
import { createMonster, displayName, migrateMonsterSex, performSynthesis, previewSynthesis, rollSex, statOf, statsOf } from "../src/game/monster";
import { Rng } from "../src/game/rng";
import { hasLOS } from "../src/game/perception";
import { sampleCell } from "../src/game/mapview";
import { getWorld, seedFromText, type Feature } from "../src/game/world";
import type { GameState, GeneKey, GenePair, Genome, WildCreature } from "../src/game/types";
import { performance } from "node:perf_hooks";

let fails = 0;
const ok = (cond: boolean, label: string): void => {
  if (!cond) {
    fails++;
    console.log(`FAIL ${label}`);
  } else console.log(`ok   ${label}`);
};

const cheb = (ax: number, ay: number, bx: number, by: number): number => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/** Places a synthetic hostile creature on a free tile adjacent to the player. */
const placeAdjacent = (gs: GameState, id: string, speciesId: string, level: number): WildCreature | null => {
  const world = getWorld(gs.seed);
  const dirs: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  for (const [dx, dy] of dirs) {
    const x = gs.player.x + dx;
    const y = gs.player.y + dy;
    if (!world.inBounds(x, y) || !world.passable(x, y) || world.siteAt(x, y)?.wall || creatureAt(gs, x, y) || partyMonAt(gs, x, y)) continue;
    const c: WildCreature = {
      id, speciesId, level, x, y, homeX: x, homeY: y,
      hpFrac: 1, satiety: 60, disposition: "aggressive", activity: "Wandering", personality: "fierce",
      geneSeed: 424242, calmUntil: 0, alpha: false, affection: 0, stalking: false,
    };
    gs.creatures[id] = c;
    return c;
  }
  return null;
};

const gs = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
// the walker needs a party that can survive random live encounters
gs.party[0].level = 20;
gs.party[0].hp = statOf(gs.party[0], "hp");
ok(gs.party.length === 1, "party has starter");
ok(gs.field[gs.party[0].uid] !== undefined, "starter deployed beside the player at start");
ok(!!gs.knowledge && Object.keys(gs.knowledge.explored).length >= 2, "start area revealed");
ok(discoveredList(gs.knowledge).some((d) => d.kind === "hamlet"), "home hamlet discovered");
ok(isRegionSeen(gs.knowledge, gs.player.x, gs.player.y), "start region seen");

const world = getWorld(gs.seed);
const before = Object.keys(gs.knowledge.explored).length;
ok(tileVisibility(gs, gs.player.x, gs.player.y) === "visible", "player tile visible");
ok(tileVisibility(gs, gs.player.x + 200, gs.player.y + 200) === "fog", "far tile is fog");

// Adaptive walk: rotate direction when terrain/creatures block the way.
const startX = gs.player.x;
const startY = gs.player.y;
let minX = startX;
let maxX = startX;
let minY = startY;
let maxY = startY;
let midPos: { x: number; y: number } | null = null;
const dirs: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
let di = 0;
let guard = 0;
while (gs.stats.steps < 150 && guard < 500) {
  guard++;
  const [dx, dy] = dirs[di % dirs.length];
  const px0 = gs.player.x;
  const py0 = gs.player.y;
  movePlayer(gs, dx, dy);
  if (gs.player.x === px0 && gs.player.y === py0) di++;
  else {
    di = 0;
    minX = Math.min(minX, gs.player.x);
    maxX = Math.max(maxX, gs.player.x);
    minY = Math.min(minY, gs.player.y);
    maxY = Math.max(maxY, gs.player.y);
    if (!midPos && gs.stats.steps >= 75) midPos = { x: gs.player.x, y: gs.player.y };
  }
}
const steps = gs.stats.steps;
ok(steps >= 100, `walked ${steps} steps`);
const after = Object.keys(gs.knowledge.explored).length;
const bboxCells = Math.max(2, Math.floor(((maxX - minX + 1) * (maxY - minY + 1)) / 64));
ok(after > before, `exploration grows (${before} -> ${after}, bbox ≈ ${bboxCells} cells)`);
ok(after >= bboxCells * 0.7, `explored covers walked bbox (${after} vs ${bboxCells})`);
ok(gs.knowledge.route.length >= 8, `route breadcrumbs (${gs.knowledge.route.length} for ${steps} steps)`);
ok(tileVisibility(gs, gs.player.x, gs.player.y) === "visible", "current tile visible after walk");

// memory: where the player came from is remembered, not fog
const far = Math.max(Math.abs(startX - gs.player.x), Math.abs(startY - gs.player.y));
if (far > 15) ok(tileVisibility(gs, startX, startY) === "memory", `left-behind area is memory (${far} tiles away)`);
else console.log(`skip left-behind check (wandered back, ${far} tiles)`);

// no leak: every discovery was made within sight of somewhere the player traveled
ok(
  discoveredList(gs.knowledge).every((d) =>
    [[startX, startY], ...gs.knowledge.route].some(([rx, ry]) => Math.max(Math.abs(d.x - rx), Math.abs(d.y - ry)) <= 30),
  ),
  "all discoveries near traveled route",
);

// LOS sanity
ok(hasLOS(world, 10, 10, 12, 10), "flat LOS true");

// map aggregation: cached and stable per seed
const s1 = sampleCell("region", world, gs.player.x, gs.player.y);
const s2 = sampleCell("world", world, gs.player.x, gs.player.y);
ok(!!s1 && !!s2, "samples exist");
ok(sampleCell("region", world, gs.player.x, gs.player.y).biome === s1.biome, "region sample cached & stable");
ok(sampleCell("world", world, gs.player.x, gs.player.y).biome === s2.biome, "world sample cached & stable");

// explored roll-up
const wc = exploredWorldCells(gs.knowledge);
ok(wc.size > 0 && anyExplored(gs.knowledge, gs.player.x - 8, gs.player.y - 8, gs.player.x + 8, gs.player.y + 8), "explored roll-up works");

// ---- Physical landmark sites (walls, floors, doors) ----
const kindsNear = (kind: string): Feature | null => {
  const fs = world.featuresNear(gs.player.x, gs.player.y, 900).filter((f) => f.kind === kind);
  return fs[0] ?? null;
};

const hamlet = kindsNear("hamlet");
ok(!!hamlet, "a hamlet exists nearby");
if (hamlet) {
  const center = world.siteAt(hamlet.x, hamlet.y);
  ok(!!center && !center.wall, "hamlet center is open plaza");
  let walls = 0;
  let doors = 0;
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      const s = world.siteAt(hamlet.x + dx, hamlet.y + dy);
      if (!s) continue;
      if (s.wall) walls++;
      if (s.door) doors++;
    }
  }
  ok(walls > 8, `hamlet has hut walls (${walls})`);
  ok(doors >= 2, `hamlet has doorways (${doors})`);
  ok(!world.passable(hamlet.x - 4, hamlet.y - 4), "hut wall blocks movement (passable=false)");
  const npcs = world.hamletNpcs(hamlet);
  ok(npcs.length === 3, `hamlet has three folk (${npcs.length})`);
  ok(npcs.every((n) => world.passable(n.x, n.y)), "folk stand on walkable tiles");
  ok(npcs.every((n) => !world.siteAt(n.x, n.y)?.wall && !world.siteAt(n.x, n.y)?.door), "folk stand clear of walls and doorways");
  ok(!!world.npcAt(npcs[0].x, npcs[0].y) && world.npcAt(npcs[0].x, npcs[0].y)!.name === npcs[0].name, "npcAt finds folk at their post");
  ok(world.npcAt(npcs[0].x + 3, npcs[0].y + 3) === null, "no folk on empty tiles");
  const w3 = new (world.constructor as new (seed: number) => typeof world)(world.seed);
  ok(w3.hamletNpcs(hamlet)[0].name === npcs[0].name, "folk are seed-deterministic");
}

const ruin = kindsNear("ruin");
ok(!!ruin, "a ruin exists nearby");
if (ruin) {
  let rw = 0;
  for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) if (world.siteAt(ruin.x + dx, ruin.y + dy)?.wall) rw++;
  ok(rw > 5, `ruin has broken walls (${rw})`);
}

const lair = kindsNear("lair");
ok(!!lair, "a lair exists nearby");
if (lair) {
  ok(!!world.siteAt(lair.x, lair.y) && !world.siteAt(lair.x, lair.y)!.wall, "lair den floor is open");
  let ring = 0;
  for (let a = 0; a < 24; a++) {
    const x = lair.x + Math.round(Math.cos((a / 24) * Math.PI * 2) * 4.4);
    const y = lair.y + Math.round(Math.sin((a / 24) * Math.PI * 2) * 4.4);
    if (world.siteAt(x, y)?.wall) ring++;
  }
  ok(ring >= 13, `lair enclosed by rock walls (${ring}/24 ring samples)`);
  // live combat samples real site walls 1:1 as blocking terrain
  let wallTerrain = 0;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const tx = lair.x + dx;
      const ty = lair.y + dy;
      if (world.siteAt(tx, ty)?.wall && terrainAt(gs, tx, ty) === "wall") wallTerrain++;
    }
  }
  ok(wallTerrain > 5, `combat terrain matches the real den walls (${wallTerrain})`);
}

// determinism across World instances
if (hamlet) {
  const w2 = new (world.constructor as new (seed: number) => typeof world)(world.seed);
  ok(!!w2.siteAt(hamlet.x - 4, hamlet.y - 4) === !!world.siteAt(hamlet.x - 4, hamlet.y - 4), "sites are seed-deterministic across instances");
}

// LOS is cut by site walls
if (ruin) {
  outerWall: for (let y = ruin.y - 4; y <= ruin.y + 4; y++) {
    for (let x = ruin.x - 3; x <= ruin.x + 2; x++) {
      if (world.siteAt(x, y)?.wall && !world.siteAt(x + 1, y)?.wall && !world.siteAt(x - 1, y)?.wall) {
        ok(!hasLOS(world, x - 1, y, x + 1, y), "site wall blocks line of sight");
        break outerWall;
      }
    }
  }
}

// movement into a wall is refused
if (hamlet) {
  seek: for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      const wx = hamlet.x + dx;
      const wy = hamlet.y + dy;
      if (world.siteAt(wx, wy)?.wall && world.passable(wx, wy - 1) && !world.siteAt(wx, wy - 1)?.door) {
        gs.player.x = wx;
        gs.player.y = wy + 1;
        const before2 = gs.stats.steps;
        const r = movePlayer(gs, 0, -1);
        ok(!r.ok && gs.stats.steps === before2, "movePlayer refuses to walk into a wall");
        break seek;
      }
    }
  }
  gs.player.x = gs.player.homeX;
  gs.player.y = gs.player.homeY;
}

// size tiers: Titanic (4×4), Huge (3×3), Large (2×2), normal (1×1)
ok(
  footprintOf(SPECIES["sunwyrm"]) === 4 && footprintOf(SPECIES["ironfang_tyrant"]) === 4,
  "titanic tier is 4×4 (sunwyrm, tyrant)",
);
ok(
  footprintOf(SPECIES["crystal_golem"]) === 3 && footprintOf(SPECIES["stormmane_drake"]) === 3,
  "huge tier is 3×3 (golem, stormmane)",
);
ok(
  footprintOf(SPECIES["skyhorn_dragon"]) === 2 && footprintOf(SPECIES["mandrake_maw"]) === 2 && footprintOf(SPECIES["jade_spikeon"]) === 2,
  "large tier is 2×2 (skyhorn, mandrake, spikeon)",
);
ok(
  footprintOf(SPECIES["mossback"]) === 1 && footprintOf(SPECIES["cindermaw"]) === 1 && footprintOf(SPECIES["tidefin_toad"]) === 1,
  "starters and small species stay 1×1",
);

// a huge wild creature blocks every tile of its footprint on the local map
{
  let spot: [number, number] | null = null;
  seekBig: for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      const x = gs.player.homeX + dx;
      const y = gs.player.homeY + dy;
      let clear = true;
      for (let oy = 0; oy < 3 && clear; oy++) {
        for (let ox = 0; ox < 4; ox++) {
          const tx = x + ox;
          const ty = y + oy;
          if (!world.passable(tx, ty) || world.siteAt(tx, ty)?.wall || world.npcAt(tx, ty) || creatureAt(gs, tx, ty)) {
            clear = false;
            break;
          }
        }
      }
      if (clear) {
        spot = [x, y];
        break seekBig;
      }
    }
  }
  ok(!!spot, "found open ground for a huge creature test");
  if (spot) {
    const [sx, sy] = spot;
    const px0 = gs.player.x;
    const py0 = gs.player.y;
    gs.player.x = sx;
    gs.player.y = sy;
    const big: WildCreature = {
      id: "big:1", speciesId: "crystal_golem", level: 6, x: sx + 1, y: sy, homeX: sx + 1, homeY: sy,
      hpFrac: 1, satiety: 60, disposition: "calm", activity: "Wandering", personality: "gentle",
      geneSeed: 999, calmUntil: gs.tick + 1000, alpha: false, affection: 0, stalking: false,
    };
    gs.creatures["big:1"] = big;
    const r1 = movePlayer(gs, 1, 0);
    ok(!r1.ok && gs.player.x === sx && gs.player.y === sy, "player blocked by huge creature's anchor tile");
    const r2 = movePlayer(gs, 1, 0);
    ok(!r2.ok && gs.player.x === sx && gs.player.y === sy, "player blocked by huge creature's covered tile");
    delete gs.creatures["big:1"];
    // a Huge (3×3) creature blocks all nine tiles of its body
    const big3: WildCreature = {
      id: "big:3", speciesId: "stormmane_drake", level: 7, x: sx + 1, y: sy, homeX: sx + 1, homeY: sy,
      hpFrac: 1, satiety: 60, disposition: "calm", activity: "Wandering", personality: "gentle",
      geneSeed: 998, calmUntil: gs.tick + 1000, alpha: false, affection: 0, stalking: false,
    };
    gs.creatures["big:3"] = big3;
    const rows3 = [0, 1, 2].map((k) => {
      gs.player.x = sx;
      gs.player.y = sy + k;
      const r = movePlayer(gs, 1, 0);
      return !r.ok && gs.player.x === sx && gs.player.y === sy + k;
    });
    ok(rows3.every(Boolean), "player blocked by Huge creature's full 3×3 body");
    ok(
      ([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]] as const).every(
        ([ox, oy]) => creatureAt(gs, sx + 1 + ox, sy + oy) === big3,
      ),
      "creatureAt covers all nine Huge tiles",
    );
    delete gs.creatures["big:3"];
    gs.player.x = px0;
    gs.player.y = py0;
  }
}

/* ------------------------------ LIVE COMBAT ---------------------------------- */

// bumping a hostile creature engages it live (no arena handoff)
{
  const g = newGame("ENGAGE-1", "Rook", "ranger", "#e8742a", previewStarter("ENGAGE-1", "mossback"));
  const foe = placeAdjacent(g, "t:1", "slimekin", 3);
  ok(!!foe, "placed a hostile beside the player");
  if (foe) {
    const r = movePlayer(g, foe.x - g.player.x, foe.y - g.player.y);
    ok(!!r.engaged && r.engaged === "t:1", "bumping a hostile engages it live");
    ok(g.target === "t:1" && g.creatures["t:1"]?.stalking === true, "engagement marks the party target");
    ok(g.stats.battles === 1, "engagement counted");
  }
}

// autonomous exchange: the fight resolves over ticks and kills pay out
{
  const g = newGame("FIGHT-1", "Rook", "ranger", "#e8742a", previewStarter("FIGHT-1", "mossback"));
  const foe = placeAdjacent(g, "f:1", "slimekin", 3);
  ok(!!foe, "fight: hostile placed");
  if (foe) {
    movePlayer(g, foe.x - g.player.x, foe.y - g.player.y);
    const gold0 = g.player.gold;
    const xp0 = g.party[0].xp + g.party[0].level;
    for (let i = 0; i < 60 && g.creatures["f:1"]; i++) waitTurn(g, 1);
    ok(!g.creatures["f:1"], "the engaged creature was defeated autonomously");
    ok(g.removed["f:1"] !== undefined, "defeat recorded in removed");
    ok(g.player.gold > gold0 || Object.values(g.bag).some((n) => (n ?? 0) > 0), "kill paid out gold or drops");
    ok(g.party[0].xp + g.party[0].level > xp0, "kill granted XP");
    ok(g.log.some((l) => l.kind === "combat"), "combat strikes were logged");
  }
}

// determinism: same seed + same actions replay the exact same fight
{
  const run = (): string => {
    const g = newGame("DETERMIN-1", "Rook", "ranger", "#e8742a", previewStarter("DETERMIN-1", "mossback"));
    const foe = placeAdjacent(g, "d:1", "slimekin", 3);
    if (!foe) return "skip";
    movePlayer(g, foe.x - g.player.x, foe.y - g.player.y);
    for (let i = 0; i < 40 && g.creatures["d:1"]; i++) waitTurn(g, 1);
    return JSON.stringify({ hp: g.party.map((m) => m.hp), gold: g.player.gold, tick: g.tick, gone: !g.creatures["d:1"] });
  };
  const r1 = run();
  const r2 = run();
  ok(r1 === r2 && r1 !== "skip", "same seed and actions reproduce the identical fight");
}

// party follow: monsters trail the player at arm's length
{
  const g = newGame("FOLLOW-1", "Rook", "ranger", "#e8742a", previewStarter("FOLLOW-1", "mossback"));
  const uid = g.party[0].uid;
  for (let i = 0; i < 6; i++) movePlayer(g, 1, 0);
  const pos = g.field[uid]!;
  const d = cheb(pos.x, pos.y, g.player.x, g.player.y);
  ok(d <= 3, `follower keeps pace (${d} tiles behind)`);
}

// hold order: a holding monster keeps its ground while the player moves away
{
  const g = newGame("HOLD-1", "Rook", "ranger", "#e8742a", previewStarter("HOLD-1", "mossback"));
  const uid = g.party[0].uid;
  setOrder(g, uid, "hold");
  const before = { ...g.field[uid]! };
  waitTurn(g, 12);
  const pos = g.field[uid]!;
  ok(pos.x === before.x && pos.y === before.y, "hold order keeps the monster in place");
}

// tap-target orders: an attacker-order monster converges on the marked creature
{
  const g = newGame("TARGET-1", "Rook", "ranger", "#e8742a", previewStarter("TARGET-1", "mossback"));
  const uid = g.party[0].uid;
  const w = getWorld(g.seed);
  let foe: WildCreature | null = null;
  for (let dx = 4; dx <= 8 && !foe; dx++) {
    for (let dy = -2; dy <= 2 && !foe; dy++) {
      const x = g.player.x + dx;
      const y = g.player.y + dy;
      if (!w.inBounds(x, y) || !w.passable(x, y) || w.siteAt(x, y)?.wall || creatureAt(g, x, y) || partyMonAt(g, x, y)) continue;
      foe = {
        id: "tg:1", speciesId: "slimekin", level: 2, x, y, homeX: x, homeY: y,
        hpFrac: 1, satiety: 80, disposition: "calm", activity: "Wandering", personality: "gentle",
        geneSeed: 777, calmUntil: g.tick + 500, alpha: false, affection: 0, stalking: false,
      };
      g.creatures[foe.id] = foe;
    }
  }
  ok(!!foe, "target: placed a calm creature nearby");
  if (foe) {
    setOrder(g, uid, "attack");
    setTarget(g, foe.id);
    const d0 = cheb(g.field[uid]!.x, g.field[uid]!.y, foe.x, foe.y);
    for (let i = 0; i < 14 && g.creatures["tg:1"]; i++) waitTurn(g, 1);
    const d1 = g.creatures["tg:1"] ? cheb(g.field[uid]!.x, g.field[uid]!.y, g.creatures["tg:1"].x, g.creatures["tg:1"].y) : 0;
    ok(d1 < d0 || !g.creatures["tg:1"], `attacker converged on its target (${d0} -> ${d1})`);
  }
}

// ordered skill: the monster paths into range, unleashes it, and provokes the mark
{
  const g = newGame("SKILLQ-1", "Rook", "ranger", "#e8742a", previewStarter("SKILLQ-1", "mossback"));
  const uid = g.party[0].uid;
  g.party[0].skills = ["ember", "bite"];
  const w = getWorld(g.seed);
  let foe: WildCreature | null = null;
  for (let dx = 5; dx <= 8 && !foe; dx++) {
    for (let dy = -2; dy <= 2 && !foe; dy++) {
      const x = g.player.x + dx;
      const y = g.player.y + dy;
      if (!w.inBounds(x, y) || !w.passable(x, y) || w.siteAt(x, y)?.wall || creatureAt(g, x, y) || partyMonAt(g, x, y)) continue;
      foe = {
        id: "sq:1", speciesId: "slimekin", level: 2, x, y, homeX: x, homeY: y,
        hpFrac: 1, satiety: 80, disposition: "calm", activity: "Wandering", personality: "gentle",
        geneSeed: 31, calmUntil: g.tick + 500, alpha: false, affection: 0, stalking: false,
      };
      g.creatures[foe.id] = foe;
    }
  }
  ok(!!foe, "skill order: placed a creature just out of range");
  if (foe) {
    queueSkill(g, uid, "ember", foe.id);
    ok(g.skillQ[uid]?.skill === "ember", "skill order queued");
    let fired = false;
    for (let i = 0; i < 12 && !fired; i++) {
      waitTurn(g, 1);
      fired = g.log.some((l) => l.text.includes("spits embers"));
    }
    ok(fired, "ordered skill fired once the monster closed in");
    ok(!g.skillQ[uid], "skill order cleared after use");
    ok(!!g.creatures["sq:1"]?.stalking, "the struck creature turns to fight back");
  }
}

// ordered self-heal: mend resolves on the monster's very next turn
{
  const g = newGame("SKILLQ-2", "Rook", "ranger", "#e8742a", previewStarter("SKILLQ-2", "mossback"));
  const uid = g.party[0].uid;
  g.party[0].skills = ["mend", "bite"];
  g.party[0].hp = 5;
  queueSkill(g, uid, "mend", uid);
  waitTurn(g, 1);
  ok(g.party[0].hp > 5, "ordered mend heals the hurt monster");
  ok(!g.skillQ[uid], "mend order cleared after use");
}

// aggression: a passive monster never starts fights, neutral retaliates
{
  const g = newGame("AGGR-1", "Rook", "ranger", "#e8742a", previewStarter("AGGR-1", "mossback"));
  const uid = g.party[0].uid;
  g.party[0].skills = ["bite"];
  setAggr(g, uid, "passive");
  ok(aggrOf(g, uid) === "passive", "aggression set to passive");
  const foe = placeAdjacent(g, "ag:1", "slimekin", 3);
  ok(!!foe, "aggression: hostile placed");
  if (foe) {
    movePlayer(g, foe.x - g.player.x, foe.y - g.player.y);
    const bite = `${displayName(g.party[0])} bites`;
    const hp0 = g.creatures["ag:1"] ? g.creatures["ag:1"].hpFrac : 1;
    for (let i = 0; i < 4; i++) waitTurn(g, 1);
    const hurt = !!g.creatures["ag:1"] && g.creatures["ag:1"].hpFrac < hp0 - 1e-9;
    const bites = g.log.some((l) => l.text.includes(bite));
    ok(!hurt && !bites, "passive monster never strikes on its own");
    setAggr(g, uid, "neutral");
    let fought = false;
    for (let i = 0; i < 6 && !fought; i++) {
      waitTurn(g, 1);
      fought = !g.creatures["ag:1"] || g.creatures["ag:1"].hpFrac < hp0 || g.log.some((l) => l.text.includes(bite));
    }
    ok(fought, "neutral monster retaliates once allowed");
  }
}

// aggressive monsters seek out hostiles further afield, unbidden
{
  const g = newGame("AGGR-2", "Rook", "ranger", "#e8742a", previewStarter("AGGR-2", "mossback"));
  const uid = g.party[0].uid;
  g.party[0].skills = ["bite"];
  setAggr(g, uid, "aggressive");
  const w = getWorld(g.seed);
  let placed = false;
  for (let dx = 8; dx <= 9 && !placed; dx++) {
    for (let dy = -1; dy <= 1 && !placed; dy++) {
      const x = g.player.x + dx;
      const y = g.player.y + dy;
      if (!w.inBounds(x, y) || !w.passable(x, y) || w.siteAt(x, y)?.wall || creatureAt(g, x, y) || partyMonAt(g, x, y)) continue;
      g.creatures["ah:1"] = {
        id: "ah:1", speciesId: "slimekin", level: 2, x, y, homeX: x, homeY: y,
        hpFrac: 1, satiety: 80, disposition: "aggressive", activity: "Wandering", personality: "fierce",
        geneSeed: 97, calmUntil: g.tick, alpha: false, affection: 0, stalking: false,
      };
      placed = true;
    }
  }
  ok(placed, "aggressive hunt: hostile placed 8 tiles out");
  const marks: string[] = [];
  const hp0: Record<string, number> = {};
  for (const c of Object.values(g.creatures)) {
    const hostile = c.stalking || (c.disposition === "aggressive" && c.calmUntil <= g.tick);
    if (hostile && cheb(c.x, c.y, g.field[uid]!.x, g.field[uid]!.y) <= 10) {
      marks.push(c.id);
      hp0[c.id] = c.hpFrac;
    }
  }
  ok(marks.includes("ah:1"), "the placed hostile is within the aggressive monster's reach");
  let provoked = false;
  for (let i = 0; i < 14 && !provoked; i++) {
    waitTurn(g, 1);
    provoked = marks.some((id) => !g.creatures[id] || g.creatures[id].stalking || g.creatures[id].hpFrac < hp0[id]);
  }
  ok(provoked, "aggressive monster hunted a hostile unbidden");
}

// a Huge (3×3) party monster deploys with a full 3×3 body on the live map
{
  const g = newGame("BIGP-1", "Rook", "ranger", "#e8742a", previewStarter("BIGP-1", "mossback"));
  const big = createMonster(g, "crystal_golem", 6, { origin: "Test", seed: 7, skills: ["crunch"] });
  big.hp = statOf(big, "hp");
  g.party.push(big);
  initField(g);
  ok(footprintOf(SPECIES["crystal_golem"]) === 3, "huge party member has a 3×3 footprint");
  const pos = g.field[big.uid]!;
  ok(
    ([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]] as const).every(
      ([ox, oy]) => partyMonAt(g, pos.x + ox, pos.y + oy) === big,
    ),
    "partyMonAt covers the whole 3×3 party body",
  );
  ok(!(pos.x === g.player.x && pos.y === g.player.y), "huge body does not overlap the player");
}

// a Titanic (4×4) party monster deploys with a full 4×4 body; a wild titan covers all 16 tiles
{
  const g = newGame("TITAN-1", "Rook", "ranger", "#e8742a", previewStarter("TITAN-1", "mossback"));
  const titan = createMonster(g, "sunwyrm", 8, { origin: "Test", seed: 11, skills: ["bite"] });
  titan.hp = statOf(titan, "hp");
  g.party.push(titan);
  initField(g);
  ok(footprintOf(SPECIES["sunwyrm"]) === 4, "sunwyrm is Titanic (4×4)");
  const pos = g.field[titan.uid]!;
  const tiles: [number, number][] = [];
  for (let oy = 0; oy < 4; oy++) for (let ox = 0; ox < 4; ox++) tiles.push([ox, oy]);
  ok(
    tiles.every(([ox, oy]) => partyMonAt(g, pos.x + ox, pos.y + oy) === titan),
    "partyMonAt covers the whole 4×4 party body",
  );
  ok(
    !(pos.x <= g.player.x && g.player.x < pos.x + 4 && pos.y <= g.player.y && g.player.y < pos.y + 4),
    "titanic body does not overlap the player",
  );
  const w = getWorld(g.seed);
  let spot: [number, number] | null = null;
  seekT: for (let dy = -9; dy <= 9 && !spot; dy++) {
    for (let dx = -9; dx <= 9 && !spot; dx++) {
      const x = g.player.x + dx;
      const y = g.player.y + dy;
      let clear = true;
      for (let oy = 0; oy < 4 && clear; oy++) {
        for (let ox = 0; ox < 4; ox++) {
          const tx = x + ox;
          const ty = y + oy;
          if (!w.inBounds(tx, ty) || !w.passable(tx, ty) || w.siteAt(tx, ty)?.wall || creatureAt(g, tx, ty) || partyMonAt(g, tx, ty) || (tx === g.player.x && ty === g.player.y)) {
            clear = false;
            break;
          }
        }
      }
      if (clear) spot = [x, y];
    }
  }
  ok(!!spot, "found open ground for a wild titanic creature");
  if (spot) {
    const [sx, sy] = spot;
    g.creatures["titan:1"] = {
      id: "titan:1", speciesId: "ironfang_tyrant", level: 9, x: sx, y: sy, homeX: sx, homeY: sy,
      hpFrac: 1, satiety: 70, disposition: "calm", activity: "Wandering", personality: "fierce",
      geneSeed: 4242, calmUntil: g.tick + 1000, alpha: true, affection: 0, stalking: false,
    };
    ok(
      tiles.every(([ox, oy]) => creatureAt(g, sx + ox, sy + oy)?.id === "titan:1"),
      "creatureAt covers all 16 tiles of a wild titan",
    );
    delete g.creatures["titan:1"];
  }
}

// lairs: the den holds an alpha with a loyal pack that fights for it
{
  const g = newGame("LAIR-1", "Rook", "ranger", "#e8742a", previewStarter("LAIR-1", "mossback"));
  // a sturdy party: the sub-tests must not end in a wipe (which would teleport the player home)
  g.party[0].level = 40;
  g.party[0].hp = statOf(g.party[0], "hp");
  const w = getWorld(g.seed);
  const lairs = w.featuresNear(g.player.x, g.player.y, 4096).filter((f) => f.kind === "lair" && f.speciesId);
  ok(lairs.length > 0, "lair pack: a lair exists in the world");
  let alpha: WildCreature | null = null;
  for (const f of lairs) {
    spawnLairPack(g, w, f);
    const a = g.creatures[`l:${f.x}:${f.y}`];
    if (a) {
      alpha = a;
      break;
    }
  }
  ok(!!alpha && alpha.alpha, "the lair's alpha stands in its den");
  const pack = alpha ? Object.values(g.creatures).filter((o) => o.pack === alpha!.id) : [];
  ok(pack.length >= 2 && pack.length <= 5, `the alpha has a loyal pack (${pack.length})`);
  ok(pack.every((o) => o.speciesId === alpha!.speciesId && o.level < alpha!.level), "packmates share the species and rank below their alpha");
  if (alpha && pack.length) {
    // engaging one minion calls the alpha and the rest of the pack
    engage(g, pack[0].id, false);
    ok(alpha.stalking && pack.slice(1).some((o) => o.stalking), "engaging one minion calls the alpha and the rest of the pack");
    for (const o of [alpha, ...pack]) o.stalking = false;
    g.target = null;
    // protection: an intruder at the den draws the guards (clear of the home hamlet so wild AI runs)
    seekOpen: for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const tx0 = g.player.x + dx;
        const ty0 = g.player.y + dy;
        if (w.inBounds(tx0, ty0) && w.passable(tx0, ty0) && !w.tile(tx0, ty0).feature && !creatureAt(g, tx0, ty0)) {
          g.player.x = tx0;
          g.player.y = ty0;
          break seekOpen;
        }
      }
    }
    // no bystanders: a stray predator would spook the alpha before it commands
    for (const id in g.creatures) {
      const o = g.creatures[id];
      if (o === alpha || o.pack === alpha.id) continue;
      if (cheb(o.x, o.y, g.player.x, g.player.y) <= 12) delete g.creatures[id];
    }
    alpha.x = g.player.x + 2;
    alpha.y = g.player.y;
    for (const o of pack) {
      o.x = g.player.x + 3;
      o.y = g.player.y;
      o.satiety = 12;
    }
    alpha.satiety = 12;
    alpha.disposition = "aggressive";
    waitTurn(g, 1);
    const guarded = pack.some((o) => o.stalking);
    waitTurn(g, 5);
    ok(guarded && g.log.some((l) => l.text.includes("bellows") || l.kind === "combat"), "the pack guards its alpha and fights for it");
    // loyalty ends with the alpha
    delete g.creatures[alpha.id];
    delete g.removed[alpha.id];
    const stray = pack[0];
    stray.x = g.player.x + 2;
    stray.y = g.player.y;
    advance(g, 2);
    ok(!stray.pack && stray.disposition === "skittish", "a minion whose alpha falls loses its loyalty and scatters");
  }
}

// fire burns out to ash on the live map
{
  const g = newGame("FIRE-1", "Rook", "ranger", "#e8742a", previewStarter("FIRE-1", "mossback"));
  let k: string | null = null;
  scan: for (let dy = -10; dy <= 10; dy++) {
    for (let dx = -10; dx <= 10; dx++) {
      const x = g.player.x + dx;
      const y = g.player.y + dy;
      if (["grass", "tallgrass", "flowers"].includes(terrainAt(g, x, y))) {
        k = `${x},${y}`;
        break scan;
      }
    }
  }
  if (k) {
    g.ground[k] = { fire: 1 };
    waitTurn(g, 1);
    ok(!g.ground[k]?.fire, "fire burns out after its fuel is spent");
    ok(g.ground[k]?.t === "ash", "burnt ground turns to ash");
  } else console.log("skip fire check (no flammable ground near the start)");
}

// balance parity: the ported arena formulas produce the same numbers
{
  const g = newGame("PARITY-1", "Rook", "scholar", "#e8742a", previewStarter("PARITY-1", "mossback"));
  const mon = g.party[0];
  const f = partyFighter(g, mon);
  const st = statsOf(mon);
  const dvBase = 6 + Math.floor(st.agi / 4);
  const dv = dvOf(g, f);
  ok(dv === dvBase || dv === dvBase + 2, `DV formula intact (base ${dvBase}, got ${dv})`);
  ok(avOf(g, f) === Math.floor(st.def / 5), "AV formula intact (mossback has no AV traits)");
  const foe = placeAdjacent(g, "p:1", "slimekin", 5);
  if (foe) {
    const ff = wildFighter(g, foe);
    const hi = hitInfo(g, f, ff, "shell_bash");
    let n = 1;
    for (let r = 2; r <= 19; r++) if (r + hi.bonus >= hi.dv) n++;
    ok(Math.abs(hi.chance - n / 20) < 1e-9, "hit chance follows the d20 formula");
  }
}

// save round trip: live-combat state persists
const json = JSON.stringify(gs);
const loaded = JSON.parse(json);
ok(loaded.version === 10, "save version 10");
ok(loaded.field && loaded.orders && loaded.ground && loaded.fighters && loaded.aggr && loaded.skillQ && "target" in loaded, "live-combat state persists");
ok(Object.keys(loaded.knowledge.explored).length === after, "explored persists exactly");

// v4 → v5 migration: old saves deploy the party at the player's side
{
  const v4 = JSON.parse(json) as GameState & { version: number };
  delete v4.field;
  delete v4.orders;
  delete v4.target;
  delete v4.ground;
  delete v4.fighters;
  (v4 as unknown as { field: GameState["field"] }).field = {};
  (v4 as unknown as { orders: GameState["orders"] }).orders = {};
  (v4 as unknown as { target: null }).target = null;
  (v4 as unknown as { ground: GameState["ground"] }).ground = {};
  (v4 as unknown as { fighters: GameState["fighters"] }).fighters = {};
  v4.version = 4;
  initField(v4);
  ok(v4.party.every((m) => !!v4.field[m.uid]), "v4 migration deploys the party at the player's side");
  ok(Object.values(v4.field).every((p) => cheb(p.x, p.y, v4.player.x, v4.player.y) <= 8), "migrated party placed near the player");
}

// v5 → v6 migration: commanded skills and aggression backfill (same normalization loadSave applies)
{
  const v5 = JSON.parse(json) as GameState & { version: number };
  delete v5.aggr;
  delete v5.skillQ;
  v5.version = 5;
  v5.aggr = v5.aggr ?? {};
  v5.skillQ = v5.skillQ ?? {};
  v5.version = 6;
  ok(aggrOf(v5, v5.party[0].uid) === "neutral", "v5 migration defaults aggression to neutral");
  v5.party[0].skills = ["bite", ...v5.party[0].skills];
  queueSkill(v5, v5.party[0].uid, "bite", v5.party[0].uid);
  ok(v5.skillQ[v5.party[0].uid]?.skill === "bite", "v5 migration accepts skill orders");
}

// v6 → v7 migration: scalar genes become allele pairs with a genetic size gene
{
  const v6 = JSON.parse(json) as GameState & { version: number };
  for (const m of v6.party) {
    const g = m.genes as unknown as Record<string, GenePair>;
    m.genes = { vigor: g.vigor.a, might: g.might.a, guard: g.guard.a, swift: g.swift.a, wit: g.wit.a } as unknown as GameState["party"][number]["genes"];
  }
  v6.version = 6;
  for (const m of v6.party) migrateMonsterGenes(m);
  const m0 = v6.party[0];
  ok(typeof m0.genes.vigor.a === "number" && typeof m0.genes.size.a === "number", "v6 migration converts scalar genes into allele pairs");
  ok(getMonsterFootprint(m0) === footprintOf(SPECIES[m0.speciesId]), "migrated size genes express the species' body footprint");
}

// v7 → v8 migration: monsters gain a sex (asexual species stay asexual)
{
  const v7 = JSON.parse(json) as GameState & { version: number };
  for (const m of v7.party) delete (m as { sex?: string }).sex;
  v7.version = 7;
  for (const m of v7.party) migrateMonsterSex(m);
  ok(v7.party.every((m) => ["male", "female", "asexual"].includes(m.sex)), "v7 migration gives every monster a sex");
  const m0 = v7.party[0];
  ok(SPECIES[m0.speciesId].sexed === false ? m0.sex === "asexual" : m0.sex !== "asexual", "migrated sex matches the species' biology");
  const s0 = m0.sex;
  migrateMonsterSex(m0);
  ok(m0.sex === s0, "sex migration is idempotent");
}

// v8 → v9 migration: loaded chunks respawn, so lairs field their packs
{
  const v8 = JSON.parse(json) as GameState & { version: number };
  v8.version = 8;
  v8.loadedChunks = [];
  loadChunks(v8);
  const w8 = getWorld(v8.seed);
  let lairsFound = 0;
  let packed = 0;
  for (const key of v8.loadedChunks) {
    const [cx, cy] = key.split(",").map(Number);
    for (const f of w8.featuresNear(cx * 16 + 8, cy * 16 + 8, 8)) {
      if (f.kind !== "lair" || !f.speciesId) continue;
      if (Math.floor(f.x / 16) !== cx || Math.floor(f.y / 16) !== cy) continue;
      lairsFound++;
      if (v8.creatures[`l:${f.x}:${f.y}`]) {
        const n = Object.values(v8.creatures).filter((o) => o.pack === `l:${f.x}:${f.y}`).length;
        if (n >= 2) packed++;
      }
    }
  }
  ok(lairsFound > 0 && packed >= 1, `v9 migration fields packs at live lairs (${packed}/${lairsFound})`);
}

// v9 → v10 migration: faction knowledge backfilled, home banner resolved
{
  const v9 = JSON.parse(json) as GameState & { version: number };
  delete v9.knowledge.nationsSeen;
  delete v9.knowledge.assocSeen;
  delete (v9 as { lastNation?: string }).lastNation;
  v9.version = 9;
  migrateFactionKnowledge(v9);
  ok(typeof v9.lastNation === "string", "v10 migration resolves the player's banner");
  ok(!!v9.knowledge.nationsSeen && !!v9.knowledge.assocSeen, "v10 migration backfills faction knowledge");
  const nat = getFactions(v9.seed).nationAt(v9.player.x, v9.player.y);
  ok(!nat || v9.knowledge.nationsSeen[nat.id] === 1, "migrated save learns the nation it stands in");
}

// v3 migration path
const v3 = JSON.parse(json) as typeof gs & { version: number };
delete v3.knowledge;
v3.version = 3;
ensureKnowledge(v3, true);
ok(!!v3.knowledge && Object.keys(v3.knowledge.explored).length > 0, "v3 migration backfills explored");
ok(Object.keys(v3.knowledge.regionsSeen).length > 0 && v3.knowledge.route.length === 1, "v3 migration seeds region + route");

/* ------------------------------- Genetics ----------------------------------- */

// allele pairs, expression and grades: hidden potential exists without showing
{
  const gg = newGame("GEN-1", "Rook", "ranger", "#e8742a", previewStarter("GEN-1", "mossback"));
  ok(expressGene({ a: 90, b: 40 }) === 65, "expression is the allele average (90/40 → 65)");
  ok(getGeneGrade(expressGene({ a: 90, b: 40 })) === "B" && getGeneGrade(90) === "S", "grades come from expressed values, not alleles");
  const lo = createMonster(gg, "cindermaw", 5, { origin: "Test", seed: 43, personality: "loyal", mutations: [], genes: { ...gg.party[0].genes, vigor: { a: 40, b: 40 } } });
  const hi = createMonster(gg, "cindermaw", 5, { origin: "Test", seed: 44, personality: "loyal", mutations: [], genes: { ...gg.party[0].genes, vigor: { a: 90, b: 40 } } });
  ok(statOf(hi, "hp") > statOf(lo, "hp"), "stats follow the expressed gene average, not a single allele");
}

// inheritance: one allele from each parent; every combination can occur
{
  const rng = new Rng(777);
  const combos = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const c = inheritGene({ a: 90, b: 40 }, { a: 85, b: 45 }, rng);
    combos.add(`${c.a}:${c.b}`);
  }
  ok(combos.has("90:85") && combos.has("90:45") && combos.has("40:85") && combos.has("40:45"), "each child takes one allele per parent; all four combinations occur");
}

// drift: symmetric, unbiased, mostly small
{
  const rng = new Rng(2024);
  let up = 0, down = 0, sum = 0, small = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const d = mutateDelta(rng);
    sum += d;
    if (d > 0) up++;
    else if (d < 0) down++;
    if (Math.abs(d) <= 2) small++;
  }
  ok(up > 0 && down > 0, "mutations can increase and decrease gene values");
  ok(Math.abs(sum / N) < 0.25, `drift is centered on zero (mean ${(sum / N).toFixed(3)})`);
  ok(Math.abs(up - down) / N < 0.06, "no upward bias: P(up) ≈ P(down)");
  ok(small / N > 0.55, "most mutations are 0/±1/±2");
}

// mutation modifies the alleles themselves and stays bounded
{
  const rng = new Rng(99);
  let changed = 0, same = 0, bounded = true;
  for (let i = 0; i < 500; i++) {
    const m = mutateGene({ a: 100, b: 5 }, rng);
    if (m.a > 100 || m.a < 5 || m.b > 100 || m.b < 5) bounded = false;
    if (m.a === 100 && m.b === 5) same++;
    else changed++;
  }
  ok(bounded, "alleles stay bounded at 5–100");
  ok(changed > 0 && same > 0, "drift sometimes changes an allele and sometimes leaves it unchanged");
  const parent = mutateGene({ a: 90, b: 50 }, rng);
  const kids = new Set<number>();
  for (let i = 0; i < 200; i++) kids.add(inheritGene(parent, { a: 70, b: 70 }, rng).a);
  ok(kids.has(parent.a) && kids.has(parent.b), "mutated alleles are part of the genome and can be inherited");
}

// size is a gene: inherited, mutable in both directions, thresholds exact
{
  const rng = new Rng(313);
  const kid = inheritGene({ a: 90, b: 94 }, { a: 45, b: 51 }, rng);
  ok((kid.a === 90 || kid.a === 94) && (kid.b === 45 || kid.b === 51), "size genes inherit one allele per parent");
  ok(sizeToFootprint(expressGene(kid)) === 3, "size expression 90/51 → 71 → 3×3 footprint");
  let upS = false, downS = false;
  for (let i = 0; i < 500 && !(upS && downS); i++) {
    const m = mutateGene({ a: 74, b: 74 }, rng);
    if (expressGene(m) > 74) upS = true;
    if (expressGene(m) < 74) downS = true;
  }
  ok(upS && downS, "size can mutate upward and downward across footprint thresholds");
}
ok(
  sizeToFootprint(5) === 1 && sizeToFootprint(24) === 1 && sizeToFootprint(25) === 2 && sizeToFootprint(49) === 2 && sizeToFootprint(50) === 3 && sizeToFootprint(74) === 3 && sizeToFootprint(75) === 4 && sizeToFootprint(100) === 4,
  "size thresholds are exact (5–24, 25–49, 50–74, 75–100)",
);

// genome-driven footprints; starters stay 1×1 (multi-tile support intact)
{
  const gg = newGame("GEN-2", "Rook", "ranger", "#e8742a", previewStarter("GEN-2", "mossback"));
  ok(getMonsterFootprint(gg.party[0]) === 1, "starters stay 1×1");
  const big = createMonster(gg, "sunwyrm", 8, { origin: "Test", seed: 11 });
  big.hp = statOf(big, "hp");
  gg.party.push(big);
  initField(gg);
  ok(getMonsterFootprint(big) === 4, "a party titan's footprint comes from its size genome");
  const pos = gg.field[big.uid]!;
  ok(
    ([[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2], [0, 3], [1, 3], [2, 3], [3, 3]] as const).every(
      ([ox, oy]) => partyMonAt(gg, pos.x + ox, pos.y + oy) === big,
    ),
    "the genomic footprint occupies tiles like any multi-tile body",
  );
}

// size influences stats moderately (wit untouched)
{
  const gg = newGame("GEN-3", "Rook", "ranger", "#e8742a", previewStarter("GEN-3", "mossback"));
  const base = gg.party[0].genes;
  const small = createMonster(gg, "cindermaw", 5, { origin: "Test", seed: 21, personality: "loyal", mutations: [], genes: { ...base, size: { a: 10, b: 14 } } });
  const large = createMonster(gg, "cindermaw", 5, { origin: "Test", seed: 22, personality: "loyal", mutations: [], genes: { ...base, size: { a: 87, b: 87 } } });
  ok(statOf(large, "hp") > statOf(small, "hp") && statOf(large, "atk") > statOf(small, "atk") && statOf(large, "def") > statOf(small, "def"), "larger size raises HP/Might/Guard potential");
  ok(statOf(large, "agi") < statOf(small, "agi"), "larger size lowers Swift");
  ok(statOf(large, "wis") === statOf(small, "wis"), "Wit is not affected by size");
  ok(statOf(large, "hp") < Math.round(statOf(small, "hp") * 1.6), "size scaling stays moderate");
}

// synthesis: allele inheritance before drift, genome and lineage intact after
{
  const gg = newGame("GEN-4", "Rook", "ranger", "#e8742a", previewStarter("GEN-4", "mossback"));
  const a = createMonster(gg, "cindermaw", 8, { origin: "Test", seed: 61, genes: { ...gg.party[0].genes, vigor: { a: 90, b: 40 } } });
  const b = createMonster(gg, "mossback", 8, { origin: "Test", seed: 62, genes: { ...gg.party[0].genes, vigor: { a: 85, b: 45 } } });
  const prev = previewSynthesis(a, b);
  ok([90, 40].includes(prev.genes.vigor.a) && [85, 45].includes(prev.genes.vigor.b), "the preview shows the inherited allele pair (before drift)");
  ok(GENE_KEYS.every((k) => typeof prev.genes[k].a === "number" && typeof prev.genes[k].b === "number"), "every gene is inherited as an allele pair");
  const child = performSynthesis(gg, a, b);
  ok(
    (Object.keys(child.genes) as GeneKey[]).every((k) => typeof child.genes[k].a === "number" && typeof child.genes[k].b === "number"),
    "synthesis produces a full allele genome",
  );
  ok([1, 2, 3, 4].includes(getMonsterFootprint(child)), "the child's footprint derives from its size genome");
  ok(child.parents?.[0] === a.uid && child.parents?.[1] === b.uid, "parents are recorded as uids for lineage");
  ok(child.sex === prev.sex && ["male", "female", "asexual"].includes(child.sex), "the child's sex matches the preview and its biology");
}

// super lineages: expression can climb across generations
{
  const rng = new Rng(808);
  const flat = (vigor: GenePair): Genome => ({ vigor, might: { a: 50, b: 50 }, guard: { a: 50, b: 50 }, swift: { a: 50, b: 50 }, wit: { a: 50, b: 50 }, size: { a: 14, b: 14 } });
  let improved = false;
  for (let line = 0; line < 12 && !improved; line++) {
    let v: GenePair = { a: 90, b: 42 };
    for (let gen = 0; gen < 20; gen++) v = driftGenome(flat(v), rng).vigor;
    if (expressGene(v) > 66) improved = true;
  }
  ok(improved, "selective breeding can push expression beyond the founding pair");
}

// sex: sexed species are male or female; spirits, slimes, golems and plants are asexual
{
  ok(
    SPECIES["pipwisp"].sexed === false && SPECIES["slimekin"].sexed === false && SPECIES["regalslime"].sexed === false && SPECIES["bloomwisp"].sexed === false && SPECIES["mandrake_maw"].sexed === false && SPECIES["crystal_golem"].sexed === false,
    "spirits, slimes, the plant-beast and the golem have no sex",
  );
  ok(
    SPECIES["cindermaw"].sexed !== false && SPECIES["sunwyrm"].sexed !== false && SPECIES["nimbletuft"].sexed !== false,
    "beasts, birds and dragons come male or female",
  );
  const rng = new Rng(4242);
  const sexes = new Set<string>();
  for (let i = 0; i < 100; i++) sexes.add(rollSex(rng, "cindermaw"));
  ok(sexes.has("male") && sexes.has("female"), "sexed species roll both male and female");
  ok(rollSex(rng, "slimekin") === "asexual" && rollSex(rng, "crystal_golem") === "asexual", "asexual species never roll a sex");
}

// waiting passes time without leaking new terrain
const expBefore = Object.keys(gs.knowledge.explored).length;
waitTurn(gs, 24);
ok(Object.keys(gs.knowledge.explored).length === expBefore, "waiting does not reveal new area");

/* ------------------------------- FACTIONS ------------------------------------ */

// nations: generated, mixed sizes, coherent blobs, unclaimable land stays free
{
  const fac = getFactions(gs.seed);
  ok(fac.nations.length >= 6 && fac.nations.length <= 24, `nations generated (${fac.nations.length})`);
  ok(fac.nations.some((n) => n.tier === "major") && fac.nations.some((n) => n.tier === "free"), "mixed realm sizes present (majors and free cities)");
  const counts = new Map<string, number>();
  for (let fy = 0; fy < 103; fy++) {
    for (let fx = 0; fx < 103; fx++) {
      const n = fac.nationAtCell(fx, fy);
      if (n) counts.set(n.id, (counts.get(n.id) ?? 0) + 1);
    }
  }
  ok(fac.nations.every((n) => (counts.get(n.id) ?? 0) > 0), "every nation holds territory");
  const sizes = [...counts.values()];
  const ratio = Math.max(...sizes) / Math.min(...sizes);
  ok(ratio >= 2.5, `mixed sizes: the largest realm is ${ratio.toFixed(1)}× the smallest`);
  let same = 0;
  let tot = 0;
  for (let i = 0; i < 4000; i++) {
    const fx = 2 + (i * 97) % 99;
    const fy = 2 + (i * 53) % 99;
    const n = fac.nationAtCell(fx, fy);
    if (!n) continue;
    for (const o of [fac.nationAtCell(fx + 1, fy), fac.nationAtCell(fx, fy + 1)]) {
      tot++;
      if (o === n) same++;
    }
  }
  ok(tot > 0 && same / tot > 0.6, `territory is coherent, not checkered (${((same / Math.max(1, tot)) * 100).toFixed(0)}% neighbor agreement)`);
  // territory resolves at 40-tile cells: a cell is claimed only if its own center is claimable land
  let badClaim = 0;
  for (let fy = 0; fy < 103; fy++) {
    for (let fx = 0; fx < 103; fx++) {
      const t = world.tile(fx * 40 + 20, fy * 40 + 20);
      if (!BIOMES[t.biome].passable && fac.nationAtCell(fx, fy)) badClaim++;
    }
  }
  ok(badClaim === 0, "sea and peaks stay unclaimed (every territory cell is claimable land)");
  const f2 = new Factions(world.seed, world);
  ok(JSON.stringify(f2.nations) === JSON.stringify(fac.nations), "nations are seed-deterministic across instances");
}

// associations: chapters inside their origin nation, charters vary by nation
{
  const fac = getFactions(gs.seed);
  ok(fac.assocs.every((a) => fac.nationAt(a.chapter.x, a.chapter.y)?.id === a.nationId), "every association chapter lies inside its origin nation");
  ok(fac.assocs.every((a) => a.chapter.kind === "hamlet"), "chapters are hamlets");
  const ch = fac.assocs[0];
  if (ch) {
    const notices = fac.hamletNotices(ch.chapter);
    ok(notices.length >= 1 && notices.length <= 3, `a chapter hamlet posts notices (${notices.length})`);
    ok(notices.every((nt) => nt.text.includes(nt.assoc.name)), "notices are signed by their association");
    ok(notices.every((nt) => nt.text.includes("duel") || nt.text.includes("Tourney") || nt.text.includes("Auction") || nt.text.includes("auction") || nt.text.includes("beast") || nt.text.includes("Sale")), "notices cover duels, tourneys and beast trade");
  }
  let multi = false;
  let none = false;
  for (const seedText of ["MAPCHECK-1", "FACTION-2", "FACTION-3", "FACTION-4"]) {
    const sd = seedFromText(seedText);
    const facS = new Factions(sd, getWorld(sd));
    for (const n of facS.nations) {
      if (n.associations.length >= 2) multi = true;
      if (n.associations.length === 0) none = true;
    }
  }
  ok(multi, "some nations charter more than one association");
  ok(none, "some nations charter no association");
}

// borders: walking crosses them, announcements fire, learning persists
{
  const g = newGame("BORDER-1", "Rook", "ranger", "#e8742a", previewStarter("BORDER-1", "mossback"));
  const fac = getFactions(g.seed);
  const home = fac.nationAt(g.player.x, g.player.y);
  ok(!home || (g.lastNation === home.id && g.knowledge.nationsSeen[home.id] === 1), "the home nation is known from the first day");
  const dirs2: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let crossed = false;
  let di2 = 0;
  for (let i = 0; i < 700 && !crossed; i++) {
    const [dx, dy] = dirs2[di2 % 4];
    const px0 = g.player.x;
    const py0 = g.player.y;
    movePlayer(g, dx, dy);
    if (g.player.x === px0 && g.player.y === py0) di2++;
    else di2 = 0;
    crossed = g.lastNation !== (home?.id ?? "");
  }
  ok(crossed, "wandering far enough crosses at least one border");
  ok(g.log.some((l) => l.text.includes("entered") || l.text.includes("unclaimed wilds")), "crossing a border is announced");
}

// perf
const t0 = performance.now();
for (let i = 0; i < 300; i++) movePlayer(gs, i % 3 === 0 ? 1 : i % 3 === 1 ? 0 : -1, 1);
const t1 = performance.now();
console.log(`perf 300 moves+combat+knowledge: ${(t1 - t0).toFixed(1)}ms`);

const t2 = performance.now();
for (let cy = 0; cy < 128; cy++) for (let cx = 0; cx < 128; cx++) sampleCell("world", world, cx * 32, cy * 32);
const t3 = performance.now();
console.log(`perf full world overview build: ${(t3 - t2).toFixed(1)}ms`);

const fac = getFactions(gs.seed);
const t4 = performance.now();
let sink = 0;
for (let i = 0; i < 20000; i++) sink += fac.nationAt((i * 131) % 4096, (i * 197) % 4096) ? 1 : 0;
const t5 = performance.now();
console.log(`perf 20000 nationAt lookups: ${(t5 - t4).toFixed(1)}ms (sink ${sink})`);
console.log(`info save JSON size: ${(json.length / 1024).toFixed(1)}KB`);

if (fails) {
  console.log(`\n${fails} FAILURES`);
  process.exit(1);
}
console.log("\nALL CHECKS PASSED");
