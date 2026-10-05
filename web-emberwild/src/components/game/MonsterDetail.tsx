import { Dna, Heart, Sparkles, Utensils } from "lucide-react";
import { ITEMS, MUTATIONS, PERSONALITIES, RARITY_COLOR, SKILLS, SPECIES, STAT_LABEL, TRAITS, ELEMENTS } from "@/game/data";
import { GENE_KEYS, expressGene, getMonsterFootprint, getMonsterSize, tierName } from "@/game/genetics";
import { GENE_FOR, GENE_LABEL, SEX_INFO, geneGrade, statsOf, xpToNext } from "@/game/monster";
import type { Monster, StatKey } from "@/game/types";
import { Bar, ElementBadge, Portrait, SectionTitle, Tag, hpColor } from "./ui";

const FEAR_TEXT: Record<string, string> = {
  water: "Deep water", fire: "Open flame", heat: "Scorching heat", cold: "Bitter cold", dark: "Deep darkness", light: "Bright light",
};

export function SkillChip({ id }: { id: string }) {
  const s = SKILLS[id];
  if (!s) return null;
  const el = ELEMENTS[s.element];
  return (
    <div className="rounded border border-frame/50 bg-black/5 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-pixel text-[13px]" style={{ color: s.element === "neutral" ? undefined : el.color, textShadow: s.element === "neutral" ? undefined : "0 1px 0 rgba(0,0,0,.35)" }}>
          {s.name}
        </span>
        <span className="font-mono text-[10px] opacity-70">
          {s.dice[0] ? `${s.dice[0]}d${s.dice[1]}` : s.heal ? `+${s.heal}` : "—"} · R{s.range}
          {s.radius ? ` · AoE${s.radius}` : ""}
          {s.cooldown ? ` · CD${s.cooldown}` : ""}
        </span>
      </div>
      <div className="text-[12px] leading-snug opacity-75">{s.desc}</div>
    </div>
  );
}

/** Full simulation readout for an owned monster (on parchment). */
export function MonsterDetail({ mon, showGenes = true }: { mon: Monster; showGenes?: boolean }) {
  const sp = SPECIES[mon.speciesId];
  const stats = statsOf(mon);
  const p = PERSONALITIES[mon.personality];
  const fp = getMonsterFootprint(mon);
  const tn = tierName(fp);
  return (
    <div className="text-ink">
      <div className="flex gap-3">
        <Portrait speciesId={mon.speciesId} size={96} />
        <div className="min-w-0 flex-1">
          <div className="font-serif text-xl font-extrabold leading-tight">
            {mon.nickname ?? sp.name}
            {mon.plus ? <span className="ml-1 font-pixel text-base text-ember">+{mon.plus}</span> : null}
          </div>
          <div className="text-[13px] opacity-75">{sp.title} · Lv {mon.level}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            <ElementBadge element={sp.element} />
            <Tag color="#6b5a7a">{sp.family}</Tag>
            <Tag color={RARITY_COLOR[sp.rarity]}>{sp.rarity}</Tag>
            <Tag color={SEX_INFO[mon.sex].color}>{SEX_INFO[mon.sex].glyph} {SEX_INFO[mon.sex].label}</Tag>
            {tn ? <Tag color="#3e6b5c">{tn} · {fp}×{fp} tiles · Size {getMonsterSize(mon)}</Tag> : null}
          </div>
          <div className="mt-1.5 space-y-1">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="w-9 font-mono">HP</span>
              <Bar value={mon.hp} max={stats.hp} color={hpColor(mon.hp / stats.hp)} className="flex-1" />
              <span className="w-14 text-right font-mono">{mon.hp}/{stats.hp}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="w-9 font-mono">XP</span>
              <Bar value={mon.xp} max={xpToNext(mon.level)} color="linear-gradient(180deg,#9fd3e6,#3f7fd0)" className="flex-1" />
              <span className="w-14 text-right font-mono">{mon.xp}/{xpToNext(mon.level)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="rounded border border-frame/40 bg-black/5 p-2">
          <div className="flex items-center gap-1 text-[11px] opacity-70"><Utensils className="h-3 w-3" /> Satiety</div>
          <div className="font-mono text-sm">{Math.round(mon.satiety)}%</div>
          <Bar value={mon.satiety} max={100} color="linear-gradient(180deg,#f2c14e,#c98a2b)" className="mt-1 h-1.5" />
        </div>
        <div className="rounded border border-frame/40 bg-black/5 p-2">
          <div className="flex items-center gap-1 text-[11px] opacity-70"><Heart className="h-3 w-3" /> Bond</div>
          <div className="font-mono text-sm">{Math.round(mon.bond)}</div>
          <Bar value={mon.bond} max={100} color="linear-gradient(180deg,#ff8fa8,#b23a48)" className="mt-1 h-1.5" />
        </div>
        <div className="rounded border border-frame/40 bg-black/5 p-2">
          <div className="text-[11px] opacity-70">Nature</div>
          <div className="font-pixel text-sm">{p.name}</div>
          <div className="text-[10px] leading-tight opacity-60">{p.desc}</div>
        </div>
      </div>

      <SectionTitle>Stats {showGenes ? "& Genes" : ""}</SectionTitle>
      <div className="space-y-1">
        {(Object.keys(stats) as StatKey[]).map((k) => {
          const g = expressGene(mon.genes[GENE_FOR[k]]);
          return (
            <div key={k} className="flex items-center gap-2 text-[13px]">
              <span className="w-9 font-mono font-medium">{STAT_LABEL[k]}</span>
              <span className="w-9 text-right font-mono font-bold">{stats[k]}</span>
              {showGenes ? (
                <>
                  <Bar value={g} max={100} color="linear-gradient(180deg,#5fd3c0,#2a8a7a)" className="h-2 flex-1" />
                  <span className="w-28 text-right font-mono text-[11px] opacity-70">
                    {GENE_LABEL[GENE_FOR[k]]} {geneGrade(g)} · {mon.genes[GENE_FOR[k]].a}/{mon.genes[GENE_FOR[k]].b}
                  </span>
                </>
              ) : null}
            </div>
          );
        })}
      </div>

      <SectionTitle>Traits & Disposition</SectionTitle>
      <div className="space-y-1.5 text-[13px]">
        {sp.traits.map((t) => (
          <div key={t}><b>{TRAITS[t].name}.</b> <span className="opacity-75">{TRAITS[t].desc}</span></div>
        ))}
        <div><b>Likes:</b> <span className="opacity-75">{ITEMS[sp.likes].name}</span> · <b>Diet:</b> <span className="capitalize opacity-75">{sp.diet}</span></div>
        <div><b>Fears:</b> <span className="opacity-75">{FEAR_TEXT[sp.fears]}</span> · <b>Active:</b> <span className="capitalize opacity-75">{sp.activity}</span></div>
      </div>

      {mon.mutations.length ? (
        <>
          <SectionTitle><span className="flex items-center gap-1.5"><Dna className="h-4 w-4" /> Mutations</span></SectionTitle>
          <div className="space-y-1 text-[13px]">
            {mon.mutations.map((m) => (
              <div key={m}>
                <b style={{ color: MUTATIONS[m].good ? "#2a7a5a" : "#9a2a3a" }}>{MUTATIONS[m].name}.</b> <span className="opacity-75">{MUTATIONS[m].desc}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <SectionTitle><span className="flex items-center gap-1.5"><Sparkles className="h-4 w-4" /> Skills</span></SectionTitle>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {mon.skills.map((s) => <SkillChip key={s} id={s} />)}
      </div>

      <SectionTitle><span className="flex items-center gap-1.5"><Dna className="h-4 w-4" /> Biology</span></SectionTitle>
      <div className="space-y-1 rounded border border-frame/40 bg-black/5 p-2 font-mono text-[11px]">
        <div className="flex justify-between gap-2"><span className="opacity-60">individual</span><span>{mon.uid} · {sp.id}</span></div>
        <div className="flex justify-between gap-2"><span className="opacity-60">physical size</span><span>{getMonsterSize(mon)} · {fp}×{fp} tiles</span></div>
        <div className="flex justify-between gap-2"><span className="opacity-60">generation</span><span>{mon.generation ?? 1}</span></div>
        <div className="flex justify-between gap-2"><span className="opacity-60">lineage</span><span>{mon.lineageId ?? "—"}</span></div>
        <div className="flex justify-between gap-2"><span className="opacity-60">parents</span><span>{mon.parents ? mon.parents.join(", ") : "founder"}</span></div>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
          {GENE_KEYS.map((g) => (
            <div key={g} className="flex justify-between gap-2">
              <span className="opacity-60">{GENE_LABEL[g]}</span>
              <span>{expressGene(mon.genes[g])} <span className="opacity-50">[{mon.genes[g].a}/{mon.genes[g].b}]</span></span>
            </div>
          ))}
        </div>
        {mon.mutHistory?.length ? (
          <div className="mt-1 border-t border-frame/40 pt-1">
            {mon.mutHistory.map((r, i) => (
              <div key={i} className="flex justify-between gap-2">
                <span className="opacity-60">gen {r.gen} drift</span>
                <span style={{ color: r.dir === "up" ? "#2a7a5a" : "#9a2a3a" }}>
                  {r.gene} {r.from}→{r.to} ({r.delta > 0 ? "+" : ""}{r.delta})
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <SectionTitle>History</SectionTitle>
      <div className="space-y-0.5 text-[13px] opacity-80">
        <div>{mon.origin}.</div>
        {mon.parents ? <div>Synthesized from {(mon.parentNames ?? mon.parents).join(" and ")}.</div> : null}
        <div>{mon.wins} battles won together.</div>
      </div>
    </div>
  );
}
