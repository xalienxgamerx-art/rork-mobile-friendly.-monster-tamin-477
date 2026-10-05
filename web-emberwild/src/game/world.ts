import { BIOMES, DAY_TICKS, HAMLET_SUFFIX, LAIR_NAMES, NAME_A, NAME_B, RUIN_NAMES, SEASON_DAYS, SHRINE_NAMES, SPECIES_LIST, TICK_MINUTES, WORLD_SIZE } from "./data";
import { Perlin, clamp01, hash01, hash2, hashString } from "./rng";
import type { BiomeId, FeatureId, ItemId, WeatherId } from "./types";

export interface Feature {
  kind: FeatureId;
  name: string;
  x: number;
  y: number;
  speciesId: string | null;
}

/** One tile of a landmark's physical structure: walls, floors, doors, rubble. */
export interface SitePiece {
  kind: FeatureId;
  feature: Feature;
  wall: boolean;
  door: boolean;
  rubble: boolean;
}

/** A hamlet folk member standing at their post — pure function of the seed. */
export interface Npc {
  role: "innkeep" | "trader" | "penkeeper";
  name: string;
  hamlet: string;
  x: number;
  y: number;
  line: string;
}

export interface TileInfo {
  x: number;
  y: number;
  biome: BiomeId;
  elev: number;
  height: number;
  baseTemp: number;
  moist: number;
  river: boolean;
  feature: Feature | null;
}

export interface WeatherInfo {
  id: WeatherId;
  temp: number;
  humidity: number;
  wind: number;
  cloud: number;
}

const FEATURE_CELL = 24;
const REGION_CELL = 160;
const SITE_R = 5;
const DIRS8: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

const smooth = (a: number, b: number, t: number): number => {
  const x = clamp01((t - a) / (b - a));
  return x * x * (3 - 2 * x);
};

const ADJ: Record<BiomeId, string[]> = {
  deep: ["Black", "Abyssal"], sea: ["Salt", "Grey"], lake: ["Still", "Glass"],
  river: ["Mossy", "Swift", "Reedy", "Pebbled"], beach: ["Shell", "Driftwood", "Sunny"],
  meadow: ["Clover", "Bright", "Bee-loud", "Golden"], forest: ["Dappled", "Old", "Fern", "Acorn"],
  taiga: ["Hushed", "Needle", "Cold"], gloomwood: ["Weeping", "Pale", "Hollow", "Ashen"],
  marsh: ["Sucking", "Murk", "Frog", "Reed"], steppe: ["Windy", "Long", "Thistle"],
  desert: ["Scorched", "Glass", "Red"], tundra: ["Frost", "Bare", "Lichen"],
  snow: ["White", "Silent"], hills: ["Heather", "Rolling", "Gorse"], mountain: ["Broken", "Eagle", "Scree"],
  peak: ["Sky", "Iron"],
};

export const SEASONS = ["Spring", "Summer", "Autumn", "Winter"] as const;
const SEASON_TEMP = [0, 6, -1, -9];

export function seasonIndex(tick: number): number {
  return Math.floor(Math.floor(tick / DAY_TICKS) / SEASON_DAYS) % 4;
}

export function timeOf(tick: number): { day: number; hour: number; minute: number; label: string; phase: "Dawn" | "Day" | "Dusk" | "Night"; night: boolean; daylight: number } {
  const day = Math.floor(tick / DAY_TICKS) + 1;
  const mins = (tick % DAY_TICKS) * TICK_MINUTES;
  const hour = Math.floor(mins / 60);
  const minute = mins % 60;
  const label = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const phase = hour >= 5 && hour < 8 ? "Dawn" : hour >= 8 && hour < 18 ? "Day" : hour >= 18 && hour < 21 ? "Dusk" : "Night";
  const h = hour + minute / 60;
  const daylight = clamp01(Math.sin(((h - 5.5) / 15) * Math.PI) * 1.4);
  return { day, hour, minute, label, phase, night: phase === "Night", daylight };
}

export class World {
  readonly seed: number;
  private cont: Perlin;
  private elevN: Perlin;
  private ridge: Perlin;
  private moistN: Perlin;
  private tempN: Perlin;
  private riverN: Perlin;
  private river2N: Perlin;
  private warp: Perlin;
  private lakeN: Perlin;
  private gloomN: Perlin;
  private weatherN: Perlin;
  private windN: Perlin;
  private cache = new Map<number, TileInfo>();
  private featureCache = new Map<number, Feature | null>();
  private siteCache = new Map<number, SitePiece | null>();
  private regionCache = new Map<number, string>();
  private start: { x: number; y: number; name: string } | null = null;

  constructor(seed: number) {
    this.seed = seed;
    this.cont = new Perlin(seed ^ 0x1111);
    this.elevN = new Perlin(seed ^ 0x2222);
    this.ridge = new Perlin(seed ^ 0x3333);
    this.moistN = new Perlin(seed ^ 0x4444);
    this.tempN = new Perlin(seed ^ 0x5555);
    this.riverN = new Perlin(seed ^ 0x6666);
    this.river2N = new Perlin(seed ^ 0x6767);
    this.warp = new Perlin(seed ^ 0x7777);
    this.lakeN = new Perlin(seed ^ 0x8888);
    this.gloomN = new Perlin(seed ^ 0x9999);
    this.weatherN = new Perlin(seed ^ 0xaaaa);
    this.windN = new Perlin(seed ^ 0xbbbb);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < WORLD_SIZE && y < WORLD_SIZE;
  }

  /** Raw elevation, 0..1 with sea level at 0.5. */
  elevation(x: number, y: number): number {
    const nx = x / WORLD_SIZE - 0.5;
    const ny = y / WORLD_SIZE - 0.5;
    const d = Math.sqrt(nx * nx + ny * ny) * 2;
    const wx = x + this.warp.fbm(x / 400, y / 400, 2) * 120;
    const wy = y + this.warp.fbm(x / 400 + 31, y / 400 - 17, 2) * 120;
    const cont = this.cont.fbm(wx / 900, wy / 900, 4);
    let e = 0.6 + cont * 0.55 + this.elevN.fbm(wx / 140, wy / 140, 5) * 0.16 - smooth(0.7, 1.05, d) * 0.5;
    const r = 1 - Math.abs(this.ridge.fbm(wx / 380, wy / 380, 4)) * 2.4;
    const ridged = Math.max(0, r) ** 4;
    e += ridged * 0.22 * smooth(0.52, 0.62, e);
    return e;
  }

  tile(x: number, y: number): TileInfo {
    const key = y * WORLD_SIZE + x;
    const c = this.cache.get(key);
    if (c) return c;
    if (this.cache.size > 160000) this.cache.clear();
    const t = this.compute(x, y);
    this.cache.set(key, t);
    return t;
  }

  private compute(x: number, y: number, withFeature = true): TileInfo {
    if (!this.inBounds(x, y)) {
      return { x, y, biome: "deep", elev: 0, height: -400, baseTemp: 4, moist: 1, river: false, feature: null };
    }
    const e = this.elevation(x, y);
    const h = clamp01((e - 0.5) / 0.55) ** 1.5;
    const lat = y / WORLD_SIZE;
    const baseTemp = -9 + lat * 38 + this.tempN.fbm(x / 600, y / 600, 3) * 10 - h * 26;
    const coast = 1 - smooth(0.5, 0.58, e);
    const moist = clamp01(0.5 + this.moistN.fbm(x / 520, y / 520, 4) * 1.05 + coast * 0.18 - h * 0.15);
    let biome: BiomeId;
    let river = false;
    if (e < 0.44) biome = "deep";
    else if (e < 0.5) biome = "sea";
    else {
      const wx = x + this.warp.fbm(x / 90, y / 90, 2) * 30;
      const wy = y + this.warp.fbm(x / 90 + 9, y / 90 + 5, 2) * 30;
      const rv = Math.abs(this.riverN.fbm(wx / 520, wy / 520, 3));
      const rv2 = Math.abs(this.river2N.fbm(wx / 240, wy / 240, 3));
      const riverAllowed = h < 0.5 && e > 0.505;
      if (riverAllowed && (rv < 0.0065 + h * -0.006 + 0.002 || (moist > 0.5 && rv2 < 0.0045 && h < 0.35))) river = true;
      const lake = this.lakeN.fbm(x / 140, y / 140, 3) > 0.36 && h < 0.22 && moist > 0.52;
      if (lake) biome = "lake";
      else if (river) biome = "river";
      else if (h > 0.66) biome = "peak";
      else if (h > 0.44) biome = baseTemp < -8 ? "snow" : "mountain";
      else if (e < 0.512 && baseTemp > 0) biome = "beach";
      else if (baseTemp < -6) biome = "snow";
      else if (baseTemp < 0) biome = "tundra";
      else if (baseTemp < 6) biome = moist > 0.42 ? "taiga" : "tundra";
      else if (baseTemp > 19 && moist < 0.36) biome = "desert";
      else if (moist < 0.42) biome = h > 0.24 ? "hills" : "steppe";
      else if (moist > 0.7 && h < 0.14) biome = "marsh";
      else if (moist > 0.52) {
        biome = this.gloomN.fbm(x / 260, y / 260, 3) > 0.28 ? "gloomwood" : "forest";
      } else biome = h > 0.24 ? "hills" : "meadow";
    }
    const height = Math.round((e - 0.5) * 2 * 3200);
    const info: TileInfo = { x, y, biome, elev: e, height, baseTemp, moist, river, feature: null };
    if (withFeature) info.feature = this.featureAt(x, y, biome);
    return info;
  }

  private cellFeature(cx: number, cy: number): Feature | null {
    const key = cy * 1000 + cx;
    if (this.featureCache.has(key)) return this.featureCache.get(key) ?? null;
    const hh = hash2(this.seed ^ 0xfea7, cx, cy);
    const fx = cx * FEATURE_CELL + 3 + (hh % (FEATURE_CELL - 6));
    const fy = cy * FEATURE_CELL + 3 + ((hh >>> 8) % (FEATURE_CELL - 6));
    let f: Feature | null = null;
    if (this.inBounds(fx, fy)) {
      const e = this.elevation(fx, fy);
      const tile = e > 0.5 ? this.computeBiomeOnly(fx, fy) : "sea";
      const roll = hash01(this.seed ^ 0xbead, cx, cy);
      const pass = BIOMES[tile].passable && tile !== "river";
      if (pass) {
        const settled = tile === "meadow" || tile === "forest" || tile === "hills" || tile === "steppe" || tile === "taiga" || tile === "beach";
        const h2 = hash2(this.seed ^ 0x77, cx, cy);
        if (settled && roll < 0.075) {
          const name = NAME_A[h2 % NAME_A.length] + NAME_B[(h2 >>> 7) % NAME_B.length] + HAMLET_SUFFIX[(h2 >>> 13) % HAMLET_SUFFIX.length];
          f = { kind: "hamlet", name, x: fx, y: fy, speciesId: null };
        } else if (roll < 0.13) {
          f = { kind: "ruin", name: RUIN_NAMES[h2 % RUIN_NAMES.length], x: fx, y: fy, speciesId: null };
        } else if (roll < 0.155) {
          f = { kind: "shrine", name: SHRINE_NAMES[h2 % SHRINE_NAMES.length], x: fx, y: fy, speciesId: null };
        } else if (roll < 0.25) {
          const sp = this.pickSpecies(tile, h2);
          if (sp) f = { kind: "lair", name: `${SPECIES_LIST.find((s) => s.id === sp)?.name ?? "Beast"} ${LAIR_NAMES[(h2 >>> 5) % LAIR_NAMES.length]}`, x: fx, y: fy, speciesId: sp };
        }
      }
    }
    this.featureCache.set(key, f);
    return f;
  }

  private computeBiomeOnly(x: number, y: number): BiomeId {
    const key = y * WORLD_SIZE + x;
    const c = this.cache.get(key);
    if (c) return c.biome;
    return this.compute(x, y, false).biome;
  }

  private featureAt(x: number, y: number, biome: BiomeId): Feature | null {
    if (!BIOMES[biome].passable) return null;
    const f = this.cellFeature(Math.floor(x / FEATURE_CELL), Math.floor(y / FEATURE_CELL));
    return f && f.x === x && f.y === y ? f : null;
  }

  /**
   * The physical structure piece (wall/floor/door) at a tile, if it lies within
   * a landmark's footprint. Pure function of the seed — hamlets, ruins, lairs
   * and shrines are real built places the party can walk into, CoQ-style.
   */
  siteAt(x: number, y: number): SitePiece | null {
    if (!this.inBounds(x, y)) return null;
    const key = y * WORLD_SIZE + x;
    const c = this.siteCache.get(key);
    if (c !== undefined) return c;
    if (this.siteCache.size > 160000) this.siteCache.clear();
    let out: SitePiece | null = null;
    const cx = Math.floor(x / FEATURE_CELL);
    const cy = Math.floor(y / FEATURE_CELL);
    outer: for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const f = this.cellFeature(cx + dx, cy + dy);
        if (!f) continue;
        const p = this.sitePiece(f, x - f.x, y - f.y);
        if (p) {
          out = p;
          break outer;
        }
      }
    }
    this.siteCache.set(key, out);
    return out;
  }

  private sitePiece(f: Feature, lx: number, ly: number): SitePiece | null {
    const ax = Math.abs(lx);
    const ay = Math.abs(ly);
    const mk = (wall: boolean, door = false, rubble = false): SitePiece => ({ kind: f.kind, feature: f, wall, door, rubble });
    if (f.kind === "hamlet") {
      if (ax > SITE_R || ay > SITE_R) return null;
      const border = (x0: number, x1: number, y0: number, y1: number): boolean =>
        lx >= x0 && lx <= x1 && ly >= y0 && ly <= y1 && (lx === x0 || lx === x1 || ly === y0 || ly === y1);
      const doorCell = (doorX: number, doorY: number): boolean => lx === doorX && ly === doorY;
      const door = doorCell(-3, -3) || doorCell(2, -3) || doorCell(0, 3);
      const wall =
        (border(-4, -2, -5, -3) || border(1, 3, -5, -3) || border(-1, 1, 3, 5)) && !door ||
        (lx === -2 && ly === 0) ||
        (lx === 2 && ly === -1);
      const inPlaza = lx * lx + ly * ly <= 30;
      if (!wall && !door && !inPlaza) return null;
      return mk(wall, door);
    }
    if (f.kind === "ruin") {
      if (ax > 4 || ay > 4) return null;
      const gap = (x: number, y: number): boolean => hash2(this.seed ^ 0xbe11, f.x * 97 + x, f.y * 97 + y) % 10 < 4;
      let wall = false;
      if (ax === 4 || ay === 4) wall = !gap(lx, ly);
      else if (ly === 0 && lx >= -2 && lx <= 2 && lx !== 0) wall = !gap(lx, ly);
      else if (lx === -3 && ly >= -2 && ly <= 2) wall = !gap(lx, ly);
      const rubble = !wall && hash2(this.seed ^ 0x1e11, f.x * 31 + lx, f.y * 31 + ly) % 10 < 2;
      return mk(wall, false, rubble);
    }
    if (f.kind === "lair") {
      const d = Math.hypot(lx, ly);
      if (d > 5.2) return null;
      const ent = DIRS8[hash2(this.seed ^ 0x1a17, f.x, f.y) % 8];
      const ea = Math.atan2(ent[1], ent[0]);
      let diff = Math.abs(Math.atan2(ly, lx) - ea);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      if (d <= 3.6) return mk(false);
      const entrance = d <= 5.2 && diff < 0.45;
      return mk(!entrance, entrance && d > 4.4);
    }
    // shrine: a ring of standing stones around a mossy altar floor
    if (ax > 3 || ay > 3) return null;
    if (Math.hypot(lx, ly) > 3.3) return null;
    const stone = (ax === 3 && ly === 0) || (ay === 3 && lx === 0) || (ax === 2 && ay === 2);
    return mk(stone);
  }

  /** Deterministically choose a species that lives in a biome. */
  pickSpecies(biome: BiomeId, h: number): string | null {
    const entries: [string, number][] = [];
    for (const s of SPECIES_LIST) {
      const w = s.biomes[biome] ?? 0;
      if (w > 0) entries.push([s.id, w]);
    }
    const total = entries.reduce((a, [, w]) => a + w, 0);
    if (total <= 0) return null;
    let r = (h / 4294967296) * total;
    for (const [id, w] of entries) {
      r -= w;
      if (r <= 0) return id;
    }
    return entries[entries.length - 1][0];
  }

  private npcCache = new Map<string, Npc[]>();

  /**
   * The folk of a hamlet, each standing by their building's doorway.
   * Deterministic from the seed — nothing about them is persisted.
   */
  hamletNpcs(f: Feature): Npc[] {
    const key = `${f.x}:${f.y}`;
    const c = this.npcCache.get(key);
    if (c) return c;
    const spots: [Npc["role"], number, number][] = [
      ["innkeep", -3, -2],
      ["trader", 2, -2],
      ["penkeeper", 0, 2],
    ];
    const NAMES = ["Marta", "Odd", "Fenn", "Bram", "Sela", "Torv", "Hesta", "Wick", "Grita", "Nol", "Asha", "Curd"];
    const LINES: Record<Npc["role"], string[]> = {
      innkeep: [
        "The hearth's warm and the soup is hot, if the soup is what you call it.",
        "Storm's coming. There is always a storm coming.",
        "Beds are soft, breakfast is grey, and both beat sleeping in a ditch.",
      ],
      trader: [
        "Fair prices! Mostly fair. Some would even say generous.",
        "You've the look of someone about to need a tonic.",
        "No refunds. The last customer knew that far too well.",
      ],
      penkeeper: [
        "Your beasts are safe here. Safer than I'd be out there.",
        "Mind the fence — the feisty one figured out the latch.",
        "Fresh hay twice a day. They eat better than I do.",
      ],
    };
    const npcs = spots.map(([role, dx, dy], i) => {
      const h = hash2(this.seed ^ 0x9bc7, f.x * 7 + i * 11, f.y * 13 + i * 5);
      const lines = LINES[role];
      return { role, name: NAMES[h % NAMES.length], hamlet: f.name, x: f.x + dx, y: f.y + dy, line: lines[(h >>> 8) % lines.length] };
    });
    this.npcCache.set(key, npcs);
    return npcs;
  }

  /** The hamlet folk member standing at this tile, if any. */
  npcAt(x: number, y: number): Npc | null {
    for (const f of this.featuresNear(x, y, SITE_R + 1)) {
      if (f.kind !== "hamlet") continue;
      for (const n of this.hamletNpcs(f)) if (n.x === x && n.y === y) return n;
    }
    return null;
  }

  featuresNear(x: number, y: number, radius: number): Feature[] {
    const out: Feature[] = [];
    const c0x = Math.floor((x - radius) / FEATURE_CELL);
    const c1x = Math.floor((x + radius) / FEATURE_CELL);
    const c0y = Math.floor((y - radius) / FEATURE_CELL);
    const c1y = Math.floor((y + radius) / FEATURE_CELL);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        if (cx < 0 || cy < 0) continue;
        const f = this.cellFeature(cx, cy);
        if (f && Math.abs(f.x - x) <= radius && Math.abs(f.y - y) <= radius) out.push(f);
      }
    }
    return out;
  }

  regionName(x: number, y: number): string {
    const rx = Math.floor(x / REGION_CELL);
    const ry = Math.floor(y / REGION_CELL);
    const key = ry * 1000 + rx;
    const c = this.regionCache.get(key);
    if (c) return c;
    const h = hash2(this.seed ^ 0x4e61, rx, ry);
    const name = NAME_A[h % NAME_A.length] + NAME_B[(h >>> 9) % NAME_B.length];
    this.regionCache.set(key, name);
    return name;
  }

  tileTitle(t: TileInfo): string {
    if (t.feature) return t.feature.name;
    const list = ADJ[t.biome];
    const h = hash2(this.seed ^ 0xad1, Math.floor(t.x / 6), Math.floor(t.y / 6));
    return `${list[h % list.length]} ${BIOMES[t.biome].noun}`;
  }

  weather(x: number, y: number, tick: number): WeatherInfo {
    const t = this.tile(x, y);
    const time = timeOf(tick);
    const season = seasonIndex(tick);
    const hr = time.hour + time.minute / 60;
    const tt = tick / 260;
    const cloud = this.weatherN.fbm(x / 340 + tt, y / 340 - tt * 0.6, 3) + (t.moist - 0.5) * 0.35 + (season === 2 ? 0.06 : 0);
    const wind = clamp01(0.45 + this.windN.fbm(x / 500 - tt * 0.8, y / 500 + tt, 2) * 1.4 + (t.biome === "steppe" || t.biome === "desert" ? 0.15 : 0));
    const diurnal = -5 * Math.cos(((hr - 3) / 24) * Math.PI * 2);
    let temp = t.baseTemp + SEASON_TEMP[season] + diurnal - Math.max(0, cloud) * 4;
    let id: WeatherId = "clear";
    if (t.biome === "desert") {
      id = wind > 0.78 ? "sandstorm" : cloud > 0.3 ? "cloudy" : "clear";
    } else if (cloud > 0.26 && t.moist > 0.3) {
      if (temp < 0.5) id = "snow";
      else id = cloud > 0.42 ? "storm" : "rain";
    } else if (hr >= 4 && hr < 9 && t.moist > 0.58 && cloud > -0.05) id = "fog";
    else if (cloud > 0.1) id = "cloudy";
    if (id === "rain" || id === "storm") temp -= 2;
    temp = Math.round(temp * 10) / 10;
    const humidity = Math.round(clamp01(t.moist * 0.6 + (cloud + 0.4) * 0.45 + (id === "rain" || id === "storm" ? 0.2 : 0) + (id === "fog" ? 0.25 : 0) - (t.biome === "desert" ? 0.35 : 0)) * 100);
    return { id, temp, humidity, wind, cloud };
  }

  /** Whether a forageable item is present here right now, given depletion records. */
  forage(x: number, y: number, tick: number, depleted: Record<string, number>): ItemId | null {
    const t = this.tile(x, y);
    const b = BIOMES[t.biome];
    if (b.forage.length === 0) return null;
    const key = `${x},${y}`;
    const dep = depleted[key];
    if (dep !== undefined && tick - dep < DAY_TICKS * 2) return null;
    const season = seasonIndex(tick);
    const mult = season === 3 ? 0.45 : season === 1 ? 1.15 : 1;
    const window = Math.floor(tick / (DAY_TICKS * 2));
    const roll = hash01(this.seed ^ (0xf00d + window), x, y);
    if (roll > b.forageChance * mult) return null;
    const h = hash2(this.seed ^ 0xf11d, x, y);
    const total = b.forage.reduce((a, [, w]) => a + w, 0);
    let r = (h / 4294967296) * total;
    for (const [id, w] of b.forage) {
      r -= w;
      if (r <= 0) return id;
    }
    return b.forage[0][0];
  }

  /** Find a starting hamlet near the heart of the world. */
  startPoint(): { x: number; y: number; name: string } {
    if (this.start) return this.start;
    const cx = Math.floor(WORLD_SIZE / 2);
    const cy = Math.floor(WORLD_SIZE * 0.56);
    let best: Feature | null = null;
    let bestD = Infinity;
    for (let ring = 0; ring < 40 && !best; ring++) {
      const r = ring * FEATURE_CELL;
      const fs = this.featuresNear(cx, cy, r + FEATURE_CELL);
      for (const f of fs) {
        if (f.kind !== "hamlet") continue;
        const tb = this.tile(f.x, f.y).biome;
        if (tb !== "meadow" && tb !== "forest" && tb !== "hills" && tb !== "steppe") continue;
        const d = Math.hypot(f.x - cx, f.y - cy);
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
    }
    if (best) this.start = { x: best.x, y: best.y, name: best.name };
    else {
      let found = { x: cx, y: cy, name: "Wayfarer's Rest" };
      outer: for (let r = 0; r < 600; r += 3) {
        for (let a = 0; a < 16; a++) {
          const x = Math.round(cx + Math.cos(a) * r);
          const y = Math.round(cy + Math.sin(a) * r);
          if (BIOMES[this.tile(x, y).biome].passable && this.tile(x, y).biome !== "river") {
            found = { x, y, name: "Wayfarer's Rest" };
            break outer;
          }
        }
      }
      this.start = found;
    }
    return this.start;
  }

  passable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const s = this.siteAt(x, y);
    if (s) return !s.wall;
    return BIOMES[this.tile(x, y).biome].passable;
  }
}

export function seedFromText(text: string): number {
  return hashString(text.trim().toUpperCase() || "EMBER") >>> 0;
}

export function randomSeedText(): string {
  const a = Math.floor(Math.random() * 90000) + 10000;
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 3; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return `${a}-${s}`;
}

let worldSingleton: World | null = null;

export function getWorld(seed: number): World {
  if (!worldSingleton || worldSingleton.seed !== seed) worldSingleton = new World(seed);
  return worldSingleton;
}

/** A* path over the world grid limited to a search budget. */
export function findPath(world: World, sx: number, sy: number, tx: number, ty: number, budget = 6000): [number, number][] | null {
  if (!world.passable(tx, ty)) return null;
  const key = (x: number, y: number): number => (y - sy + 512) * 1024 + (x - sx + 512);
  const open: { x: number; y: number; g: number; f: number }[] = [{ x: sx, y: sy, g: 0, f: 0 }];
  const came = new Map<number, number>();
  const gScore = new Map<number, number>([[key(sx, sy), 0]]);
  let iter = 0;
  while (open.length && iter < budget) {
    iter++;
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.x === tx && cur.y === ty) {
      const path: [number, number][] = [];
      let k = key(cur.x, cur.y);
      let cx = cur.x;
      let cy = cur.y;
      while (!(cx === sx && cy === sy)) {
        path.unshift([cx, cy]);
        const p = came.get(k);
        if (p === undefined) break;
        cx = (p % 1024) - 512 + sx;
        cy = Math.floor(p / 1024) - 512 + sy;
        k = p;
      }
      return path;
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (Math.abs(nx - sx) > 500 || Math.abs(ny - sy) > 500) continue;
        if (!world.passable(nx, ny)) continue;
        const cost = BIOMES[world.tile(nx, ny).biome].cost * (dx && dy ? 1.01 : 1);
        const ng = cur.g + cost;
        const nk = key(nx, ny);
        if (ng < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, ng);
          came.set(nk, key(cur.x, cur.y));
          const hh = Math.max(Math.abs(tx - nx), Math.abs(ty - ny));
          open.push({ x: nx, y: ny, g: ng, f: ng + hh });
        }
      }
    }
  }
  return null;
}
