import { useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, Dices, Flame, Leaf, Map as MapIcon, ScrollText, Sparkles } from "lucide-react";
import { ART, MONSTER_ART } from "@/game/assets";
import { ITEMS, ORIGINS, SCARVES, SPECIES, STARTERS, TRAITS, ELEMENTS } from "@/game/data";
import { expressGene } from "@/game/genetics";
import { GENE_FOR, GENE_LABEL, geneGrade, statsOf } from "@/game/monster";
import { newGame, previewStarter } from "@/game/sim";
import { playMusic, setScreen, startGame } from "@/game/store";
import type { ItemId, Monster, OriginId, StatKey } from "@/game/types";
import { randomSeedText } from "@/game/world";
import { cn } from "@/lib/utils";
import { Bar, ElementBadge, SectionTitle } from "./ui";

const ORIGIN_ICON: Record<OriginId, typeof Flame> = { wanderer: MapIcon, herbalist: Leaf, ranger: Sparkles, scholar: ScrollText };
const FEARS: Record<string, string> = { water: "Deep water", fire: "Open flame", heat: "Scorching heat", cold: "Bitter cold", dark: "Deep darkness", light: "Bright light" };

export function CreateScreen() {
  const [step, setStep] = useState<0 | 1>(0);
  const [name, setName] = useState<string>("Rook");
  const [origin, setOrigin] = useState<OriginId>("wanderer");
  const [scarf, setScarf] = useState<string>(SCARVES[0]);
  const [seed, setSeed] = useState<string>("48151-QUD");
  const [pick, setPick] = useState<string>("cindermaw");

  const starters = useMemo(() => STARTERS.map((s) => previewStarter(seed || "EMBER", s)), [seed]);
  const chosen = starters.find((m) => m.speciesId === pick) ?? starters[0];

  const begin = (): void => {
    const gs = newGame(seed || "EMBER", name, origin, scarf, chosen);
    startGame(gs);
    playMusic("wilds");
  };

  return (
    <div className="relative min-h-[100dvh] w-full overflow-x-hidden bg-night">
      <img src={ART.title} alt="" className="pixel fixed inset-0 h-full w-full object-cover opacity-45 blur-[1px]" draggable={false} />
      <div className="fixed inset-0 bg-gradient-to-b from-[#1c1830]/70 via-[#1c1830]/55 to-[#1c1830]/95" />

      <div className="relative mx-auto flex min-h-[100dvh] max-w-6xl flex-col px-4 pb-6 pt-4 sm:px-8 safe-top">
        <div className="flex items-center justify-between">
          <button onClick={() => (step === 0 ? setScreen("title") : setStep(0))} className="flex h-11 items-center gap-2 font-pixel text-parchment/85 hover:text-parchment">
            <ArrowLeft className="h-5 w-5" /> {step === 0 ? "Back to title" : "Back"}
          </button>
          <div className="flex items-center gap-2 font-pixel text-sm text-parchment/60">
            <span className={cn("h-2 w-8 rounded-full", "bg-ember")} />
            <span className={cn("h-2 w-8 rounded-full", step === 1 ? "bg-ember" : "bg-white/15")} />
          </div>
        </div>

        {step === 0 ? (
          <>
            <h1 className="mt-3 font-serif text-4xl font-extrabold text-parchment text-shadow-ink sm:text-5xl">Who sets out?</h1>
            <p className="mt-1 text-parchment/70">Every journey starts with a name, a past, and a world to walk in.</p>
            <div className="mt-5 grid flex-1 gap-4 lg:grid-cols-[1fr_340px]">
              <div className="panel-parchment corners p-4 sm:p-5">
                <label className="font-serif text-[15px] font-bold" htmlFor="tamer-name">Name</label>
                <input
                  id="tamer-name"
                  value={name}
                  maxLength={16}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 h-12 w-full rounded-md border-2 border-frame bg-[#fff8e6] px-3 font-pixel text-lg text-ink outline-none focus:ring-2 focus:ring-ember"
                />
                <SectionTitle>Background</SectionTitle>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(Object.keys(ORIGINS) as OriginId[]).map((o) => {
                    const Icon = ORIGIN_ICON[o];
                    const d = ORIGINS[o];
                    const on = origin === o;
                    return (
                      <button
                        key={o}
                        onClick={() => setOrigin(o)}
                        className={cn(
                          "rounded-md border-2 p-3 text-left transition-all active:scale-[.98]",
                          on ? "border-ember bg-ember/10 shadow-[0_0_0_2px_rgba(232,116,42,.25)]" : "border-frame/40 bg-black/[.03] hover:border-frame",
                        )}
                      >
                        <div className="flex items-center gap-2 font-pixel text-base">
                          <Icon className={cn("h-4 w-4", on ? "text-ember" : "opacity-60")} /> {d.name}
                        </div>
                        <div className="mt-0.5 text-[13px] italic opacity-75">{d.desc}</div>
                        <div className="mt-1 text-[12px] font-medium text-[#7a4a1a]">{d.perk}</div>
                        <div className="mt-1 text-[11px] opacity-60">
                          {d.gold}g · {Object.entries(d.bag).map(([k, n]) => `${n} ${ITEMS[k as ItemId].name}`).join(", ")}
                        </div>
                      </button>
                    );
                  })}
                </div>
                <SectionTitle>Scarf</SectionTitle>
                <div className="flex gap-2">
                  {SCARVES.map((c) => (
                    <button
                      key={c}
                      onClick={() => setScarf(c)}
                      aria-label={`Scarf color ${c}`}
                      className={cn("h-11 w-11 rounded-md border-2 border-frame transition-transform active:scale-90", scarf === c && "ring-2 ring-ember ring-offset-2 ring-offset-parchment")}
                      style={{ background: c, boxShadow: "inset 0 -4px 0 rgba(0,0,0,.25)" }}
                    />
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-4">
                <div className="panel-night corners flex flex-col items-center p-4">
                  <div className="relative grid h-44 w-44 place-items-center rounded-full bg-[radial-gradient(circle,rgba(232,116,42,.35),transparent_70%)]">
                    <img src={ART.tamer} alt="Your tamer" className="pixel anim-bob h-40 w-40 object-contain" draggable={false} />
                    <span className="absolute bottom-10 left-1/2 h-3 w-14 -translate-x-1/2 rounded-sm opacity-80 mix-blend-color" style={{ background: scarf }} />
                  </div>
                  <div className="font-pixel text-xl text-gold">{name || "Rook"}</div>
                  <div className="text-sm text-parchment/70">{ORIGINS[origin].name}</div>
                </div>
                <div className="panel-night p-4">
                  <label htmlFor="seed" className="font-pixel text-gold">World Seed</label>
                  <p className="text-xs text-parchment/60">Same seed, same world: every river, ruin and creature, forever.</p>
                  <div className="mt-2 flex gap-2">
                    <input
                      id="seed"
                      value={seed}
                      maxLength={20}
                      onChange={(e) => setSeed(e.target.value.toUpperCase())}
                      className="h-11 min-w-0 flex-1 rounded-md border-2 border-frame bg-night-3 px-3 font-mono text-parchment outline-none focus:ring-2 focus:ring-gold"
                    />
                    <button className="btn-game btn-night h-11 w-11 px-0" onClick={() => setSeed(randomSeedText())} aria-label="Random seed">
                      <Dices className="h-5 w-5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end">
              <button className="btn-game btn-ember h-14 w-full text-lg sm:w-72" disabled={!name.trim()} onClick={() => setStep(1)}>
                Choose a companion <ChevronRight className="h-5 w-5" />
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 className="mt-3 font-serif text-4xl font-extrabold text-parchment text-shadow-ink sm:text-5xl">Choose Your Starter</h1>
            <p className="mt-1 text-parchment/70">A lifelong companion for your journey. Genes are fixed by your world seed.</p>
            <div className="mt-5 grid flex-1 gap-4 lg:grid-cols-[1fr_380px]">
              <div className="grid grid-cols-3 gap-2 sm:gap-4">
                {starters.map((m) => {
                  const sp = SPECIES[m.speciesId];
                  const on = pick === m.speciesId;
                  return (
                    <button
                      key={m.speciesId}
                      onClick={() => setPick(m.speciesId)}
                      className={cn(
                        "panel-parchment group flex flex-col overflow-hidden p-1.5 text-left transition-all duration-200 sm:p-2",
                        on ? "-translate-y-1 shadow-[0_0_0_3px_#e8742a,0_0_30px_rgba(232,116,42,.55)]" : "opacity-85 hover:opacity-100",
                      )}
                    >
                      <div
                        className="relative aspect-square w-full overflow-hidden rounded-[4px] border-2 border-frame/70"
                        style={{ background: `radial-gradient(circle at 50% 40%, ${ELEMENTS[sp.element].color}77, #2a2140 80%)` }}
                      >
                        <img src={MONSTER_IMG(m.speciesId)} alt={sp.name} className={cn("pixel absolute inset-0 h-full w-full object-contain p-[8%] transition-transform duration-300", on && "anim-bob scale-105")} draggable={false} />
                      </div>
                      <div className="px-1 pb-1 pt-2 text-center">
                        <div className="font-serif text-base font-extrabold leading-tight sm:text-2xl">{sp.name}</div>
                        <div className="mt-1 flex justify-center"><ElementBadge element={sp.element} /></div>
                        <p className="mt-2 hidden text-[13px] leading-snug opacity-80 sm:block">{sp.desc}</p>
                      </div>
                    </button>
                  );
                })}
              </div>

              <StarterPanel monKey={chosen.speciesId} mon={chosen} />
            </div>
            <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button className="btn-game btn-night h-14 sm:w-40" onClick={() => setStep(0)}>
                <ArrowLeft className="h-5 w-5" /> Back
              </button>
              <button className="btn-game btn-ember h-14 text-lg sm:w-80" onClick={begin}>
                Choose {SPECIES[chosen.speciesId].name} <ChevronRight className="h-5 w-5" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const MONSTER_IMG = (id: string): string => MONSTER_ART[id];

function StarterPanel({ mon, monKey }: { mon: Monster; monKey: string }) {
  const sp = SPECIES[mon.speciesId];
  const st = statsOf(mon);
  return (
    <div key={monKey} className="panel-parchment corners p-4 animate-in fade-in slide-in-from-right-2 duration-200">
      <div className="flex gap-3">
        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-md border-2 border-frame" style={{ background: `radial-gradient(circle at 50% 40%, ${ELEMENTS[sp.element].color}88, #2a2140 85%)` }}>
          <img src={MONSTER_IMG(mon.speciesId)} alt="" className="pixel h-full w-full object-contain p-1" />
        </div>
        <div>
          <div className="font-serif text-lg font-extrabold leading-tight">{sp.name}, {sp.title}</div>
          <div className="mt-1"><ElementBadge element={sp.element} /></div>
          <p className="mt-1.5 text-[13px] leading-snug opacity-80">{sp.lore}</p>
        </div>
      </div>
      <SectionTitle>Base Stats · Lv {mon.level}</SectionTitle>
      <div className="space-y-1">
        {(Object.keys(st) as StatKey[]).map((k) => {
          const g = expressGene(mon.genes[GENE_FOR[k]]);
          return (
            <div key={k} className="flex items-center gap-2 text-[13px]">
              <span className="w-9 font-mono">{k.toUpperCase()}</span>
              <span className="w-8 text-right font-mono font-bold">{st[k]}</span>
              <Bar value={g} max={100} color="linear-gradient(180deg,#5fd3c0,#2a8a7a)" className="h-2 flex-1" />
              <span className="w-16 text-right font-mono text-[11px] opacity-70">{GENE_LABEL[GENE_FOR[k]]} {geneGrade(g)}</span>
            </div>
          );
        })}
      </div>
      <SectionTitle>Traits & Disposition</SectionTitle>
      <div className="space-y-1.5 text-[13px]">
        {sp.traits.map((t) => (
          <div key={t}><b>Trait: {TRAITS[t].name}.</b> <span className="opacity-75">{TRAITS[t].desc}</span></div>
        ))}
        <div><b>Likes: {ITEMS[sp.likes].name}.</b> <span className="opacity-75">Increases affinity quickly.</span></div>
        <div><b>Fears: {FEARS[sp.fears]}.</b> <span className="opacity-75">Becomes uneasy near it.</span></div>
        <div><b>Nature:</b> <span className="capitalize opacity-75">{mon.personality}</span></div>
      </div>
    </div>
  );
}
