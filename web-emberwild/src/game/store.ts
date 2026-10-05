import { useSyncExternalStore } from "react";
import { MUSIC } from "./assets";
import { initField } from "./combat";
import { migrateMonsterGenes } from "./genetics";
import { migrateMonsterSex } from "./monster";
import { migrateFactionKnowledge } from "./factions";
import { ensureKnowledge } from "./knowledge";
import { SAVE_VERSION, loadChunks } from "./sim";
import type { GameState } from "./types";

export type Screen = "title" | "create" | "game";

const SAVE_KEY = "emberwild.save.v3";
const MUTE_KEY = "emberwild.muted";

interface StoreShape {
  gs: GameState | null;
  screen: Screen;
  muted: boolean;
  v: number;
}

const store: StoreShape = {
  gs: null,
  screen: "title",
  muted: typeof localStorage !== "undefined" && localStorage.getItem(MUTE_KEY) === "1",
  v: 0,
};

const listeners = new Set<() => void>();
let saveTimer: number | null = null;

function emit(): void {
  store.v += 1;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Re-renders the caller whenever the game store changes. Returns the store snapshot. */
export function useGame(): StoreShape {
  useSyncExternalStore(subscribe, () => store.v);
  return store;
}

export function getStore(): StoreShape {
  return store;
}

function scheduleSave(): void {
  if (saveTimer !== null) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 400);
}

export function saveNow(): void {
  if (!store.gs) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(store.gs));
  } catch (e) {
    console.warn("[emberwild] save failed", e instanceof Error ? e.message : "unknown");
  }
}

/** Mutates game state in place, then re-renders and autosaves. */
export function act<T>(fn: (gs: GameState) => T): T | undefined {
  if (!store.gs) return undefined;
  const r = fn(store.gs);
  emit();
  scheduleSave();
  return r;
}

export function setScreen(screen: Screen): void {
  store.screen = screen;
  emit();
}

export function startGame(gs: GameState): void {
  store.gs = gs;
  store.screen = "game";
  saveNow();
  emit();
}

export function hasSave(): boolean {
  try {
    return !!localStorage.getItem(SAVE_KEY);
  } catch {
    return false;
  }
}

export function savedSummary(): { name: string; seed: string; day: number; party: string[] } | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const gs = JSON.parse(raw) as GameState;
    return { name: gs.player.name, seed: gs.seedText, day: Math.floor(gs.tick / 288) + 1, party: gs.party.map((m) => m.speciesId) };
  } catch {
    return null;
  }
}

export function loadSave(): boolean {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const gs = JSON.parse(raw) as GameState;
    if (gs.version <= 4) {
      if (gs.version === 3) ensureKnowledge(gs, true);
      // v3/v4 → v5: live combat — party field positions, orders, overlays
      gs.field = gs.field ?? {};
      gs.orders = gs.orders ?? {};
      gs.target = gs.target ?? null;
      gs.ground = gs.ground ?? {};
      gs.fighters = gs.fighters ?? {};
      initField(gs);
    }
    // v5 → v6: commanded skills and per-monster aggression
    gs.aggr = gs.aggr ?? {};
    gs.skillQ = gs.skillQ ?? {};
    // v6 → v7: allele-pair genomes (adds the genetic size gene)
    if (gs.version <= 6) for (const m of [...gs.party, ...gs.pen]) migrateMonsterGenes(m);
    // v7 → v8: monsters gain a sex
    if (gs.version <= 7) for (const m of [...gs.party, ...gs.pen]) migrateMonsterSex(m);
    // v8 → v9: loaded chunks respawn, so lairs field their packs
    if (gs.version <= 8) gs.loadedChunks = [];
    // v9 → v10: faction knowledge records, home banner resolved
    if (gs.version <= 9) migrateFactionKnowledge(gs);
    gs.version = SAVE_VERSION;
    if (gs.version !== SAVE_VERSION) return false;
    store.gs = gs;
    loadChunks(gs);
    store.screen = "game";
    emit();
    return true;
  } catch (e) {
    console.warn("[emberwild] load failed", e instanceof Error ? e.message : "unknown");
    return false;
  }
}

export function deleteSave(): void {
  localStorage.removeItem(SAVE_KEY);
  store.gs = null;
  emit();
}

/* ----------------------------------- Audio ---------------------------------- */

type Track = "wilds" | "battle" | null;
const audio: Partial<Record<"wilds" | "battle", HTMLAudioElement>> = {};
let current: Track = null;
const fades = new Map<HTMLAudioElement, number>();

function el(t: "wilds" | "battle"): HTMLAudioElement {
  let a = audio[t];
  if (!a) {
    a = new Audio(MUSIC[t]);
    a.loop = true;
    a.volume = 0;
    a.preload = "auto";
    audio[t] = a;
  }
  return a;
}

function fadeTo(a: HTMLAudioElement, target: number, ms: number): void {
  const prev = fades.get(a);
  if (prev) window.clearInterval(prev);
  const start = a.volume;
  const t0 = performance.now();
  if (target > 0 && a.paused) a.play().catch(() => undefined);
  const id = window.setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    a.volume = Math.max(0, Math.min(1, start + (target - start) * k));
    if (k >= 1) {
      window.clearInterval(id);
      fades.delete(a);
      if (target === 0) a.pause();
    }
  }, 50);
  fades.set(a, id);
}

/** Crossfades to the given music track (no-op while muted). */
export function playMusic(t: Track): void {
  current = t;
  for (const k of ["wilds", "battle"] as const) {
    const a = audio[k];
    if (k === t && !store.muted) fadeTo(el(k), k === "battle" ? 0.42 : 0.35, 900);
    else if (a) fadeTo(a, 0, 700);
  }
}

export function toggleMute(): void {
  store.muted = !store.muted;
  localStorage.setItem(MUTE_KEY, store.muted ? "1" : "0");
  playMusic(current);
  emit();
}
