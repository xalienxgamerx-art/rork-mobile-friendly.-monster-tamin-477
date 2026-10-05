import { SPECIES } from "./data";
import { Rng, hashString } from "./rng";
import type { GameState, Monster, Maturity, ReproMode, ReproPairing, ReproductiveProfile, ReproStatus, Sex, WildCreature } from "./types";

/** Ticks of gestation/incubation while a reproduction is underway (one in-world day). */
export const DEVELOP_TICKS = 288;
/** Ticks both parents rest after a reproduction completes (two in-world days). */
export const BREED_COOLDOWN_TICKS = 576;
/** Level at which individuals reach reproductive maturity (growth systems refine this later). */
export const MATURITY_LEVEL = 5;

/** Structured outcome of a successful reproduction — no offspring yet; later phases (eggs, gestation, nests) carry this forward. */
export interface ReproductionResult {
  ok: true;
  pairing: ReproPairing;
  parentIds: [string, string];
  /** Ticks of development (gestation/incubation) before offspring would emerge. */
  developTicks: number;
  startedTick: number;
  /** Parent profiles snapshotted at reproduction start. */
  parents: [ReproductiveProfile, ReproductiveProfile];
}

/** Why a reproduction could not begin. */
export interface ReproductionRejection {
  ok: false;
  reason: string;
}
export type ReproductionOutcome = ReproductionResult | ReproductionRejection;

/** The outcome of a compatibility check. */
export interface ReproCheck {
  ok: boolean;
  reason?: string;
}

/** A reproduction that finished its development window (offspring production arrives in later phases). */
export interface ReproCompletion {
  id: string;
  partnerId: string;
  pairing: ReproPairing;
  completedTick: number;
}

/** Stable body id across monsters (uid) and wild creatures (id). */
export function bodyId(m: Monster | WildCreature): string {
  return "uid" in m ? m.uid : m.id;
}

/** Rolls a reproductive mode for a new individual: sexed species are male or female, the rest are asexual. */
export function rollReproMode(rng: Rng, speciesId: string): ReproMode {
  return SPECIES[speciesId].sexed === false ? "asexual" : rng.chance(0.5) ? "female" : "male";
}

/** Deterministic mode for a legacy wild creature, derived from its stable id. */
export function wildReproMode(id: string, speciesId: string): ReproMode {
  return rollReproMode(new Rng(hashString(id) ^ 0x5e70), speciesId);
}

/** Data-driven maturity: a level threshold today, life-stage growth later. */
export function maturityFor(level: number): Maturity {
  return level >= MATURITY_LEVEL ? "mature" : "immature";
}

/** Builds a fresh profile: fertile, mature per level, available, no cooldown. */
export function makeReproProfile(mode: ReproMode, level: number, tick: number): ReproductiveProfile {
  return { mode, fertility: 100, maturity: maturityFor(level), status: "available", cooldownUntil: tick };
}

/**
 * Effective reproductive status, resolving stored state against the current tick.
 * Active reproduction wins, then maturity and fertility mask availability, then cooldown.
 */
export function reproStateOf(p: ReproductiveProfile, tick: number): ReproStatus {
  if (p.status === "reproducing" && p.developUntil !== undefined && p.developUntil > tick) return "reproducing";
  if (p.maturity === "immature") return "immature";
  if (p.fertility <= 0) return "infertile";
  if (p.cooldownUntil > tick) return "cooldown";
  return "available";
}

/** Whether the individual is currently available to begin a reproduction. */
export function isBreedingAvailable(m: Monster | WildCreature, tick: number): boolean {
  return !!m.repro && reproStateOf(m.repro, tick) === "available";
}

/**
 * Mode compatibility: male×female in either order, or two asexual parents.
 * Two-parent asexual reproduction is deliberate — there is no clone-self path.
 */
export function modesCompatible(ma: ReproMode, mb: ReproMode): boolean {
  if (ma === "asexual" && mb === "asexual") return true;
  return (ma === "male" && mb === "female") || (ma === "female" && mb === "male");
}

/** Why this individual cannot begin a reproduction right now, or null if it can. */
function availabilityBlock(p: ReproductiveProfile, tick: number): string | null {
  const s = reproStateOf(p, tick);
  if (s === "immature") return "immature";
  if (s === "infertile") return "infertile";
  if (s === "reproducing") return "already reproducing";
  if (s === "cooldown") return "cooling down";
  return null;
}

/**
 * Biological compatibility only: are these two individuals capable of reproducing?
 * Species identity and context (wild vs player vs facility) are mating rules for later
 * phases and deliberately play no part here — the engine processes any compatible pair.
 */
export function canReproduce(a: Monster | WildCreature, b: Monster | WildCreature, tick: number): ReproCheck {
  if (bodyId(a) === bodyId(b)) return { ok: false, reason: "an individual cannot reproduce with itself" };
  if (!a.repro || !b.repro) return { ok: false, reason: "missing reproductive profile" };
  const blockA = availabilityBlock(a.repro, tick);
  if (blockA) return { ok: false, reason: `${bodyId(a)} is ${blockA}` };
  const blockB = availabilityBlock(b.repro, tick);
  if (blockB) return { ok: false, reason: `${bodyId(b)} is ${blockB}` };
  if (!modesCompatible(a.repro.mode, b.repro.mode)) return { ok: false, reason: `${a.repro.mode} cannot pair with ${b.repro.mode}` };
  return { ok: true };
}

/**
 * Begins a reproduction between two biologically compatible parents: both enter the
 * reproducing state for the development window. Produces no offspring — the result is
 * structured data that later phases (eggs, gestation, nests) carry forward.
 */
export function beginReproduction(a: Monster | WildCreature, b: Monster | WildCreature, tick: number): ReproductionOutcome {
  const check = canReproduce(a, b, tick);
  if (!check.ok) return { ok: false, reason: check.reason ?? "incompatible" };
  const pairing: ReproPairing = a.repro!.mode === "asexual" ? "asexual" : "sexual";
  const snapA: ReproductiveProfile = { ...a.repro! };
  const snapB: ReproductiveProfile = { ...b.repro! };
  const developUntil = tick + DEVELOP_TICKS;
  for (const [self, other] of [[a, b], [b, a]] as const) {
    const p = self.repro!;
    p.status = "reproducing";
    p.pairing = pairing;
    p.engagedWith = bodyId(other);
    p.developUntil = developUntil;
  }
  return { ok: true, pairing, parentIds: [bodyId(a), bodyId(b)], developTicks: DEVELOP_TICKS, startedTick: tick, parents: [snapA, snapB] };
}

/**
 * Reconciles every individual's reproductive state with simulation time: maturity
 * follows level, active reproductions complete into breeding cooldown, and stored
 * status tracks the effective state. Returns the reproductions that completed.
 */
export function advanceReproduction(state: GameState): ReproCompletion[] {
  const tick = state.tick;
  const done: ReproCompletion[] = [];
  for (const body of [...state.party, ...state.pen, ...Object.values(state.creatures)]) {
    const p = body.repro;
    if (!p) continue; // legacy bodies are backfilled by migrateRepro on load
    p.maturity = maturityFor(body.level);
    if (p.status === "reproducing" && (p.developUntil === undefined || p.developUntil <= tick)) {
      done.push({ id: bodyId(body), partnerId: p.engagedWith ?? "?", pairing: p.pairing ?? "sexual", completedTick: tick });
      p.status = "cooldown";
      p.cooldownUntil = tick + BREED_COOLDOWN_TICKS;
      p.engagedWith = undefined;
      p.developUntil = undefined;
      continue;
    }
    const s = reproStateOf(p, tick);
    if (p.status !== s) p.status = s;
  }
  return done;
}

/** Reconciles a profile's derived fields without inventing state (idempotent). */
function reconcileRepro(p: ReproductiveProfile, level: number): void {
  p.maturity = maturityFor(level);
  if (p.status === "reproducing" && p.developUntil === undefined) p.status = "available";
}

/** Backfills a monster's reproductive profile from its sex (idempotent). */
export function migrateReproMon(m: Monster): void {
  if (!m.repro) m.repro = makeReproProfile(m.sex, m.level, 0);
  reconcileRepro(m.repro, m.level);
}

/** Backfills a wild creature's reproductive profile, deterministically from its id (idempotent). */
export function migrateReproCreature(c: WildCreature): void {
  if (!c.repro) c.repro = makeReproProfile(wildReproMode(c.id, c.speciesId), c.level, 0);
  reconcileRepro(c.repro, c.level);
}

/** Whole-state backfill for older saves — idempotent, safe to run on every load. */
export function migrateRepro(gs: GameState): void {
  for (const m of [...gs.party, ...gs.pen]) migrateReproMon(m);
  for (const c of Object.values(gs.creatures)) migrateReproCreature(c);
}
