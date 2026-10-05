/**
 * Heritable genetics for Emberwild monsters.
 *
 * Every monster carries two alleles per gene (a genome). A monster's expressed
 * genes are derived from the allele pair, so hidden potential can persist
 * through generations: a monster may show a mediocre gene while carrying an
 * excellent allele. Synthesis deals one allele from each parent (independent
 * 50/50 per parent) and then applies symmetric drift that mutates the
 * inherited alleles themselves — lineages can be bred deliberately, improve
 * or regress across generations.
 */
import { SPECIES, footprintOf } from "./data";
import { Rng, clamp, hashString } from "./rng";
import type { GameState, GeneKey, GenePair, Genes, Genome, Monster, MutationRecord, StatKey, WildCreature } from "./types";

export const ALLELE_MIN = 5;
export const ALLELE_MAX = 100;

/** Every heritable gene, in display order. */
export const GENE_KEYS: GeneKey[] = ["vigor", "might", "guard", "swift", "wit", "size"];

const STAT_GENE_KEYS = GENE_KEYS.filter((k) => k !== "size") as Exclude<GeneKey, "size">[];

const clampAllele = (v: number): number => Math.round(clamp(v, ALLELE_MIN, ALLELE_MAX));

/* ------------------------------- Validation --------------------------------- */

/**
 * Validates a genome from save data: every gene must be a pair of finite
 * numbers. Out-of-range values are clamped (recoverable); missing genes, NaN,
 * or Infinity make the whole genome structurally invalid (null) so callers
 * regenerate deterministically instead of propagating corruption.
 */
export function sanitizeGenome(g: unknown): Genome | null {
  if (!g || typeof g !== "object") return null;
  const src = g as Record<string, unknown>;
  const out = {} as Genome;
  for (const k of GENE_KEYS) {
    const p = src[k];
    if (!p || typeof p !== "object") return null;
    const a = (p as { a: unknown }).a;
    const b = (p as { b: unknown }).b;
    if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    out[k] = { a: clampAllele(a), b: clampAllele(b) };
  }
  return out;
}

/** Expressed value of a gene: the average of its two alleles (90/40 → 65). */
export const expressGene = (p: GenePair): number => Math.round((clampAllele(p.a) + clampAllele(p.b)) / 2);

/** Expressed value of every gene in a genome. */
export function expressGenome(g: Genome): Genes {
  const out = {} as Genes;
  for (const k of GENE_KEYS) out[k] = expressGene(g[k]);
  return out;
}

/* ------------------------------- Inheritance -------------------------------- */

/**
 * Mendelian inheritance of one gene: one random allele from each parent, each
 * parent contributing either of its two alleles with a 50/50 chance. This is
 * what lets recessive (hidden) alleles persist through generations.
 */
export function inheritGene(pa: GenePair, pb: GenePair, rng: Rng): GenePair {
  return { a: rng.chance(0.5) ? pa.a : pa.b, b: rng.chance(0.5) ? pb.a : pb.b };
}

/** Inherits a whole genome — allele selection only, no drift yet. */
export function inheritGenome(a: Genome, b: Genome, rng: Rng): Genome {
  const out = {} as Genome;
  for (const k of GENE_KEYS) out[k] = inheritGene(a[k], b[k], rng);
  return out;
}

/**
 * Symmetric drift delta: triangular over −3..+3 (peaked at 0) with a rare
 * escalation to ±4..±6. P(upward) === P(downward); most mutations are small.
 */
export function mutateDelta(rng: Rng): number {
  let d = rng.int(0, 3) + rng.int(0, 3) - 3;
  if (d !== 0 && rng.chance(0.12)) d = Math.sign(d) * (4 + rng.int(0, 2));
  return d;
}

/** Drifts one gene pair: each allele has a 50% chance to mutate by a small symmetric delta. */
export function mutateGene(p: GenePair, rng: Rng): GenePair {
  const step = (v: number): number => (rng.chance(0.5) ? v : clampAllele(v + mutateDelta(rng)));
  return { a: step(p.a), b: step(p.b) };
}

/** Applies mutation/drift to an inherited genome; returns a new genome. */
export function driftGenome(g: Genome, rng: Rng): Genome {
  const out = {} as Genome;
  for (const k of GENE_KEYS) out[k] = mutateGene(g[k], rng);
  return out;
}

/* ------------------------------ Founders & lineage --------------------------- */

/** A founder's lineage id: derived from the stable individual id, never a name. */
export const founderLineage = (id: string): string => `L:${id}`;

/** A monster's generation — founders default to 1. */
export const genOf = (m: { generation?: number }): number => m.generation ?? 1;

/**
 * Offspring lineage: the lexicographically smallest parent lineage id —
 * symmetric in parent order and deterministic, so siblings share one stable
 * ancestry id regardless of which parent was listed first.
 */
export function childLineage(parents: { uid: string; lineageId?: string }[]): string {
  const ids = parents.map((p) => p.lineageId ?? founderLineage(p.uid)).sort();
  return ids[0] ?? founderLineage("lost");
}

/** Offspring generation: one past the highest parent generation. */
export function childGeneration(parents: { generation?: number }[]): number {
  return Math.max(...parents.map(genOf)) + 1;
}

/**
 * Compares two genomes and returns the expressed-gene changes drift caused,
 * as structured mutation records (never log text).
 */
export function mutationRecords(before: Genome, after: Genome, gen: number): MutationRecord[] {
  const out: MutationRecord[] = [];
  for (const k of GENE_KEYS) {
    const from = expressGene(before[k]);
    const to = expressGene(after[k]);
    if (to === from) continue;
    out.push({ gene: k, from, to, delta: to - from, dir: to > from ? "up" : "down", gen });
  }
  return out;
}

/* --------------------------------- Size ------------------------------------- */

/** Expressed size (5–100) → tile footprint side. The single source of truth. */
export function sizeToFootprint(expr: number): 1 | 2 | 3 | 4 {
  const v = clamp(expr, ALLELE_MIN, ALLELE_MAX);
  return v >= 75 ? 4 : v >= 50 ? 3 : v >= 25 ? 2 : 1;
}

/** Allele bands that express each footprint tier (species defaults roll inside). */
export const SIZE_BAND: Record<1 | 2 | 3 | 4, [number, number]> = { 1: [5, 24], 2: [25, 49], 3: [50, 74], 4: [75, 100] };

/** Footprint tier name for the UI; null for normal (1×1) bodies. */
export function tierName(fp: number): "Large" | "Huge" | "Titanic" | null {
  return fp >= 4 ? "Titanic" : fp === 3 ? "Huge" : fp === 2 ? "Large" : null;
}

/** A size gene pair that expresses the species' body tier (jittered within its band). */
export function speciesSizePair(rng: Rng, speciesId: string): GenePair {
  const band = SIZE_BAND[footprintOf(SPECIES[speciesId]) as 1 | 2 | 3 | 4];
  return { a: rng.int(band[0], band[1]), b: rng.int(band[0], band[1]) };
}

/** Expressed size of a monster — what stats and footprint read. */
export const getMonsterSize = (mon: Monster): number => expressGene(mon.genes.size);

/** The monster's tile footprint, derived from its expressed size gene. */
export function getMonsterFootprint(mon: Monster): 1 | 2 | 3 | 4 {
  return sizeToFootprint(getMonsterSize(mon));
}

/* ------------------------------ Stat scaling -------------------------------- */

/**
 * Size→stat scaling at the extremes of the expressed size range (configurable
 * for balance): larger bodies gain vigor/might/guard potential and lose
 * swiftness; wit is untouched. A biological modifier, not a tile-count
 * multiplier — a 4×4 body is meaningfully, but not absurdly, stronger.
 */
export const SIZE_STAT_SCALE: Record<StatKey, number> = { hp: 0.28, atk: 0.18, def: 0.18, agi: -0.22, wis: 0 };

/** Multiplier a stat receives from the monster's expressed size. */
export function sizeStatMul(key: StatKey, sizeExpr: number): number {
  return 1 + ((sizeExpr - ALLELE_MIN) / (ALLELE_MAX - ALLELE_MIN)) * SIZE_STAT_SCALE[key];
}

/* ------------------------------ Genome helpers ------------------------------ */

/** Founder genome: stat genes roll on the classic curve; size within the species' band. */
export function rollGenome(rng: Rng, speciesId: string, bonus = 0): Genome {
  const g = (): number => Math.max(ALLELE_MIN, Math.min(ALLELE_MAX, Math.round(25 + rng.next() * 35 + rng.next() * 20 + bonus)));
  const out = {} as Genome;
  for (const k of STAT_GENE_KEYS) out[k] = { a: g(), b: g() };
  out.size = speciesSizePair(rng, speciesId);
  return out;
}

/** Deterministic genotype for a wild creature, derived from its gene seed. */
export const wildGenotypeFromSeed = (geneSeed: number, speciesId: string): Genome => rollGenome(new Rng(geneSeed ^ 0x6765), speciesId);

/** Builds a genome from legacy scalar genes; size rolls within the species' band. */
export function genomeFromGenes(g: Partial<Genes>, speciesId: string, rng: Rng): Genome {
  const out = {} as Genome;
  for (const k of STAT_GENE_KEYS) {
    const v = clampAllele(g[k] ?? 40);
    out[k] = { a: v, b: v };
  }
  out.size = speciesSizePair(rng, speciesId);
  return out;
}

/** Extracts whatever scalar (or half-migrated) gene data survives in a legacy genes field. */
function scalarOf(g: unknown): Partial<Genes> {
  const out: Partial<Genes> = {};
  if (!g || typeof g !== "object") return out;
  const src = g as Record<string, unknown>;
  for (const k of STAT_GENE_KEYS) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (v && typeof v === "object" && typeof (v as GenePair).a === "number" && Number.isFinite((v as GenePair).a)) out[k] = (v as GenePair).a;
  }
  return out;
}

/**
 * Migration: converts pre-genetics scalar genes ({ vigor: 72 }) into an allele
 * genome ({ vigor: { a: 72, b: 72 } }) and adds a size gene from species data.
 * Valid allele genomes are clamped and pass through untouched (idempotent);
 * structurally invalid data (NaN, missing genes) regenerates deterministically
 * from the monster's stable uid instead of propagating corruption.
 */
export function migrateMonsterGenes(m: Monster): void {
  const clean = sanitizeGenome(m.genes);
  if (clean) {
    m.genes = clean;
    return;
  }
  const rng = new Rng(hashString(m.uid) ^ 0x6e6e);
  m.genes = genomeFromGenes(scalarOf(m.genes), m.speciesId, rng);
}

/** Backfills lineage metadata for legacy monsters (founders: generation 1). Idempotent. */
export function migrateMonsterBio(m: Monster): void {
  if (typeof m.generation !== "number") m.generation = 1;
  if (!m.lineageId) m.lineageId = founderLineage(m.uid);
  if (!Array.isArray(m.mutHistory)) m.mutHistory = [];
}

/**
 * Backfills a wild creature's explicit genotype (authoritative from here on)
 * and founder lineage, deterministically from its gene seed. Idempotent.
 */
export function migrateCreatureBio(c: WildCreature): void {
  const clean = sanitizeGenome(c.genes);
  c.genes = clean ?? wildGenotypeFromSeed(c.geneSeed, c.speciesId);
  if (typeof c.gen !== "number") c.gen = 1;
  if (!c.lineageId) c.lineageId = founderLineage(c.id);
}

/** One idempotent biology pass over every creature in a game state — runs on every load. */
export function migrateBiology(gs: GameState): void {
  for (const m of [...gs.party, ...gs.pen]) {
    migrateMonsterGenes(m);
    migrateMonsterBio(m);
  }
  for (const c of Object.values(gs.creatures)) migrateCreatureBio(c);
}

/* --------------------------------- Grades ----------------------------------- */

/** Gene grade from an expressed value (S/A/B/C/D/F). */
export function getGeneGrade(v: number): string {
  if (v >= 85) return "S";
  if (v >= 70) return "A";
  if (v >= 55) return "B";
  if (v >= 40) return "C";
  if (v >= 25) return "D";
  return "F";
}
