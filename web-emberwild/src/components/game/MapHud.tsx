import { Home, LocateFixed, Minus, Plus, Skull, Sparkles, Triangle } from "lucide-react";
import type { ReactNode } from "react";
import type { MapScale } from "@/game/mapview";
import { cn } from "@/lib/utils";

const SCALE_NAME: Record<MapScale, string> = { world: "World", region: "Region", local: "Local" };

const ctlBtn =
  "grid h-11 w-11 place-items-center rounded-md border-2 border-frame/80 bg-night/85 text-parchment backdrop-blur-sm transition active:scale-90 disabled:opacity-40 disabled:active:scale-100";

/** Zoom in/out + center controls for the exploration map. */
export function ZoomControls({
  scale,
  onZoom,
  onCenter,
}: {
  scale: MapScale;
  onZoom: (dir: 1 | -1) => void;
  onCenter: () => void;
}) {
  return (
    <div className="absolute right-2 top-2 z-10 flex flex-col items-center gap-1.5">
      <button className={ctlBtn} onClick={() => onZoom(1)} disabled={scale === "local"} aria-label="Zoom in">
        <Plus className="h-5 w-5" />
      </button>
      <span className="rounded border border-frame/60 bg-night/85 px-1 py-0.5 text-center font-pixel text-[10px] leading-none text-gold backdrop-blur-sm">
        {SCALE_NAME[scale]}
      </span>
      <button className={ctlBtn} onClick={() => onZoom(-1)} disabled={scale === "world"} aria-label="Zoom out">
        <Minus className="h-5 w-5" />
      </button>
      {scale !== "local" ? (
        <button className={cn(ctlBtn, "h-10 w-10")} onClick={onCenter} aria-label="Center on you">
          <LocateFixed className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

interface LegendItem {
  glyph: ReactNode;
  label: string;
}

const fogGlyph = <span className="inline-block h-2.5 w-2.5 rounded-[2px] border border-frame/80 bg-[#131022]" aria-hidden />;
const routeGlyph = <span className="inline-block w-4 border-t-2 border-dashed border-gold/80" aria-hidden />;

/** Compact legend for the REGION/WORLD zooms — the local map reads clearly without one. */
export function MapLegend({ scale }: { scale: MapScale }) {
  const chips: LegendItem[] =
    scale === "region"
      ? [
            { glyph: <Home className="h-3 w-3 text-gold" aria-hidden />, label: "Hamlet" },
            { glyph: <span className="text-[11px] leading-none text-[#f0e6cf]" aria-hidden>⚑</span>, label: "Capital" },
            { glyph: <span className="text-[11px] leading-none text-[#c9b7e6]" aria-hidden>⚖</span>, label: "Chapter" },
            { glyph: <Sparkles className="h-3 w-3 text-[#3fb8a5]" aria-hidden />, label: "Shrine" },
            { glyph: <Triangle className="h-3 w-3 text-parchment/90" aria-hidden />, label: "Ruin" },
            { glyph: <Skull className="h-3 w-3 text-[#ff8a7a]" aria-hidden />, label: "Lair" },
            { glyph: routeGlyph, label: "Trail" },
            { glyph: fogGlyph, label: "Unknown" },
          ]
        : [
            { glyph: <Home className="h-3 w-3 text-gold" aria-hidden />, label: "Hamlet" },
            { glyph: <span className="text-[11px] leading-none text-[#f0e6cf]" aria-hidden>⚑</span>, label: "Capital" },
            { glyph: <span className="text-[11px] leading-none text-[#c9b7e6]" aria-hidden>⚖</span>, label: "Chapter" },
            { glyph: <Sparkles className="h-3 w-3 text-[#3fb8a5]" aria-hidden />, label: "Shrine" },
            { glyph: <Skull className="h-3 w-3 text-[#ff8a7a]" aria-hidden />, label: "Lair" },
            { glyph: routeGlyph, label: "Trail" },
            { glyph: fogGlyph, label: "Unknown" },
          ];
  return (
    <div className="pointer-events-none absolute bottom-14 left-1/2 z-10 flex max-w-[86%] -translate-x-1/2 flex-wrap items-center justify-center gap-1">
      {chips.map((c) => (
        <span
          key={c.label}
          className="flex items-center gap-1 rounded border border-frame/60 bg-night/85 px-1.5 py-0.5 font-pixel text-[10px] leading-none text-parchment/90 backdrop-blur-sm"
        >
          {c.glyph}
          {c.label}
        </span>
      ))}
    </div>
  );
}

/** Scale title shown above the map at REGION/WORLD zoom. */
export function ScaleTitle({ scale, region }: { scale: MapScale; region: string }) {
  if (scale === "local") return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-md border-2 border-frame/80 bg-night/85 px-2.5 py-1 text-center backdrop-blur-sm">
      <div className="font-pixel text-[13px] leading-tight text-gold text-shadow-ink">
        {scale === "world" ? "The Emberwilds" : `${region} Lands`}
      </div>
      <div className="font-mono text-[10px] leading-tight text-parchment/60">
        {scale === "world" ? "as far as you know it" : "known country"}
      </div>
    </div>
  );
}
