import { memo, type ReactNode } from "react";
import { X } from "lucide-react";
import { MONSTER_ART } from "@/game/assets";
import { ELEMENTS, RARITY_COLOR, SPECIES } from "@/game/data";
import type { Element } from "@/game/types";
import { cn } from "@/lib/utils";

export const Bar = memo(function Bar({ value, max, color, className }: { value: number; max: number; color: string; className?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={cn("bar-track", className)}>
      <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
});

export function hpColor(frac: number): string {
  if (frac > 0.55) return "linear-gradient(180deg,#7be08a,#3d9a4f)";
  if (frac > 0.25) return "linear-gradient(180deg,#f2c14e,#c98a2b)";
  return "linear-gradient(180deg,#ff6b5a,#b23a48)";
}

export const ElementBadge = memo(function ElementBadge({ element, className }: { element: Element; className?: string }) {
  const e = ELEMENTS[element];
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-pixel text-[11px] leading-none text-white text-shadow-ink", className)}
      style={{ background: e.color, boxShadow: "inset 0 -2px 0 rgba(0,0,0,.25)" }}
    >
      <span aria-hidden>{e.glyph}</span>
      {e.name}
    </span>
  );
});

export const Tag = memo(function Tag({ children, color, className }: { children: ReactNode; color: string; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center rounded px-1.5 py-0.5 font-pixel text-[11px] leading-none text-white text-shadow-ink", className)}
      style={{ background: color, boxShadow: "inset 0 -2px 0 rgba(0,0,0,.25)" }}
    >
      {children}
    </span>
  );
});

export const Portrait = memo(function Portrait({
  speciesId,
  size = 64,
  className,
  framed = true,
  silhouette = false,
}: {
  speciesId: string;
  size?: number;
  className?: string;
  framed?: boolean;
  silhouette?: boolean;
}) {
  const sp = SPECIES[speciesId];
  const el = ELEMENTS[sp.element];
  return (
    <div
      className={cn("relative shrink-0 overflow-hidden", framed && "rounded-md border-2 border-frame", className)}
      style={{
        width: size,
        height: size,
        background: framed ? `radial-gradient(circle at 50% 35%, ${el.color}55, #241d3a 75%)` : undefined,
        boxShadow: framed ? "inset 0 0 0 1px rgba(242,193,78,.25)" : undefined,
      }}
    >
      <img
        src={MONSTER_ART[speciesId]}
        alt={sp.name}
        draggable={false}
        className="pixel absolute inset-0 h-full w-full object-contain p-[6%]"
        style={silhouette ? { filter: "brightness(0) opacity(.55)" } : undefined}
      />
    </div>
  );
});

export function RarityDot({ rarity }: { rarity: keyof typeof RARITY_COLOR }) {
  return <span className="inline-block h-2 w-2 rotate-45" style={{ background: RARITY_COLOR[rarity] }} />;
}

/** Full-screen modal sheet that becomes a bottom sheet on mobile. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  wide,
  icon,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
  icon?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal>
      <button aria-label="Close" className="absolute inset-0 bg-[#0b0817]/75 backdrop-blur-[2px] animate-in fade-in" onClick={onClose} />
      <div
        className={cn(
          "panel-night corners relative flex max-h-[92dvh] w-full flex-col animate-in slide-in-from-bottom-6 duration-200 sm:max-h-[86vh] sm:rounded-lg",
          wide ? "sm:max-w-5xl" : "sm:max-w-xl",
          "rounded-b-none sm:rounded-b-md",
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b-2 border-frame/60 px-4 py-2.5">
          <div className="flex items-center gap-2 font-pixel text-lg text-gold text-shadow-ink">
            {icon}
            {title}
          </div>
          <button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-md text-parchment/80 hover:bg-white/5 hover:text-parchment" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto safe-bottom">{children}</div>
      </div>
    </div>
  );
}

export function StatRow({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 py-[3px]">
      <span className="flex items-center gap-1.5 text-[13px] opacity-80">
        {icon}
        {label}
      </span>
      <span className="font-mono text-[13px] font-medium">
        {value}
        {sub ? <span className="ml-1 opacity-60">{sub}</span> : null}
      </span>
    </div>
  );
}

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-1.5 mt-3 border-b border-frame/40 pb-1 font-serif text-[15px] font-bold", className)}>{children}</div>;
}

export function Embers({ count = 18 }: { count?: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className="absolute bottom-0 block h-1 w-1 rounded-[1px]"
          style={{
            left: `${(i * 53) % 100}%`,
            background: i % 3 ? "#f2c14e" : "#e8742a",
            boxShadow: "0 0 6px #e8742a",
            animation: `ember-rise ${6 + (i % 5) * 1.7}s linear ${(i * 0.83) % 7}s infinite`,
          }}
        />
      ))}
    </div>
  );
}
