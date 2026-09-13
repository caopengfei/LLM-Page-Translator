// Regenerates icons/icon.svg and the 16/32/48/128 toolbar PNGs from one geometry
// definition, so the pack icon can never drift from the .brand-mark tile in theme.css.
//
// The tile mirrors .brand-mark (src/shared/theme.css): 34px square, 10px radius,
// linear-gradient(145deg, --accent-2, --accent) with the light-theme accent pair.
// The globe is the same feather-style glyph the options page and popup inline.
import { deflateSync } from 'node:zlib';
import { realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CANVAS = 24;
const TILE_RADIUS = (10 / 34) * CANVAS;
const GRADIENT = { from: '#14b8a6', to: '#0d9488', angleDeg: 145 };
const GLOBE = {
  box: CANVAS,
  circle: { cx: 12, cy: 12, r: 10 },
  equator: { a: { x: 2, y: 12 }, b: { x: 22, y: 12 } },
  // Feather's globe meridian: four R=15.3 arcs standing in for an rx4/ry10 ellipse.
  meridian: [
    [{ x: 12, y: 2 }, { x: 16, y: 12 }],
    [{ x: 16, y: 12 }, { x: 12, y: 22 }],
    [{ x: 12, y: 22 }, { x: 8, y: 12 }],
    [{ x: 8, y: 12 }, { x: 12, y: 2 }],
  ],
  arcRadius: 15.3,
};

// Below 32px the mark is scaled up and the stroke thickened so the line art survives the
// downsample. At 16px the meridian is dropped: inside a ~12px globe the meridian plus the
// equator reads as a lattice rather than a sphere, and the strokes at that scale have to
// stay thick enough (>=1.5px) to hold a solid white core.
const SIZES = [
  { px: 16, globeScale: 0.8, strokeWidth: 3, meridian: false },
  { px: 32, globeScale: 0.62, strokeWidth: 2.2 },
  { px: 48, globeScale: 0.6, strokeWidth: 2 },
  { px: 128, globeScale: 0.6, strokeWidth: 2 },
];
const CANONICAL_SCALE = 0.6;

const mod2pi = (value) => ((value % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

// SVG arc -> center parameterisation for the circular case (rx == ry), verified by
// picking the centre whose angular sweep actually matches the large-arc/sweep flags.
function resolveArc(p0, p1, radius) {
  const mx = (p0.x - p1.x) / 2;
  const my = (p0.y - p1.y) / 2;
  const d = Math.hypot(mx, my);
  const r = Math.max(radius, d);
  const h = Math.sqrt(Math.max(0, r * r - d * d));
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const candidates = [
    { x: mid.x + (h * my) / d, y: mid.y - (h * mx) / d },
    { x: mid.x - (h * my) / d, y: mid.y + (h * mx) / d },
  ];
  for (const c of candidates) {
    const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
    const a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
    const span = mod2pi(a1 - a0); // sweep=1 draws the increasing-angle arc
    if (span <= Math.PI) return { c, r, a0, span };
  }
  throw new Error('unresolved arc');
}

const MERIDIAN = GLOBE.meridian.map(([p0, p1]) => resolveArc(p0, p1, GLOBE.arcRadius));

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

const GRAD_FROM = hexToRgb(GRADIENT.from);
const GRAD_TO = hexToRgb(GRADIENT.to);
const GRAD_RAD = (GRADIENT.angleDeg * Math.PI) / 180;
const GRAD_DIR = { x: Math.sin(GRAD_RAD), y: -Math.cos(GRAD_RAD) };
const GRAD_LEN = CANVAS * (Math.abs(GRAD_DIR.x) + Math.abs(GRAD_DIR.y));

function tileColor(x, y) {
  const t = Math.min(1, Math.max(0, 0.5 + ((x - CANVAS / 2) * GRAD_DIR.x + (y - CANVAS / 2) * GRAD_DIR.y) / GRAD_LEN));
  return {
    r: GRAD_FROM.r + (GRAD_TO.r - GRAD_FROM.r) * t,
    g: GRAD_FROM.g + (GRAD_TO.g - GRAD_FROM.g) * t,
    b: GRAD_FROM.b + (GRAD_TO.b - GRAD_FROM.b) * t,
  };
}

function insideTile(x, y) {
  const dx = Math.max(TILE_RADIUS - x, x - (CANVAS - TILE_RADIUS), 0);
  const dy = Math.max(TILE_RADIUS - y, y - (CANVAS - TILE_RADIUS), 0);
  return Math.hypot(dx, dy) <= TILE_RADIUS;
}

const distToSegment = (p, a, b) => {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const t = Math.min(1, Math.max(0, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
};

const distToArc = (p, arc) => {
  const dx = p.x - arc.c.x;
  const dy = p.y - arc.c.y;
  const offset = mod2pi(Math.atan2(dy, dx) - arc.a0);
  if (offset <= arc.span) return Math.abs(Math.hypot(dx, dy) - arc.r);
  const end = {
    x: arc.c.x + arc.r * Math.cos(arc.a0 + arc.span),
    y: arc.c.y + arc.r * Math.sin(arc.a0 + arc.span),
  };
  const start = { x: arc.c.x + arc.r * Math.cos(arc.a0), y: arc.c.y + arc.r * Math.sin(arc.a0) };
  return Math.min(Math.hypot(p.x - start.x, p.y - start.y), Math.hypot(p.x - end.x, p.y - end.y));
};

function insideGlobe(x, y, halfWidth, meridian) {
  const dx = x - GLOBE.circle.cx;
  const dy = y - GLOBE.circle.cy;
  if (Math.abs(Math.hypot(dx, dy) - GLOBE.circle.r) <= halfWidth) return true;
  if (distToSegment({ x, y }, GLOBE.equator.a, GLOBE.equator.b) <= halfWidth) return true;
  if (meridian) for (const arc of MERIDIAN) if (distToArc({ x, y }, arc) <= halfWidth) return true;
  return false;
}

function renderRgba(px, globeScale, strokeWidth, superSample, meridian = true) {
  const n = px * superSample;
  const unit = CANVAS / n;
  const globeBox = CANVAS * globeScale;
  const globeOrigin = (CANVAS - globeBox) / 2;
  const toGlobe = CANVAS / globeBox;
  const halfWidth = strokeWidth / 2;
  const out = Buffer.alloc(px * px * 4);
  const samples = superSample * superSample;

  for (let y = 0; y < px; y += 1) {
    for (let x = 0; x < px; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < superSample; sy += 1) {
        for (let sx = 0; sx < superSample; sx += 1) {
          const ux = (x * superSample + sx + 0.5) * unit;
          const uy = (y * superSample + sy + 0.5) * unit;
          if (!insideTile(ux, uy)) continue;
          const base = tileColor(ux, uy);
          const stroke = insideGlobe((ux - globeOrigin) * toGlobe, (uy - globeOrigin) * toGlobe, halfWidth, meridian);
          r += stroke ? 255 : base.r;
          g += stroke ? 255 : base.g;
          b += stroke ? 255 : base.b;
          a += 1;
        }
      }
      const offset = (y * px + x) * 4;
      if (a > 0) {
        out[offset] = Math.round(r / a);
        out[offset + 1] = Math.round(g / a);
        out[offset + 2] = Math.round(b / a);
      }
      out[offset + 3] = Math.round((a / samples) * 255);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(px, rgba) {
  const raw = Buffer.alloc(px * (px * 4 + 1));
  for (let y = 0; y < px; y += 1) {
    raw[y * (px * 4 + 1)] = 0;
    rgba.copy(raw, y * (px * 4 + 1) + 1, y * px * 4, (y + 1) * px * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildSvg() {
  const box = CANVAS * CANONICAL_SCALE;
  const origin = (CANVAS - box) / 2;
  const start = {
    x: CANVAS / 2 - (GRAD_LEN / 2) * GRAD_DIR.x,
    y: CANVAS / 2 - (GRAD_LEN / 2) * GRAD_DIR.y,
  };
  const end = {
    x: CANVAS / 2 + (GRAD_LEN / 2) * GRAD_DIR.x,
    y: CANVAS / 2 + (GRAD_LEN / 2) * GRAD_DIR.y,
  };
  const round = (value) => Number(value.toFixed(3));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by scripts/generate-icons.mjs - edit the generator, not this file. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="128" height="128" role="img" aria-label="LLM Page Translator">
  <defs>
    <linearGradient id="tile" gradientUnits="userSpaceOnUse" x1="${round(start.x)}" y1="${round(start.y)}" x2="${round(end.x)}" y2="${round(end.y)}">
      <stop offset="0" stop-color="${GRADIENT.from}"/>
      <stop offset="1" stop-color="${GRADIENT.to}"/>
    </linearGradient>
  </defs>
  <rect width="${CANVAS}" height="${CANVAS}" rx="${round(TILE_RADIUS)}" fill="url(#tile)"/>
  <g transform="translate(${round(origin)} ${round(origin)}) scale(${CANONICAL_SCALE})" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="${GLOBE.circle.cx}" cy="${GLOBE.circle.cy}" r="${GLOBE.circle.r}"/>
    <line x1="${GLOBE.equator.a.x}" y1="${GLOBE.equator.a.y}" x2="${GLOBE.equator.b.x}" y2="${GLOBE.equator.b.y}"/>
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
  </g>
</svg>
`;
}

export { renderRgba, encodePng, buildSvg, SIZES, CANONICAL_SCALE };

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMain) {
  writeFileSync(resolve(root, 'icons/icon.svg'), buildSvg());
  for (const { px, globeScale, strokeWidth, meridian } of SIZES) {
    const superSample = px <= 48 ? 16 : 8;
    const rgba = renderRgba(px, globeScale, strokeWidth, superSample, meridian);
    const file = resolve(root, `icons/icon${px}.png`);
    writeFileSync(file, encodePng(px, rgba));
    console.log(`wrote icons/icon${px}.png (${px}x${px}, globe ${globeScale}, stroke ${strokeWidth}${meridian === false ? ', no meridian' : ''})`);
  }
  console.log('wrote icons/icon.svg');
}
