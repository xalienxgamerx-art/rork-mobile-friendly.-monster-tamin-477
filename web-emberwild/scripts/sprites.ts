/**
 * Creature sprite pipeline.
 *
 *   bun scripts/sprites.ts contact   — build a labeled-by-position contact sheet of the raw sources
 *   bun scripts/sprites.ts build     — clean backgrounds + export to public/monsters/v2 + QA sheet
 *
 * Cleaning keeps black that belongs to the creature (eyes, dark maws, textured armor)
 * and removes background black: border-connected regions plus large uniform enclosed pockets.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

interface RawImage { w: number; h: number; data: Uint8Array }
interface Rect { x0: number; y0: number; x1: number; y1: number } // fractions of width/height

const SRC_DIR = "/tmp/monart";
const OUT_DIR = "public/monsters/v2";
const QA_DIR = "../.qa-monart";

/** Source file -> species id, established by visual content check (filenames are shifted!). */
const MAP: Record<string, string> = {
  "golem.png": "skullclub_orc",
  "hawk.png": "ironfang_tyrant",
  "mandrake.png": "jade_spikeon",
  "orc.png": "crystal_golem",
  "skyhorn.png": "tidefin_toad",
  "spikeon.png": "mandrake_maw",
  "stormmane.png": "crested_wyrm",
  "toad.png": "skyhorn_dragon",
  "tyrant.png": "zephyr_hawk",
  "wyrm.png": "stormmane_drake",
};

/** Older batch art: species id -> remote attachment URL (verified baked black backgrounds). */
const OLD_MAP: Record<string, string> = {
  cindermaw: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/f5a7ae1a-2246-4252-8434-a07fab0e0499.png",
  mossback: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/eded9b58-64b4-4b2f-8fed-c6ab8e25e5b9.png",
  pipwisp: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/9c815195-b162-4a4d-8571-ad5b7103b0ef.png",
  slimekin: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/879ab242-2622-4381-9a01-c4fca3b32c54.png",
  boglurk: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/9b0696b5-7dce-47cb-832b-ddd27a3dc9e9.png",
  nimbletuft: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/6a0703f8-2dbc-48a7-8030-1426316fad6d.png",
  thornhog: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/b52ef178-a5f3-4c4e-883e-625d1027460a.png",
  dunescuttle: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/1b08786f-3bc5-4bc2-ac06-9046fbc3a7ce.png",
  frostnib: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/7fc21d06-68a6-4c0a-a089-d8d056857e7b.png",
  gloamoth: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/1e7fc107-eeef-45ca-af9f-4f6457886596.png",
  cragjaw: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/9161acf5-6224-4d30-bea7-8faa7fec47e3.png",
  hollowcrow: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/1ab9479c-6263-4360-833e-e8ea275f2c24.png",
  regalslime: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/d2fa6607-15d2-45de-91a9-222914a84287.png",
  sunwyrm: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/916eab06-cbe2-4e4e-b401-0076d79553fc.png",
  bloomwisp: "https://ymk3ebvu3chfbjw17nxd9.rork.app/~assets/img/0faecefa-716f-4c69-9a4d-9790159fa3b0.png",
};

/** Per-species cleaning overrides, tuned during visual QA. */
const OVERRIDES: Record<string, { T?: number; seed?: Rect[]; protect?: Rect[] }> = {};

/* ---------------------------------- PNG codec --------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function decodePng(buf: Uint8Array): RawImage {
  if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error("not a PNG");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8;
  let w = 0, h = 0, depth = 8, ct = 6, interlace = 0;
  let plte: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos < buf.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const d = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = dv.getUint32(pos + 8); h = dv.getUint32(pos + 12);
      depth = buf[pos + 16]; ct = buf[pos + 17]; interlace = buf[pos + 20];
    } else if (type === "PLTE") plte = d;
    else if (type === "tRNS") trns = d;
    else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (interlace) throw new Error("interlaced PNG not supported");
  if (depth !== 8 && depth !== 16) throw new Error(`bit depth ${depth} not supported`);
  const ch = ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : 4;
  const step = ch * (depth / 8);
  const stride = Math.ceil((w * ch * depth) / 8);
  const raw = inflateSync(concat(idat));
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= step ? cur[i - step] : 0;
      const b = prev[i];
      const c = i >= step ? prev[i - step] : 0;
      let v = raw[p + i];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[i] = v;
    }
    p += stride;
    for (let x = 0; x < w; x++) {
      const o = x * step;
      let r: number, g: number, b2: number, al = 255;
      if (ct === 6) { r = cur[o]; g = cur[o + 1]; b2 = cur[o + 2]; al = cur[o + 3]; }
      else if (ct === 2) { r = cur[o]; g = cur[o + 1]; b2 = cur[o + 2]; }
      else if (ct === 4) { r = g = b2 = cur[o]; al = cur[o + 1]; }
      else if (ct === 0) { r = g = b2 = cur[o]; }
      else { const idx = cur[o]; r = plte![idx * 3]; g = plte![idx * 3 + 1]; b2 = plte![idx * 3 + 2]; if (trns && idx < trns.length) al = trns[idx]; }
      const o4 = (y * w + x) * 4;
      out[o4] = r; out[o4 + 1] = g; out[o4 + 2] = b2; out[o4 + 3] = al;
    }
    prev = cur;
  }
  return { w, h, data: out };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function encodePng(img: RawImage): Uint8Array {
  const { w, h, data } = img;
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6;
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/* --------------------------------- Processing --------------------------------- */

const lum = (d: Uint8Array, o: number) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];

/** Remove background black while keeping creature-internal black. */
export function clean(src: RawImage, ov: { T?: number; seed?: Rect[]; protect?: Rect[] }): RawImage {
  const { w, h } = src;
  const T = ov.T ?? 36;
  const black = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (Math.max(src.data[o], src.data[o + 1], src.data[o + 2]) <= T) black[i] = 1;
  }
  const px = (r: Rect, f: (i: number) => void) => {
    for (let y = Math.floor(r.y0 * h); y < Math.ceil(r.y1 * h); y++)
      for (let x = Math.floor(r.x0 * w); x < Math.ceil(r.x1 * w); x++) f(y * w + x);
  };
  for (const r of ov.protect ?? []) px(r, (i) => { black[i] = 0; });

  // pass 1: flood from borders (+ manual seeds) through black
  const remove = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qn = 0;
  const seed = (i: number) => { if (black[i] && !remove[i]) { remove[i] = 1; queue[qn++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  for (const r of ov.seed ?? []) px(r, seed);
  let qh = 0;
  while (qh < qn) {
    const i = queue[qh++];
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        seed(ny * w + nx);
      }
    }
  }

  // pass 2: enclosed black pockets — remove when large AND uniform (flat fill = background).
  // Creature black (eyes, maws, textured armor creases) is small or textured, so it stays.
  const comp = new Int32Array(w * h).fill(-1);
  for (let i0 = 0; i0 < w * h; i0++) {
    if (!black[i0] || remove[i0] || comp[i0] >= 0) continue;
    const id = comp[i0] = i0;
    const pixels: number[] = [i0];
    for (let k = 0; k < pixels.length; k++) {
      const i = pixels[k], x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (black[ni] && !remove[ni] && comp[ni] < 0) { comp[ni] = id; pixels.push(ni); }
        }
      }
    }
    if (pixels.length * 400 < w * h) continue; // < 0.25% of canvas: creature detail
    let sr = 0, sg = 0, sb = 0;
    for (const i of pixels) { const o = i * 4; sr += src.data[o]; sg += src.data[o + 1]; sb += src.data[o + 2]; }
    const mr = sr / pixels.length, mg = sg / pixels.length, mb = sb / pixels.length;
    let varSum = 0;
    for (const i of pixels) { const o = i * 4; varSum += (src.data[o] - mr) ** 2 + (src.data[o + 1] - mg) ** 2 + (src.data[o + 2] - mb) ** 2; }
    const std = Math.sqrt(varSum / pixels.length);
    if (std < 16) for (const i of pixels) remove[i] = 1;
  }

  const out: RawImage = { w, h, data: Uint8Array.from(src.data) };
  for (let i = 0; i < w * h; i++) if (remove[i]) out.data[i * 4 + 3] = 0;
  defringe(out);
  return out;
}

/** Blend dark pixels that hug transparency toward nearby body color (kills dark halos). */
export function defringe(img: RawImage, radius = 5): void {
  const { w, h } = img;
  const snap = Uint8Array.from(img.data);
  const transparent = (x: number, y: number) => snap[(y * w + x) * 4 + 3] === 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (snap[o + 3] === 0) continue;
      let nearEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      for (let dy = -1; dy <= 1 && !nearEdge; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || transparent(nx, ny)) { nearEdge = true; break; }
        }
      }
      if (!nearEdge || lum(snap, o) >= 95) continue;
      let br = -1, bg = -1, bb = -1, bd = radius + 1;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const no = (ny * w + nx) * 4;
          if (snap[no + 3] === 0 || lum(snap, no) < 105) continue;
          const d = Math.abs(dx) + Math.abs(dy);
          if (d < bd) { bd = d; br = snap[no]; bg = snap[no + 1]; bb = snap[no + 2]; }
        }
      }
      if (br < 0) continue;
      const k = 0.65;
      img.data[o] = Math.round(snap[o] * (1 - k) + br * k);
      img.data[o + 1] = Math.round(snap[o + 1] * (1 - k) + bg * k);
      img.data[o + 2] = Math.round(snap[o + 2] * (1 - k) + bb * k);
    }
  }
}

/** Crop to opaque bounds with a small pad. */
export function trim(img: RawImage, pad = 8): RawImage {
  const { w, h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const nw = x1 - x0 + 1, nh = y1 - y0 + 1;
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) out.set(data.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x1 + 1) * 4), y * nw * 4);
  return { w: nw, h: nh, data: out };
}

/** Box-filter downscale so the longest side is <= maxSide. */
export function resize(img: RawImage, maxSide = 384): RawImage {
  const scale = Math.min(1, maxSide / Math.max(img.w, img.h));
  const nw = Math.max(1, Math.round(img.w * scale));
  const nh = Math.max(1, Math.round(img.h * scale));
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy0 = (y * img.h) / nh, sy1 = ((y + 1) * img.h) / nh;
    for (let x = 0; x < nw; x++) {
      const sx0 = (x * img.w) / nw, sx1 = ((x + 1) * img.w) / nw;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const cov = (Math.min(sy1, sy + 1) - Math.max(sy0, sy)) * (Math.min(sx1, sx + 1) - Math.max(sx0, sx));
          if (cov <= 0) continue;
          const o = (sy * img.w + sx) * 4;
          const al = img.data[o + 3] / 255;
          r += img.data[o] * al * cov; g += img.data[o + 1] * al * cov; b += img.data[o + 2] * al * cov;
          a += al * cov; n += cov;
        }
      }
      const o = (y * nw + x) * 4;
      if (a > 0.0001) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(255 * Math.min(1, a / n));
      }
    }
  }
  return { w: nw, h: nh, data: out };
}

/** Tile images onto a checkerboard sheet so transparency is visible. */
export function contactSheet(images: RawImage[], tile = 320): RawImage {
  const cols = Math.ceil(Math.sqrt(images.length));
  const rows = Math.ceil(images.length / cols);
  const check = 10;
  const W = cols * tile, H = rows * tile;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = ((x / check) | 0) + ((y / check) | 0);
      const o = (y * W + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = c % 2 ? 210 : 240;
      data[o + 3] = 255;
    }
  }
  images.forEach((img, k) => {
    const fit = resize(img, tile - 16);
    const cx = (k % cols) * tile + (tile - fit.w) / 2;
    const cy = ((k / cols) | 0) * tile + (tile - fit.h) / 2;
    for (let y = 0; y < fit.h; y++) {
      for (let x = 0; x < fit.w; x++) {
        const so = (y * fit.w + x) * 4;
        if (fit.data[so + 3] === 0) continue;
        const a = fit.data[so + 3] / 255;
        const o = (((y + cy) | 0) * W + ((x + cx) | 0)) * 4;
        data[o] = data[o] * (1 - a) + fit.data[so] * a;
        data[o + 1] = data[o + 1] * (1 - a) + fit.data[so + 1] * a;
        data[o + 2] = data[o + 2] * (1 - a) + fit.data[so + 2] * a;
        data[o + 3] = 255;
      }
    }
  });
  return { w: W, h: H, data };
}

/* ------------------------------------ Modes ----------------------------------- */

function contact(): void {
  mkdirSync(QA_DIR, { recursive: true });
  const files = Object.keys(MAP).sort();
  const images = files.map((f) => decodePng(new Uint8Array(readFileSync(`${SRC_DIR}/${f}`))));
  const sheet = contactSheet(images);
  writeFileSync(`${QA_DIR}/src_contact.png`, encodePng(sheet));
  console.log("source order:", files.join(", "));
}

function build(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(QA_DIR, { recursive: true });
  const outs: RawImage[] = [];
  for (const [file, species] of Object.entries(MAP)) {
    const src = decodePng(new Uint8Array(readFileSync(`${SRC_DIR}/${file}`)));
    const out = resize(trim(clean(src, OVERRIDES[species] ?? {})), 384);
    writeFileSync(`${OUT_DIR}/${species}.png`, encodePng(out));
    outs.push(out);
    console.log(`${species} <- ${file} (${src.w}x${src.h} -> ${out.w}x${out.h})`);
  }
  const sheet = contactSheet(outs);
  writeFileSync(`${QA_DIR}/out_contact.png`, encodePng(sheet));
}

async function loadOld(species: string): Promise<RawImage> {
  const res = await fetch(OLD_MAP[species]);
  if (!res.ok) throw new Error(`${species}: fetch failed (${res.status})`);
  return decodePng(new Uint8Array(await res.arrayBuffer()));
}

async function buildOld(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(QA_DIR, { recursive: true });
  const species = Object.keys(OLD_MAP).sort();
  const srcs: RawImage[] = [];
  const outs: RawImage[] = [];
  for (const sp of species) {
    const src = await loadOld(sp);
    const out = resize(trim(clean(src, OVERRIDES[sp] ?? {})), 384);
    writeFileSync(`${OUT_DIR}/${sp}.png`, encodePng(out));
    srcs.push(resize(src, 384));
    outs.push(out);
    console.log(`${sp} (${src.w}x${src.h} -> ${out.w}x${out.h})`);
  }
  writeFileSync(`${QA_DIR}/old_src_contact.png`, encodePng(contactSheet(srcs)));
  writeFileSync(`${QA_DIR}/old_out_contact.png`, encodePng(contactSheet(outs)));
}

const mode = process.argv[2];
if (mode === "contact") contact();
else if (mode === "build") build();
else if (mode === "build-old") void buildOld();
else console.log("usage: bun scripts/sprites.ts contact|build|build-old");
