import { MUTATIONS, PERSONALITIES, RECIPES, SKILLS, SPECIES } from "./data";
import {
  childGeneration,
  childLineage,
  driftGenome,
  expressGene,
  founderLineage,
  inheritGenome,
  mutationRecords,
  rollGenome,
  sizeStatMul,
  speciesSizePair,
} from "./genetics";
import { Rng, hashString } from "./rng";
import { makeReproProfile, rollReproMode } from "./reproduction";
import type { GameState, GeneKey, Genome, Monster, MutationId, MutationRecord, PersonalityId, Sex, StatKey, Stats } from "./types";

export const GENE_FOR: Record<StatKey, GeneKey> = { hp: "vigor", atk: "might", def: "guard", agi: "swift", wis: "wit" };
export const GENE_LABEL: Record<GeneKey, string> = { vigor: "Vigor", might: "Might", guard: "Guard", swift: "Swift", wit: "Wit", size: "Size" };
export { getGeneGrade as geneGrade } from "./genetics";
const GROWTH: Record<StatKey, number> = { hp: 0.13, atk: 0.09, def: 0.09, agi: 0.08, wis: 0.09 };
const PERSONALITY_IDS = Object.keys(PERSONALITIES) as PersonalityId[];
const GOOD_MUTS: MutationId[] = ["thick_hide", "twin_hearted", "luminous", "quickened", "iron_jaw", "old_soul", "ember_veins", "star_marked"];
const BAD_MUTS: MutationId[] = ["frail", "hollow_eyed"];

/** Founder genome — delegates to the shared genetics module. */
export function rollGenes(rng: Rng, bonus = 0, speciesId: string): Genome {
  return rollGenome(rng, speciesId, bonus);
}

export function rollPersonality(rng: Rng): PersonalityId {
  return rng.pick(PERSONALITY_IDS);
}

/** Display info for each sex: glyph, label and UI color. */
export const SEX_INFO: Record<Sex, { label: string; glyph: string; color: string }> = {
  male: { label: "Male", glyph: "♂", color: "#3f7fd0" },
  female: { label: "Female", glyph: "♀", color: "#c2527f" },
  asexual: { label: "Asexual", glyph: "◌", color: "#8a8477" },
};

/** Rolls a monster's sex: male/female for sexed species, asexual for spirits, slimes, the golem and plants. */
export function rollSex(rng: Rng, speciesId: string): Sex {
  return rollReproMode(rng, speciesId);
}

export function rollMutations(rng: Rng, gloom: boolean): MutationId[] {
  const out: MutationId[] = [];
  const chance = gloom ? 0.18 : 0.06;
  if (rng.chance(chance)) {
    const bad = rng.chance(gloom ? 0.55 : 0.25);
    out.push(bad ? rng.pick(BAD_MUTS) : rng.pick(GOOD_MUTS));
  }
  return out;
}

export function skillsForLevel(speciesId: string, level: number): string[] {
  const sp = SPECIES[speciesId];
  return sp.learnset.filter(([lv]) => lv <= level).map(([, s]) => s).slice(-5);
}

export function xpToNext(level: number): number {
  return Math.round(18 * Math.pow(level, 1.55));
}

export function newUid(state: GameState): string {
  state.uidSeq += 1;
  return `m${state.uidSeq.toString(36)}`;
}

export function createMonster(
  state: GameState,
  speciesId: string,
  level: number,
  opts: {
    genes?: Genome;
    personality?: PersonalityId;
    mutations?: MutationId[];
    origin: string;
    seed: number;
    parents?: string[] | null;
    parentNames?: string[];
    plus?: number;
    sex?: Sex;
    skills?: string[];
    generation?: number;
    lineageId?: string;
    mutHistory?: MutationRecord[];
  },
): Monster {
  const rng = new Rng(opts.seed);
  const genes = opts.genes ?? rollGenes(rng, 0, speciesId);
  const personality = opts.personality ?? rollPersonality(rng);
  const mutations = opts.mutations ?? rollMutations(rng, false);
  const sex = opts.sex ?? rollSex(rng, speciesId);
  const skills = opts.skills ?? skillsForLevel(speciesId, level);
  const mon: Monster = {
    uid: newUid(state),
    speciesId,
    nickname: null,
    level,
    xp: 0,
    hp: 1,
    genes,
    mutations,
    personality,
    sex,
    skills,
    satiety: 80,
    bond: 20,
    plus: opts.plus ?? 0,
    origin: opts.origin,
    bornTick: state.tick,
    parents: opts.parents ?? null,
    parentNames: opts.parentNames,
    generation: opts.generation ?? 1,
    lineageId: opts.lineageId ?? founderLineage("pending"),
    mutHistory: opts.mutHistory ?? [],
    repro: makeReproProfile(sex, level, state.tick),
    wins: 0,
  };
  if (!opts.lineageId) mon.lineageId = founderLineage(mon.uid);
  mon.hp = statOf(mon, "hp");
  return mon;
}

export function statOf(mon: Monster, key: StatKey): number {
  const sp = SPECIES[mon.speciesId];
  const base = sp.base[key];
  const grown = base * (1 + (mon.level - 1) * GROWTH[key]);
  const gene = 0.82 + (expressGene(mon.genes[GENE_FOR[key]]) / 100) * 0.36;
  const size = sizeStatMul(key, expressGene(mon.genes.size));
  let mod = PERSONALITIES[mon.personality].mods[key] ?? 1;
  for (const m of mon.mutations) mod *= MUTATIONS[m].mods[key] ?? 1;
  const plus = 1 + mon.plus * 0.05;
  const hungry = key !== "hp" && mon.satiety < 15 ? 0.88 : 1;
  return Math.max(1, Math.round(grown * gene * size * mod * plus * hungry));
}

export function statsOf(mon: Monster): Stats {
  return { hp: statOf(mon, "hp"), atk: statOf(mon, "atk"), def: statOf(mon, "def"), agi: statOf(mon, "agi"), wis: statOf(mon, "wis") };
}

export function displayName(mon: Monster): string {
  return mon.nickname ?? SPECIES[mon.speciesId].name;
}

/** Grants XP; returns lines describing level-ups and newly learned skills. */
export function grantXp(mon: Monster, amount: number): string[] {
  const lines: string[] = [];
  mon.xp += amount;
  while (mon.xp >= xpToNext(mon.level) && mon.level < 50) {
    mon.xp -= xpToNext(mon.level);
    const before = statOf(mon, "hp");
    mon.level += 1;
    const after = statOf(mon, "hp");
    mon.hp = Math.min(after, mon.hp + (after - before));
    lines.push(`${displayName(mon)} grew to level ${mon.level}!`);
    for (const [lv, skill] of SPECIES[mon.speciesId].learnset) {
      if (lv === mon.level && !mon.skills.includes(skill)) {
        mon.skills.push(skill);
        if (mon.skills.length > 6) mon.skills.shift();
        lines.push(`${displayName(mon)} learned ${SKILLS[skill].name}.`);
      }
    }
  }
  return lines;
}

export function synthesisResult(a: Monster, b: Monster): string {
  for (const [x, y, r] of RECIPES) {
    if ((a.speciesId === x && b.speciesId === y) || (a.speciesId === y && b.speciesId === x)) return r;
  }
  return SPECIES[a.speciesId].family === SPECIES[b.speciesId].family || a.level >= b.level ? a.speciesId : b.speciesId;
}

export interface SynthPreview {
  speciesId: string;
  plus: number;
  genes: Genome;
  inherited: string[];
  mutationChance: number;
  sex: Sex;
}

export function previewSynthesis(a: Monster, b: Monster): SynthPreview {
  const speciesId = synthesisResult(a, b);
  const plus = Math.min(99, Math.floor((a.plus + b.plus) / 2) + 1 + Math.floor((a.level + b.level) / 20));
  // deterministic preview: the same inheritance the shrine performs, before drift
  const rng = new Rng(hashString(a.uid) ^ hashString(b.uid) ^ 0x2e55);
  const genes = inheritGenome(a.genes, b.genes, rng);
  // same deterministic rng, one draw later: the preview's sex is the child's sex
  const sex = rollSex(rng, speciesId);
  const own = new Set(skillsForLevel(speciesId, 1));
  const pool = [...a.skills, ...b.skills].filter((s) => !own.has(s));
  const inherited = Array.from(new Set(pool)).slice(0, 2);
  return { speciesId, plus, genes, inherited, mutationChance: 0.2 + (a.mutations.length + b.mutations.length) * 0.1, sex };
}

export function performSynthesis(state: GameState, a: Monster, b: Monster): Monster {
  const p = previewSynthesis(a, b);
  const rng = new Rng(state.seed ^ state.tick ^ state.uidSeq * 7919);
  const genes = driftGenome(p.genes, rng);
  const muts: MutationId[] = [];
  for (const m of [...a.mutations, ...b.mutations]) if (rng.chance(0.45) && !muts.includes(m)) muts.push(m);
  if (rng.chance(p.mutationChance)) {
    const m = rng.chance(0.2) ? rng.pick(BAD_MUTS) : rng.pick(GOOD_MUTS);
    if (!muts.includes(m)) muts.push(m);
  }
  const personality = rng.chance(0.5) ? a.personality : rng.chance(0.7) ? b.personality : rollPersonality(rng);
  const skills = [...skillsForLevel(p.speciesId, 1), ...p.inherited];
  // lineage: one generation past the highest parent, sharing the parents' ancestry id
  const generation = childGeneration([a, b]);
  const lineageId = childLineage([a, b]);
  const mutHistory = mutationRecords(p.genes, genes, generation);
  const child = createMonster(state, p.speciesId, 1, {
    genes,
    personality,
    mutations: muts.slice(0, 3),
    origin: "Synthesized",
    seed: rng.next() * 1e9,
    parents: [a.uid, b.uid],
    parentNames: [displayName(a), displayName(b)],
    plus: p.plus,
    sex: p.sex,
    skills,
    generation,
    lineageId,
    mutHistory,
  });
  child.bond = Math.round((a.bond + b.bond) / 2);
  return child;
}

/** Backfills sex for pre-v8 saves, deterministically from the monster's uid. */
export function migrateMonsterSex(m: Monster): void {
  if (!m.sex) m.sex = rollSex(new Rng(hashString(m.uid) ^ 0x53e0), m.speciesId);
}

