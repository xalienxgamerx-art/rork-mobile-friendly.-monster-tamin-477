import { WORLD_SIZE } from "./data";
import type { BiomeId } from "./types";
import { type World } from "./world";

/**
 * MapData / MapAggregation — one world, three resolutions.
 *
 * All scales sample the SAME world coordinates, so a hill seen at LOCAL is
 * the same hill colored at REGION and the same highland cell at WORLD.
 * Aggregates are cached per seed; only cells inside the current window are
 * ever computed. Nothing here decides what the player is allowed to know —
 * knowledge gating lives in knowledge.ts and the renderer.
 */
export type MapScale = "world" | "region" | "local";

/** World tiles covered by one cell at each scale. */
export const SCALE_CELL: Record<MapScale, number> = { world: 32, region: 4, local: 1 };

/** Zoom-in order: world → region → local. */
export function zoomIn(scale: MapScale): MapScale {
  return scale === "world" ? "region" : "local";
}

/** Zoom-out order: local → region → world. */
export function zoomOut(scale: MapScale): MapScale {
  return scale === "local" ? "region" : "world";
}

export interface MapSample {
  biome: BiomeId;
  elev: number;
  river: boolean;
  water: boolean;
}

const isWater = (b: BiomeId): boolean => b === "deep" || b === "sea" || b === "lake";

/* ------------------------------- Agg caches -------------------------------- */

const regionCache = new Map<number, MapSample & { kind: "region" }>();
let regionSeed = -1;
const overviewCache = new Map<number, MapSample & { kind: "world" }>();
let overviewSeed = -1;

function makeAgg(size: number, samples: [number, number][], world: World): MapSample {
  const [sx, sy] = samples[0];
  const t0 = world.tile(sx, sy);
  let river = t0.river;
  let water = isWater(t0.biome);
  let biome = t0.biome;
  for (let i = 1; i < samples.length; i++) {
    const [ox, oy] = samples[i];
    const t = world.tile(ox, oy);
    river = river || t.river;
    water = water || isWater(t.biome);
    if (water && !isWater(biome)) biome = t.biome;
  }
  return { biome, elev: t0.elev, river, water };
}

/** Aggregated sample for the cell of this scale that contains world tile (wx, wy). */
export function sampleCell(scale: "world" | "region", world: World, wx: number, wy: number): MapSample {
  const size = SCALE_CELL[scale];
  const cx = Math.floor(wx / size);
  const cy = Math.floor(wy / size);
  if (cx < 0 || cy < 0 || cx * size >= WORLD_SIZE || cy * size >= WORLD_SIZE) {
    return { biome: "deep", elev: 0, river: false, water: true };
  }
  if (scale === "region") {
    if (regionSeed !== world.seed) {
      regionSeed = world.seed;
      regionCache.clear();
    }
    const key = cy * 1024 + cx;
    let c = regionCache.get(key);
    if (!c) {
      const bx = cx * size;
      const by = cy * size;
      c = { kind: "region", ...makeAgg(size, [[bx + 2, by + 2], [bx + 3, by + 1], [bx + 1, by + 3]], world) };
      regionCache.set(key, c);
      if (regionCache.size > 80000) regionCache.clear();
    }
    return c;
  }
  if (overviewSeed !== world.seed) {
    overviewSeed = world.seed;
    overviewCache.clear();
  }
  const key = cy * 128 + cx;
  let c = overviewCache.get(key);
  if (!c) {
    const bx = cx * size;
    const by = cy * size;
    c = { kind: "world", ...makeAgg(size, [[bx + 16, by + 16], [bx + 22, by + 10], [bx + 9, by + 24]], world) };
    overviewCache.set(key, c);
  }
  return c;
}

/** Pre-builds the whole-world overview in small chunks; returns a cancel fn. */
export function warmOverviewAsync(seed: number, world: World, rowsPerChunk = 12): () => void {
  if (overviewSeed === seed && overviewCache.size >= 128 * 128) return () => undefined;
  let cy = 0;
  const id = setInterval(() => {
    for (let i = 0; i < rowsPerChunk && cy < 128; i++, cy++) {
      for (let cx = 0; cx < 128; cx++) sampleCell("world", world, cx * 32, cy * 32);
    }
    if (cy >= 128) clearInterval(id);
  }, 40);
  return () => clearInterval(id);
}

/** Warms region cells around a point so opening the region map rarely computes. */
export function warmRegionAround(world: World, x: number, y: number, radiusTiles = 120): void {
  const size = SCALE_CELL.region;
  const c0x = Math.floor((x - radiusTiles) / size);
  const c1x = Math.floor((x + radiusTiles) / size);
  const c0y = Math.floor((y - radiusTiles) / size);
  const c1y = Math.floor((y + radiusTiles) / size);
  for (let cy = c0y; cy <= c1y; cy++) {
    for (let cx = c0x; cx <= c1x; cx++) {
      if (cx < 0 || cy < 0) continue;
      sampleCell("region", world, cx * size, cy * size);
    }
  }
}
