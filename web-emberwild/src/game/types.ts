export type Element = "neutral" | "fire" | "water" | "earth" | "air" | "nature" | "frost" | "shadow";
export type StatKey = "hp" | "atk" | "def" | "agi" | "wis";
export type Stats = Record<StatKey, number>;
/** The six heritable genes. `size` drives the monster's tile footprint. */
export type GeneKey = "vigor" | "might" | "guard" | "swift" | "wit" | "size";
/** Expressed gene values (derived from genomes; used by UI and legacy saves). */
export type Genes = Record<GeneKey, number>;
/** Two alleles per gene — the genetic source of truth. */
export interface GenePair {
  a: number;
  b: number;
}
export type Genome = Record<GeneKey, GenePair>;

export type BiomeId =
  | "deep" | "sea" | "lake" | "river" | "beach" | "meadow" | "forest" | "taiga" | "gloomwood"
  | "marsh" | "steppe" | "desert" | "tundra" | "snow" | "hills" | "mountain" | "peak";

export type FeatureId = "hamlet" | "ruin" | "shrine" | "lair";

export type ItemId =
  | "berries" | "nuts" | "roasted_nuts" | "fish" | "meat" | "herb" | "mushroom"
  | "cactus_fruit" | "honeycomb" | "ore" | "tonic";

export type PersonalityId = "brave" | "timid" | "curious" | "lazy" | "gluttonous" | "loyal" | "fierce" | "gentle";
export type MutationId =
  | "thick_hide" | "twin_hearted" | "luminous" | "quickened" | "iron_jaw"
  | "old_soul" | "frail" | "hollow_eyed" | "ember_veins" | "star_marked";
export type TraitId =
  | "warm_blooded" | "slick" | "thorny" | "mossy_shell" | "night_eyes" | "flutter"
  | "stoneskin" | "frost_coat" | "regal" | "photosynth" | "sunborn";
export type StatusId = "burning" | "soaked" | "poisoned" | "slowed" | "rooted" | "stunned" | "blinded" | "shelled" | "wary" | "veiled";
export type Terrain =
  | "grass" | "tallgrass" | "flowers" | "water" | "mud" | "rock" | "tree" | "sand" | "snow" | "ash" | "gloom"
  | "wall" | "woodwall" | "floor" | "door" | "rubble";
export type WeatherId = "clear" | "cloudy" | "rain" | "storm" | "snow" | "fog" | "sandstorm";
export type Disposition = "curious" | "skittish" | "aggressive" | "calm";
export type OriginId = "wanderer" | "herbalist" | "ranger" | "scholar";
export type FearKind = "water" | "fire" | "heat" | "cold" | "dark" | "light";
export type Diet = "herbivore" | "carnivore" | "omnivore" | "lithovore";
export type Activity = "diurnal" | "nocturnal" | "crepuscular";
export type Family = "Beast" | "Slime" | "Bird" | "Bug" | "Spirit" | "Dragon" | "Brute";
export type Rarity = "common" | "uncommon" | "rare" | "legendary";
export type Sex = "male" | "female" | "asexual";

export interface Monster {
  uid: string;
  speciesId: string;
  nickname: string | null;
  level: number;
  xp: number;
  hp: number;
  genes: Genome;
  mutations: MutationId[];
  personality: PersonalityId;
  sex: Sex;
  skills: string[];
  satiety: number;
  bond: number;
  plus: number;
  origin: string;
  bornTick: number;
  parents: string[] | null;
  /** Display names captured at synthesis time (parents are consumed on synthesis). */
  parentNames?: string[];
  wins: number;
}

export interface WildCreature {
  id: string;
  speciesId: string;
  level: number;
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  hpFrac: number;
  satiety: number;
  disposition: Disposition;
  activity: string;
  personality: PersonalityId;
  geneSeed: number;
  calmUntil: number;
  alpha: boolean;
  affection: number;
  stalking: boolean;
  /** Id of the lair alpha this minion is loyal to (absent for solo creatures). */
  pack?: string;
}

export type LogKind = "info" | "event" | "combat" | "system" | "good" | "bad" | "weather";

export interface LogEntry {
  id: number;
  tick: number;
  text: string;
  kind: LogKind;
}

export interface Player {
  name: string;
  origin: OriginId;
  scarf: string;
  x: number;
  y: number;
  gold: number;
  homeX: number;
  homeY: number;
  homeName: string;
  fx: number;
  fy: number;
}

export interface GameStats {
  steps: number;
  battles: number;
  tamed: number;
  synthesized: number;
  foraged: number;
}

/** A landmark the player has explicitly found and can place on their maps. */
export interface Discovery {
  kind: FeatureId;
  name: string;
  x: number;
  y: number;
  tick: number;
}

/**
 * The player's knowledge of the world — deliberately separate from the world
 * itself. The procedural world is authoritative; this is only what the player
 * has seen, visited or been told about, and it persists across save/load.
 */
export interface WorldKnowledge {
  /** Explored 8×8-tile cells, key = (cellY << 9) | cellX. */
  explored: Record<number, 1>;
  /** Discovered landmarks, key = `f:x:y`. */
  discovered: Record<string, Discovery>;
  /** 160-tile region cells whose name the player has learned, key = `rx,ry`. */
  regionsSeen: Record<string, 1>;
  /** Nation ids whose banner the player has stood under, key = nation id. */
  nationsSeen: Record<string, 1>;
  /** Association ids the player has learned from notices, key = association id. */
  assocSeen: Record<string, 1>;
  /** The player's own traveled trail (breadcrumbs, capped). */
  route: [number, number][];
}

export interface BStatus {
  id: StatusId;
  turns: number;
}

/** Where a party monster stands on the live map and what it should do there. */
export type FieldOrder = "follow" | "attack" | "hold";

/** How readily a party monster fights on its own initiative. */
export type Aggression = "passive" | "neutral" | "aggressive";

/** A queued skill command: the monster paths into range, then unleashes it. */
export interface SkillOrder {
  skill: string;
  /** Wild creature id, or a party uid for ally/self skills. */
  target: string;
}

/** Per-combatant combat state (statuses and skill cooldowns) on the live map. */
export interface FighterState {
  statuses: BStatus[];
  cooldowns: Record<string, number>;
}

/** Sparse terrain/fire overlay on a world tile, key = "x,y". */
export interface GroundTile {
  fire?: number;
  t?: Terrain;
}

export interface GameState {
  version: number;
  seedText: string;
  seed: number;
  tick: number;
  player: Player;
  party: Monster[];
  pen: Monster[];
  bag: Partial<Record<ItemId, number>>;
  creatures: Record<string, WildCreature>;
  loadedChunks: string[];
  removed: Record<string, number>;
  depleted: Record<string, number>;
  log: LogEntry[];
  logSeq: number;
  seen: Record<string, boolean>;
  tamed: Record<string, boolean>;
  regions: Record<string, string>;
  lastWeather: WeatherId;
  lastRegion: string;
  /** Nation id the player currently stands in ("" = unclaimed wilds). */
  lastNation: string;
  stats: GameStats;
  /** Party monster positions on the live map, key = monster uid. */
  field: Record<string, { x: number; y: number }>;
  /** Party standing orders, key = monster uid. */
  orders: Record<string, FieldOrder>;
  /** Per-monster aggression, key = monster uid; a missing key means "neutral". */
  aggr: Record<string, Aggression>;
  /** Queued skill commands, key = monster uid; resolved on the monster's next turn. */
  skillQ: Record<string, SkillOrder>;
  /** The creature the party is currently targeting (wild creature id). */
  target: string | null;
  /** Sparse fire/terrain overlays on the live map, key = "x,y". */
  ground: Record<string, GroundTile>;
  /** Combat state per combatant: party uids and wild creature ids. */
  fighters: Record<string, FighterState>;
  uidSeq: number;
  knowledge: WorldKnowledge;
}
