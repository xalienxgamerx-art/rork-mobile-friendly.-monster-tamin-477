import type { GameState, LogKind } from "./types";

/** Appends a line to the adventure log (kept here so game modules can log without importing sim.ts). */
export function addLog(state: GameState, text: string, kind: LogKind = "info"): void {
  state.logSeq += 1;
  state.log.push({ id: state.logSeq, tick: state.tick, text, kind });
  if (state.log.length > 220) state.log.splice(0, state.log.length - 220);
}

/** Human compass direction for a delta, e.g. "to the north-east". */
export function compass(dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return "right beside you";
  const dirs = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
  const idx = (Math.round((Math.atan2(dy, dx) / (Math.PI * 2)) * 8) + 8) % 8;
  return `to the ${dirs[idx]}`;
}
