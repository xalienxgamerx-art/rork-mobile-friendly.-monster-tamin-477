import { BIOMES, NAME_A, NAME_B, SPECIES_LIST, WORLD_SIZE } from "./data";
import { addLog } from "./log";
import { hash2, hash01 } from "./rng";
import type { Feature, World } from "./world";
import { getWorld } from "./world";
import type { GameState } from "./types";

/**
 * Nations & beast-tamer associations — political geography as a pure function
 * of the seed, exactly like every other world system.
 *
 *  - Nations claim territory in weighted Voronoi blobs around capital hamlets,
 *    with three tiers (major realms, minor domains, free cities) so mixed sizes
 *    exist side by side. Unclaimable terrain (deep water, peaks) stays frontier.
 *  - Associations are chartered by one origin nation, keep a chapter hall in one
 *    of that nation's hamlets, and post notices about duels, tourneys and the
 *    legal sale of beasts.
 *
 * Nothing here decides what the player knows — learning nations and
 * associations mutates GameState.knowledge only, and that is all a save stores.
 */

/** Territory granularity in world tiles (a 4096² world is a 103×103 faction grid). */
export const FACTION_CELL = 40;
const REGION = 160;
const RG = Math.ceil(WORLD_SIZE / REGION);

export type NationTier = "major" | "minor" | "free";

export interface Nation {
  id: string;
  name: string;
  form: string;
  title: string;
  tier: NationTier;
  color: string;
  capX: number;
  capY: number;
  /** The capital hamlet the nation grew around. */
  hamlet: Feature;
  reach: number;
  power: number;
  associations: Association[];
}

export interface Association {
  id: string;
  name: string;
  nationId: string;
  /** The hamlet where this association keeps its chapter hall. */
  chapter: Feature;
}

export interface Notice {
  text: string;
  assoc: Association;
}

/** Heraldic banner colors, tuned to read over the night-blue map. */
const HERALDIC = [
  "#a33327", "#2f5f8a", "#c9a227", "#3d6b35", "#7b3f9d", "#a05a2c",
  "#8e2f4f", "#2e7d76", "#5a6b2f", "#8a5a3a", "#4f6d9e", "#9e4f2e",
];

const FORMS: Record<NationTier, string[]> = {
  major: ["Kingdom", "Empire", "Grand Duchy"],
  minor: ["March", "Duchy", "Barony", "Earldom"],
  free: ["Free City", "Burgh", "Canton"],
};

interface TierPass {
  tier: NationTier;
  gate: number;
  minDist: number;
  cap: number;
  reach: number;
  power: [number, number];
}

const TIER_PASSES: TierPass[] = [
  { tier: "major", gate: 0.5, minDist: 1250, cap: 6, reach: 1050, power: [2.2, 2.6] },
  { tier: "minor", gate: 0.62, minDist: 780, cap: 13, reach: 640, power: [1.35, 1.65] },
  { tier: "free", gate: 0.55, minDist: 520, cap: 19, reach: 420, power: [0.85, 1.05] },
];

const ASSOC_CORES = [
  "Beast Court", "Tamers' Compact", "Leash & Ledger", "Pit Wardens",
  "Beast Charter", "Tamer's Assembly", "Ledger of Beasts", "Arena Conclave",
];

const NOTICE_SEASONS = ["Spring", "Summer", "Autumn", "Winter"];

interface CellInfo {
  nat: Nation | null;
  claimable: boolean;
}

export class Factions {
  readonly seed: number;
  readonly nations: Nation[] = [];
  readonly assocs: Association[] = [];
  private world: World;
  private cellCache = new Map<number, CellInfo>();

  constructor(seed: number, world: World) {
    this.seed = seed;
    this.world = world;
    this.build();
  }

  private build(): void {
    /* ------------------------------ capitals ------------------------------ */
    interface Candidate {
      hamlet: Feature;
      rx: number;
      ry: number;
      order: number;
    }
    const settled = (f: Feature): boolean => {
      const b = this.world.tile(f.x, f.y).biome;
      return b === "meadow" || b === "forest" || b === "hills" || b === "steppe" || b === "taiga" || b === "beach";
    };
    const cand: Candidate[] = [];
    for (let ry = 0; ry < RG; ry++) {
      for (let rx = 0; rx < RG; rx++) {
        const cx = Math.min(WORLD_SIZE - 1, rx * REGION + 80);
        const cy = Math.min(WORLD_SIZE - 1, ry * REGION + 80);
        const hamlets = this.world.featuresNear(cx, cy, 80).filter((f) => f.kind === "hamlet");
        if (!hamlets.length) continue;
        hamlets.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
        const ham = hamlets.find(settled) ?? hamlets[0];
        cand.push({ hamlet: ham, rx, ry, order: hash01(this.seed ^ 0xfa71, rx, ry) });
      }
    }
    cand.sort((a, b) => a.order - b.order);

    const usedNames = new Set<string>();
    const usedHamlets = new Set<string>();
    const accepted: { n: Nation }[] = [];
    for (let pi = 0; pi < TIER_PASSES.length; pi++) {
      const pass = TIER_PASSES[pi];
      for (const c of cand) {
        if (this.nations.length >= pass.cap) break;
        if (hash01(this.seed ^ (0xfa81 + pi), c.rx, c.ry) >= pass.gate) continue;
        const key = `${c.hamlet.x}:${c.hamlet.y}`;
        if (usedHamlets.has(key)) continue;
        if (accepted.some((a) => Math.hypot(a.n.capX - c.hamlet.x, a.n.capY - c.hamlet.y) < pass.minDist)) continue;
        const h = hash2(this.seed ^ 0x6a7e, c.hamlet.x, c.hamlet.y);
        let name = "";
        for (let s = 0; s < 30 && !name; s++) {
          const hh = hash2(this.seed ^ (0x6a7e + s * 7919), c.hamlet.x * 3 + s, c.hamlet.y * 5 + s);
          const candidate = NAME_A[hh % NAME_A.length] + NAME_B[(hh >>> 8) % NAME_B.length];
          if (!usedNames.has(candidate)) name = candidate;
        }
        if (!name) name = `${NAME_A[h % NAME_A.length]}${NAME_B[(h >>> 8) % NAME_B.length]}`;
        usedNames.add(name);
        usedHamlets.add(key);
        const forms = FORMS[pass.tier];
        const form = forms[(h >>> (4 + pi * 3)) % forms.length];
        const power = pass.power[0] + (hash01(this.seed ^ 0x70e4, c.hamlet.x, c.hamlet.y) * (pass.power[1] - pass.power[0]));
        // keep neighboring banners visually distinct
        const nearSame = accepted.filter((a) => Math.hypot(a.n.capX - c.hamlet.x, a.n.capY - c.hamlet.y) < 900);
        let ci = (h >>> 16) % HERALDIC.length;
        for (let k = 0; k < HERALDIC.length && nearSame.some((a) => a.n.color === HERALDIC[ci]); k++) ci = (ci + 1) % HERALDIC.length;
        const nation: Nation = {
          id: `n:${c.hamlet.x}:${c.hamlet.y}`,
          name,
          form,
          title: `${form} of ${name}`,
          tier: pass.tier,
          color: HERALDIC[ci],
          capX: c.hamlet.x,
          capY: c.hamlet.y,
          hamlet: c.hamlet,
          reach: pass.reach,
          power,
          associations: [],
        };
        this.nations.push(nation);
        accepted.push({ n: nation });
      }
    }

    /* ---------------------------- associations ---------------------------- */
    const usedCores = new Set<string>();
    for (const nation of this.nations) {
      const h = hash2(this.seed ^ 0xacc7, nation.capX, nation.capY);
      const roll = h % 10;
      const count = roll < 4 ? 0 : roll < 8 ? 1 : 2;
      if (!count) continue;
      const inNation = this.world
        .featuresNear(nation.capX, nation.capY, nation.reach)
        .filter((f) => f.kind === "hamlet" && this.nationAt(f.x, f.y) === nation);
      const offCapital = inNation.filter((f) => f.x !== nation.capX || f.y !== nation.capY);
      const pool = offCapital.length ? offCapital : inNation;
      const usedChapters = new Set<string>();
      for (let i = 0; i < count && pool.length > usedChapters.size; i++) {
        const hh = hash2(this.seed ^ (0xbee1 + i * 31), nation.capX, nation.capY);
        const chapter = pool.filter((f) => !usedChapters.has(`${f.x}:${f.y}`))[hh % Math.max(1, pool.length - usedChapters.size)] ?? null;
        if (!chapter) break;
        usedChapters.add(`${chapter.x}:${chapter.y}`);
        let core = "";
        for (let s = 0; s < 20 && !core; s++) {
          const candidate = ASSOC_CORES[(hh >>> (3 + s * 5)) % ASSOC_CORES.length];
          if (!usedCores.has(candidate)) core = candidate;
        }
        if (!core) core = ASSOC_CORES[(hh >>> 3) % ASSOC_CORES.length];
        usedCores.add(core);
        const assoc: Association = {
          id: `a:${chapter.x}:${chapter.y}`,
          name: `${core} of ${nation.name}`,
          nationId: nation.id,
          chapter,
        };
        this.assocs.push(assoc);
        nation.associations.push(assoc);
      }
    }
  }

  /** The nation whose territory covers this faction cell (lazily cached). */
  nationAtCell(fcx: number, fcy: number): Nation | null {
    return this.cell(fcx, fcy).nat;
  }

  /** Whether this faction cell is claimable land at all (not sea or peak). */
  claimableCell(fcx: number, fcy: number): boolean {
    return this.cell(fcx, fcy).claimable;
  }

  /** The nation whose territory covers this world tile (null = unclaimed). */
  nationAt(x: number, y: number): Nation | null {
    if (x < 0 || y < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE) return null;
    return this.nationAtCell(Math.floor(x / FACTION_CELL), Math.floor(y / FACTION_CELL));
  }

  private cell(fcx: number, fcy: number): CellInfo {
    if (fcx < 0 || fcy < 0 || fcx > WORLD_SIZE / FACTION_CELL || fcy > WORLD_SIZE / FACTION_CELL) return { nat: null, claimable: false };
    const key = fcy * 1024 + fcx;
    const c = this.cellCache.get(key);
    if (c) return c;
    const wx = fcx * FACTION_CELL + FACTION_CELL / 2;
    const wy = fcy * FACTION_CELL + FACTION_CELL / 2;
    const t = this.world.tile(wx, wy);
    const claimable = BIOMES[t.biome].passable;
    let nat: Nation | null = null;
    if (claimable) {
      let best = Infinity;
      for (const n of this.nations) {
        const dx = wx - n.capX;
        const dy = wy - n.capY;
        const d2 = dx * dx + dy * dy;
        if (Math.sqrt(d2) > n.reach) continue;
        const score = d2 / n.power;
        if (score < best) {
          best = score;
          nat = n;
        }
      }
    }
    const info: CellInfo = { nat, claimable };
    this.cellCache.set(key, info);
    return info;
  }

  nationById(id: string): Nation | null {
    return this.nations.find((n) => n.id === id) ?? null;
  }

  /** The association whose chapter hall stands on this hamlet feature, if any. */
  associationAt(f: Feature): Association | null {
    const nation = this.nationAt(f.x, f.y);
    if (!nation) return null;
    return nation.associations.find((a) => a.chapter.x === f.x && a.chapter.y === f.y) ?? null;
  }

  /** 1–3 notices posted at a hamlet; empty where no association holds a charter. */
  hamletNotices(f: Feature): Notice[] {
    const nation = this.nationAt(f.x, f.y);
    if (!nation || !nation.associations.length) return [];
    const h = hash2(this.seed ^ 0x0e0e, f.x, f.y);
    const assoc = nation.associations[h % nation.associations.length];
    const h2 = hash2(this.seed ^ 0x0e0f, f.x, f.y);
    const count = 1 + (h2 % 3);
    const season = NOTICE_SEASONS[(h2 >>> 6) % 4];
    const sp = SPECIES_LIST[(h2 >>> 12) % SPECIES_LIST.length].name;
    const templates: ((a: Association) => string)[] = [
      (a) => `The ${season} Tourney comes to ${f.name}. Tamers of good standing may enter one beast; wagers close at the opening horn. — ${a.name}`,
      (a) => `Human duels are lawful only in the sanctioned ring. First blood or yielded ground. No beasts inside the ropes. — ${a.name}`,
      (a) => `Auction license renewed for the ${f.name} market. Unlicensed beast sales will be seized and fined. — ${a.name}`,
      (a) => `Sale of the ${sp} is restricted in ${nation.title} this season. Permits are issued at the chapter hall. — ${a.name}`,
      (a) => `Tamers found selling ailing beasts forfeit their license, their beast, and their standing. — ${a.name}`,
      (a) => `Every beast entered at ${f.name} must bear the ${a.name} brand before the scales. — ${a.name}`,
    ];
    const out: Notice[] = [];
    const used = new Set<number>();
    for (let i = 0; i < count; i++) {
      const idx = (h + i * 5 + (h2 >>> 3)) % templates.length;
      if (used.has(idx)) continue;
      used.add(idx);
      out.push({ text: templates[idx](assoc), assoc });
    }
    return out;
  }
}

let factionsSingleton: { seed: number; fac: Factions } | null = null;

/** The factions of a world, one instance per seed (like getWorld). */
export function getFactions(seed: number, world?: World): Factions {
  if (!factionsSingleton || factionsSingleton.seed !== seed) {
    factionsSingleton = { seed, fac: new Factions(seed, world ?? getWorld(seed)) };
  }
  return factionsSingleton.fac;
}

/**
 * Marks what reading a hamlet's notices board teaches: the local nation (if
 * not already known) and any association whose chapter stands here.
 */
export function learnNotices(state: GameState, f: Feature): void {
  const fac = getFactions(state.seed);
  const nation = fac.nationAt(f.x, f.y);
  if (!nation) return;
  const k = state.knowledge;
  if (!k.nationsSeen) k.nationsSeen = {};
  if (!k.assocSeen) k.assocSeen = {};
  const newNation = !k.nationsSeen[nation.id];
  k.nationsSeen[nation.id] = 1;
  for (const a of nation.associations) {
    if (a.chapter.x === f.x && a.chapter.y === f.y && !k.assocSeen[a.id]) {
      k.assocSeen[a.id] = 1;
      addLog(state, `The notices board names the ${a.name}, chartered by ${nation.title}.`, "event");
    }
  }
  if (newNation) addLog(state, `These lands answer to ${nation.title}.`, "system");
}

/**
 * Save migration (v9 → v10): backfill faction knowledge records and silently
 * resolve which banner the player currently stands under.
 */
export function migrateFactionKnowledge(gs: GameState): void {
  if (!gs.knowledge) gs.knowledge = { explored: {}, discovered: {}, regionsSeen: {}, route: [], nationsSeen: {}, assocSeen: {} };
  if (!gs.knowledge.nationsSeen) gs.knowledge.nationsSeen = {};
  if (!gs.knowledge.assocSeen) gs.knowledge.assocSeen = {};
  if (!gs.lastNation) {
    const nat = getFactions(gs.seed).nationAt(gs.player.x, gs.player.y);
    gs.lastNation = nat?.id ?? "";
    if (nat) gs.knowledge.nationsSeen[nat.id] = 1;
  }
}
