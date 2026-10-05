import { memo, useEffect, useRef } from "react";
import { BedDouble, Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, Coins, Droplets, Feather, Flame, Footprints, Leaf, Mountain, MapPinned, MessageCircle, PawPrint, Scale, Shield, Sun, Swords, Thermometer, Wind, Crown, Navigation, Utensils } from "lucide-react";
import { aggrOf, queueSkill, setAggr, setOrder, statusesOf, wildMonster } from "@/game/combat";
import { BIOMES, ITEMS, PERSONALITIES, SKILLS, SPECIES, STATUSES, STAT_LABEL, TRAITS } from "@/game/data";
import { getFactions } from "@/game/factions";
import { isRegionSeen } from "@/game/knowledge";
import { expressGene } from "@/game/genetics";
import { GENE_FOR, displayName, geneGrade, statsOf, statOf } from "@/game/monster";
import { hash2 } from "@/game/rng";
import { compass, creatureAt, dangerLevel, canSee } from "@/game/sim";
import { act } from "@/game/store";
import { biomeTex, featureTex, terrainTex } from "@/game/tiles";
import type { Aggression, FieldOrder, GameState, Monster, StatKey, WeatherId, WildCreature } from "@/game/types";
import { getWorld, type Npc } from "@/game/world";
import { cn } from "@/lib/utils";
import { Bar, ElementBadge, Portrait, Tag, hpColor } from "./ui";

export const WEATHER_ICON: Record<WeatherId, typeof Sun> = {
  clear: Sun, cloudy: Cloud, rain: CloudRain, storm: CloudLightning, snow: CloudSnow, fog: CloudFog, sandstorm: Wind,
};
export const WEATHER_NAME: Record<WeatherId, string> = {
  clear: "Clear", cloudy: "Overcast", rain: "Rain", storm: "Thunderstorm", snow: "Snowfall", fog: "Fog", sandstorm: "Sandstorm",
};

const FEATURE_DESC: Record<string, string> = {
  hamlet: "A small hamlet. Inn, trader, and friendly faces.",
  ruin: "Old stones from an older people. Something may be buried here.",
  shrine: "A shrine of twisted roots. Two monsters may be joined here.",
  lair: "A lair. Its alpha and its loyal pack guard it.",
};

const TileThumb = memo(function TileThumb({ gs, x, y }: { gs: GameState; x: number; y: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    const world = getWorld(gs.seed);
    const ts = 32;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const t = world.tile(x + dx, y + dy);
        const X = (dx + 3) * ts;
        const Y = (dy + 1) * ts;
        ctx.drawImage(biomeTex(t.biome, hash2(gs.seed, x + dx, y + dy) % 4), X, Y, ts, ts);
        const sp = world.siteAt(x + dx, y + dy);
        if (sp) {
          const st = sp.wall ? (sp.kind === "hamlet" ? "woodwall" : "wall") : sp.door ? "door" : sp.rubble ? "rubble" : "floor";
          const sv = st === "floor" ? (sp.kind === "hamlet" ? 1 : sp.kind === "lair" ? 2 : 0) : 0;
          ctx.drawImage(terrainTex(st, sv), X, Y, ts, ts);
        }
        if (t.feature) ctx.drawImage(featureTex(t.feature.kind), X, Y, ts, ts);
      }
    }
    ctx.strokeStyle = "#fff4dc";
    ctx.lineWidth = 2;
    ctx.strokeRect(3 * ts + 1, ts + 1, ts - 2, ts - 2);
  }, [gs, x, y]);
  return <canvas ref={ref} width={224} height={96} className="pixel h-auto w-full rounded border-2 border-frame/70" />;
});

function Row({ icon: Icon, children }: { icon: typeof Sun; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[13px] leading-snug">
      <Icon className="mt-[2px] h-3.5 w-3.5 shrink-0 opacity-70" />
      <span>{children}</span>
    </div>
  );
}

export function TileCard({ gs, x, y }: { gs: GameState; x: number; y: number }) {
  const world = getWorld(gs.seed);
  const t = world.tile(x, y);
  const b = BIOMES[t.biome];
  const w = world.weather(x, y, gs.tick);
  const WIcon = WEATHER_ICON[w.id];
  const forage = b.passable ? world.forage(x, y, gs.tick, gs.depleted) : null;
  const danger = b.passable ? dangerLevel(world, x, y, t.biome, 1) : 0;
  const here = x === gs.player.x && y === gs.player.y;
  const fac = getFactions(gs.seed);
  const nat = fac.nationAt(x, y);
  const assoc = t.feature?.kind === "hamlet" ? fac.associationAt(t.feature) : null;
  return (
    <div className="panel-parchment corners p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="truncate font-serif text-[17px] font-extrabold">{world.tileTitle(t)}</div>
        <div className="shrink-0 font-mono text-[11px] opacity-70">({x}, {y})</div>
      </div>
      <TileThumb gs={gs} x={x} y={y} />
      <div className="mt-2 space-y-1">
        <Row icon={Leaf}><b>{b.name}</b>{t.river && t.biome !== "river" ? " · River" : ""} · {b.vegetation}</Row>
        <Row icon={Mountain}>Elevation {t.height > 0 ? `${t.height} m` : `${-t.height} m deep`} · {world.regionName(x, y)} lands</Row>
        <Row icon={Crown}>{nat ? <><b style={{ color: nat.color }}>{nat.title}</b> territory</> : "Unclaimed wilds"}</Row>
        {assoc ? <Row icon={Scale}>Chapter of the <b>{assoc.name}</b> · chartered by {fac.nationById(assoc.nationId)?.title}</Row> : null}
        <Row icon={Thermometer}>Temp {w.temp}°C · <Droplets className="inline h-3 w-3" /> Humidity {w.humidity}%</Row>
        <Row icon={WIcon}>{WEATHER_NAME[w.id]} · Wind {Math.round(w.wind * 40)} km/h</Row>
        {b.passable ? <Row icon={Footprints}>Movement cost {b.cost} · Danger Lv ~{danger}</Row> : <Row icon={Footprints}>Impassable</Row>}
        {b.passable && b.forage.length ? (
          <Row icon={Utensils}>{forage ? <>Forage: <b style={{ color: "#5a6b1a" }}>{ITEMS[forage].name}</b></> : gs.depleted[`${x},${y}`] !== undefined ? "Picked clean recently" : "Nothing to forage right now"}</Row>
        ) : null}
      </div>
      <p className="mt-1.5 text-[12px] italic opacity-70">{t.feature ? FEATURE_DESC[t.feature.kind] : b.blurb}{here ? " You are here." : ""}</p>
    </div>
  );
}

/** What the player remembers about a tile they have explored but left. */
export function MemoryTileCard({ gs, x, y }: { gs: GameState; x: number; y: number }) {
  const world = getWorld(gs.seed);
  const t = world.tile(x, y);
  const b = BIOMES[t.biome];
  const nat = getFactions(gs.seed).nationAt(x, y);
  return (
    <div className="panel-parchment corners p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="truncate font-serif text-[17px] font-extrabold">{world.tileTitle(t)}</div>
        <div className="shrink-0 font-mono text-[11px] opacity-70">({x}, {y})</div>
      </div>
      <div className="space-y-1">
        <Row icon={Leaf}><b>{b.name}</b>{t.river && t.biome !== "river" ? " · River" : ""}</Row>
        <Row icon={Mountain}>Elevation {t.height > 0 ? `${t.height} m` : `${-t.height} m deep`} · {world.regionName(x, y)} lands</Row>
        <Row icon={Crown}>{nat ? nat.title : "Unclaimed wilds"}</Row>
        {t.feature ? <Row icon={Navigation}>{t.feature.name}</Row> : null}
      </div>
      <p className="mt-1.5 text-[12px] italic opacity-70">You remember this place, though you are not there now. Who knows what has changed since.</p>
    </div>
  );
}

/** What the player can know about a tile they have never observed: nothing. */
export function UnknownTileCard({ gs, x, y }: { gs: GameState; x: number; y: number }) {
  const world = getWorld(gs.seed);
  const seen = isRegionSeen(gs.knowledge, x, y);
  return (
    <div className="panel-parchment corners p-3">
      <div className="mb-1 flex items-center gap-2 font-serif text-[17px] font-extrabold"><MapPinned className="h-4 w-4 opacity-60" /> Unexplored</div>
      <div className="text-[13px] opacity-80">{seen ? `Somewhere in the ${world.regionName(x, y)} lands.` : "Lands you have never laid eyes on."}</div>
      <div className="mt-1 font-mono text-[11px] opacity-60">({x}, {y})</div>
      <p className="mt-1.5 text-[12px] italic opacity-70">The map only knows what you have seen. Travel closer to learn more.</p>
    </div>
  );
}

const DISP_COLOR: Record<string, string> = { curious: "#2a8a7a", skittish: "#8a6a2a", aggressive: "#b23a48", calm: "#3f7fd0" };

const NPC_ROLE: Record<Npc["role"], { title: string; desc: string; icon: typeof Sun }> = {
  innkeep: { title: "Innkeeper", desc: "Keeps the inn — a warm bed until dawn, and a hearth you could call home.", icon: BedDouble },
  trader: { title: "Trader", desc: "Buys what you forage, sells what you need. Coin on the barrel.", icon: Coins },
  penkeeper: { title: "Pen Keeper", desc: "Tends the monster pens. Swap who walks beside you here.", icon: PawPrint },
};

/** Inspect card for a hamlet folk standing at their post. */
export function NpcCard({ npc, gs, onTalk, onApproach }: { npc: Npc; gs: GameState; onTalk: () => void; onApproach: () => void }) {
  const role = NPC_ROLE[npc.role];
  const Icon = role.icon;
  const d = Math.max(Math.abs(npc.x - gs.player.x), Math.abs(npc.y - gs.player.y));
  return (
    <div className="panel-parchment corners p-3">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 font-serif text-[17px] font-extrabold">
        <Icon className="h-4 w-4 opacity-70" />
        {npc.name}
        <span className="font-pixel text-sm font-normal opacity-70">{role.title}</span>
      </div>
      <div className="text-[12px] opacity-70">
        of {npc.hamlet} · {d === 0 ? "right beside you" : d <= 1 ? "adjacent" : `${d} tiles away`}
      </div>
      <p className="mt-1.5 font-serif text-sm italic leading-snug">“{npc.line}”</p>
      <p className="mt-1.5 text-[12px] leading-snug opacity-80">{role.desc}</p>
      <div className="mt-2.5">
        {d <= 1 ? (
          <button className="btn-game btn-ember h-11 w-full text-sm" onClick={onTalk}><MessageCircle className="h-4 w-4" /> Talk to {npc.name}</button>
        ) : (
          <button className="btn-game btn-night h-11 w-full text-sm" onClick={onApproach}><Navigation className="h-4 w-4" /> Walk over</button>
        )}
      </div>
    </div>
  );
}

export function CreatureCard({
  gs, c, onFight, onFeed, onApproach, onTarget,
}: {
  gs: GameState;
  c: WildCreature;
  onFight: () => void;
  onFeed: () => void;
  onApproach: () => void;
  onTarget: () => void;
}) {
  const sp = SPECIES[c.speciesId];
  const mon = wildMonster(gs, c);
  const st = statsOf(mon);
  const hp = Math.round(st.hp * c.hpFrac);
  const scholar = gs.player.origin === "scholar";
  const d = Math.max(Math.abs(c.x - gs.player.x), Math.abs(c.y - gs.player.y));
  const calm = c.calmUntil > gs.tick;
  const disp = calm ? "calm" : c.disposition;
  const hostile = c.stalking || (c.disposition === "aggressive" && !calm);
  const sts = statusesOf(gs, c.id);
  return (
    <div className="panel-parchment corners p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 truncate font-serif text-[17px] font-extrabold">
          {c.alpha ? <Crown className="h-4 w-4 text-[#b8860b]" /> : null}
          {c.alpha ? "Great " : "Wild "}{sp.name} <span className="font-pixel text-sm font-normal opacity-80">Lv {c.level}</span>
        </div>
      </div>
      <div className="flex gap-3">
        <Portrait speciesId={c.speciesId} size={84} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="w-14 font-mono">HP {hp}/{st.hp}</span>
            <Bar value={hp} max={st.hp} color={hpColor(c.hpFrac)} className="flex-1" />
          </div>
          <div className="flex items-center gap-2 text-[12px]">
            <span className="w-14 font-mono">Hunger {Math.round(100 - c.satiety)}%</span>
            <Bar value={100 - c.satiety} max={100} color="linear-gradient(180deg,#f2c14e,#c98a2b)" className="flex-1" />
          </div>
          <div className="text-[13px] font-bold" style={{ color: DISP_COLOR[disp] }}>
            Disposition: <span className="capitalize">{disp}</span>
          </div>
          <div className="text-[12px] opacity-80">{c.activity} · {d <= 1 ? "adjacent" : `${d} tiles ${compass(c.x - gs.player.x, c.y - gs.player.y).replace("to the ", "")}`}</div>
        </div>
      </div>
      <p className="mt-2 text-[13px] leading-snug opacity-80">{sp.desc}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        <ElementBadge element={sp.element} />
        <Tag color="#6b5a7a">{sp.family}</Tag>
        <Tag color="#7a6a4a">{PERSONALITIES[c.personality].name}</Tag>
        {sp.traits.map((t) => <Tag key={t} color="#4a6a5a">{TRAITS[t].name}</Tag>)}
        {sts.map((s) => <Tag key={s.id} color={STATUSES[s.id].color}>{STATUSES[s.id].name} {s.turns}</Tag>)}
      </div>
      <div className="mt-2 grid grid-cols-5 gap-1 text-center">
        {(Object.keys(st) as StatKey[]).map((k) => (
          <div key={k} className="rounded bg-black/5 py-0.5">
            <div className="font-mono text-[10px] opacity-60">{STAT_LABEL[k]}</div>
            <div className="font-pixel text-[15px] leading-tight">{st[k]}</div>
            <div className="font-mono text-[9px] opacity-60">{scholar ? geneGrade(expressGene(mon.genes[GENE_FOR[k]])) : "?"}</div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 text-[12px] opacity-75">
        Diet <span className="capitalize">{sp.diet}</span> · Likes {gs.seen[c.speciesId] || scholar ? ITEMS[sp.likes].name : "???"}
        {c.affection > 0 ? ` · Affection ${c.affection}/100` : ""}
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-2">
        {d <= 1 ? (
          <>
            <button className="btn-game btn-parch h-11 text-sm" onClick={onFeed}><Utensils className="h-4 w-4" /> Offer Food</button>
            {hostile ? (
              <button className="btn-game btn-ember h-11 text-sm" onClick={onFight}><Swords className="h-4 w-4" /> Engage</button>
            ) : (
              <button className="btn-game btn-night h-11 text-sm" onClick={onTarget}><Swords className="h-4 w-4" /> Mark target</button>
            )}
          </>
        ) : (
          <button className="btn-game btn-night col-span-2 h-11 text-sm" onClick={onApproach}><Navigation className="h-4 w-4" /> Approach</button>
        )}
      </div>
    </div>
  );
}

const ORDER_LABEL: Record<FieldOrder, string> = { follow: "Follow", attack: "Attack", hold: "Hold" };

/** A targeting request: pick an enemy for the attack order, or a target for a skill. */
export type PickMode = { mode: "target"; uid: string } | { mode: "skill"; uid: string; skillId: string };

const AGGR_ICON: Record<Aggression, typeof Flame> = { passive: Feather, neutral: Scale, aggressive: Flame };
const AGGR_LABEL: Record<Aggression, string> = { passive: "Passive", neutral: "Neutral", aggressive: "Aggressive" };
const AGGR_HINT: Record<Aggression, string> = {
  passive: "Only fights when you order it to.",
  neutral: "Fights back when hostiles close in.",
  aggressive: "Seeks out hostiles on its own.",
};

/**
 * Command console for a party monster on the live map: its order, temperament,
 * health, statuses and skills — with Follow / Attack-target / Hold buttons,
 * tap-to-target skill orders, and a Passive / Neutral / Aggressive temper.
 */
export function PartyCommandCard({
  gs,
  mon,
  picking = null,
  onPickTarget,
  onOrderSkill,
}: {
  gs: GameState;
  mon: Monster;
  picking?: PickMode | null;
  onPickTarget?: (uid: string) => void;
  onOrderSkill?: (uid: string, skillId: string) => void;
}) {
  const sp = SPECIES[mon.speciesId];
  const max = statOf(mon, "hp");
  const order: FieldOrder = gs.orders[mon.uid] ?? "follow";
  const aggr = aggrOf(gs, mon.uid);
  const sts = statusesOf(gs, mon.uid);
  const pos = gs.field[mon.uid];
  const target = gs.target ? gs.creatures[gs.target] : null;
  const downed = mon.hp <= 0;
  const queued = gs.skillQ[mon.uid];
  const pickingTarget = picking?.mode === "target" && picking.uid === mon.uid;
  return (
    <div className="panel-parchment corners p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-1.5 truncate font-serif text-[17px] font-extrabold">
          {displayName(mon)} <span className="font-pixel text-sm font-normal opacity-80">Lv {mon.level}</span>
          {mon.plus ? <span className="font-pixel text-ember">+{mon.plus}</span> : null}
        </div>
        <span className="shrink-0 font-mono text-[11px] opacity-70">{pos ? `${pos.x}, ${pos.y}` : ""}</span>
      </div>
      <div className="flex gap-3">
        <Portrait speciesId={mon.speciesId} size={84} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="w-14 font-mono">HP {mon.hp}/{max}</span>
            <Bar value={mon.hp} max={max} color={hpColor(mon.hp / max)} className="flex-1" />
          </div>
          <div className="flex items-center gap-2 text-[12px]">
            <span className="w-14 font-mono">Hunger {Math.round(100 - mon.satiety)}%</span>
            <Bar value={100 - mon.satiety} max={100} color="linear-gradient(180deg,#f2c14e,#c98a2b)" className="flex-1" />
          </div>
          <div className="text-[12px] opacity-80">Bond {mon.bond} · Order: <b>{ORDER_LABEL[order]}</b>{downed ? " · DOWNED" : ""}</div>
        </div>
      </div>
      {sts.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {sts.map((s) => <Tag key={s.id} color={STATUSES[s.id].color}>{STATUSES[s.id].name} {s.turns}</Tag>)}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1">
        <ElementBadge element={sp.element} />
        {mon.skills.slice(-4).map((s) => {
          const sk = SKILLS[s];
          if (!sk) return null;
          const cd = gs.fighters[mon.uid]?.cooldowns[s] ?? 0;
          const pickingThis = picking?.mode === "skill" && picking.uid === mon.uid && picking.skillId === s;
          return (
            <button
              key={s}
              disabled={downed || cd > 0}
              title={`${sk.name} — ${sk.desc}`}
              onClick={() => (onOrderSkill ? onOrderSkill(mon.uid, s) : act((g) => queueSkill(g, mon.uid, s, mon.uid)))}
              className={cn(
                "rounded border px-1.5 py-0.5 text-[11px] font-bold transition-colors",
                pickingThis || queued?.skill === s
                  ? "border-ember bg-ember/15 text-ember"
                  : "border-[#4a5a7a]/50 bg-[#4a5a7a]/10 text-[#3d4d6e] hover:bg-[#4a5a7a]/25",
                (downed || cd > 0) && "opacity-45",
              )}
            >
              {sk.name}
              {cd > 0 ? ` ·${cd}` : ""}
            </button>
          );
        })}
      </div>
      {downed ? (
        <p className="mt-2.5 rounded bg-[#b23a48]/10 p-2 text-[12px] font-bold text-[#b23a48]">Downed — revive with a Hearth Tonic, at camp (3h+), or the inn.</p>
      ) : (
        <>
          <div className="mt-2.5 grid grid-cols-3 gap-2">
            {(["follow", "attack", "hold"] as FieldOrder[]).map((o) => {
              const Icon = o === "follow" ? Footprints : o === "attack" ? Swords : Shield;
              return (
                <button
                  key={o}
                  className={cn("btn-game h-10 flex-col gap-0 text-[12px]", order === o || (o === "attack" && pickingTarget) ? "btn-ember" : "btn-night")}
                  onClick={() => {
                    if (o === "attack" && onPickTarget) onPickTarget(mon.uid);
                    else act((g) => setOrder(g, mon.uid, o));
                  }}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {ORDER_LABEL[o]}
                </button>
              );
            })}
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider opacity-60">Temper</span>
            <div className="grid flex-1 grid-cols-3 gap-1.5">
              {(["passive", "neutral", "aggressive"] as Aggression[]).map((a) => {
                const Icon = AGGR_ICON[a];
                return (
                  <button key={a} className={cn("btn-game h-8 gap-1 px-1 text-[10.5px]", aggr === a ? "btn-ember" : "btn-night")} onClick={() => act((g) => setAggr(g, mon.uid, a))}>
                    <Icon className="h-3.5 w-3.5" />
                    {AGGR_LABEL[a]}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
      <div className="mt-1.5 text-[11px] leading-snug opacity-70">
        {queued && SKILLS[queued.skill]
          ? `Ordered: ${SKILLS[queued.skill].name} — closing in on its mark.`
          : order === "attack"
            ? target
              ? `Hunting the ${SPECIES[target.speciesId].name}. Press Attack to retarget.`
              : "No target yet — press Attack, then tap an enemy."
            : order === "hold"
              ? "Holds this ground."
              : "Follows at your side."}{" "}
        {AGGR_HINT[aggr]}
      </div>
    </div>
  );
}

export function useSelectedCreature(gs: GameState, sel: { x: number; y: number } | null): WildCreature | null {
  if (!sel) return null;
  const c = creatureAt(gs, sel.x, sel.y);
  return c && canSee(gs, c.x, c.y) ? c : null;
}
