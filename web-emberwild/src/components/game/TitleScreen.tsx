import { useState } from "react";
import { BookOpen, Flame, Sprout, Trash2, Volume2, VolumeX } from "lucide-react";
import { ART } from "@/game/assets";
import { SPECIES } from "@/game/data";
import { deleteSave, hasSave, loadSave, savedSummary, setScreen, toggleMute, useGame } from "@/game/store";
import { BestiarySheet } from "./Bestiary";
import { Embers, Portrait } from "./ui";

export function TitleScreen({ onNewJourney }: { onNewJourney: () => void }) {
  const { muted } = useGame();
  const [bestiary, setBestiary] = useState<boolean>(false);
  const [confirmDelete, setConfirmDelete] = useState<boolean>(false);
  const [, force] = useState<number>(0);
  const save = savedSummary();
  const canContinue = hasSave() && !!save;

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-night">
      <img src={ART.title} alt="" className="pixel absolute inset-0 h-full w-full object-cover object-[30%_50%] sm:object-center" draggable={false} />
      <div className="absolute inset-0 bg-gradient-to-b from-[#1c1830]/30 via-transparent to-[#1c1830]/85" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_40%,transparent_30%,rgba(14,10,28,.55)_100%)]" />
      <Embers />

      <div className="pointer-events-none absolute left-5 top-5 hidden font-mono text-[10px] uppercase leading-[1.55] tracking-[0.25em] text-parchment/70 sm:block safe-top">
        Monsters<br />Places<br />People<br />Stories<br />Always<br />A further path
      </div>
      <button
        onClick={toggleMute}
        className="absolute right-4 top-4 z-10 grid h-11 w-11 place-items-center rounded-md border-2 border-frame bg-night/80 text-parchment safe-top"
        aria-label={muted ? "Unmute music" : "Mute music"}
      >
        {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
      </button>

      <div className="relative z-[1] flex h-full flex-col items-center px-5 pt-[9vh] sm:pt-[6vh]">
        <Flame className="anim-flicker h-9 w-9 text-ember drop-shadow-[0_0_10px_#e8742a]" fill="#f2c14e" />
        <h1 className="wordmark mt-1 text-[clamp(3rem,13vw,7rem)] leading-none">EMBERWILD</h1>
        <div className="mt-1 flex items-center gap-2 text-gold/80">
          <span className="h-[2px] w-16 bg-gradient-to-r from-transparent to-gold/80" />
          <span className="h-2 w-2 rotate-45 border border-gold" />
          <span className="h-[2px] w-16 bg-gradient-to-l from-transparent to-gold/80" />
        </div>
        <p className="mt-2 font-pixel text-lg text-parchment text-shadow-ink sm:text-xl">Tame. Study. Survive.</p>

        <div className="mt-auto mb-[6vh] flex w-full max-w-sm flex-col gap-3 sm:mt-10">
          <button className="btn-game btn-ember h-14 justify-between text-lg" onClick={onNewJourney}>
            <span className="flex items-center gap-3"><Flame className="h-5 w-5" /> New Journey</span>
            <span aria-hidden>›</span>
          </button>
          <button className="btn-game btn-night h-14 justify-between text-lg" disabled={!canContinue} onClick={() => loadSave()}>
            <span className="flex items-center gap-3">
              <BookOpen className="h-5 w-5" />
              <span className="flex flex-col items-start leading-tight">
                Continue
                {save ? <span className="font-body text-xs text-parchment/60">{save.name} · Day {save.day} · {save.seed}</span> : null}
              </span>
            </span>
            {save ? (
              <span className="flex -space-x-2">
                {save.party.slice(0, 3).map((s, i) => SPECIES[s] ? <Portrait key={i} speciesId={s} size={28} /> : null)}
              </span>
            ) : <span aria-hidden>›</span>}
          </button>
          <button className="btn-game btn-night h-12 justify-between" onClick={() => setBestiary(true)}>
            <span className="flex items-center gap-3"><Sprout className="h-5 w-5 text-teal" /> Bestiary</span>
            <span aria-hidden>›</span>
          </button>
          {canContinue ? (
            confirmDelete ? (
              <div className="flex gap-2">
                <button className="btn-game btn-night h-10 flex-1 text-sm" onClick={() => setConfirmDelete(false)}>Keep it</button>
                <button
                  className="btn-game h-10 flex-1 bg-crimson text-sm text-parchment"
                  onClick={() => {
                    deleteSave();
                    setConfirmDelete(false);
                    force((n) => n + 1);
                  }}
                >
                  Erase journey
                </button>
              </div>
            ) : (
              <button className="mx-auto flex items-center gap-1.5 py-2 text-xs text-parchment/50 hover:text-parchment/80" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-3.5 w-3.5" /> Erase saved journey
              </button>
            )
          ) : null}
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-5 font-mono text-[10px] uppercase tracking-[0.25em] text-parchment/50 safe-bottom">ver 1.0 · a kinder tomorrow</div>
      <BestiarySheet open={bestiary} onClose={() => setBestiary(false)} />
    </div>
  );
}

export function goTitle(): void {
  setScreen("title");
}
