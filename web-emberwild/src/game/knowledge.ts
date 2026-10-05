import { WORLD_SIZE } from "./data";
import { addLog, compass } from "./log";
import { computeVisibleFrom, perceptionSources, seesTile } from "./perception";
import type { Discovery, FeatureId, GameState } from "./types";
import { type World, getWorld } from "./world";

/**
 * WorldKnowledge — the map IS what the player knows, never what the generator
 * knows. Every helper here reads/mutates gs.knowledge only.
 *
 * Three persistent tiers (plus transient visibility, see perception.ts):
 *  - unexplored: nothing recorded; maps render fog.
 *  - explored:   8×8-tile cells the player has observed; basic geography persists.
 *  - discovered: specific named landmarks (hamlet/shrine/ruin/lair) persist forever.
 */

/** Explored-cell granularity in tiles. */
export const EXPLORE_CELL = 8;
const EXPLORE_GRID = 512; // 4096 / 8
const REGION_CELL = 160;

export const eCellKey = (x: number, y: number): number => ((y >> 3) << 9) | (x >> 3);
export const regionKey = (x: number, y: number): string => `${Math.floor(x / REGION_CELL)},${Math.floor(y / REGION_CELL)}`;
export const featureKey = (x: number, y: number): string => `f:${x}:${y}`;

export function emptyKnowledge() {
  return { explored: {}, discovered: {}, regionsSeen: {}, nationsSeen: {}, assocSeen: {}, route: [] as [number, number][] };
}

/**
 * Guarantees the knowledge fields exist. Used by save migration (v3 → v4):
 * old saves get a one-time welcoming backfill around where the player stands,
 * so existing journeys keep their bearings instead of opening in total fog.
 */
export function ensureKnowledge(state: GameState, backfill = false): void {
  if (!state.knowledge) state.knowledge = emptyKnowledge();
  const k = state.knowledge;
  if (!k.explored) k.explored = {};
  if (!k.discovered) k.discovered = {};
  if (!k.regionsSeen) k.regionsSeen = {};
  if (!k.nationsSeen) k.nationsSeen = {};
  if (!k.assocSeen) k.assocSeen = {};
  if (!k.route) k.route = [];
  if (!backfill) return;
  const world = getWorld(state.seed);
  const { x: px, y: py } = state.player;
  const R = 9;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R * R) continue;
      const x = px + dx;
      const y = py + dy;
      if (world.inBounds(x, y)) k.explored[eCellKey(x, y)] = 1;
    }
  }
  k.regionsSeen[regionKey(px, py)] = 1;
  if (!k.route.length) k.route.push([px, py]);
  const f = world.tile(px, py).feature;
  if (f) discoverFeature(state, f, false);
}

export function isExplored(k: GameState["knowledge"], x: number, y: number): boolean {
  return k.explored[eCellKey(x, y)] === 1;
}

/** Is any explored cell inside this rectangle (world-tile coords, inclusive)? */
export function anyExplored(k: GameState["knowledge"], tx0: number, ty0: number, tx1: number, ty1: number): boolean {
  const cx0 = tx0 >> 3;
  const cy0 = ty0 >> 3;
  const cx1 = tx1 >> 3;
  const cy1 = ty1 >> 3;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (k.explored[(cy << 9) | cx] === 1) return true;
    }
  }
  return false;
}

/** Set of aggregated 32×32 world cells containing at least one explored sub-cell. */
export function exploredWorldCells(k: GameState["knowledge"]): Set<number> {
  const s = new Set<number>();
  for (const key in k.explored) {
    const n = Number(key);
    s.add(((n >> 9) >> 2) * 128 + ((n & 511) >> 2));
  }
  return s;
}

export function isRegionSeen(k: GameState["knowledge"], x: number, y: number): boolean {
  return k.regionsSeen[regionKey(x, y)] === 1;
}

export type TileAwareness = "visible" | "memory" | "fog";

/** Combines transient perception with persistent knowledge for one tile. */
export function tileVisibility(state: GameState, x: number, y: number): TileAwareness {
  if (seesTile(state, x, y)) return "visible";
  if (isExplored(state.knowledge, x, y)) return "memory";
  return "fog";
}

/** Records a landmark as known. Returns true when newly discovered. */
export function discoverFeature(state: GameState, f: { kind: FeatureId; name: string; x: number; y: number }, announce = true): boolean {
  const k = state.knowledge;
  const key = featureKey(f.x, f.y);
  if (k.discovered[key]) return false;
  const d: Discovery = { kind: f.kind, name: f.name, x: f.x, y: f.y, tick: state.tick };
  k.discovered[key] = d;
  k.regionsSeen[regionKey(f.x, f.y)] = 1;
  if (announce) {
    const where = compass(f.x - state.player.x, f.y - state.player.y);
    const line: Record<FeatureId, string> = {
      hamlet: `You spot ${f.name} ${where}. Chimney smoke threads the sky.`,
      ruin: `You make out the ${f.name} ${where}, old stones keeping their own counsel.`,
      shrine: `A pale green light marks ${f.name} ${where}.`,
      lair: `You glimpse a ${f.name} ${where}. Best give it room.`,
    };
    addLog(state, line[f.kind], "event");
  }
  return true;
}

/**
 * Folds the player's current perception into persistent knowledge:
 * marks observed cells as explored, learns the region name, and discovers
 * landmarks that are actually visible (terrain line-of-sight respected).
 * Called whenever time advances — never on a render timer.
 */
export function updateKnowledge(state: GameState): void {
  const world = getWorld(state.seed);
  const k = state.knowledge;
  if (!k) return;
  const sources = perceptionSources(state).filter((s) => s.tag === "player");
  const visible = computeVisibleFrom(state, sources);
  const src = sources[0];
  for (const key of visible) {
    const x = key % WORLD_SIZE;
    const y = Math.floor(key / WORLD_SIZE);
    k.explored[eCellKey(x, y)] = 1;
  }
  k.regionsSeen[regionKey(state.player.x, state.player.y)] = 1;
  if (src) {
    for (const f of world.featuresNear(state.player.x, state.player.y, src.radius + 2)) {
      if (Math.max(Math.abs(f.x - src.x), Math.abs(f.y - src.y)) > src.radius) continue;
      if (!visible.has(f.y * WORLD_SIZE + f.x)) continue;
      discoverFeature(state, f, true);
    }
  }
}

/** Drops a breadcrumb on the player's traveled route (kept sparse). */
export function markRoute(state: GameState): void {
  const route = state.knowledge.route;
  const { x, y } = state.player;
  const last = route[route.length - 1];
  if (last && Math.max(Math.abs(last[0] - x), Math.abs(last[1] - y)) < 6) return;
  route.push([x, y]);
  if (route.length > 1200) route.splice(0, route.length - 1000);
}

export function discoveredList(k: GameState["knowledge"]): Discovery[] {
  return Object.values(k.discovered);
}
