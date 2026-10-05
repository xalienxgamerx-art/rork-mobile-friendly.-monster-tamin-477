const A = "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets";

export const ART = {
  title: `${A}/img/94366765-b218-416a-85d3-57a4400c78c2.png`,
  tamer: `${A}/img/cca5b7d9-b94f-436f-ad59-4195d925194f.png`,
  icon: "/icon.png",
} as const;

// All 25 sprites are processed locally in public/monsters/v2 — transparent background,
// no baked outline, creature-internal black preserved. Rebuild with: bun scripts/sprites.ts
export const MONSTER_ART: Record<string, string> = Object.fromEntries(
  ["cindermaw", "mossback", "pipwisp", "slimekin", "boglurk", "nimbletuft", "thornhog", "dunescuttle", "frostnib", "gloamoth",
   "cragjaw", "hollowcrow", "regalslime", "sunwyrm", "bloomwisp", "zephyr_hawk", "tidefin_toad", "skullclub_orc", "crested_wyrm",
   "mandrake_maw", "jade_spikeon", "stormmane_drake", "crystal_golem", "skyhorn_dragon", "ironfang_tyrant",
  ].map((id) => [id, `/monsters/v2/${id}.png`]),
);

export const MUSIC = {
  wilds: `${A}/aud/78b47f55-05a0-41cc-9936-686bc768b87f.mp3`,
  battle: `${A}/aud/d2d06a16-f11e-4d3c-90fd-9d80cbd1dcba.mp3`,
} as const;
