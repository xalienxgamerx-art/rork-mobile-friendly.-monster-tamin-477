import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Backpack, BedDouble, Coins, Flame, Home, PawPrint, ScrollText, Sparkles, Tent, Utensils } from "lucide-react";
import { ITEMS, PARTY_MAX, SHOP_STOCK, SPECIES, SYNTH_MIN_LEVEL, ELEMENTS } from "@/game/data";
import { getFactions } from "@/game/factions";
import { expressGene, sizeToFootprint } from "@/game/genetics";
import { GENE_LABEL, SEX_INFO, displayName, geneGrade, previewSynthesis, statOf } from "@/game/monster";
import { INN_COST, PEN_MAX, buyItem, campRest, hoursUntilDawn, innRest, moveInParty, offerFood, releaseMonster, sellItem, swapPartyPen, synthesize, useItemOn, addLog } from "@/game/sim";
import { act } from "@/game/store";
import type { GameState, GeneKey, ItemId, Monster } from "@/game/types";
import type { Feature, Npc } from "@/game/world";
import { cn } from "@/lib/utils";
import { MonsterDetail } from "./MonsterDetail";
import { Bar, Portrait, SectionTitle, Sheet, hpColor } from "./ui";
import { toast } from "sonner";

function MonRow({ m, active, onClick, right }: { m: Monster; active?: boolean; onClick: () => void; right?: React.ReactNode }) {
  const max = statOf(m, "hp");
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md border-2 p-1.5 text-left transition-colors",
        active ? "border-gold bg-gold/10" : "border-frame/40 bg-night-3/40 hover:border-frame",
      )}
    >
      <Portrait speciesId={m.speciesId} size={44} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-1">
          <span className="truncate font-pixel text-[15px] text-parchment">
            {displayName(m)}
            {m.plus ? <span className="text-ember"> +{m.plus}</span> : null}
            <span className="ml-1 font-mono text-[12px]" style={{ color: SEX_INFO[m.sex].color }}>{SEX_INFO[m.sex].glyph}</span>
          </span>
          <span className="font-mono text-[11px] text-parchment/60">Lv{m.level}</span>
        </div>
        <Bar value={m.hp} max={max} color={hpColor(m.hp / max)} className="mt-1 h-1.5" />
        <div className="mt-0.5 flex justify-between font-mono text-[10px] text-parchment/55">
          <span>{m.hp}/{max} HP</span>
          <span className={m.satiety < 25 ? "text-[#ff8a7a]" : ""}>Food {Math.round(m.satiety)}%</span>
        </div>
      </div>
      {right}
    </button>
  );
}

const FOOD_ITEMS = (gs: GameState): ItemId[] => (Object.keys(gs.bag) as ItemId[]).filter((k) => (gs.bag[k] ?? 0) > 0);

/* --------------------------------- Party ------------------------------------ */

export function PartySheet({ gs, open, onClose, atHamlet }: { gs: GameState; open: boolean; onClose: () => void; atHamlet: boolean }) {
  const [sel, setSel] = useState<string>("");
  const [feeding, setFeeding] = useState<boolean>(false);
  const [rename, setRename] = useState<string | null>(null);
  const [confirmRelease, setConfirmRelease] = useState<boolean>(false);
  const all = [...gs.party, ...gs.pen];
  const mon = all.find((m) => m.uid === sel) ?? gs.party[0];
  const inParty = gs.party.includes(mon);

  return (
    <Sheet open={open} onClose={onClose} wide title={`Monsters · ${gs.party.length}/${PARTY_MAX}`} icon={<PawPrint className="h-5 w-5" />}>
      <div className="flex flex-col gap-3 p-3 md:flex-row">
        <div className="space-y-1.5 md:w-72 md:shrink-0">
          <div className="font-pixel text-sm text-gold/80">Party</div>
          {gs.party.map((m, i) => (
            <MonRow
              key={m.uid}
              m={m}
              active={m.uid === mon?.uid}
              onClick={() => { setSel(m.uid); setFeeding(false); setConfirmRelease(false); }}
              right={
                <div className="flex flex-col">
                  <span role="button" aria-label="Move up" className={cn("grid h-6 w-7 place-items-center rounded text-parchment/70 hover:bg-white/10", i === 0 && "opacity-20")} onClick={(e) => { e.stopPropagation(); act((g) => moveInParty(g, m.uid, -1)); }}><ArrowUp className="h-3.5 w-3.5" /></span>
                  <span role="button" aria-label="Move down" className={cn("grid h-6 w-7 place-items-center rounded text-parchment/70 hover:bg-white/10", i === gs.party.length - 1 && "opacity-20")} onClick={(e) => { e.stopPropagation(); act((g) => moveInParty(g, m.uid, 1)); }}><ArrowDown className="h-3.5 w-3.5" /></span>
                </div>
              }
            />
          ))}
          <div className="flex items-center justify-between pt-2 font-pixel text-sm text-gold/80">
            <span>Pen at {gs.player.homeName}</span>
            <span className="font-mono text-[11px] text-parchment/50">{gs.pen.length}/{PEN_MAX}</span>
          </div>
          {gs.pen.length === 0 ? <div className="rounded-md border border-dashed border-frame/40 p-3 text-center text-xs text-parchment/50">Empty. Tamed monsters go here when your party is full.</div> : null}
          {!atHamlet && gs.pen.length > 0 ? <div className="text-[11px] text-parchment/50">Visit any hamlet to swap monsters in and out.</div> : null}
          {gs.pen.map((m) => (
            <MonRow key={m.uid} m={m} active={m.uid === mon?.uid} onClick={() => { setSel(m.uid); setFeeding(false); setConfirmRelease(false); }} />
          ))}
        </div>
        {mon ? (
          <div className="panel-parchment min-w-0 flex-1 p-4">
            <MonsterDetail mon={mon} />
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <button className="btn-game btn-ember h-11 text-sm" onClick={() => setFeeding((f) => !f)}><Utensils className="h-4 w-4" /> Feed</button>
              <button className="btn-game btn-night h-11 text-sm" onClick={() => setRename(rename === null ? displayName(mon) : null)}>Rename</button>
              <button
                className="btn-game btn-night h-11 text-sm"
                disabled={!atHamlet}
                onClick={() => { const r = act((g) => swapPartyPen(g, mon.uid)); if (r) toast(r); }}
              >
                {inParty ? "To Pen" : "To Party"}
              </button>
              {confirmRelease ? (
                <button className="btn-game h-11 bg-crimson text-sm text-parchment" onClick={() => { act((g) => releaseMonster(g, mon.uid)); setSel(""); setConfirmRelease(false); }}>Confirm</button>
              ) : (
                <button className="btn-game btn-night h-11 text-sm" disabled={inParty && gs.party.length <= 1} onClick={() => setConfirmRelease(true)}>Release</button>
              )}
            </div>
            {rename !== null ? (
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  act(() => { mon.nickname = rename.trim() ? rename.trim().slice(0, 14) : null; });
                  setRename(null);
                }}
              >
                <input value={rename} onChange={(e) => setRename(e.target.value)} maxLength={14} className="h-11 min-w-0 flex-1 rounded-md border-2 border-frame bg-[#fff8e6] px-3 font-pixel text-ink outline-none" autoFocus />
                <button className="btn-game btn-teal h-11 text-sm">Save</button>
              </form>
            ) : null}
            {feeding ? <FeedGrid gs={gs} onPick={(item) => { const r = act((g) => useItemOn(g, mon, item)); if (r) { act((g) => addLog(g, r, "good")); toast(r); } }} speciesLikes={SPECIES[mon.speciesId].likes} /> : null}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

function FeedGrid({ gs, onPick, speciesLikes, showLikes = true }: { gs: GameState; onPick: (i: ItemId) => void; speciesLikes?: ItemId; showLikes?: boolean }) {
  const items = FOOD_ITEMS(gs);
  if (!items.length) return <div className="mt-3 rounded-md border border-dashed border-frame/50 p-3 text-center text-sm opacity-70">Your bag is empty. Forage in the wild or visit a trader.</div>;
  return (
    <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {items.map((id) => (
        <button key={id} onClick={() => onPick(id)} className={cn("flex items-center gap-2 rounded-md border-2 bg-black/5 p-2 text-left transition-transform active:scale-95", showLikes && speciesLikes === id ? "border-ember" : "border-frame/40 hover:border-frame")}>
          <span className="grid h-8 w-8 place-items-center rounded bg-ink font-pixel text-lg" style={{ color: ITEMS[id].color }}>{ITEMS[id].glyph}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-bold">{ITEMS[id].name}</span>
            <span className="font-mono text-[11px] opacity-60">×{gs.bag[id]}{showLikes && speciesLikes === id ? " · loves" : ""}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------- Bag ------------------------------------- */

export function BagSheet({ gs, open, onClose }: { gs: GameState; open: boolean; onClose: () => void }) {
  const [item, setItem] = useState<ItemId | null>(null);
  const items = FOOD_ITEMS(gs);
  const it = item && (gs.bag[item] ?? 0) > 0 ? ITEMS[item] : null;
  return (
    <Sheet open={open} onClose={onClose} title="Bag" icon={<Backpack className="h-5 w-5" />}>
      <div className="p-3">
        <div className="mb-3 flex items-center gap-2 font-pixel text-gold"><Coins className="h-4 w-4" /> {gs.player.gold} gold</div>
        {items.length === 0 ? <div className="rounded-md border border-dashed border-frame/50 p-6 text-center text-sm text-parchment/60">Nothing but crumbs. Press Forage on rich tiles to gather food.</div> : null}
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {items.map((id) => (
            <button key={id} onClick={() => setItem(id)} className={cn("flex items-center gap-2.5 rounded-md border-2 p-2 text-left", item === id ? "border-gold bg-gold/10" : "border-frame/40 bg-night-3/40")}>
              <span className="grid h-9 w-9 place-items-center rounded bg-night font-pixel text-xl" style={{ color: ITEMS[id].color }}>{ITEMS[id].glyph}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-bold text-parchment">{ITEMS[id].name}</span>
                <span className="block truncate text-[12px] text-parchment/60">{ITEMS[id].desc}</span>
              </span>
              <span className="font-mono text-sm text-parchment/80">×{gs.bag[id]}</span>
            </button>
          ))}
        </div>
        {it && item ? (
          <div className="panel-parchment mt-3 p-3">
            <div className="font-serif text-lg font-bold">{it.name}</div>
            <div className="text-[13px] opacity-75">{it.desc}</div>
            <div className="mt-1 font-mono text-[12px] opacity-70">Food +{it.food} · Heal +{it.heal} · Diets: {it.diets.join(", ") || "any"} · Worth {it.value}g</div>
            <SectionTitle>Give to</SectionTitle>
            <div className="grid gap-1.5 sm:grid-cols-3">
              {gs.party.map((m) => (
                <button
                  key={m.uid}
                  className="flex items-center gap-2 rounded-md border-2 border-frame/40 bg-black/5 p-1.5 hover:border-frame active:scale-95"
                  onClick={() => { const r = act((g) => useItemOn(g, m, item)); if (r) { act((g) => addLog(g, r, "good")); toast(r); } }}
                >
                  <Portrait speciesId={m.speciesId} size={36} />
                  <span className="text-left text-[13px] font-bold leading-tight">{displayName(m)}<br /><span className="font-mono text-[10px] font-normal opacity-60">{m.hp}/{statOf(m, "hp")} · {Math.round(m.satiety)}%</span></span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

/* -------------------------------- Feed wild --------------------------------- */

export function OfferSheet({ gs, open, onClose, creatureId, onEngage }: { gs: GameState; open: boolean; onClose: () => void; creatureId: string | null; onEngage: (id: string) => void }) {
  const c = creatureId ? gs.creatures[creatureId] : null;
  return (
    <Sheet open={open && !!c} onClose={onClose} title={c ? `Offer food to ${SPECIES[c.speciesId].name}` : "Offer food"} icon={<Utensils className="h-5 w-5" />}>
      {c ? (
        <div className="p-3">
          <div className="panel-parchment p-3">
            <div className="flex items-center gap-3">
              <Portrait speciesId={c.speciesId} size={56} />
              <div className="text-[13px] leading-snug">
                Feed a creature its favourite food to calm it and win it over. Enough affection and it will follow you without a fight.
                <div className="mt-1 font-mono text-[12px]">Affection {c.affection}/100 · Diet <span className="capitalize">{SPECIES[c.speciesId].diet}</span></div>
              </div>
            </div>
            <FeedGrid
              gs={gs}
              speciesLikes={SPECIES[c.speciesId].likes}
              showLikes={!!gs.seen[c.speciesId] || gs.player.origin === "scholar"}
              onPick={(item) => {
                const r = act((g) => offerFood(g, c.id, item));
                if (r?.engaged) {
                  onClose();
                  onEngage(r.engaged);
                } else if (!gs.creatures[c.id]) onClose();
              }}
            />
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

/* --------------------------------- Camp ------------------------------------- */

export function CampSheet({ gs, open, onClose, onEngage }: { gs: GameState; open: boolean; onClose: () => void; onEngage: (id: string) => void }) {
  const dawn = hoursUntilDawn(gs.tick);
  const run = (h: number): void => {
    const r = act((g) => campRest(g, h));
    onClose();
    if (r?.engaged) onEngage(r.engaged);
  };
  return (
    <Sheet open={open} onClose={onClose} title="Make Camp" icon={<Tent className="h-5 w-5" />}>
      <div className="space-y-3 p-3">
        <div className="panel-parchment flex items-center gap-3 p-3">
          <Flame className="anim-flicker h-10 w-10 shrink-0 text-ember" fill="#f2c14e" />
          <p className="text-[13px] leading-snug">
            Rest heals your monsters and roasts any raw nuts you carry. Hungry monsters eat from your bag. The wild doesn't sleep, though. Predators may find your fire.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <button className="btn-game btn-night h-14 flex-col gap-0 text-sm" onClick={() => run(2)}>2 hours<span className="font-body text-[11px] opacity-60">short rest</span></button>
          <button className="btn-game btn-night h-14 flex-col gap-0 text-sm" onClick={() => run(4)}>4 hours<span className="font-body text-[11px] opacity-60">long rest</span></button>
          <button className="btn-game btn-ember h-14 flex-col gap-0 text-sm" onClick={() => run(dawn)}>Until dawn<span className="font-body text-[11px] opacity-80">{dawn}h</span></button>
        </div>
      </div>
    </Sheet>
  );
}

/* ----------------------------- Hamlet folk ---------------------------------- */

const NPC_ROLE: Record<Npc["role"], string> = { innkeep: "Innkeeper", trader: "Trader", penkeeper: "Pen Keeper" };
const NPC_ICON: Record<Npc["role"], typeof Home> = { innkeep: BedDouble, trader: Coins, penkeeper: PawPrint };

export function NpcSheet({ gs, open, npc, onClose, onParty }: { gs: GameState; open: boolean; npc: Npc | null; onClose: () => void; onParty: () => void }) {
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const sellable = FOOD_ITEMS(gs);
  const isHome = gs.player.x === gs.player.homeX && gs.player.y === gs.player.homeY;
  const hamletName = npc?.hamlet ?? "";
  if (!npc) return null;
  const Icon = NPC_ICON[npc.role];
  return (
    <Sheet open={open} onClose={onClose} title={`${npc.name} · ${NPC_ROLE[npc.role]}`} icon={<Icon className="h-5 w-5" />}>
      <div className="space-y-3 p-3">
        <div className="panel-parchment p-3">
          <div className="font-serif text-sm font-bold">“{npc.line}”</div>
          <div className="mt-1 font-mono text-[11px] opacity-60">{npc.name} of {hamletName}</div>
        </div>
        <div className="flex items-center justify-between font-pixel text-gold"><span className="flex items-center gap-2"><Coins className="h-4 w-4" /> {gs.player.gold} gold</span>{isHome ? <span className="text-xs text-teal">Home</span> : null}</div>
        {npc.role === "innkeep" ? (
          <>
            <button className="btn-game btn-ember h-14 w-full flex-col gap-0 text-sm" disabled={gs.player.gold < INN_COST} onClick={() => { const r = act((g) => innRest(g)); if (r) { toast(r); onClose(); } }}>
              <span className="flex items-center gap-1.5"><BedDouble className="h-4 w-4" /> Rest at the Inn</span>
              <span className="font-body text-[11px] opacity-80">{INN_COST}g · full heal, fed, until dawn</span>
            </button>
            {!isHome ? (
              <button
                className="btn-game btn-night h-11 w-full text-sm"
                onClick={() => act((g) => { g.player.homeX = g.player.x; g.player.homeY = g.player.y; g.player.homeName = hamletName; addLog(g, `You make ${hamletName} your home. ${npc.name} promises to bring your monsters over.`, "good"); onClose(); })}
              >
                <Home className="h-4 w-4" /> Make {hamletName} your home
              </button>
            ) : null}
          </>
        ) : null}
        {npc.role === "penkeeper" ? (
          <button className="btn-game btn-night h-14 w-full flex-col gap-0 text-sm" onClick={onParty}>
            <span className="flex items-center gap-1.5"><PawPrint className="h-4 w-4" /> Visit the Monster Pen</span>
            <span className="font-body text-[11px] opacity-60">{gs.pen.length} waiting · swap party members</span>
          </button>
        ) : null}
        {npc.role === "trader" ? (
          <div className="panel-parchment p-3">
            <div className="mb-2 flex gap-2">
              {(["buy", "sell"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} className={cn("h-9 flex-1 rounded-md border-2 font-pixel text-sm capitalize", tab === t ? "border-ember bg-ember/15" : "border-frame/40")}>{t}</button>
              ))}
            </div>
            <div className="space-y-1.5">
              {(tab === "buy" ? SHOP_STOCK : sellable).map((id) => {
                const price = tab === "buy" ? Math.ceil(ITEMS[id].value * 1.5) : ITEMS[id].value;
                return (
                  <div key={id} className="flex items-center gap-2.5 rounded-md border border-frame/40 bg-black/5 p-2">
                    <span className="grid h-8 w-8 place-items-center rounded bg-ink font-pixel text-lg" style={{ color: ITEMS[id].color }}>{ITEMS[id].glyph}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-bold">{ITEMS[id].name} {tab === "sell" ? <span className="font-mono font-normal opacity-60">×{gs.bag[id]}</span> : null}</span>
                      <span className="block truncate text-[11px] opacity-65">{ITEMS[id].desc}</span>
                    </span>
                    <button
                      className="btn-game btn-parch h-10 min-w-[72px] px-2 text-sm"
                      disabled={tab === "buy" && gs.player.gold < price}
                      onClick={() => { const r = act((g) => (tab === "buy" ? buyItem(g, id) : sellItem(g, id))); if (r) toast(r); }}
                    >
                      {price}g
                    </button>
                  </div>
                );
              })}
              {tab === "sell" && sellable.length === 0 ? <div className="p-3 text-center text-sm opacity-60">Nothing to sell.</div> : null}
            </div>
          </div>
        ) : null}
      </div>
    </Sheet>
  );}

/* -------------------------------- Shrine ------------------------------------ */

export function ShrineSheet({ gs, open, onClose, name }: { gs: GameState; open: boolean; onClose: () => void; name: string }) {
  const [a, setA] = useState<string>("");
  const [b, setB] = useState<string>("");
  const all = [...gs.party, ...gs.pen];
  const ma = all.find((m) => m.uid === a) ?? null;
  const mb = all.find((m) => m.uid === b) ?? null;
  const preview = useMemo(() => (ma && mb ? previewSynthesis(ma, mb) : null), [ma, mb]);
  const ready = !!ma && !!mb && ma.level >= SYNTH_MIN_LEVEL && mb.level >= SYNTH_MIN_LEVEL && all.length > 2;
  const known = preview ? !!gs.seen[preview.speciesId] : false;

  const pick = (uid: string): void => {
    if (a === uid) setA("");
    else if (b === uid) setB("");
    else if (!a) setA(uid);
    else setB(uid);
  };

  return (
    <Sheet open={open} onClose={onClose} wide title={name} icon={<Sparkles className="h-5 w-5 text-teal" />}>
      <div className="flex flex-col gap-3 p-3 md:flex-row">
        <div className="md:w-80 md:shrink-0">
          <p className="mb-2 text-[13px] text-parchment/70">Choose two monsters of level {SYNTH_MIN_LEVEL}+. The shrine joins them into one new creature that inherits their genes, a few skills, sometimes their mutations, and grows stronger (+).</p>
          <div className="space-y-1.5">
            {all.map((m) => (
              <MonRow
                key={m.uid}
                m={m}
                active={m.uid === a || m.uid === b}
                onClick={() => pick(m.uid)}
                right={m.level < SYNTH_MIN_LEVEL ? <span className="font-mono text-[10px] text-[#ff8a7a]">Lv{SYNTH_MIN_LEVEL}+</span> : m.uid === a ? <span className="font-pixel text-gold">A</span> : m.uid === b ? <span className="font-pixel text-gold">B</span> : null}
              />
            ))}
          </div>
        </div>
        <div className="panel-parchment min-w-0 flex-1 p-4">
          <div className="flex items-center justify-center gap-3">
            {ma ? <Portrait speciesId={ma.speciesId} size={76} /> : <div className="grid h-[76px] w-[76px] place-items-center rounded-md border-2 border-dashed border-frame/50 font-pixel opacity-50">A</div>}
            <span className="font-pixel text-2xl text-teal">+</span>
            {mb ? <Portrait speciesId={mb.speciesId} size={76} /> : <div className="grid h-[76px] w-[76px] place-items-center rounded-md border-2 border-dashed border-frame/50 font-pixel opacity-50">B</div>}
            <span className="font-pixel text-2xl text-teal">=</span>
            {preview ? <Portrait speciesId={preview.speciesId} size={92} silhouette={!known} className="anim-bob" /> : <div className="grid h-[92px] w-[92px] place-items-center rounded-md border-2 border-dashed border-frame/50 font-pixel text-2xl opacity-50">?</div>}
          </div>
          {preview ? (
            <div className="mt-3">
              <div className="text-center font-serif text-xl font-extrabold">
                {known ? SPECIES[preview.speciesId].name : "An unknown creature"} <span className="font-pixel text-ember">+{preview.plus}</span>
              </div>
              {known ? <div className="text-center text-[13px] opacity-70">{SPECIES[preview.speciesId].title} · <span style={{ color: ELEMENTS[SPECIES[preview.speciesId].element].color }}>{ELEMENTS[SPECIES[preview.speciesId].element].name}</span></div> : null}
              <SectionTitle>Inherited genes (before drift)</SectionTitle>
              <div className="grid grid-cols-6 gap-1 text-center">
                {(Object.keys(preview.genes) as GeneKey[]).map((k) => {
                  const p = preview.genes[k];
                  const expr = expressGene(p);
                  return (
                    <div key={k} className="rounded bg-black/5 py-1">
                      <div className="font-mono text-[10px] opacity-60">{GENE_LABEL[k]}</div>
                      <div className="font-pixel text-lg">{k === "size" ? `${sizeToFootprint(expr)}×${sizeToFootprint(expr)}` : geneGrade(expr)}</div>
                      <div className="font-mono text-[9px] opacity-50">{p.a}/{p.b}</div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 text-[13px]">
                <b>Sex:</b> <span style={{ color: SEX_INFO[preview.sex].color }}>{SEX_INFO[preview.sex].glyph} {SEX_INFO[preview.sex].label}</span> · <b>Inherited skills:</b> {preview.inherited.length ? preview.inherited.join(", ").replace(/_/g, " ") : "none"} · <b>Mutation chance:</b> {Math.round(preview.mutationChance * 100)}%
              </div>
              <p className="mt-2 text-[12px] italic opacity-70">Both parents are consumed. The child starts at level 1, but its + makes every stat stronger.</p>
              <button
                className="btn-game btn-teal mt-3 h-12 w-full"
                disabled={!ready}
                onClick={() => {
                  const child = act((g) => synthesize(g, a, b));
                  if (child) {
                    toast(`A new ${SPECIES[child.speciesId].name} is born!`);
                    setA("");
                    setB("");
                  }
                }}
              >
                <Sparkles className="h-4 w-4" /> Perform Synthesis
              </button>
              {!ready ? <div className="mt-1 text-center text-[12px] text-[#9a2a3a]">{all.length <= 2 ? "You must keep at least one other monster." : `Both must be level ${SYNTH_MIN_LEVEL} or higher.`}</div> : null}
            </div>
          ) : (
            <p className="mt-6 text-center text-sm opacity-60">Choose two monsters to see what the roots will make of them.</p>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/* -------------------------------- Notices ----------------------------------- */

/** The hamlet notices board: seeded postings from the local beast-tamer association. */
export function NoticesSheet({ gs, open, onClose, hamlet }: { gs: GameState; open: boolean; onClose: () => void; hamlet: Feature | null }) {
  const notices = useMemo(() => (hamlet ? getFactions(gs.seed).hamletNotices(hamlet) : []), [gs.seed, hamlet]);
  const nation = hamlet ? getFactions(gs.seed).nationAt(hamlet.x, hamlet.y) : null;
  const assoc = notices[0]?.assoc ?? null;
  return (
    <Sheet open={open} onClose={onClose} title={hamlet ? `${hamlet.name} · Notices` : "Notices"} icon={<ScrollText className="h-5 w-5 text-gold" />}>
      <div className="space-y-2.5 p-3">
        {notices.length ? (
          notices.map((n, i) => (
            <div key={i} className="panel-parchment p-3">
              <div className="font-serif text-sm leading-snug">{n.text}</div>
            </div>
          ))
        ) : (
          <p className="p-3 text-center text-sm opacity-60">The board holds only weather-worn staples. No association posts here.</p>
        )}
        {assoc && nation ? (
          <div className="text-center font-mono text-[11px] opacity-60">
            Posted by the {assoc.name} · chartered by the {nation.title}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
