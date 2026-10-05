import { useMemo, useState } from "react";
import { BookOpen } from "lucide-react";
import { BIOMES, ITEMS, RARITY_COLOR, RECIPES, SPECIES, SPECIES_LIST, STAT_LABEL } from "@/game/data";
import { getStore } from "@/game/store";
import type { BiomeId, StatKey } from "@/game/types";
import { cn } from "@/lib/utils";
import { SkillChip } from "./MonsterDetail";
import { ElementBadge, Portrait, SectionTitle, Sheet, Tag } from "./ui";

export function BestiarySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const gs = getStore().gs;
  const [sel, setSel] = useState<string>(SPECIES_LIST[0].id);
  const known = (id: string): boolean => !gs || !!gs.seen[id];
  const tamed = (id: string): boolean => !!gs?.tamed[id];
  const sp = SPECIES[sel];
  const isKnown = known(sel);
  const count = useMemo(() => (gs ? SPECIES_LIST.filter((s) => gs.seen[s.id]).length : SPECIES_LIST.length), [gs]);
  const recipes = RECIPES.filter(([, , r]) => r === sel);

  return (
    <Sheet open={open} onClose={onClose} wide title={`Bestiary · ${count}/${SPECIES_LIST.length}`} icon={<BookOpen className="h-5 w-5" />}>
      <div className="flex flex-col gap-3 p-3 md:flex-row">
        <div className="grid grid-cols-5 gap-1.5 md:w-[300px] md:shrink-0 md:grid-cols-4 md:content-start">
          {SPECIES_LIST.map((s) => (
            <button
              key={s.id}
              onClick={() => setSel(s.id)}
              className={cn("relative rounded-md p-0.5 transition-transform active:scale-95", sel === s.id && "ring-2 ring-gold")}
              aria-label={known(s.id) ? s.name : "Unknown"}
            >
              <Portrait speciesId={s.id} size={64} className="h-auto w-full" silhouette={!known(s.id)} />
              {tamed(s.id) ? <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-teal ring-1 ring-night" /> : null}
            </button>
          ))}
        </div>
        <div className="panel-parchment min-w-0 flex-1 p-4">
          {isKnown ? (
            <>
              <div className="flex gap-3">
                <Portrait speciesId={sel} size={110} />
                <div className="min-w-0">
                  <div className="font-serif text-2xl font-extrabold leading-tight">{sp.name}</div>
                  <div className="text-sm opacity-75">{sp.title}</div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    <ElementBadge element={sp.element} />
                    <Tag color="#6b5a7a">{sp.family}</Tag>
                    <Tag color={RARITY_COLOR[sp.rarity]}>{sp.rarity}</Tag>
                  </div>
                  <p className="mt-2 text-[14px] leading-snug">{sp.desc}</p>
                </div>
              </div>
              <p className="mt-3 border-l-2 border-ember/60 pl-3 font-serif text-[15px] italic leading-snug opacity-85">“{sp.lore}”</p>
              <SectionTitle>Base Stats</SectionTitle>
              <div className="grid grid-cols-5 gap-1 text-center">
                {(Object.keys(sp.base) as StatKey[]).map((k) => (
                  <div key={k} className="rounded bg-black/5 py-1">
                    <div className="font-mono text-[11px] opacity-70">{STAT_LABEL[k]}</div>
                    <div className="font-pixel text-lg">{sp.base[k]}</div>
                  </div>
                ))}
              </div>
              <SectionTitle>Ecology</SectionTitle>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
                <div><b>Habitat:</b> {Object.entries(sp.biomes).filter(([, w]) => (w ?? 0) > 0).map(([b]) => BIOMES[b as BiomeId].name).join(", ") || "Unknown"}</div>
                <div className="capitalize"><b>Diet:</b> {sp.diet}</div>
                <div className="capitalize"><b>Active:</b> {sp.activity}</div>
                <div><b>Likes:</b> {ITEMS[sp.likes].name}</div>
                <div className="capitalize"><b>Fears:</b> {sp.fears}</div>
                <div><b>Size:</b> {["", "Small", "Medium", "Large", "Titanic"][sp.size] ?? "Small"}</div>
              </div>
              {recipes.length ? (
                <>
                  <SectionTitle>Synthesis</SectionTitle>
                  <div className="space-y-1 text-[13px]">
                    {recipes.map(([a, b]) => (
                      <div key={a + b} className="flex items-center gap-2">
                        <Portrait speciesId={a} size={28} silhouette={!known(a)} />+<Portrait speciesId={b} size={28} silhouette={!known(b)} />
                        <span className="opacity-75">{known(a) ? SPECIES[a].name : "???"} + {known(b) ? SPECIES[b].name : "???"}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              <SectionTitle>Learnset</SectionTitle>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {sp.learnset.map(([lv, s]) => (
                  <div key={s} className="relative">
                    <span className="absolute -left-1 -top-1 z-[1] rounded bg-ink px-1 font-mono text-[10px] text-parchment">Lv{lv}</span>
                    <SkillChip id={s} />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-3 text-center">
              <Portrait speciesId={sel} size={140} silhouette />
              <div className="font-serif text-xl font-bold">Unknown creature</div>
              <p className="max-w-xs text-sm opacity-70">Encounter it in the wild to fill in this page.</p>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
