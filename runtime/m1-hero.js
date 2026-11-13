// M1 Hero runtime v1.4.0
// Renders USDM1 hairline hero art with WebGL. Shared by the generator and the Webflow embed.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.min.js';

THREE.ColorManagement.enabled = false;
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const frac = (x) => x - Math.floor(x);
const gauss = (x) => Math.exp(-x * x);
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pen: collects line segments and points for one frame
class Pen {
  constructor() {
    // nb: each vertex's neighbor along its path (previous point for a segment start, next point for its end),
    // or the vertex itself at a free end. Wide strokes use it to miter the joins. c0: first vertex of the current path.
    this.L = { pos: new Float32Array(3 * 16384), a: new Float32Array(16384), nb: new Float32Array(3 * 16384), e: new Int32Array(16384), k: new Float32Array(16384), n: 0, c0: 0 };
    // Fills: triangles painted with the background, used to hide what lies behind a shape. k is the stacking layer
    // (higher sits in front); every line vertex carries the layer of its shape too, so a fill hides only the lines
    // of shapes below it. Lines with layer -1 (grid, unlayered concepts) sit behind every fill.
    this.F = { pos: new Float32Array(3 * 8192), k: new Float32Array(8192), n: 0 };
    this.layer = -1;
    // e: which shape each vertex belongs to, as id * 2 + (1 for every other shape), or -1 for lines that never take
    // the stroke gradient (grid, rules, moving light). Concepts set it with el() before drawing each shape.
    this.cur = -1; this.lo = new Float64Array(256); this.hi = new Float64Array(256);
    this.P = { pos: new Float32Array(3 * 1024), a: new Float32Array(1024), s: new Float32Array(1024), n: 0 };
    this.o = { x: 0, y: 0, z: 0, a: 1 };
    this.grewL = this.grewP = this.grewF = false;
  }
  reset() { this.L.n = 0; this.L.c0 = 0; this.P.n = 0; this.F.n = 0; this.cur = -1; this.layer = -1; }
  // Start a shape: id groups its lines (the gradient spans the shape's own extent), odd marks every other shape.
  el(id, odd = id & 1) { this.cur = id < 0 ? -1 : id * 2 + (odd ? 1 : 0); this.layer = id < 0 ? -1 : id; }
  // Filled disc in the background color at the current layer.
  disc(cx, cy, z, r, n = 48) {
    const F = this.F;
    if (F.n + n * 3 > F.k.length) {
      const c = Math.max(F.k.length * 2, F.n + n * 3);
      const p = new Float32Array(c * 3); p.set(F.pos); F.pos = p;
      const k = new Float32Array(c); k.set(F.k); F.k = k;
      this.grewF = true;
    }
    const pts = circlePts(n);
    for (let i = 0; i < n; i++) {
      const a = i * 2, b = ((i + 1) % n) * 2, o = F.n * 3, P = F.pos, d = r * 2;
      P[o] = cx; P[o + 1] = cy; P[o + 2] = z;
      P[o + 3] = cx + pts[a] * d; P[o + 4] = cy + pts[a + 1] * d; P[o + 5] = z;
      P[o + 6] = cx + pts[b] * d; P[o + 7] = cy + pts[b + 1] * d; P[o + 8] = z;
      F.k[F.n] = F.k[F.n + 1] = F.k[F.n + 2] = this.layer; F.n += 3;
    }
  }
  _growL(k) {
    const L = this.L;
    if (L.n + k <= L.a.length) return;
    const c = Math.max(L.a.length * 2, L.n + k);
    const p = new Float32Array(c * 3); p.set(L.pos); L.pos = p;
    const a = new Float32Array(c); a.set(L.a); L.a = a;
    const nb = new Float32Array(c * 3); nb.set(L.nb); L.nb = nb;
    const e = new Int32Array(c); e.set(L.e); L.e = e;
    const lk = new Float32Array(c); lk.set(L.k); L.k = lk;
    this.grewL = true;
  }
  seg(x1, y1, z1, a1, x2, y2, z2, a2) {
    if (a1 < 0.003 && a2 < 0.003) return;
    this._growL(2);
    const L = this.L, i = L.n * 3, P = L.pos, N = L.nb;
    const f = Math.fround; // positions are stored as float32, so compare at that precision
    if (f(x1) === f(x2) && f(y1) === f(y2) && f(z1) === f(z2)) return; // zero length: nothing to draw, and it would break the join
    const joined = L.n > 0 && P[i - 3] === f(x1) && P[i - 2] === f(y1) && P[i - 1] === f(z1);
    P[i] = x1; P[i + 1] = y1; P[i + 2] = z1;
    P[i + 3] = x2; P[i + 4] = y2; P[i + 5] = z2;
    if (joined) { // link both ways: this start sees the previous start, the previous end sees this end
      N[i] = P[i - 6]; N[i + 1] = P[i - 5]; N[i + 2] = P[i - 4];
      N[i - 3] = x2; N[i - 2] = y2; N[i - 1] = z2;
    } else { N[i] = x1; N[i + 1] = y1; N[i + 2] = z1; L.c0 = L.n; }
    N[i + 3] = x2; N[i + 4] = y2; N[i + 5] = z2;
    const c = L.c0 * 3;
    if (L.c0 < L.n && P[c] === f(x2) && P[c + 1] === f(y2) && P[c + 2] === f(z2)) { // path closes on its first point
      N[i + 3] = P[c + 3]; N[i + 4] = P[c + 4]; N[i + 5] = P[c + 5];
      N[c] = x1; N[c + 1] = y1; N[c + 2] = z1;
    }
    L.a[L.n] = a1; L.a[L.n + 1] = a2; L.e[L.n] = L.e[L.n + 1] = this.cur; L.k[L.n] = L.k[L.n + 1] = this.layer; L.n += 2;
  }
  // Stroke fill. mode 1: every shape fades from full strength to clear across its own extent, toward angle ang
  // (radians, 0 = right, counterclockwise), reaching clear at reach × the extent. mode 2: every other shape does.
  shade(mode, ang, reach, upTo = this.L.n) {
    if (!mode) return;
    const L = this.L, E = L.e, P = L.pos, A = L.a, dx = Math.cos(ang), dy = Math.sin(ang);
    let max = -1;
    for (let i = 0; i < upTo; i++) if (E[i] > max) max = E[i];
    if (max < 0) return;
    const m = (max >> 1) + 1;
    if (this.lo.length < m) { this.lo = new Float64Array(m * 2); this.hi = new Float64Array(m * 2); }
    const lo = this.lo, hi = this.hi;
    lo.fill(Infinity, 0, m); hi.fill(-Infinity, 0, m);
    const on = (e) => e >= 0 && (mode === 1 || (e & 1) === 1);
    for (let i = 0; i < upTo; i++) {
      const e = E[i]; if (!on(e)) continue;
      const k = e >> 1, p = P[i * 3] * dx + P[i * 3 + 1] * dy;
      if (p < lo[k]) lo[k] = p; if (p > hi[k]) hi[k] = p;
    }
    const r = Math.max(0.05, reach);
    for (let i = 0; i < upTo; i++) {
      const e = E[i]; if (!on(e)) continue;
      const k = e >> 1, span = hi[k] - lo[k];
      if (span < 1e-6) continue;
      const t = (P[i * 3] * dx + P[i * 3 + 1] * dy - lo[k]) / span;
      // A shape with almost no extent along the fill direction (a straight line running across it) would flip between
      // unfaded and fully faded as it bends by a fraction of a pixel, so the fade eases in over the first few pixels.
      const w = span >= 3 ? 1 : sstep(0, 3, span);
      A[i] *= 1 - w * Math.min(1, t / r);
    }
  }
  // f(t, o) fills o.x, o.y, o.z, o.a for t in [0, 1]
  poly(n, f) {
    const o = this.o;
    o.z = 0; o.a = 1; f(0, o);
    let px = o.x, py = o.y, pz = o.z, pa = o.a;
    for (let i = 1; i <= n; i++) {
      o.z = 0; o.a = 1; f(i / n, o);
      this.seg(px, py, pz, pa, o.x, o.y, o.z, o.a);
      px = o.x; py = o.y; pz = o.z; pa = o.a;
    }
  }
  // closed outline from a cached 2D point loop, alpha by perimeter position
  loop(pts, cx, cy, z, sx, sy, af) {
    const n = pts.length / 2;
    let px = cx + pts[0] * sx, py = cy + pts[1] * sy, pa = af(0);
    for (let i = 1; i <= n; i++) {
      const k = (i % n) * 2, x = cx + pts[k] * sx, y = cy + pts[k + 1] * sy, a = af(i / n);
      this.seg(px, py, z, pa, x, y, z, a);
      px = x; py = y; pa = a;
    }
  }
  point(x, y, z, s, a) {
    if (a < 0.003) return;
    const P = this.P;
    if (P.n + 1 > P.a.length) {
      const c = P.a.length * 2;
      const p = new Float32Array(c * 3); p.set(P.pos); P.pos = p;
      const aa = new Float32Array(c); aa.set(P.a); P.a = aa;
      const ss = new Float32Array(c); ss.set(P.s); P.s = ss;
      this.grewP = true;
    }
    const i = P.n * 3;
    P.pos[i] = x; P.pos[i + 1] = y; P.pos[i + 2] = z; P.a[P.n] = a; P.s[P.n] = s; P.n++;
  }
}

const shapeCache = new Map();
function rrectPts(w, h, r) {
  const key = `r${w.toFixed(1)}:${h.toFixed(1)}:${r.toFixed(1)}`;
  if (shapeCache.has(key)) return shapeCache.get(key);
  r = Math.min(r, w / 2, h / 2);
  const out = [], k = 6;
  const cs = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 1], [-w / 2 + r, -h / 2 + r, 2], [w / 2 - r, -h / 2 + r, 3]];
  for (const [cx, cy, q] of cs) {
    for (let i = 0; i <= k; i++) {
      const a = (q + i / k) * Math.PI / 2;
      out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  }
  const arr = new Float32Array(out);
  shapeCache.set(key, arr);
  return arr;
}
function circlePts(n, start = 0, sweep = TAU, close = true) {
  const key = `c${n}:${start}:${sweep}`;
  if (shapeCache.has(key)) return shapeCache.get(key);
  const out = [];
  const m = close ? n : n + 1;
  for (let i = 0; i < m; i++) { const a = start + sweep * i / n; out.push(Math.cos(a) * 0.5, Math.sin(a) * 0.5); }
  const arr = new Float32Array(out);
  shapeCache.set(key, arr);
  return arr;
}

// ---------- Shared grid ----------
// Background hairline grid any concept can switch on. Fades away from a focus point and sits behind the art.
function drawGrid(c, pen, G) {
  const { W, H } = c, u0 = H / 900;
  const step = Math.max(6, G.step * u0), z = -G.depth * u0, ga = G.strength * 0.32 * c.introAt(0.3);
  if (ga < 0.002) return;
  const fx = (G.fx - 0.5) * W, fy = (0.5 - G.fy) * H, f = G.focus;
  for (let x = Math.ceil(-0.65 * W / step) * step; x < 0.65 * W; x += step) {
    const w = lerp(1, 1 - sstep(0.15, 0.5, Math.abs(x - fx) / W), f);
    pen.poly(10, (s, o) => { o.x = x; o.y = lerp(-H * 0.65, H * 0.65, s); o.z = z; o.a = ga * w * Math.sin(Math.PI * s); });
  }
  for (let y = Math.ceil(-0.65 * H / step) * step; y < 0.65 * H; y += step) {
    const w = lerp(1, 1 - sstep(0.1, 0.45, Math.abs(y - fy) / H), f);
    pen.poly(16, (s, o) => { o.x = lerp(-W * 0.65, W * 0.65, s); o.y = y; o.z = z; o.a = ga * 0.6 * w * Math.sin(Math.PI * s); });
  }
}

// ---------- Concepts ----------
// Units: world px, origin at canvas center, y up. ctx.u scales Figma px (900 tall frame) to the canvas.
const p = (v, min, max, step, label, extra) => Object.assign({ v, min, max, step, label }, extra);

export const CONCEPTS = {
  orbit: {
    label: 'Institutions',
    group: 'Pages',
    family: 'Institutions',
    blurb: 'Concentric arcs in shallow depth. Arcs breathe, light runs along each ring, and the stack tilts toward the cursor.',
    layout: { wide: { x: 0.1275, y: 1.017, s: 1 }, tall: { x: -0.865, y: 1.047, s: 1.13 } },
    params: {
      count: p(4, 2, 12, 1, 'Rings'),
      rMin: p(82, 20, 500, 1, 'Smallest radius'),
      rMax: p(721, 150, 1600, 1, 'Largest radius'),
      spread: p(1, 0.4, 3, 0.05, 'Radius curve'),
      shift: p(0.78, 0, 1.5, 0.01, 'Center drift'),
      sweep: p(0.95, 0.2, 1, 0.01, 'Arc sweep'),
      drop: p(1, 0, 3, 0.05, 'Drop lines'),
      depth: p(90, 0, 600, 5, 'Depth'),
      breathe: p(1, 0, 4, 0.05, 'Breathe'),
      pulse: p(0.8, 0, 3, 0.05, 'Light pulse'),
    },
    init(c, P, rnd) {
      const n = Math.round(P.count), rings = [];
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? Math.pow(i / (n - 1), P.spread) : 1;
        rings.push({ r: lerp(P.rMin, P.rMax, f), ph: rnd() * TAU, sp: 0.8 + rnd() * 0.5 });
      }
      return { rings };
    },
    draw(c, pen, st, P) {
      const { u, t, I } = c, n = st.rings.length;
      st.rings.forEach((g, i) => {
        const r = g.r * u * (1 + 0.03 * P.breathe * I * Math.sin(t * 0.45 * g.sp + g.ph));
        const cx = c.ax + g.r * u * P.shift, cy = c.ay;
        const z = n > 1 ? (i / (n - 1) - 0.5) * P.depth * u : 0;
        const grow = c.introAt(0.12 * i);
        const ext = Math.PI * P.sweep * grow;
        const thp = frac(t * 0.05 * g.sp + g.ph / TAU) * Math.PI * 1.6 - 0.2;
        const pulse = P.pulse * (0.25 + I);
        const segs = Math.max(48, Math.min(400, (r / 5) | 0));
        pen.el(i);
        pen.poly(segs, (s, o) => {
          const th = s * ext;
          o.x = cx + r * Math.cos(th); o.y = cy + r * Math.sin(th); o.z = z;
          const fade = 1 - sstep(ext * 0.3, ext, th);
          o.a = fade * (0.7 + pulse * gauss((th - thp) / 0.12));
        });
        const L = P.drop * (92 + 0.3 * g.r) * u * c.introAt(0.4 + 0.12 * i);
        if (L > 1) pen.poly(12, (s, o) => { o.x = cx + r; o.y = cy + s * L; o.z = z; o.a = 1.1 * Math.pow(1 - s, 1.1); });
      });
    },
  },

  tunnel: {
    label: 'RMI',
    group: 'Pages',
    family: 'RMI',
    blurb: 'The nested ellipses become a true 3D tunnel that streams forward. Rings turn to face the cursor.',
    layout: { wide: { x: -0.01, y: 0.5, s: 1 }, tall: { x: -0.05, y: 0.42, s: 0.85 } },
    params: {
      count: p(7, 3, 24, 1, 'Rings'),
      rMin: p(80, 10, 400, 1, 'Smallest radius'),
      rMax: p(640, 150, 1400, 1, 'Largest radius'),
      span: p(0.92, 0.2, 2, 0.01, 'Tunnel length'),
      curve: p(1.6, 0.6, 3, 0.05, 'Spacing curve'),
      squash: p(0.36, 0.04, 1, 0.01, 'Ring turn'),
      flow: p(1, 0, 4, 0.05, 'Flow speed'),
      side: p(0.45, 0, 1, 0.01, 'Side shading'),
    },
    init(c, P, rnd) { return { ph: rnd() }; },
    draw(c, pen, st, P) {
      const { u, t, I, W, H } = c, n = Math.round(P.count);
      const flow = t * 0.04 * P.flow + st.ph;
      const sq = clamp(P.squash + c.mn.x * c.md * 0.22 * (0.3 + I) * c.mouseAmt, 0.03, 1);
      const cz = Math.sqrt(1 - sq * sq);
      const cy = c.ay + c.mn.y * c.md * 0.05 * H * I * c.mouseAmt;
      const zMax = c.D * 0.55;
      for (let k = 0; k < n; k++) {
        const q = frac((k + flow) / n);
        const r = P.rMin * Math.pow(P.rMax / P.rMin, q) * u;
        const x = c.ax + P.span * W * Math.pow(q, P.curve);
        const a0 = sstep(0, 0.12, q) * (1 - sstep(0.82, 1, q)) * c.introAt(0.1 * (n - k) / n);
        if (a0 < 0.01) continue;
        const segs = Math.max(64, Math.min(360, (r / 4) | 0));
        pen.el(k);
        pen.poly(segs, (s, o) => {
          const ph = s * TAU;
          const co = Math.cos(ph);
          o.x = x + r * sq * co; o.y = cy + r * Math.sin(ph); o.z = Math.min(zMax, r * co * cz * 0.55);
          o.a = a0 * 0.85 * (1 - P.side * 0.5 * (1 - co));
        });
      }
    },
  },

  frames: {
    label: 'Ecosystem',
    group: 'Pages',
    family: 'Ecosystem',
    blurb: 'Nested frames recede to one vanishing point and slowly stream outward. Light rests on opposite corners and traces each frame, and the vanishing point leans toward the cursor.',
    // Defaults reproduce the Ecosystem hero art: wide is the 1162×582 tunnel, tall is the phone crop,
    // where the vanishing point sits off the right edge and only the left and bottom sides show.
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: { x: 1.31, y: 0.41, s: 0.784 } },
    params: {
      count: p(6, 2, 16, 1, 'Frames'),
      wMax: p(1800, 300, 3600, 1, 'Outer width'),
      aspect: p(0.5, 0.2, 1.5, 0.01, 'Height ratio'),
      step: p(0.83, 0.6, 0.95, 0.005, 'Frame step'),
      inner: p(0.45, 0, 1, 0.01, 'Inner fade'),
      lobes: p(2, 1, 2, 1, 'Corner light', { options: { 'One corner': 1, 'Opposite corners': 2 } }),
      angle: p(135, 0, 360, 1, 'Light angle'),
      contrast: p(0.85, 0, 1, 0.01, 'Light contrast'),
      focus: p(1.5, 0.5, 8, 0.1, 'Light focus'),
      vx: p(0, -900, 900, 1, 'Vanishing X'),
      vy: p(0, -600, 600, 1, 'Vanishing Y'),
      depth: p(0, 0, 400, 5, 'Depth'),
      flow: p(1, 0, 4, 0.05, 'Flow speed'),
      trace: p(0.8, 0, 3, 0.05, 'Light trace'),
      lean: p(1, 0, 3, 0.05, 'Cursor lean'),
    },
    init(c, P, rnd) { return { ph: rnd() }; },
    draw(c, pen, st, P) {
      const { u, t, I, W, H } = c, n = Math.round(P.count);
      // At t = 0 (the poster frame) the frames sit exactly on their resting sizes and the trace is dark.
      const flow = t * 0.035 * P.flow, base = Math.floor(flow), fr = flow - base;
      const wake = sstep(0, 3, t);
      const lean = P.lean * c.md * c.mouseAmt * (0.3 + I);
      const lx = P.vx * u + c.mn.x * lean * 0.12 * W, ly = -P.vy * u + c.mn.y * lean * 0.1 * H;
      const th0 = P.angle * Math.PI / 180, lobes = Math.round(P.lobes), con = P.contrast;
      const sMin = Math.pow(P.step, n - 1);
      for (let k = 0; k <= n; k++) {
        const d = k - fr; // 0 = outermost resting frame, n - 1 = innermost
        const sc = Math.pow(P.step, d);
        const a0 = clamp(d + 1, 0, 1) * clamp(n - d, 0, 1) // fade out past the outer frame, in from the center
          * (1 - P.inner * clamp(d / Math.max(1, n - 1), 0, 1)) * c.introAt(0.12 * (n - k));
        if (a0 < 0.01) continue;
        const w = P.wMax * u * sc, h = w * P.aspect;
        const k1 = 1 - (sc - sMin) / (1 - sMin || 1); // 0 outer, 1 inner: deeper frames shift further
        const cx = c.ax + lx * k1, cy = c.ay + ly * k1, z = -P.depth * u * d;
        const thp = frac(t * 0.045 + (k + base) * 0.173 + st.ph) * TAU;
        const alpha = (x, y) => {
          const th = Math.atan2((y - cy) / P.aspect, x - cx);
          const lit = Math.pow(0.5 + 0.5 * Math.cos(lobes * (th - th0)), P.focus);
          const glint = P.trace * wake * (0.4 + I) * gauss(Math.atan2(Math.sin(th - thp), Math.cos(th - thp)) / 0.22);
          return a0 * (1 - con + con * lit + glint);
        };
        const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
        const C = [[x0, y1], [x1, y1], [x1, y0], [x0, y0], [x0, y1]];
        const m = Math.max(12, Math.min(64, (w / 24) | 0));
        pen.el(k, (k + base) & 1);
        for (let sIdx = 0; sIdx < 4; sIdx++) {
          const [ax, ay] = C[sIdx], [bx, by] = C[sIdx + 1], mm = sIdx & 1 ? Math.max(6, (m * P.aspect) | 0) : m;
          for (let i = 0; i < mm; i++) {
            const ta = i / mm, tb = (i + 1) / mm;
            const xa = lerp(ax, bx, ta), ya = lerp(ay, by, ta), xb = lerp(ax, bx, tb), yb = lerp(ay, by, tb);
            pen.seg(xa, ya, z, alpha(xa, ya), xb, yb, z, alpha(xb, yb));
          }
        }
      }
    },
  },

  burst: {
    label: 'Settlement',
    group: 'Use cases',
    family: 'Settlement',
    blurb: 'Rays meet at one node. A light enters on one ray and leaves on the ray directly opposite, crossing the node in one straight line: value moves through settlement instead of collecting in it. A few lights at a time, alternating direction. Rays near the cursor brighten.',
    layout: { wide: { x: 0.5, y: 0.765, s: 1 }, tall: { x: 0.5, y: 0.79, s: 0.8 } },
    params: {
      rays: p(7, 1, 30, 1, 'Rays per side'),
      spread: p(15, 1, 70, 0.5, 'Spread (deg)'),
      length: p(1, 0.3, 2.5, 0.01, 'Ray length'),
      vline: p(1, 0, 1.5, 0.01, 'Vertical line'),
      depth: p(260, 0, 1000, 5, 'Depth'),
      lights: p(3, 0, 8, 1, 'Lights'),
      period: p(10, 3, 30, 0.5, 'Crossing time (s)'),
      reach: p(0.75, 0.3, 1, 0.01, 'Light reach'),
      light: p(1, 0, 3, 0.05, 'Light'),
      node: p(5, 0, 14, 0.5, 'Node size'),
    },
    init(c, P, rnd) {
      const rays = [], n = Math.round(P.rays);
      for (const side of [-1, 1]) {
        for (let j = 0; j < n; j++) {
          const f = n > 1 ? (j + 0.5 + (rnd() - 0.5) * 0.8) / n : 0.5;
          rays.push({ side, ang: lerp(-P.spread, P.spread, f) * Math.PI / 180, len: 0.7 + rnd() * 0.6, b: 0.35 + rnd() * 0.65, z: (rnd() - 0.5) * 2 });
          rnd(); // keeps the same random layout as earlier versions
        }
      }
      // For each ray, the ray on the other side that continues it straight through the node.
      const opp = rays.map((r) => {
        let best = -1, d = Infinity;
        rays.forEach((q, j) => { if (q.side !== r.side && Math.abs(q.ang + r.ang) < d) { d = Math.abs(q.ang + r.ang); best = j; } });
        return best;
      });
      return { rays, opp, n };
    },
    draw(c, pen, st, P) {
      const { u, t, I, W, H } = c, fx = c.ax, fy = c.ay, n = st.n;
      const m = sstep(0, 3, t) * P.light * (0.5 + I);
      // Scale grows or shrinks the whole fan around the node. The art is drawn relative to the frame, so measure the scale
      // against this concept's default (1 wide, 0.8 tall): at the default it draws exactly as before.
      const sc = (u * 900 / H) / (W / H < 1 ? this.layout.tall.s : this.layout.wide.s);
      const vecs = st.rays.map((r) => {
        const L = P.length * W * 0.55 * r.len * sc * c.introAt(0.05);
        return [r.side * Math.cos(r.ang) * L, Math.sin(r.ang) * L, r.z * P.depth * u];
      });
      // Each light runs from reach along one ray, through the node, to reach along the opposite ray. A new pair of rays
      // is picked every crossing, and the direction alternates.
      const spots = st.rays.map(() => []), N = Math.round(P.lights);
      for (let k = 0; k < N && n > 0; k++) {
        const x = t / P.period + k / N, cyc = Math.floor(x), q = frac(x);
        const a = Math.floor(frac(Math.sin((cyc * 7 + k * 13) * 127.1 + 311.7) * 43758.5453) * n);
        const b = st.opp[a];
        if (b < 0) continue;
        const [src, dst] = (cyc + k) % 2 ? [b, a] : [a, b];
        const d = lerp(-P.reach, P.reach, q), env = sstep(0, 0.12, q) * (1 - sstep(0.88, 1, q));
        spots[src].push(-d, env); spots[dst].push(d, env);
      }
      const w = 0.07 * Math.max(0.6, 900 * u / (W * sc)), R = 70 * u, ms = c.md * c.mouseAmt;
      st.rays.forEach((r, i) => {
        const v = vecs[i], sp = spots[i];
        let hv = 0;
        if (ms > 0) { // brighten the rays near the cursor
          const l2 = v[0] * v[0] + v[1] * v[1] || 1, s = clamp(((c.mx - fx) * v[0] + (c.my - fy) * v[1]) / l2, 0, 1);
          hv = ms * gauss(Math.hypot(c.mx - fx - v[0] * s, c.my - fy - v[1] * s) / R) * (1 - sstep(0.4, 1, s));
        }
        const b = r.b * (1 + 0.8 * hv);
        pen.el(i);
        pen.poly(28, (s, o) => {
          o.x = fx + v[0] * s; o.y = fy + v[1] * s; o.z = v[2] * s;
          let g = 0;
          for (let j = 0; j < sp.length; j += 2) g += sp[j + 1] * gauss((s - sp[j]) / w);
          o.a = b * (0.3 + 0.7 * sstep(0, 0.06, s)) * (1 - sstep(0.4, 1, s)) + 1.8 * m * g * (1 - sstep(0.55, 1, s));
        });
      });
      pen.el(-1);
      if (P.vline > 0) {
        const up = 0.32 * H * P.vline * sc * c.introAt(0.3), dn = 0.26 * H * P.vline * sc * c.introAt(0.3);
        pen.poly(20, (s, o) => { o.x = fx; o.y = lerp(fy - dn, fy + up, s); const k = s < dn / (up + dn) ? 1 - s / (dn / (up + dn)) : (s - dn / (up + dn)) / (1 - dn / (up + dn)); o.a = 0.7 * Math.pow(1 - k, 1.6); });
      }
      if (P.node > 0) {
        pen.point(fx, fy, 0, P.node * sc, 0.95 * c.introAt(0));
        pen.point(fx, fy, 0, -P.node * 6 * sc, 0.08 * c.introAt(0));
      }
    },
  },

  network: {
    label: 'Newsroom',
    group: 'Pages',
    family: 'Newsroom',
    blurb: 'Hub nodes fan out to the edges in depth. The network drifts, pulses travel inbound, and hubs lean toward the cursor.',
    layout: { wide: { x: 0.245, y: 0.76, s: 1 }, tall: { x: 0.35, y: 0.8, s: 0.85 } },
    params: {
      hubs: p(3, 1, 7, 1, 'Hubs per cluster'),
      gap: p(0.13, 0.04, 0.3, 0.005, 'Hub spacing'),
      edges: p(3, 1, 8, 1, 'Edges per hub'),
      sats: p(3, 0, 12, 1, 'Satellites'),
      reach: p(1, 0.3, 2.5, 0.01, 'Edge reach'),
      depth: p(260, 0, 1000, 5, 'Depth'),
      drift: p(1, 0, 4, 0.05, 'Drift'),
      pulses: p(6, 0, 40, 1, 'Pulses'),
      mirror: p(1, 0, 1, 1, 'Second cluster'),
      node: p(8, 2, 16, 0.5, 'Hub size'),
    },
    init(c, P, rnd) {
      const clusters = [];
      const nc = P.mirror >= 0.5 ? 2 : 1;
      for (let ci = 0; ci < nc; ci++) {
        const hubs = [];
        for (let h = 0; h < Math.round(P.hubs); h++) {
          const edges = [];
          for (let e = 0; e < Math.round(P.edges); e++) edges.push({ dx: 0.3 + rnd() * 0.5, dy: (rnd() - 0.5) * 0.8, z: (rnd() - 0.5) * 2, ph: rnd() * TAU, b: 0.45 + rnd() * 0.55 });
          hubs.push({ h, edges, ph: rnd() * TAU });
        }
        const sats = [];
        for (let s = 0; s < Math.round(P.sats); s++) {
          const hub = (rnd() * hubs.length) | 0;
          sats.push({ hub, edge: (rnd() * hubs[hub].edges.length) | 0, f: 0.2 + rnd() * 0.45, off: (rnd() - 0.5) * 0.04, link: (rnd() * hubs.length) | 0, ph: rnd() * TAU });
        }
        clusters.push({ hubs, sats });
      }
      const pulses = [];
      for (let k = 0; k < Math.round(P.pulses); k++) {
        const ci = (rnd() * nc) | 0, hub = (rnd() * clusters[ci].hubs.length) | 0;
        pulses.push({ ci, hub, edge: (rnd() * clusters[ci].hubs[hub].edges.length) | 0, ph: rnd(), sp: 0.7 + rnd() * 0.6 });
      }
      return { clusters, pulses };
    },
    draw(c, pen, st, P) {
      const { u, t, I, W, H } = c;
      const dr = P.drift * (0.25 + I);
      const geo = st.clusters.map((cl, ci) => {
        const sign = ci === 0 ? 1 : -1;
        const bx = ci === 0 ? c.ax : -c.ax, by = ci === 0 ? c.ay : -c.ay;
        const dir = bx <= 0 ? -1 : 1;
        const nh = cl.hubs.length;
        const hubs = cl.hubs.map((hb) => {
          let x = bx, y = by + (hb.h - (nh - 1) / 2) * P.gap * H * sign;
          y += Math.sin(t * 0.25 + hb.ph) * 8 * u * dr;
          const z = Math.sin(t * 0.2 + hb.ph) * 50 * u * dr;
          x += (c.mx - x) * 0.04 * I * c.md * c.mouseAmt; y += (c.my - y) * 0.04 * I * c.md * c.mouseAmt;
          const ends = hb.edges.map((e) => [x + dir * e.dx * W * P.reach * 0.75, y + e.dy * H * 0.75 + Math.sin(t * 0.15 + e.ph) * 20 * u * dr, e.z * P.depth * u]);
          return { x, y, z, ends };
        });
        return { hubs };
      });
      const gi = c.introAt(0.1);
      let eid = 0;
      st.clusters.forEach((cl, ci) => {
        const G = geo[ci];
        cl.hubs.forEach((hb, hi) => {
          const H0 = G.hubs[hi];
          hb.edges.forEach((e, ei) => {
            const [ex, ey, ez] = H0.ends[ei];
            pen.el(eid++);
            pen.poly(16, (s, o) => {
              const w = s * gi;
              o.x = lerp(H0.x, ex, w); o.y = lerp(H0.y, ey, w); o.z = lerp(H0.z, ez, w);
              o.a = e.b * 0.75 * (1 - sstep(0.35, 1, s));
            });
          });
          pen.point(H0.x, H0.y, H0.z, P.node, 0.85 * c.introAt(0));
        });
        cl.sats.forEach((sa) => {
          const H0 = G.hubs[sa.hub], [ex, ey, ez] = H0.ends[sa.edge];
          const f = sa.f + Math.sin(t * 0.18 + sa.ph) * 0.03 * dr;
          const x = lerp(H0.x, ex, f), y = lerp(H0.y, ey, f) + sa.off * H, z = lerp(H0.z, ez, f);
          const L = G.hubs[sa.link];
          pen.el(eid++);
          pen.seg(x, y, z, 0.45 * gi, L.x, L.y, L.z, 0.6 * gi);
          pen.point(x, y, z, P.node * 0.45, 0.75 * c.introAt(0.4));
        });
      });
      pen.el(-1);
      const vis = clamp(0.35 + I, 0, 1) * c.introAt(0.6);
      st.pulses.forEach((k) => {
        const H0 = geo[k.ci].hubs[k.hub], [ex, ey, ez] = H0.ends[k.edge];
        const q = 1 - frac(t * 0.06 * k.sp + k.ph);
        const far = 1 - sstep(0.6, 0.95, q);
        pen.poly(8, (s, o) => {
          const w = clamp(q + 0.1 * s, 0, 1);
          o.x = lerp(H0.x, ex, w); o.y = lerp(H0.y, ey, w); o.z = lerp(H0.z, ez, w);
          o.a = vis * far * 1.3 * Math.pow(1 - s, 2);
        });
      });
    },
  },

  tiles: {
    label: 'Treasury Operations',
    group: 'Use cases',
    family: 'Treasury, Roles',
    blurb: 'An outlined tile grid that lifts toward the viewer under the cursor like a lens, with a slow depth wave across the field.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: { x: 0.5, y: 0.5, s: 0.9 } },
    params: {
      shape: p(0, 0, 2, 1, 'Shape', { options: { 'Rounded rect': 0, Circle: 1, 'Half circle': 2 } }),
      pitchX: p(181, 20, 500, 1, 'Column pitch'),
      pitchY: p(290, 20, 600, 1, 'Row pitch'),
      w: p(204, 8, 500, 1, 'Tile width'),
      h: p(249, 8, 600, 1, 'Tile height'),
      radius: p(16, 0, 120, 1, 'Corner radius'),
      alt: p(1, 0, 1, 1, 'Alternate columns'),
      altW: p(0.53, 0.2, 1.5, 0.01, 'Alt width'),
      altH: p(0.81, 0.2, 1.5, 0.01, 'Alt height'),
      stagger: p(0.53, 0, 1, 0.01, 'Stagger'),
      cols: p(0, 0, 30, 1, 'Columns (0 fills)'),
      rules: p(0, 0, 1, 0.01, 'Rule lines'),
      lens: p(1, 0, 3, 0.05, 'Cursor lens'),
      lensR: p(0.3, 0.05, 1, 0.01, 'Lens size'),
      wave: p(0.6, 0, 3, 0.05, 'Depth wave'),
    },
    init(c, P, rnd) { const seeds = []; for (let i = 0; i < 4096; i++) seeds.push(rnd()); return { seeds }; },
    draw(c, pen, st, P) {
      const { u, t, I, W, H } = c;
      const px = P.pitchX * u, py = P.pitchY * u;
      const shape = Math.round(P.shape);
      const nc = P.cols > 0 ? Math.round(P.cols) : Math.ceil(W / px) + 3;
      const nr = Math.ceil(H / py) + 3;
      const j0 = P.cols > 0 ? -Math.floor((nc - 1) / 2) : -Math.ceil((W / 2 + c.ax) / px) - 1;
      const j1 = P.cols > 0 ? j0 + nc - 1 : Math.ceil((W / 2 - c.ax) / px) + 1;
      const i0 = -Math.ceil((H / 2 + c.ay) / py) - 2, i1 = Math.ceil((H / 2 - c.ay) / py) + 2;
      const lensR = P.lensR * H, gi = c.introAt(0);
      for (let j = j0; j <= j1; j++) {
        const odd = P.alt >= 0.5 && (j & 1) !== 0;
        const cx = c.ax + j * px;
        const tw = P.w * u * (odd ? P.altW : 1), th = P.h * u * (odd ? P.altH : 1);
        const oy = (j & 1) !== 0 ? P.stagger * py : 0;
        for (let i = i0; i <= i1; i++) {
          const cy = c.ay + i * py + oy;
          if (cy - th > H / 2 || cy + th < -H / 2) continue;
          const sd = st.seeds[(i * 131 + j * 31) & 4095];
          const dm = Math.hypot(cx - c.mx, cy - c.my) / lensR;
          const k = c.md * gauss(dm) * c.mouseAmt;
          const z = P.lens * (0.3 + I) * k * 170 * u + P.wave * I * Math.sin(cx * 0.004 / u + cy * 0.003 / u + t * 0.7) * 70 * u;
          const base = (0.45 + 0.55 * sd) * (1 + 1.2 * k * P.lens * (0.3 + I)) * gi;
          const ph = sd;
          const af = (s) => base * (0.55 + 0.45 * Math.cos(TAU * (s - 0.3 - ph * 0.2)));
          pen.el((j - j0) * (i1 - i0 + 1) + (i - i0), (i + j) & 1); // checkerboard when alternating
          if (shape === 0) pen.loop(rrectPts(tw, th, P.radius * u), cx, cy, z, 1, 1, af);
          else if (shape === 1) pen.loop(circlePts(48), cx, cy, z, tw, tw, af);
          else {
            const d = Math.min(th, py);
            pen.loop(circlePts(24, Math.PI / 2, Math.PI, false), cx, cy, z, d, d, af);
          }
        }
      }
      pen.el(-1);
      if (P.rules > 0) {
        const ra = P.rules * 0.6 * gi;
        for (let i = i0; i <= i1; i++) {
          const y = c.ay + (i + 0.5) * py;
          if (Math.abs(y) > H / 2 + 2) continue;
          pen.poly(20, (s, o) => { o.x = lerp(-W / 2, W / 2, s); o.y = y; o.a = ra * (0.5 + 0.5 * Math.sin(Math.PI * s)); });
        }
        if (shape === 2) for (let j = j0; j <= j1; j++) {
          const x = c.ax + j * px;
          pen.poly(16, (s, o) => { o.x = x; o.y = lerp(-H / 2, H / 2, s); o.a = ra; });
        }
      }
    },
  },

  bars: {
    label: 'Collateral Mobility',
    group: 'Use cases',
    family: 'Collateral Mobility, Roles',
    blurb: 'Stacked outline bars that slide in and out like moving positions. A highlight sweeps through the stack and bars near the cursor reach toward it.',
    layout: { wide: { x: 0.3, y: 0.47, s: 1 }, tall: { x: 0.62, y: 0.4, s: 0.8 } },
    params: {
      count: p(13, 2, 40, 1, 'Bars'),
      orient: p(0, 0, 1, 1, 'Orientation', { options: { Horizontal: 0, Vertical: 1 } }),
      pitch: p(64, 10, 200, 1, 'Pitch'),
      thick: p(40, 0, 160, 1, 'Thickness'),
      radius: p(0, 0, 80, 1, 'Corner radius'),
      len: p(1000, 100, 2400, 5, 'Length'),
      lenVar: p(0, 0, 1, 0.01, 'Length variance'),
      slant: p(100, -300, 300, 1, 'Slant'),
      solid: p(0.35, 0, 1, 0.01, 'Line-only share'),
      slide: p(1, 0, 4, 0.05, 'Slide'),
      depth: p(160, 0, 800, 5, 'Depth'),
      highlight: p(1, 0, 3, 0.05, 'Highlight sweep'),
    },
    init(c, P, rnd) {
      const bars = [];
      for (let i = 0; i < Math.round(P.count); i++) bars.push({ b: 0.35 + rnd() * 0.65, line: rnd() < P.solid, ph: rnd() * TAU, lv: rnd() });
      return { bars };
    },
    draw(c, pen, st, P) {
      const { u, t, I } = c, n = st.bars.length;
      const vert = Math.round(P.orient) === 1;
      const hi = frac(t * 0.04) * (n + 6) - 3;
      const map = (dx, dy) => (vert ? [c.ax - dy, c.ay + dx] : [c.ax + dx, c.ay + dy]);
      st.bars.forEach((b, i) => {
        const yl = ((n - 1) / 2 - i) * P.pitch * u;
        const L = P.len * u * (1 - P.lenVar * b.lv) * c.introAt(0.04 * i);
        let x0 = -P.len * u / 2 + ((n - 1) / 2 - i) * P.slant * u;
        x0 += Math.sin(t * 0.3 + b.ph) * 60 * u * P.slide * (0.2 + I);
        const [, wy] = map(0, yl);
        const [wx] = map(x0 + L / 2, yl);
        const k = c.md * c.mouseAmt * gauss(((vert ? wx - c.mx : wy - c.my)) / (P.pitch * u * 2.5));
        x0 += k * ((vert ? c.my - (c.ay + x0 + L / 2) : c.mx - (c.ax + x0 + L / 2))) * 0.25 * (0.3 + I);
        const z = n > 1 ? (i / (n - 1) - 0.5) * P.depth * u : 0;
        const glow = 1 + P.highlight * (0.3 + I) * 1.6 * gauss((i - hi) / 1.3);
        const a = b.b * glow;
        const th = b.line ? 0 : P.thick * u;
        const edgeA = (k2) => (s) => a * k2 * sstep(0, 0.03, s) * (0.3 + 0.7 * (1 - s));
        const top = edgeA(0.8), bot = edgeA(0.45);
        pen.el(i);
        if (th <= 0.5) { // line-only bar
          pen.poly(20, (s, o) => { const [x, y] = map(x0 + L * s, yl); o.x = x; o.y = y; o.z = z; o.a = top(s); });
          return;
        }
        // Outline bar: one closed path (top edge, end cap, bottom edge, start cap) with optional rounded corners.
        const R = Math.min((P.radius || 0) * u, th / 2, L / 2), r0 = R / L, steps = R > 0.5 ? 6 : 0;
        const xs = x0, xe = x0 + L, yT = yl + th / 2, yB = yl - th / 2;
        const pts = [];
        const arc = (cx, cy, a0, a1, al0, al1) => {
          for (let j = 1; j <= steps; j++) { const f = j / steps, an = a0 + (a1 - a0) * f; pts.push(cx + Math.cos(an) * R, cy + Math.sin(an) * R, lerp(al0, al1, f)); }
        };
        for (let j = 0; j <= 20; j++) { const s = lerp(r0, 1 - r0, j / 20); pts.push(xs + L * s, yT, top(s)); }
        arc(xe - R, yT - R, Math.PI / 2, 0, top(1 - r0), a * 0.2);
        pts.push(xe, yT - R, a * 0.2, xe, yB + R, a * 0.15);
        arc(xe - R, yB + R, 0, -Math.PI / 2, a * 0.15, bot(1 - r0));
        for (let j = 0; j <= 20; j++) { const s = lerp(1 - r0, r0, j / 20); pts.push(xs + L * s, yB, bot(s)); }
        arc(xs + R, yB + R, -Math.PI / 2, -Math.PI, bot(r0), a * 0.5);
        pts.push(xs, yB + R, a * 0.5, xs, yT - R, a * 0.7);
        arc(xs + R, yT - R, Math.PI, Math.PI / 2, a * 0.7, top(r0));
        let [px, py] = map(pts[0], pts[1]), pa = pts[2];
        for (let j = 3; j < pts.length; j += 3) {
          const [x, y] = map(pts[j], pts[j + 1]);
          if (Math.abs(x - px) + Math.abs(y - py) < 1e-3) { pa = pts[j + 2]; continue; } // fully rounded ends leave zero-length caps
          pen.seg(px, py, z, pa, x, y, z, pts[j + 2]);
          px = x; py = y; pa = pts[j + 2];
        }
      });
    },
  },

  waves: {
    label: 'Repo Cash Leg',
    group: 'Use cases',
    family: 'Repo Cash',
    blurb: 'Nested waves cross at one point, like cash and collateral changing hands. Light runs both ways along the curves and the crossing leans toward the cursor.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: { x: 0.5, y: 0.653, s: 0.454 } },
    params: {
      count: p(3, 1, 12, 1, 'Lines'),
      width: p(2680, 600, 5000, 10, 'Wave width'),
      height: p(947, 100, 2400, 1, 'Wave height'),
      step: p(0.133, 0, 0.3, 0.001, 'Line spacing'),
      reach: p(147, 60, 400, 1, 'Wave reach (deg)'),
      mirror: p(1, 0, 1, 1, 'Curves', { options: { 'Crossing pair': 1, 'Single wave': 0 } }),
      depth: p(60, 0, 600, 5, 'Depth'),
      twist: p(0.25, 0, 1.5, 0.01, '3D twist'),
      breathe: p(1, 0, 4, 0.05, 'Breathe'),
      flow: p(1, 0, 4, 0.05, 'Flow speed'),
      pulse: p(0.8, 0, 3, 0.05, 'Light pulse'),
    },
    init(c, P, rnd) {
      const lines = [];
      for (let i = 0; i < Math.round(P.count); i++) lines.push({ ph: rnd() * TAU, sp: 0.85 + rnd() * 0.3 });
      return { lines };
    },
    draw(c, pen, st, P) {
      const { u, t, I } = c, n = st.lines.length;
      const lean = c.md * c.mouseAmt * (0.3 + I);
      const cx = c.ax + (c.mx - c.ax) * 0.08 * lean, cy = c.ay + (c.my - c.ay) * 0.12 * lean;
      const reach = P.reach * Math.PI / 180;
      const sides = Math.round(P.mirror) ? [1, -1] : [1];
      st.lines.forEach((g, i) => {
        const k = Math.max(0.05, 1 - i * P.step);
        const hw = P.width * u * k / 2;
        const A = P.height * u * k / 2 * (1 + 0.05 * P.breathe * (0.3 + I) * Math.sin(t * 0.4 * g.sp + g.ph));
        const z0 = n > 1 ? (i / (n - 1) - 0.5) * P.depth * u : 0;
        const grow = c.introAt(0.15 * i);
        const segs = Math.max(120, Math.min(480, (hw / 6) | 0));
        pen.el(i);
        for (const sg of sides) {
          // pulses travel left to right on one curve and right to left on its mirror
          const head = frac(t * 0.05 * P.flow * g.sp + g.ph / TAU + (sg < 0 ? 0.5 : 0));
          const hp = sg > 0 ? head : 1 - head;
          const pulse = P.pulse * (0.25 + I);
          pen.poly(segs, (s, o) => {
            const v = (s * 2 - 1) * grow, th = v * reach;
            o.x = cx + v * hw;
            o.y = cy + sg * A * Math.sin(th);
            o.z = z0 + sg * P.twist * A * (1 - Math.cos(th));
            o.a = (0.75 + pulse * gauss((s - hp) / 0.035)) * (1 - sstep(0.88, 1, Math.abs(v)));
          });
        }
      });
    },
  },
};

// ---------- Use case, institution and role concepts ----------
// Drawn from the Figma "Primary - Hero" page. Art units are Figma px with the origin at the frame center and y down,
// as in Figma; each draw maps them to world with X() and Y(). Split art (640 × 960) uses tall s 0.9375, so one
// art px is one canvas px at 960 tall. Every motion is scaled by wake(t), so the poster frame (t = 0) is the art at rest.
const wake = (t) => sstep(0, 3, t);
const near = (c, x, y, R) => c.md * c.mouseAmt * gauss(Math.hypot(x - c.mx, y - c.my) / R);
const offView = (c, x, y, hw, hh) => Math.abs(x) - hw > c.W / 2 + 4 || Math.abs(y) - hh > c.H / 2 + 4;
const art = (c) => [(x) => c.ax + x * c.u, (y) => c.ay - y * c.u];
// Rim light around a closed outline: brightest toward ang (deg, 0 = right, counterclockwise), like the Figma strokes.
const rim = (base, ang, con = 0.45) => (s) => base * (1 - con + con * Math.cos(TAU * s - ang * Math.PI / 180));
// Stroke an outline given as flat [x, y, ...] world points, subdivided so alpha can vary along it.
// af(s, x, y): s is the position along the outline, 0 to 1.
function outline(pen, P, z, af, closed = true) {
  const n = P.length / 2, m = closed ? n : n - 1;
  let per = 0; const acc = [0];
  for (let i = 0; i < m; i++) { const j = (i + 1) % n; per += Math.hypot(P[j * 2] - P[i * 2], P[j * 2 + 1] - P[i * 2 + 1]); acc.push(per); }
  if (per < 0.5) return;
  const st = Math.max(10, per / 160);
  let px = P[0], py = P[1], pa = af(0, px, py);
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % n, x0 = P[i * 2], y0 = P[i * 2 + 1], x1 = P[j * 2], y1 = P[j * 2 + 1], len = acc[i + 1] - acc[i];
    const k = Math.max(1, Math.ceil(len / st));
    for (let q = 1; q <= k; q++) {
      const f = q / k, x = q === k ? x1 : lerp(x0, x1, f), y = q === k ? y1 : lerp(y0, y1, f);
      const a = af((acc[i] + len * f) / per, x, y);
      pen.seg(px, py, z, pa, x, y, z, a); px = x; py = y; pa = a;
    }
  }
}
// Rounded rectangle outline in world units, starting on the right edge and running counterclockwise.
function rrPath(cx, cy, w, h, r) {
  r = clamp(r, 0, Math.min(w, h) / 2);
  // Corner segments scale with the radius (about one per 3 px of radius), so large rounded ends stay smooth.
  const k = r > 0.5 ? clamp(Math.ceil(r / 3), 6, 48) : 0, P = [], hw = w / 2 - r, hh = h / 2 - r;
  const cs = [[hw, hh], [-hw, hh], [-hw, -hh], [hw, -hh]];
  for (let q = 0; q < 4; q++) for (let i = 0; i <= k; i++) {
    const a = (q + (k ? i / k : 0.5)) * Math.PI / 2;
    P.push(cx + cs[q][0] + Math.cos(a) * r, cy + cs[q][1] + Math.sin(a) * r);
  }
  return P;
}
const ring = (pen, cx, cy, d, z, af) => pen.loop(circlePts(48), cx, cy, z, d, d, af);
const seeds = (rnd, n = 1024) => { const s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = rnd(); return { s }; };
const sd = (st, i, j = 0) => st.s[((i * 131 + j * 31) % 1024 + 1024) % 1024];

const SPLIT = { x: 0.5, y: 0.5, s: 0.9375 };
// The USDM1 burst from the brand mark (logo units, radius 15, y down): [angle in degrees, inner radius, outer radius].
// Long rays on the axes, shorter ones on the diagonals, and eight inner rays between them that reach closer to the center.
const BURST = [
  ...[0, 90, 180, 270].map((d) => [d, 10, 14.86]),
  ...[45, 135, 225, 315].map((d) => [d, 10, 13.7]),
  ...[22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5].map((d) => [d, 6.3, 14.4]),
];


// Structured Products panels, Figma px in the 1600 × 900 frame: [left, top, right, bottom].
const PANELS = [
  [34, -40, 435, 279], [34, 292, 435, 692], [447, -40, 635, 219], [650, -40, 735, 219], [748, -40, 954, 89],
  [748, 102, 954, 219], [447, 232, 954, 692], [969, -40, 1238, 692], [1253, -40, 1570, 692], [34, 705, 1146, 960], [1161, 705, 1570, 960],
];
// OTC Desks columns drawn with a solid stroke in the Figma frame (the rest fade downward), by index into OTC_TOPS.
const OTC_ACCENTS = new Set([6, 8, 12, 16, 22, 27, 32]);
// OTC Desks column tops, Figma px in the 640 × 960 frame, 32.6 px apart. Repeats mirrored past the ends.
const OTC_TOPS = [373, 375, 364, 356, 351, 338, 315, 292, 285, 299, 320, 327, 315, 302, 307, 336, 372, 391, 379, 348, 317, 297, 285, 273, 267, 279, 315, 364, 397, 396, 364, 327, 308, 308, 314, 311, 300, 294];
// Hedge Funds and Trading Firms bars, Figma px in the 640 × 960 frame: [center x, width, top, bottom].
// Left to right: the long side's six floor bars (outer to center), then the short side's six ceiling bars (center to outer).
// The floor bars are mirrored in Figma, so their x there is the right edge. Every gap is 16 px.
const HEDGE = [
  [5.5, 29, 400, 774], [52.5, 33, 357, 774], [103.5, 37, 320, 774], [159.5, 43, 269, 774], [221, 48, 217, 774], [286.5, 51, 186, 774],
  [353.5, 51, 186, 679], [419, 48, 186, 650], [480.5, 43, 186, 626], [536.5, 37, 186, 587], [587.5, 33, 186, 558], [634.5, 29, 186, 533],
];

// A Margin pill, as in the Figma frame: a rule with a slab hanging below it. The rule is the slab's top edge; the slab is
// dark with an inner shadow (inset 0 4px 8px), so light spills down from the top edge and fades within a few px.
// The glow is drawn as hairlines packed one stroke width apart, so it reads as a solid gradient at any pixel ratio.
function pill(c, pen, cx, y, w, P, af) {
  const u = c.u, h = P.pillH * u, r = clamp((P.pillR || 0) * u, 0, Math.min(w, h) / 2), top = y, bot = y - h;
  const rr = Math.max(r, 1), edge = P.pillEdge ?? 0;
  // Outline: full strength along the top edge, easing to the side and bottom strength around the corners.
  // With the sides off (the Figma look) only the top edge and its corners are drawn.
  const ease = (s, x, yy) => af(s, x) * lerp(edge, 1, clamp((yy - (top - rr)) / rr, 0, 1));
  if (edge > 0.003) outline(pen, rrPath(cx, y - h / 2, w, h, r), 0, ease);
  else {
    const pts = [], k = r > 0.5 ? 8 : 0;
    for (let i = 0; i <= k; i++) { const a = Math.PI - (k ? i / k : 1) * Math.PI / 2; pts.push(cx - w / 2 + r + Math.cos(a) * r, top - r + Math.sin(a) * r); }
    for (let i = 0; i <= k; i++) { const a = Math.PI / 2 - (k ? i / k : 0) * Math.PI / 2; pts.push(cx + w / 2 - r + Math.cos(a) * r, top - r + Math.sin(a) * r); }
    outline(pen, pts, 0, ease, false);
  }
  const glow = 0.32 * (P.pillGlow ?? 1), depth = (P.pillDepth ?? 5.5) * u;
  if (glow <= 0) return;
  const step = Math.max(0.25, (c.lw || 1) / (c.dpr || 1)), n = Math.max(16, (w / 60) | 0);
  for (let d = step; d < h - step * 0.5; d += step) {
    const g = glow * Math.exp(-(d / depth) * (d / depth));
    if (g < 0.004) break;
    const yy = top - d, dy = Math.min(d, h - d), ins = dy < r ? r - Math.sqrt(Math.max(0, r * r - (r - dy) * (r - dy))) : 0;
    const x0 = cx - w / 2 + ins, ww = w - 2 * ins;
    if (ww <= 1) continue;
    pen.poly(n, (s, o) => { o.x = x0 + ww * s; o.y = yy; o.a = af(s, o.x) * g; });
  }
}

Object.assign(CONCEPTS, {
  margin: {
    label: 'Margin',
    family: 'Margin',
    group: 'Use cases',
    blurb: 'A stack of rules that narrows row by row, like margin tightening. Light sweeps down the stack, the rows breathe in width, and rows near the cursor brighten and reach out.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: { x: 0.5, y: 0.5, s: 0.8 } },
    tall: { wTop: 840, wBot: 100, top: -650, bottom: 520 }, // mobile and split start from these
    params: {
      count: p(13, 3, 40, 1, 'Rows'),
      wTop: p(1600, 200, 3200, 10, 'Top width'),
      wBot: p(192, 0, 1600, 2, 'Bottom width'),
      taper: p(1, 0.3, 3, 0.05, 'Taper curve'),
      top: p(-339, -1200, 400, 1, 'Top row Y'),
      bottom: p(339, -400, 1200, 1, 'Bottom row Y'),
      spacing: p(1.87, 0.5, 3, 0.01, 'Spacing curve'),
      pills: p(4, 0, 12, 1, 'Pill rows'),
      pillH: p(12, 2, 40, 1, 'Pill height'),
      pillR: p(0, 0, 20, 0.5, 'Pill corner radius'),
      pillGlow: p(1, 0, 3, 0.05, 'Pill inner glow'),
      pillDepth: p(5.5, 1, 20, 0.5, 'Pill glow depth'),
      pillEdge: p(0, 0, 1, 0.01, 'Pill sides and bottom'),
      fade: p(0.65, 0, 1, 0.01, 'End fade'),
      breathe: p(1, 0, 4, 0.05, 'Breathe'),
      sweep: p(1, 0, 3, 0.05, 'Light sweep'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I } = c, [X, Y] = art(c), n = Math.round(P.count), mo = wake(t) * (0.3 + I);
      const np = Math.round(P.pills), pillAt = new Set();
      for (let k = 0; k < np; k++) pillAt.add(Math.round(1 + k * (np > 1 ? 5 / 3 : 0)));
      const hi = frac(t * 0.05) * (n + 4) - 2;
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0;
        const y = Y(lerp(P.top, P.bottom, Math.pow(f, P.spacing)));
        const k = near(c, c.mx, y, 60 * u) * (0.4 + I);
        const w = (P.wBot + (P.wTop - P.wBot) * Math.pow(1 - f, P.taper)) * u
          * (1 + 0.05 * P.breathe * mo * Math.sin(t * 0.45 + i * 0.7) + 0.08 * k) * c.introAt(0.05 * i);
        const glow = 1 + P.sweep * mo * 1.4 * gauss((i - hi) / 1.2) + 0.8 * k;
        const base = lerp(1, 0.45, f) * glow;
        const cx = X(0);
        const af = (s, x) => { const q = clamp((x - cx) / w + 0.5, 0, 1); return base * (1 - P.fade + P.fade * Math.pow(Math.sin(Math.PI * q), 0.7)); };
        pen.el(i);
        if (pillAt.has(i) && P.pillH > 0) pill(c, pen, cx, y, w, P, af);
        else pen.poly(Math.max(24, (w / 20) | 0), (s, o) => { o.x = cx - w / 2 + w * s; o.y = y; o.a = af(s, o.x); });
      }
    },
  },

  structured: {
    label: 'Structured Products',
    family: 'Structured Products',
    group: 'Use cases',
    blurb: 'Rounded panels packed into one structure, like tranches of a product. A highlight passes from panel to panel and the panel under the cursor lifts toward the viewer.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: { x: 0.62, y: 0.42, s: 0.62 } },
    params: {
      gap: p(13, 0, 60, 1, 'Gap'),
      radius: p(10, 0, 60, 1, 'Corner radius'),
      light: p(135, 0, 360, 1, 'Light angle'),
      contrast: p(0.5, 0, 1, 0.01, 'Light contrast'),
      lift: p(1, 0, 3, 0.05, 'Cursor lift'),
      drift: p(1, 0, 4, 0.05, 'Depth drift'),
      pass: p(1, 0, 3, 0.05, 'Highlight pass'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), g = (P.gap - 13) / 2;
      const hi = frac(t * 0.03) * (PANELS.length + 3) - 1.5;
      PANELS.forEach(([l, tp, r, b], i) => {
        const x0 = X(l - 800 - g), x1 = X(r - 800 + g), y0 = Y(tp - 450 - g), y1 = Y(b - 450 + g);
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
        if (w < 2 || h < 2 || offView(c, cx, cy, w / 2, h / 2)) return;
        const k = c.md * c.mouseAmt * (Math.abs(c.mx - cx) < w / 2 && Math.abs(c.my - cy) < h / 2 ? 1 : 0.15 * near(c, cx, cy, 400 * u));
        const z = P.lift * (0.3 + I) * k * 90 * u + P.drift * mo * Math.sin(t * 0.35 + sd(st, i) * TAU) * 40 * u;
        const base = (0.6 + 0.4 * sd(st, i, 3)) * (1 + P.pass * mo * 1.3 * gauss((i - hi) / 0.9) + 0.5 * k) * c.introAt(0.06 * i);
        pen.el(i);
        outline(pen, rrPath(cx, cy, w, h, P.radius * u), z, rim(base, P.light, P.contrast));
      });
    },
  },

  optimization: {
    label: 'Collateral Optimization',
    family: 'Collateral Optimization',
    group: 'Use cases',
    blurb: 'Columns of tiles that grow toward the center, where the best fit sits. The columns rise and settle like an allocation being tuned, and tiles near the cursor lift.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: { x: 0.5, y: 0.5, s: 0.5 } },
    params: {
      sides: p(4, 1, 10, 1, 'Columns per side'),
      sEdge: p(80, 10, 300, 1, 'Edge tile size'),
      sStep: p(25, -40, 100, 1, 'Size step'),
      sCenter: p(232, 20, 500, 1, 'Center tile size'),
      gapX: p(56, 0, 200, 1, 'Column gap'),
      gapY: p(14, 0, 100, 1, 'Row gap'),
      topEdge: p(-192, -600, 600, 1, 'Edge column top'),
      topCenter: p(232, -600, 600, 1, 'Center column top'),
      radius: p(12, 0, 60, 1, 'Corner radius'),
      rise: p(1, 0, 4, 0.05, 'Rise and settle'),
      lens: p(1, 0, 3, 0.05, 'Cursor lift'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I, H } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), K = Math.round(P.sides);
      const cols = [];
      for (let k = 0; k <= K; k++) cols.push({ size: k === K ? P.sCenter : P.sEdge + k * P.sStep, top: lerp(P.topEdge, P.topCenter, sstep(0, 1, k / K)), k });
      // x of each column, from the center outward
      let x = 0; const at = { [K]: 0 };
      for (let k = K - 1; k >= 0; k--) { x += (cols[k + 1].size + cols[k].size) / 2 + P.gapX; at[k] = x; }
      let id = 0;
      for (const col of cols) {
        const sides = col.k === K ? [0] : [-1, 1];
        for (const sg of sides) {
          const cxA = sg * at[col.k];
          const off = P.rise * mo * 26 * Math.sin(t * 0.4 + col.k * 0.9 + (sg < 0 ? 0.6 : 0));
          for (let r = 0; r < 40; r++) {
            const yA = col.top + col.size / 2 + r * (col.size + P.gapY) + off;
            const cx = X(cxA), cy = Y(yA), s = col.size * u;
            if (cy + s / 2 < -H / 2 - 4) break;
            if (offView(c, cx, cy, s / 2, s / 2)) continue;
            const k = near(c, cx, cy, 160 * u);
            const z = P.lens * (0.3 + I) * k * 120 * u;
            const base = (0.5 + 0.5 * sd(st, r, col.k * 2 + (sg > 0))) * (1 - 0.35 * clamp(r / 6, 0, 1)) * (1 + k) * c.introAt(0.05 * (K - col.k) + 0.03 * r);
            pen.el(id++, (r + col.k) & 1);
            outline(pen, rrPath(cx, cy, s, s, P.radius * u), z, rim(base, 120, 0.5));
          }
        }
      }
    },
  },

  financing: {
    label: 'Financing',
    family: 'Financing',
    group: 'Use cases',
    blurb: 'A grid of parallelograms that leans further row by row, like terms extending. A slow shear wave runs across the grid and shapes near the cursor stand up straight.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: { x: 0.5, y: 0.5, s: 1.05 } },
    params: {
      rows: p(4, 1, 10, 1, 'Rows'),
      cols: p(6, 1, 16, 1, 'Columns'),
      w: p(190, 20, 500, 1, 'Width'),
      h: p(194, 20, 500, 1, 'Height'),
      pitchX: p(208, 20, 600, 1, 'Column pitch'),
      pitchY: p(208, 20, 600, 1, 'Row pitch'),
      slant0: p(44, -400, 400, 1, 'Top row lean'),
      slantStep: p(43.3, -200, 200, 0.1, 'Lean per row'),
      fade: p(0.5, 0, 1, 0.01, 'Lower row fade'),
      shear: p(1, 0, 4, 0.05, 'Shear wave'),
      straighten: p(1, 0, 3, 0.05, 'Cursor straighten'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I);
      const R = Math.round(P.rows), C = Math.round(P.cols);
      for (let r = 0; r < R; r++) {
        const yA = (r - (R - 1) / 2) * P.pitchY;
        for (let j = 0; j < C; j++) {
          const xA = (j - (C - 1) / 2) * P.pitchX;
          const cx = X(xA), cy = Y(yA);
          const k = near(c, cx, cy, 170 * u);
          let sl = P.slant0 + r * P.slantStep + P.shear * mo * 30 * Math.sin(t * 0.35 + j * 0.55 - r * 0.4);
          sl *= 1 - 0.85 * clamp(P.straighten * (0.4 + I) * k, 0, 1);
          const hw = P.w / 2 * u, hh = P.h / 2 * u, d = sl / 2 * u;
          if (offView(c, cx, cy, hw + Math.abs(d), hh)) continue;
          const base = (1 - P.fade * (R > 1 ? r / (R - 1) : 0)) * (0.65 + 0.35 * sd(st, r, j)) * (1 + 0.8 * k) * c.introAt(0.05 * (r + j));
          // top edge leans right by the slant: the shapes read as "/"
          const pts = [cx + hw + d, cy + hh, cx - hw + d, cy + hh, cx - hw - d, cy - hh, cx + hw - d, cy - hh];
          pen.el(r * C + j, (r + j) & 1);
          outline(pen, pts, k * 60 * u, (s, x) => base * (0.45 + 0.55 * sstep(-1.2, 1, (x - cx) / (hw + Math.abs(d)))));
        }
      }
    },
  },

  repo: {
    label: 'Repo',
    family: 'Repo',
    group: 'Use cases',
    blurb: 'Each row is one capsule split by a center rule, collateral on the left and cash on the right. In the opening leg light carries collateral along the top edge while cash runs the bottom edge the other way; they cross the rule together and it flashes as the legs settle. At maturity both run back.',
    layout: { wide: { x: 0.495, y: 0.5, s: 1 }, tall: { x: 0.495, y: 0.5, s: 0.96 } },
    params: {
      pitch: p(240, 80, 500, 1, 'Row pitch'),
      r: p(96, 20, 250, 1, 'End radius'),
      len: p(1180, 300, 2400, 1, 'Capsule length'),
      margin: p(24, 0, 200, 1, 'Edge margin'),
      period: p(8, 2, 30, 0.5, 'Cycle (s)'),
      light: p(1, 0, 3, 0.05, 'Light'),
      rules: p(0.5, 0, 1, 0.01, 'Rule lines'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, W, H } = c, py = P.pitch * u, R = Math.min(P.r * u, py / 2);
      // Keep both round ends in frame: on narrow screens the capsule shortens instead of running off the sides.
      const room = W / 2 - Math.abs(c.ax) - P.margin * u;
      const hw = Math.max(R * 1.5, Math.min(P.len * u / 2, room));
      const i0 = Math.floor((-H / 2 - c.ay) / py) - 1, i1 = Math.ceil((H / 2 - c.ay) / py) + 1;
      if (P.rules > 0) {
        const ra = P.rules * 0.6 * c.introAt(0);
        pen.el(-1);
        for (let i = i0; i <= i1; i++) {
          const y = c.ay + (i + 0.5) * py;
          if (Math.abs(y) > H / 2 + 2) continue;
          pen.poly(20, (s, o) => { o.x = lerp(-W / 2, W / 2, s); o.y = y; o.a = ra * (0.5 + 0.5 * Math.sin(Math.PI * s)); });
        }
      }
      // The lights run the full length, end to end, so they roll onto the round ends instead of stopping where the curve begins.
      const left = c.ax - hw, right = c.ax + hw, w = 70 * u, m = wake(t) * P.light;
      for (let i = i0; i <= i1; i++) {
        const yc = c.ay + i * py;
        if (Math.abs(yc) - R > H / 2 + 4) continue;
        // Opening leg over the first 36% of the cycle, closing leg from 50% to 86%.
        const ph = frac(t / P.period + sd(st, i + 9) * 0.9);
        const q1 = clamp(ph / 0.36, 0, 1), q2 = clamp((ph - 0.5) / 0.36, 0, 1), closing = q2 > 0, q = closing ? q2 : q1;
        const on = sstep(0, 0.24, q) * (1 - sstep(0.76, 1, q)); // long, soft fade in and out
        // Opening: collateral top left to right, cash bottom right to left. Closing: both run back.
        const top = closing ? lerp(right, left, q) : lerp(left, right, q), bot = closing ? lerp(left, right, q) : lerp(right, left, q);
        const cross = gauss((q - 0.5) / 0.06) * on * m;
        const k = c.md * c.mouseAmt * gauss((yc - c.my) / (py * 0.6));
        const base = (0.5 + 0.25 * sd(st, i)) * (1 + 0.7 * k) * c.introAt(0.06 * (i - i0));
        pen.el(i);
        outline(pen, rrPath(c.ax, yc, 2 * hw, 2 * R, R), 0, (s, x, y) => {
          // Top half carries the collateral light, bottom half the cash light. On the round ends the light dims as the
          // curve turns toward the middle, so it wraps around the end and fades instead of being cut off.
          const dy = y - yc, cap = Math.abs(x - c.ax) > hw - R ? Math.pow(clamp(Math.abs(dy) / R, 0, 1), 2) : 1;
          const g = Math.abs(dy) < 1e-3 ? 0 : gauss((x - (dy > 0 ? top : bot)) / w) * cap;
          return base * (1 - 0.55 * sstep(0.55, 1, Math.abs(x - c.ax) / hw)) + 1.6 * m * on * g;
        });
        // The center rule inside the row: faint, flashing as the legs cross it.
        pen.el(-1);
        const ra = 0.22 * base + 1.4 * cross;
        pen.poly(8, (s, o) => { o.x = c.ax; o.y = yc - R + 2 * R * s; o.a = ra * (0.6 + 0.4 * Math.sin(Math.PI * s)); });
      }
    },
  },

  liquidity: {
    label: 'Trading & Liquidity',
    family: 'Trading & Liquidity',
    group: 'Use cases',
    blurb: 'Two columns of long lanes that interleave, like orders on both sides of a book. The lanes slide past each other, light runs along them and lanes near the cursor brighten.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: { x: 0.5, y: 0.5, s: 0.85 } },
    params: {
      rows: p(12, 2, 40, 1, 'Lanes'),
      pitch: p(64, 10, 200, 1, 'Lane pitch'),
      len: p(1221, 100, 3000, 1, 'Lane length'),
      h: p(24, 0, 80, 1, 'Lane height'),
      offset: p(335.5, 0, 1200, 0.5, 'Column offset'),
      fade: p(0.85, 0, 1, 0.01, 'Outer fade'),
      slide: p(1, 0, 4, 0.05, 'Slide'),
      run: p(1, 0, 3, 0.05, 'Light run'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), n = Math.round(P.rows);
      for (let i = 0; i < n; i++) {
        const right = (i & 1) === 0, sg = right ? 1 : -1;
        const y = Y((i - (n - 1) / 2) * P.pitch);
        const k = near(c, c.mx, y, P.pitch * 0.9 * u);
        const L = P.len * u * c.introAt(0.04 * i);
        // The intro grows each lane in from its outer end, so lanes enter from the left and right edges.
        const cx = X(sg * P.offset) + sg * (P.len * u - L) / 2 + sg * P.slide * mo * 60 * u * Math.sin(t * 0.3 + sd(st, i) * TAU) + (c.mx - X(sg * P.offset)) * 0.04 * k;
        const inner = cx - sg * L / 2; // the end that faces the center
        const head = frac(t * 0.06 + sd(st, i, 1));
        const base = (0.6 + 0.4 * sd(st, i, 2)) * (1 + 0.9 * k);
        const af = (s, x) => {
          const q = clamp(sg * (x - inner) / L, 0, 1);
          return base * (1 - P.fade * q + P.run * mo * 1.2 * gauss((q - head) / 0.05));
        };
        pen.el(i, right);
        if (P.h > 0.5) outline(pen, rrPath(cx, y, L, P.h * u, P.h * u / 2), 0, af);
        else pen.poly(40, (s, o) => { o.x = cx - L / 2 + L * s; o.y = y; o.a = af(s, o.x); });
      }
    },
  },

  assets: {
    label: 'Asset Managers',
    family: 'Asset Managers',
    group: 'Institutions',
    blurb: 'A row of arrowheads that grows step by step, like assets compounding. A pulse of momentum moves through the row and the arrowheads near the cursor reach toward it.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1.25 }, tall: SPLIT },
    params: {
      count: p(6, 2, 16, 1, 'Arrowheads'),
      pitch: p(95.3, 20, 300, 0.1, 'Pitch'),
      w0: p(50, 5, 300, 1, 'First width'),
      wStep: p(9.07, -40, 60, 0.01, 'Width step'),
      h0: p(193, 10, 800, 1, 'First height'),
      hStep: p(56.7, -100, 200, 0.1, 'Height step'),
      x0: p(-286, -900, 900, 1, 'Start X'),
      y: p(0, -600, 600, 0.5, 'Center Y'),
      back: p(0.3, 0, 1, 0.01, 'Back edge'),
      pulse: p(1, 0, 3, 0.05, 'Momentum pulse'),
      reach: p(1, 0, 3, 0.05, 'Cursor reach'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), n = Math.round(P.count);
      const head = frac(t * 0.06) * (n + 3) - 1.5;
      for (let i = 0; i < n; i++) {
        const w = (P.w0 + i * P.wStep) * u, h = (P.h0 + i * P.hStep) * u * c.introAt(0.08 * i);
        const xl = X(P.x0 + i * P.pitch) + P.pulse * mo * 12 * u * gauss((i - head) / 1.1), cy = Y(P.y);
        const k = near(c, xl + w, cy, 160 * u);
        const tip = xl + w * (1 + 0.25 * P.reach * (0.4 + I) * k);
        const glow = 1 + P.pulse * mo * 1.5 * gauss((i - head) / 1.1) + 0.8 * k;
        const base = lerp(0.55, 1, n > 1 ? i / (n - 1) : 1) * glow;
        pen.el(i);
        outline(pen, [tip, cy, xl, cy + h / 2, xl, cy - h / 2], 0, (s, x) => base * lerp(P.back, 1, clamp((x - xl) / Math.max(1, tip - xl) * 4, 0, 1)));
      }
    },
  },

  treasurers: {
    label: 'Corporate Treasurers',
    family: 'Corporate Treasurers',
    group: 'Institutions',
    blurb: 'A grid of rounded cells that widen to the right and deepen downward, like balances building up. A slow ripple of light crosses the grid and cells lift under the cursor.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: SPLIT },
    params: {
      w0: p(64, 8, 300, 1, 'First column width'),
      wStep: p(14, -20, 80, 0.5, 'Width step'),
      h0: p(40, 8, 300, 1, 'First row height'),
      hGrow: p(1.185, 0.8, 1.6, 0.005, 'Row growth'),
      gap: p(8, 0, 60, 1, 'Gap'),
      ox: p(-9, -400, 400, 1, 'Left inset'),
      oy: p(-58, -400, 400, 1, 'Top inset'),
      radius: p(8, 0, 60, 1, 'Corner radius'),
      ripple: p(1, 0, 3, 0.05, 'Light ripple'),
      lens: p(1, 0, 3, 0.05, 'Cursor lift'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I, W, H } = c, mo = wake(t) * (0.3 + I);
      let x = c.ax - W / 2 + P.ox * u;
      for (let j = 0; j < 80 && x < W / 2 + 4; j++) {
        const w = Math.max(2, P.w0 + j * P.wStep) * u;
        let y = c.ay + H / 2 - P.oy * u, h = P.h0 * u;
        for (let i = 0; i < 80 && y > -H / 2 - 4; i++) {
          const cx = x + w / 2, cy = y - h / 2;
          if (!offView(c, cx, cy, w / 2, h / 2)) {
            const k = near(c, cx, cy, 150 * u);
            const wave = Math.sin((cx + cy) / (260 * u) - t * 0.6);
            const base = (0.45 + 0.55 * sd(st, i, j)) * (1 + P.ripple * mo * 0.6 * wave + k) * c.introAt(0.03 * (i + j));
            pen.el(j * 80 + i, (i + j) & 1);
            outline(pen, rrPath(cx, cy, w, h, P.radius * u), P.lens * (0.3 + I) * k * 110 * u, rim(base, 120, 0.45));
          }
          y -= h + P.gap * u; h *= P.hGrow;
        }
        x += w + P.gap * u;
      }
    },
  },

  custody: {
    label: 'Custody & Collateral Settlement',
    family: 'Custody & Collateral Settlement',
    group: 'Institutions',
    blurb: 'A lattice of rails with nodes that swell toward one secure center. Packets travel the rails between nodes, nodes pulse as they arrive and the center follows the cursor.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: SPLIT },
    params: {
      pitch: p(191.6, 40, 500, 0.1, 'Pitch'),
      ox: p(0, -500, 500, 1, 'Grid X'),
      oy: p(0, -500, 500, 1, 'Grid Y'),
      rows: p(4, 0, 20, 1, 'Rows of cells (0 fills)'),
      fx: p(0, -900, 900, 1, 'Center X'),
      fy: p(-95.5, -900, 900, 1, 'Center Y'),
      sMax: p(78, 4, 200, 1, 'Center node'),
      sMin: p(28, 0, 120, 1, 'Outer node'),
      reach: p(1.25, 0.2, 5, 0.05, 'Swell reach'),
      rails: p(0.8, 0, 1.5, 0.01, 'Rail strength'),
      packets: p(1, 0, 3, 0.05, 'Packets'),
      follow: p(1, 0, 3, 0.05, 'Cursor follow'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I, W, H } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), pi = P.pitch * u;
      const lean = P.follow * c.md * c.mouseAmt * (0.3 + I);
      const fx = X(P.fx) + (c.mx - X(P.fx)) * 0.5 * lean, fy = Y(P.fy) + (c.my - Y(P.fy)) * 0.5 * lean;
      const gx = X(P.ox), gy = Y(P.oy);
      const j0 = Math.floor((-W / 2 - gx) / pi) - 1, j1 = Math.ceil((W / 2 - gx) / pi) + 1;
      const rH = Math.round(P.rows) / 2;
      const i0 = rH ? -Math.floor(rH) : Math.floor((gy - H / 2) / pi) - 1, i1 = rH ? Math.floor(rH) : Math.ceil((gy + H / 2) / pi) + 1;
      const size = (x, y) => (P.sMin + (P.sMax - P.sMin) * gauss(Math.hypot(x - fx, y - fy) / (pi * P.reach))) * u;
      const gi = c.introAt(0);
      // rails: each one runs between two neighboring nodes and stops at their outlines
      pen.el(-1);
      const rail = (x0, y0, x1, y1, r0, r1, key) => {
        const L = Math.hypot(x1 - x0, y1 - y0), a0 = r0 / 2 / L, a1 = 1 - r1 / 2 / L;
        if (a1 <= a0) return;
        const head = frac(t * 0.08 * (0.8 + 0.4 * sd(st, key)) + sd(st, key, 5));
        const on = sd(st, key, 9) < 0.35;
        pen.poly(12, (s, o) => {
          const f = lerp(a0, a1, s);
          o.x = lerp(x0, x1, f); o.y = lerp(y0, y1, f);
          o.a = P.rails * gi * (0.55 + (on ? P.packets * mo * 2 * gauss((f - head) / 0.06) : 0));
        });
      };
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const x = gx + j * pi, y = gy - i * pi, r = size(x, y);
        if (j < j1) { const x2 = x + pi; rail(x, y, x2, y, r, size(x2, y), i * 97 + j); }
        if (i < i1) { const y2 = y - pi; rail(x, y, x, y2, r, size(x, y2), i * 89 + j * 7 + 500); }
      }
      let id = 0;
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const x = gx + j * pi, y = gy - i * pi, d = size(x, y);
        if (offView(c, x, y, d / 2, d / 2)) continue;
        const pulse = 1 + P.packets * mo * 0.8 * Math.pow(0.5 + 0.5 * Math.sin(t * 0.9 + sd(st, i, j) * TAU), 6);
        pen.el(id++);
        ring(pen, x, y, d * (1 + 0.04 * (pulse - 1)), 0, rim((0.75 + 0.25 * sd(st, j, i)) * pulse * gi, 110, 0.4));
      }
    },
  },

  banks: {
    label: 'Banks',
    family: 'Banks',
    group: 'Institutions',
    blurb: 'A cascade of large rounded squares stepping down and to the left, like balance sheets stacked in depth. The stack fans in and out, light traces each edge and the stack leans toward the cursor.',
    layout: { wide: { x: 0.62, y: 0.42, s: 0.9 }, tall: SPLIT },
    params: {
      count: p(4, 1, 12, 1, 'Squares'),
      size: p(656, 50, 1600, 1, 'Size'),
      radius: p(24, 0, 200, 1, 'Corner radius'),
      x: p(217, -900, 900, 1, 'Front X'),
      y: p(-71, -900, 900, 1, 'Front Y'),
      stepX: p(-136, -400, 400, 1, 'Step X'),
      stepY: p(136, -400, 400, 1, 'Step Y'),
      depth: p(60, 0, 400, 5, 'Depth'),
      light: p(0.8, 0, 1, 0.01, 'Edge light'),
      fan: p(1, 0, 4, 0.05, 'Fan'),
      trace: p(1, 0, 3, 0.05, 'Light trace'),
      lean: p(1, 0, 3, 0.05, 'Cursor lean'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), n = Math.round(P.count);
      const fan = 1 + 0.12 * P.fan * mo * Math.sin(t * 0.3);
      const lean = P.lean * c.md * c.mouseAmt * (0.3 + I);
      for (let k = 0; k < n; k++) {
        const s = P.size * u, f = n > 1 ? k / (n - 1) : 0;
        const cx = X(P.x + k * P.stepX * fan) + c.mn.x * lean * 30 * u * k, cy = Y(P.y + k * P.stepY * fan) + c.mn.y * lean * 30 * u * k;
        const base = lerp(1, 0.55, f) * c.introAt(0.15 * k);
        const head = frac(t * 0.04 + sd(st, k));
        pen.el(k);
        outline(pen, rrPath(cx, cy, s, s, P.radius * u), -k * P.depth * u, (q, x, y) => {
          const lit = sstep(-0.7, 0.5, ((y - cy) - 0.5 * (x - cx)) / s);
          const d = Math.abs(q - head), glint = gauss(Math.min(d, 1 - d) / 0.04);
          return base * (1 - P.light + P.light * lit + P.trace * mo * glint);
        });
      }
    },
  },

  primeAlt: {
    label: 'Prime Brokers',
    family: 'Prime Brokers',
    group: 'Institutions',
    blurb: 'Slim slats that hang from one flat top edge and lean in toward a point below the frame, laid out as in the Figma hero. Light runs down the slats, the set slowly widens and narrows, and the cursor spreads it: wider toward the edges, tighter at the center.',
    layout: { wide: { x: 0.5, y: 0.56, s: 1.3 }, tall: SPLIT },
    // Defaults are the Figma frame (640 × 960) in px, measured from its center: 9 slats per side, 24.1 px wide,
    // tops 51.3 px apart along y -214, bottoms 19.5 px apart along y 630 (below the frame). Art y runs down.
    params: {
      perSide: p(9, 1, 30, 1, 'Slats per side'),
      width: p(24.1, 0, 120, 0.1, 'Slat width'),
      topGap: p(51.3, 0, 200, 0.1, 'Top spacing'),
      topCenter: p(25.7, -200, 200, 0.1, 'Top center offset'),
      botGap: p(19.5, 0, 200, 0.1, 'Bottom spacing'),
      botCenter: p(9.8, -200, 200, 0.1, 'Bottom center offset'),
      top: p(-214, -900, 900, 1, 'Top Y'),
      bottom: p(630, -900, 1400, 1, 'Bottom Y'),
      light: p(1, 0, 1, 0.01, 'Gradient fade'),
      sway: p(1, 0, 4, 0.05, 'Breathe'),
      pulses: p(1, 0, 3, 0.05, 'Pulses'),
      lean: p(1, 0, 3, 0.05, 'Cursor spread'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), n = Math.round(P.perSide);
      const H = P.bottom - P.top, w = P.width / 2;
      if (Math.abs(H) < 1) return;
      const lean = P.lean * c.md * c.mouseAmt * (0.3 + I);
      // Slat positions only widen and narrow, mirrored about the center line; the slats keep their width.
      const spread = 1 + P.sway * mo * 0.06 * Math.sin(t * 0.25) + lean * 0.15 * (Math.abs(c.mn.x) * 2 - 1);
      let id = 0;
      for (const sg of [-1, 1]) for (let j = 0; j < n; j++) {
        const xt = sg * (P.topCenter + P.topGap * j), xb = sg * (P.botCenter + P.botGap * j);
        // Figma lays the same stroke gradient over each slat's own bounding box: clear at its top left, full at its bottom right.
        const x0 = Math.min(xt, xb) - w, bw = Math.abs(xt - xb) + 2 * w;
        const lit = (x, y) => 1 - P.light * clamp(1.2936 - 0.7461 * (x - x0) / bw - 0.7909 * (y - P.top) / H, 0, 1);
        const base = 0.9 + 0.1 * sd(st, j, sg + 4), grow = c.introAt(0.04 * j);
        const head = frac(t * 0.06 * (0.8 + 0.4 * sd(st, j, sg + 2)) + sd(st, j, sg));
        const at = (q, e) => { // q: 0 at the bottom, 1 at the top; e: -1 left edge, 1 right edge
          const x = lerp(xb, xt, q) + e * w, y = lerp(P.bottom, P.top, q);
          return [X(lerp(xb, xt, q) * spread + e * w), Y(y), base * lit(x, y) * (1 + P.pulses * mo * 1.4 * gauss((1 - q - head) / 0.035))];
        };
        pen.el(id++);
        for (const e of [-1, 1]) pen.poly(48, (s, o) => { // the intro grows each slat up from the bottom
          const [x, y, a] = at(s * grow, e); o.x = x; o.y = y; o.a = a;
        });
        const cap = sstep(0.85, 1, grow);
        for (const q of [0, 1]) {
          const [x1, y1, a1] = at(q * grow, -1), [x2, y2, a2] = at(q * grow, 1);
          pen.seg(x1, y1, 0, a1 * (q ? cap : 1), x2, y2, 0, a2 * (q ? cap : 1));
        }
      }
    },
  },

  exchanges: {
    base: 'dots',
    label: 'Exchanges & Trading Venue',
    family: 'Exchanges & Trading Venue',
    group: 'Institutions',
    blurb: 'A staggered field of rings that swells toward the center like a crowded venue. The swell drifts, rings shimmer as they quote and the swell follows the cursor.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: SPLIT },
    defaults: { pitchX: 84, pitchY: 84.5, stagger: 0, ox: 42, oy: 40, size: 104, profile: 0, floor: 0.3, reach: 400, light: 225, contrast: 0.45, fill: 1, depth: 1 },
  },

  dots: {
    label: 'Ring Field',
    family: 'Exchanges, Market Makers, Collateral Management',
    group: 'Institutions',
    hidden: true,
    blurb: 'A field of rings whose size follows a swell or a ramp.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: SPLIT },
    params: {
      pitchX: p(84, 10, 300, 0.5, 'Column pitch'),
      pitchY: p(84.5, 10, 300, 0.5, 'Row pitch'),
      stagger: p(0.5, 0, 1, 0.01, 'Stagger'),
      ox: p(278, -600, 600, 0.5, 'Grid X'),
      oy: p(40, -600, 600, 0.5, 'Grid Y'),
      size: p(104, 2, 300, 1, 'Ring size'),
      profile: p(0, 0, 2, 1, 'Size profile', { options: { Swell: 0, Ramp: 1, Even: 2 } }),
      floor: p(0.3, 0, 1, 0.01, 'Smallest share'),
      reach: p(400, 50, 2000, 5, 'Swell reach'),
      cx: p(0, -900, 900, 1, 'Swell X'),
      cy: p(0, -900, 900, 1, 'Swell Y'),
      rampY: p(21, -900, 900, 1, 'Ramp middle Y'),
      rampSpan: p(660, 50, 2000, 5, 'Ramp length'),
      rampTilt: p(0.3, -2, 2, 0.01, 'Ramp tilt'),
      light: p(225, 0, 360, 1, 'Light angle'),
      contrast: p(0.45, 0, 1, 0.01, 'Light contrast'),
      shimmer: p(1, 0, 3, 0.05, 'Shimmer'),
      drift: p(1, 0, 4, 0.05, 'Swell drift'),
      follow: p(1, 0, 3, 0.05, 'Cursor follow'),
      fill: p(0, 0, 1, 1, 'Ring fill', { options: { None: 0, Background: 1 } }),
      depth: p(0, 0, 1, 1, 'Ring sizing', { options: { Scale: 0, Depth: 1 } }),
      parallax: p(0.12, 0, 1, 0.01, 'Depth parallax'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I, W, H, D } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), filled = P.fill > 0.5, deep = P.depth > 0.5;
      const px = P.pitchX * u, py = P.pitchY * u, mode = Math.round(P.profile);
      const lean = P.follow * c.md * c.mouseAmt * (0.3 + I);
      const sx = X(P.cx) + P.drift * mo * 60 * u * Math.sin(t * 0.2) + (c.mx - X(P.cx)) * 0.6 * lean;
      const sy = Y(P.cy) + P.drift * mo * 40 * u * Math.cos(t * 0.17) + (c.my - Y(P.cy)) * 0.6 * lean;
      const gx = X(P.ox), gy = Y(P.oy), dMax = P.size * u;
      const i0 = Math.floor((-H / 2 - dMax - gy) / py) - 1, i1 = Math.ceil((H / 2 + dMax - gy) / py) + 1;
      let id = 0;
      for (let i = i0; i <= i1; i++) {
        const oy = gy + i * py, sh = (i & 1) ? P.stagger * px : 0;
        const j0 = Math.floor((-W / 2 - dMax - gx - sh) / px) - 1, j1 = Math.ceil((W / 2 + dMax - gx - sh) / px) + 1;
        for (let j = j0; j <= j1; j++) {
          const x = gx + sh + j * px, y = oy;
          let f;
          if (mode === 0) {
            const R = P.reach * u;
            const g = (d) => P.floor + (1 - P.floor) * gauss(d / R);
            f = g(x - sx) * g(y - sy);
          } else if (mode === 1) {
            const xa = (x - c.ax) / u, ya = (c.ay - y) / u;
            f = P.floor + (1 - P.floor) * sstep(0, 1, (ya - P.rampY - P.rampTilt * xa) / P.rampSpan + 0.5);
            const k = near(c, x, y, 140 * u) * lean; f = Math.min(1, f + 0.4 * k);
          } else f = 1;
          const shim = 1 + P.shimmer * mo * 0.06 * Math.sin(t * 0.8 + sd(st, i, j) * TAU);
          const d = dMax * f * shim * c.introAt(0.02 * Math.abs(i) + 0.02 * Math.abs(j));
          if (d < 1 || offView(c, x, y, d / 2, d / 2)) continue;
          const base = (0.6 + 0.4 * sd(st, j, i)) * (1 + P.shimmer * mo * 0.5 * Math.max(0, Math.sin(t * 0.5 + sd(st, i, j + 7) * TAU)));
          pen.el(id++, (i + j) & 1);
          // Filled rings overlap like shingles, stacked as in the Figma frame: each row sits over the row above it
          // and each ring over its left neighbor. The order depends only on grid position, so nothing ever pops.
          if (filled) pen.layer = clamp(400 - i, 0, 640) * 512 + clamp(j + 256, 0, 511);
          if (deep) {
            // Rings set back in space: smaller rings sit further back, and the cursor tilt gives them parallax.
            // At full parallax every ring is the same size and perspective alone shrinks it; lower values compress
            // the depth (and size each ring to match) so the far rings don't swing across the frame.
            const k = Math.max(0.05, f * shim), z = P.parallax * D * (1 - 1 / k), ps = D / (D - z);
            const dw = dMax * k / ps * c.introAt(0.02 * Math.abs(i) + 0.02 * Math.abs(j));
            if (filled) pen.disc(x / ps, y / ps, z, dw / 2);
            ring(pen, x / ps, y / ps, dw, z, rim(base, P.light, P.contrast));
          } else {
            if (filled) pen.disc(x, y, 0, d / 2);
            ring(pen, x, y, d, 0, rim(base, P.light, P.contrast));
          }
        }
      }
    },
  },

  hedge: {
    label: 'Hedge Funds & Trading Firms',
    family: 'Hedge Funds & Trading Firms',
    group: 'Institutions',
    blurb: 'Columns that climb from the floor on one side and hang from the ceiling on the other, like long and short books held against each other. Every few seconds a trade lands at the center: both books give up the same height in a quick burst, then glide slowly back to rest as the motion carries out to the edges. The floor and ceiling never move. The cursor presses the columns beneath it shorter, and their mirrored partners match.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1.3 }, tall: SPLIT },
    params: {
      scaleW: p(1, 0.2, 4, 0.01, 'Width scale'),
      spread: p(1, 0.3, 3, 0.01, 'Spread'),
      radius: p(0, 0, 40, 1, 'Corner radius'),
      fade: p(1, 0, 1, 0.01, 'Gradient fade'),
      trade: p(1, 0, 4, 0.05, 'Trade size'),
      every: p(6, 2, 20, 0.5, 'Trade interval (s)'),
      settle: p(1, 0.3, 3, 0.05, 'Settle speed'),
      press: p(1, 0, 3, 0.05, 'Cursor weight'),
    },
    init(c, P, rnd) { return Object.assign(seeds(rnd), { y: new Float64Array(6), v: new Float64Array(6), t: -1 }); },
    draw(c, pen, st, P) {
      const { u, t, I } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), n = HEDGE.length;
      const xs = HEDGE.map(([xc]) => X((xc - 320) * P.spread));
      // The floor and ceiling lines are the baselines of the trade and never move: only the column heights change.
      // Columns pair up mirror-wise (center with center, out to the outer pair) and each pair shares one height change,
      // so whatever one side gains or gives up, the other matches exactly.
      // Spring model over the six pairs, in art px of height given up (positive = shorter). Each pair has mass from its width,
      // a soft spring back to rest, stiff links to its neighbors and strong damping: a trade bursts out fast, then glides back
      // slowly without bouncing, while the outer pairs follow a beat later.
      const dt0 = st.t < 0 || t < st.t ? 0 : Math.min(0.1, t - st.t);
      if (st.t < 0 || t < st.t) { st.y.fill(0); st.v.fill(0); }
      const kS = 1.5, kN = 30, damp = 4 * P.settle, press = P.press * c.md * c.mouseAmt * (0.4 + I);
      const force = new Float64Array(6);
      // The cursor presses the pair beneath it shorter, on both sides at once.
      for (let j = 0; j < 6; j++) force[j] = press * 260 * (near(c, xs[5 - j], c.my, 80 * u) + near(c, xs[6 + j], c.my, 80 * u));
      // A trade every few seconds, struck at the center pair, alternating direction.
      const k0 = Math.floor((st.t - 2) / P.every), k1 = Math.floor((t - 2) / P.every);
      if (dt0 > 0 && k1 > k0 && t > 2) st.v[0] += 250 * P.trade * (k1 & 1 ? 1 : -1) * (0.75 + 0.5 * sd(st, k1 & 1023));
      for (let left = dt0, h; left > 1e-6; left -= h) {
        h = Math.min(left, 1 / 120);
        for (let j = 0; j < 6; j++) {
          const m = HEDGE[5 - j][1] / 40, y = st.y[j];
          let f = -kS * y - damp * st.v[j] * m + force[j];
          if (j > 0) f += kN * (st.y[j - 1] - y);
          if (j < 5) f += kN * (st.y[j + 1] - y);
          st.v[j] += f / m * h;
        }
        for (let j = 0; j < 6; j++) st.y[j] += st.v[j] * h;
      }
      st.t = t;
      HEDGE.forEach(([, w, top, bot], i) => {
        const up = i < 6; // climbs from the floor; otherwise hangs from the ceiling
        const d = clamp(st.y[up ? 5 - i : i - 6], -160, 0.6 * (bot - top)) * mo; // height given up, the same on both sides
        let y0 = top - 480 + (up ? d : 0), y1 = bot - 480 - (up ? 0 : d); // only the free end moves
        const g = c.introAt(0.05 * (up ? 5 - i : i - 6));
        if (up) y0 = lerp(y1, y0, g); else y1 = lerp(y0, y1, g);
        const wy0 = Y(y0), wy1 = Y(y1), x = xs[i];
        const h = Math.abs(wy1 - wy0), cy = (wy0 + wy1) / 2, ww = w * P.scaleW * u;
        if (h < 1) return;
        // The Figma stroke gradient over each column's own box: full at its bottom outer corner, clear toward the opposite top corner
        // (the floor columns are mirrored, so theirs runs the other way).
        const x0 = x - ww / 2, yt = Math.max(wy0, wy1);
        pen.el(i, up);
        outline(pen, rrPath(x, cy, ww, h, P.radius * u), 0, (s, px, py) => {
          const nx = clamp((px - x0) / ww, 0, 1), ny = clamp((yt - py) / h, 0, 1);
          return (0.85 + 0.15 * sd(st, i)) * (1 - P.fade * clamp(1.294 - 0.746 * (up ? 1 - nx : nx) - 0.791 * ny, 0, 1));
        });
      });
    },
  },

  makers: {
    base: 'dots',
    label: 'Market Makers',
    family: 'Market Makers',
    group: 'Institutions',
    blurb: 'An even, staggered field of rings, like quotes posted on both sides. Rings shimmer as they update and the field brightens around the cursor.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: SPLIT },
    defaults: { pitchX: 83, pitchY: 83, stagger: 0.5, ox: 42.5, oy: -455.5, size: 63, profile: 2, light: 160, contrast: 0.6 },
  },

  otc: {
    label: 'OTC Desks',
    family: 'OTC Desks',
    group: 'Institutions',
    blurb: 'A row of tall rounded columns whose tops trace an uneven skyline, like negotiated prices. A lighter set of columns arrives after the rest, the skyline ripples slowly and columns near the cursor rise to meet it.',
    layout: { wide: { x: 0.5, y: 0.5, s: 0.95 }, tall: SPLIT },
    params: {
      pitch: p(32.6, 6, 120, 0.1, 'Pitch'),
      w: p(19, 1, 80, 0.5, 'Column width'),
      x0: p(-603.7, -2000, 600, 0.5, 'First column X'),
      relief: p(1, 0, 3, 0.01, 'Skyline relief'),
      lift: p(0, -600, 600, 1, 'Skyline Y'),
      fade: p(0.7, 0, 1, 0.01, 'Downward fade'),
      ripple: p(1, 0, 4, 0.05, 'Ripple'),
      rise: p(1, 0, 3, 0.05, 'Cursor rise'),
      set: p(0, 0, 1, 1, 'Lighter set', { options: { 'Every other': 0, 'Figma accents': 1 } }),
      dim: p(0.45, 0, 1, 0.01, 'Other columns'),
      entry: p(4, 0, 4, 1, 'Entrance', { options: { Fade: 0, 'Fade and lift': 1, 'Fade sweep': 2, Grow: 3, 'Diagonal sweep': 4 } }),
      lag: p(2, 0, 6, 0.1, 'Lighter set delay (s)'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I, W, H } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), m = OTC_TOPS.length;
      const entry = Math.round(P.entry);
      const mean = OTC_TOPS.reduce((a, b) => a + b, 0) / m;
      const j0 = Math.floor((-W / 2 / u - c.ax / u - P.x0) / P.pitch) - 1, j1 = Math.ceil((W / 2 / u - c.ax / u - P.x0) / P.pitch) + 1;
      const bottom = -H / 2 - 20;
      for (let j = j0; j <= j1; j++) {
        const q = ((j % (2 * m)) + 2 * m) % (2 * m), top0 = OTC_TOPS[q < m ? q : 2 * m - 1 - q];
        const x = X(P.x0 + j * P.pitch);
        const k = near(c, x, c.my, 70 * u) * P.rise * (0.4 + I);
        // The lighter set: every other column, or the solid-stroke accent columns from the Figma frame.
        const light = Math.round(P.set) ? OTC_ACCENTS.has(q < m ? q : 2 * m - 1 - q) : (j & 1) === 1;
        // Entrance: the other columns come in first and the lighter set follows as a group, P.lag seconds later.
        const d0 = light ? P.lag : 0, sweep = entry === 2 ? 0.035 * (j - j0) : 0, g = c.introAt(d0 + sweep);
        const lift = entry === 1 ? (1 - g) * 60 : 0;
        const ty = mean + (top0 - mean) * P.relief - 480 + P.lift - P.ripple * mo * 18 * Math.sin(t * 0.4 + j * 0.35) - k * 70 + lift;
        const yTop = entry === 3 ? lerp(bottom, Y(ty), g) : Y(ty);
        const h = yTop - bottom, w = P.w * u;
        if (h < w || Math.abs(x) - w > W / 2 + 4) continue;
        const a = entry === 3 || entry === 4 ? 1 : g;
        if (a < 0.003) continue;
        const base = (light ? 1 : P.dim * (0.85 + 0.3 * sd(st, j))) * (1 + 0.7 * k) * a, fade = P.fade * (light ? 0.35 : 1);
        pen.el(j, j & 1);
        // Diagonal sweep: a soft fade front that crosses the frame from the bottom left to the top right, point by point.
        const diag = entry === 4 ? (xx, y) => c.introAt(d0 + 1.6 * clamp(0.5 * (xx / W + 0.5) + 0.5 * (y / H + 0.5), 0, 1)) : () => 1;
        outline(pen, rrPath(x, (yTop + bottom) / 2, w, h, w / 2), 0, (s, xx, y) => base * diag(xx, y) * (1 - fade * clamp((yTop - y) / (H * 0.6), 0, 1)));
      }
    },
  },

  leadership: {
    label: 'Leadership',
    family: 'Leadership',
    group: 'Roles',
    blurb: 'Nested arcs that rise into one crest, layer over layer. The arcs breathe, light runs over the crest and the arcs lift toward the cursor.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: SPLIT },
    params: {
      count: p(24, 2, 60, 1, 'Arcs'),
      first: p(-109, -900, 900, 1, 'First arc end Y'),
      step: p(27.5, 2, 120, 0.1, 'End spacing'),
      h0: p(184, 0, 800, 1, 'First arc height'),
      decay: p(0.918, 0.7, 1.2, 0.001, 'Height decay'),
      cx: p(0, -900, 900, 1, 'Crest X'),
      half: p(440, 100, 2000, 1, 'Half width'),
      fade: p(0.45, 0, 1, 0.01, 'Lower fade'),
      breathe: p(1, 0, 4, 0.05, 'Breathe'),
      run: p(1, 0, 3, 0.05, 'Light run'),
      lift: p(1, 0, 3, 0.05, 'Cursor lift'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I, W } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), n = Math.round(P.count);
      const hx = Math.max(W / 2 / u + 20, P.half); // the crest always spans the frame
      for (let i = 0; i < n; i++) {
        const end = P.first + i * P.step;
        const h = P.h0 * Math.pow(P.decay, i) * (1 + 0.08 * P.breathe * mo * Math.sin(t * 0.4 - i * 0.25)) * c.introAt(0.03 * i);
        const head = frac(t * 0.05 + sd(st, i));
        const base = lerp(0.95, 1 - P.fade, n > 1 ? i / (n - 1) : 0);
        pen.el(i);
        pen.poly(80, (s, o) => {
          const xa = P.cx + (s * 2 - 1) * hx, q = (xa - P.cx) / hx;
          o.x = X(xa);
          const k = near(c, o.x, Y(end - h), 220 * u) * P.lift * (0.3 + I);
          o.y = Y(end - h * (1 - q * q) - k * 25);
          o.a = base * (1 - sstep(0.9, 1, Math.abs(s * 2 - 1))) * (1 + P.run * mo * 1.3 * gauss((s - head) / 0.04) + 0.6 * k);
        });
      }
    },
  },

  legal: {
    label: 'Legal',
    family: 'Legal',
    group: 'Roles',
    blurb: 'Bars that interlock in a pinwheel weave, like clauses that hold each other in place. The weave shimmers, bars slide gently along their length and bars near the cursor lift.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: SPLIT },
    params: {
      unit: p(150.5, 30, 400, 0.5, 'Weave unit'),
      len: p(205, 10, 600, 1, 'Bar length'),
      w: p(66, 4, 300, 1, 'Bar width'),
      radius: p(8, 0, 100, 1, 'Corner radius'),
      hx: p(0, -600, 600, 0.5, 'Weave X'),
      hy: p(0, -600, 600, 0.5, 'Weave Y'),
      light: p(120, 0, 360, 1, 'Light angle'),
      contrast: p(0.45, 0, 1, 0.01, 'Light contrast'),
      slide: p(1, 0, 4, 0.05, 'Slide'),
      lens: p(1, 0, 3, 0.05, 'Cursor lift'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I, W, H } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), q = P.unit;
      // horizontal bars: x = hx + 2q·j + q·(i odd), y = hy + q·i; vertical bars sit on the same lattice, rotated
      const vx = P.hx, vy = P.hy + q;
      const Wa = W / 2 / u + P.len, Ha = H / 2 / u + P.len;
      const ox = -c.ax / u, oy = c.ay / u;
      let id = 0;
      const bar = (xa, ya, horiz, key) => {
        const sl = P.slide * mo * 10 * Math.sin(t * 0.4 + sd(st, key) * TAU);
        const x = X(xa + (horiz ? sl : 0)), y = Y(ya + (horiz ? 0 : sl));
        const bw = (horiz ? P.len : P.w) * u, bh = (horiz ? P.w : P.len) * u;
        if (offView(c, x, y, bw / 2, bh / 2)) return;
        const k = near(c, x, y, 150 * u);
        const base = (0.55 + 0.45 * sd(st, key, 3)) * (1 + k) * c.introAt(0.1 * sd(st, key, 7));
        pen.el(id++, horiz);
        outline(pen, rrPath(x, y, bw, bh, P.radius * u), P.lens * (0.3 + I) * k * 100 * u, rim(base, P.light, P.contrast));
      };
      const iA = Math.floor((oy - Ha - P.hy) / q), iB = Math.ceil((oy + Ha - P.hy) / q);
      for (let i = iA; i <= iB; i++) {
        const sh = (i & 1) ? q : 0;
        const jA = Math.floor((ox - Wa - P.hx - sh) / (2 * q)), jB = Math.ceil((ox + Wa - P.hx - sh) / (2 * q));
        for (let j = jA; j <= jB; j++) bar(P.hx + sh + 2 * q * j, P.hy + q * i, true, i * 53 + j);
      }
      const jA = Math.floor((ox - Wa - vx) / q), jB = Math.ceil((ox + Wa - vx) / q);
      for (let j = jA; j <= jB; j++) {
        const sh = (j & 1) ? q : 0;
        const iA2 = Math.floor((oy - Ha - vy - sh) / (2 * q)), iB2 = Math.ceil((oy + Ha - vy - sh) / (2 * q));
        for (let i = iA2; i <= iB2; i++) bar(vx + q * j, vy + sh + 2 * q * i, false, j * 59 + i + 700);
      }
    },
  },

  risk: {
    label: 'Risk',
    family: 'Risk',
    group: 'Roles',
    blurb: 'Many lines gather from across the frame into one point, like exposures netting down. Light flows along the lines into the point, which sways and leans toward the cursor.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: SPLIT },
    params: {
      count: p(40, 4, 120, 1, 'Lines'),
      spread: p(948, 50, 2400, 1, 'Spread at left'),
      px: p(503, -900, 1400, 1, 'Point X'),
      py: p(45, -900, 900, 1, 'Point Y'),
      ly: p(0, -900, 900, 1, 'Spread center Y'),
      shape: p(1, 0.3, 3, 0.01, 'Gather curve'),
      glow: p(0.85, 0, 1, 0.01, 'Point glow'),
      sway: p(1, 0, 4, 0.05, 'Sway'),
      flow: p(1, 0, 3, 0.05, 'Light flow'),
      lean: p(1, 0, 3, 0.05, 'Cursor lean'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I, W } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), n = Math.round(P.count);
      const lean = P.lean * c.md * c.mouseAmt * (0.3 + I);
      const pX = X(P.px) + (c.mx - X(P.px)) * 0.12 * lean;
      const pY = Y(P.py + P.sway * mo * 30 * Math.sin(t * 0.3)) + (c.my - Y(P.py)) * 0.25 * lean;
      const xL = Math.min(X(P.px - 988), -W / 2 - 10);
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0.5;
        const yL = Y(P.ly + (f - 0.5) * P.spread);
        const head = frac(t * 0.06 * (0.8 + 0.4 * sd(st, i)) + sd(st, i, 1));
        const grow = c.introAt(0.01 * i);
        pen.el(i);
        pen.poly(60, (s, o) => {
          const q = s * grow; // the intro draws each line from the left edge in toward the point
          o.x = lerp(xL, pX, q);
          o.y = lerp(yL, pY, Math.pow(sstep(0, 1, q), P.shape));
          o.a = (lerp(0.15, 1, Math.pow(q, 1.5 * P.glow + 0.2))) * (0.85 + P.flow * mo * 1.4 * gauss((q - head) / 0.04));
        });
      }
    },
  },

  pooling: {
    label: 'CFO/Treasury',
    family: 'CFO/Treasury',
    group: 'Roles',
    blurb: 'Lines spread across the top sweep down into one tight bundle, like cash from many accounts pooled into a single position. Light pulses travel steadily down every line into the bundle, and lines near the cursor glow brighter.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: SPLIT },
    params: {
      count: p(40, 4, 120, 1, 'Lines'), // even, so no line runs dead straight down the center
      spread: p(600, 50, 1600, 1, 'Spread at top'),
      bundle: p(88, 0, 600, 1, 'Bundle width'),
      neck: p(120, -400, 480, 1, 'Neck Y'),
      top: p(-560, -900, 0, 1, 'Top Y'),
      cx: p(0, -600, 600, 1, 'Bundle X'),
      hold: p(410, 0, 900, 1, 'Top curve'),
      pull: p(270, 0, 900, 1, 'Neck curve'),
      pulses: p(3, 1, 8, 1, 'Pulses per line'),
      speed: p(1, 0, 4, 0.05, 'Pulse speed'),
      flow: p(1, 0, 3, 0.05, 'Light flow'),
      lean: p(1, 0, 3, 0.05, 'Cursor glow'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I, H } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), n = Math.round(P.count);
      const bot = Math.max(P.neck + 40, (c.ay + H / 2) / u + 20); // the bundle always runs off the bottom edge
      const top = Math.min(P.top, (c.ay - H / 2) / u - 20); // lines enter from above the top edge
      const glow = P.lean * (0.3 + I);
      const sc = 0.62; // share of each line spent on the curve, the rest runs straight down
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0.5;
        const x0 = P.cx + (f - 0.5) * P.spread, b = P.cx + (f - 0.5) * P.bundle;
        const y1 = P.neck, c1 = top + P.hold, c2 = y1 - P.pull;
        const lag = 0.12 * sd(st, i, 1); // small per-line offset so pulses ripple instead of marching in lockstep
        const base = (0.7 + 0.3 * sd(st, i, 2)) * c.introAt(0); // the intro is a plain fade in, every line at once
        pen.el(i);
        pen.poly(90, (s, o) => {
          const q = s;
          let xa, ya;
          if (q < sc) {
            const v = q / sc, w = 1 - v;
            xa = w * w * w * x0 + 3 * w * w * v * x0 + 3 * w * v * v * b + v * v * v * b;
            ya = w * w * w * top + 3 * w * w * v * c1 + 3 * w * v * v * c2 + v * v * v * y1;
          } else { xa = b; ya = lerp(y1, bot, (q - sc) / (1 - sc)); }
          o.x = X(xa); o.y = Y(ya);
          // The cursor only brightens lines, never moves them: a bend would change each line's extent, and with the
          // Gradient stroke fill (which fades across that extent) the near-straight center lines would flicker.
          const k = near(c, o.x, o.y, 160 * u) * glow;
          const ph = frac(q * P.pulses - t * 0.08 * P.speed + lag); // always moves down the line, toward the bundle
          o.a = base * (1 + P.flow * mo * 1.4 * gauss(Math.min(ph, 1 - ph) / 0.05) + 0.9 * k);
        });
      }
    },
  },

  trading: {
    label: 'Trading',
    family: 'Trading',
    group: 'Roles',
    blurb: 'Rows of split lanes whose gaps line up into one arrow, like a trade cutting through the book. The arrow pushes forward and back, light runs along the lanes and rows near the cursor lean toward it.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: SPLIT },
    params: {
      rows: p(17, 3, 60, 1, 'Rows'),
      pitch: p(54, 10, 200, 1, 'Row pitch'),
      h: p(26, 0, 80, 1, 'Lane height'),
      gap: p(88, 0, 400, 1, 'Gap'),
      tip: p(358, -900, 900, 1, 'Arrow tip X'),
      step: p(100, -300, 300, 1, 'Step per row'),
      fade: p(0.7, 0, 1, 0.01, 'Outer fade'),
      push: p(1, 0, 4, 0.05, 'Push'),
      run: p(1, 0, 3, 0.05, 'Light run'),
      lean: p(1, 0, 3, 0.05, 'Cursor lean'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I, W } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I), n = Math.round(P.rows), mid = (n - 1) / 2;
      const xl = -W / 2 - 30 * u, xr = W / 2 + 30 * u;
      for (let i = 0; i < n; i++) {
        const y = Y((i - mid) * P.pitch), d = Math.abs(i - mid);
        const k = near(c, c.mx, y, P.pitch * u) * P.lean * (0.4 + I);
        const split = X(P.tip - d * P.step + P.push * mo * 40 * Math.sin(t * 0.4 - d * 0.35)) + (c.mx - X(P.tip - d * P.step)) * 0.15 * k;
        const a = split - P.gap * u / 2, b = split + P.gap * u / 2;
        const head = frac(t * 0.05 + sd(st, i));
        const base = (0.6 + 0.4 * sd(st, i, 1)) * (1 + 0.8 * k) * c.introAt(0.03 * d);
        const lane = (x0, x1, odd, dir) => {
          if (x1 - x0 < 2) return;
          const L = x1 - x0, cx = (x0 + x1) / 2;
          pen.el(i * 2 + odd, odd);
          const af = (s, x) => { const q = clamp(dir > 0 ? (x - x0) / L : (x1 - x) / L, 0, 1); return base * (1 - P.fade * q + P.run * mo * gauss((q - head) / 0.05)); };
          if (P.h > 0.5) outline(pen, rrPath(cx, y, L, P.h * u, P.h * u / 2), 0, af);
          else pen.poly(30, (s, o) => { o.x = lerp(x0, x1, s); o.y = y; o.a = af(s, o.x); });
        };
        lane(xl, a, 0, -1); // fades toward the left edge
        lane(b, xr, 1, 1);  // fades toward the right edge
      }
    },
  },

  lending: {
    label: 'Lending',
    family: 'Lending',
    group: 'Roles',
    blurb: 'Fine bars hang from the top and rise from the bottom, meeting along one S-curve, like a loan drawn down and repaid. The curve slides and breathes and bends toward the cursor.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: SPLIT },
    params: {
      pitch: p(38, 6, 120, 0.5, 'Pitch'),
      w: p(10, 1, 60, 0.5, 'Bar width'),
      x0: p(29, -200, 200, 0.5, 'First bar X'),
      offset: p(20, 0, 60, 0.5, 'Set offset'),
      mid: p(8, -600, 600, 1, 'Curve middle Y'),
      amp: p(295, 0, 900, 1, 'Curve height'),
      span: p(720, 50, 3000, 5, 'Curve length'),
      cx: p(10, -900, 900, 1, 'Curve X'),
      overlap: p(6, -60, 60, 1, 'Overlap'),
      fade: p(0.65, 0, 1, 0.01, 'Fade from curve'),
      slide: p(1, 0, 4, 0.05, 'Slide'),
      bend: p(1, 0, 3, 0.05, 'Cursor bend'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I, W, H } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I);
      const cx = P.cx + P.slide * mo * 60 * Math.sin(t * 0.25), amp = P.amp * (1 + 0.08 * P.slide * mo * Math.sin(t * 0.33));
      // Where the two sets meet (art y, down): the curve climbs to the right, so the bottom bars rise from left to right.
      const E = (xa) => P.mid - amp * (2 * sstep(0, 1, (xa - cx) / P.span + 0.5) - 1);
      const topY = H / 2 + 30 * u, botY = -H / 2 - 30 * u, xa0 = (-W / 2 - c.ax) / u, xa1 = (W / 2 - c.ax) / u;
      let id = 0;
      for (const set of [0, 1]) {
        const off = set ? P.x0 - P.offset : P.x0;
        const j0 = Math.floor((xa0 - off) / P.pitch) - 1, j1 = Math.ceil((xa1 - off) / P.pitch) + 1;
        for (let j = j0; j <= j1; j++) {
          const xa = off + j * P.pitch, x = X(xa);
          const k = near(c, x, c.my, 80 * u) * P.bend * (0.3 + I);
          const e = Y(E(xa)) + (c.my - Y(E(xa))) * 0.3 * k;
          const grow = c.introAt(0.004 * Math.abs(j));
          const y0 = set ? botY : topY, y1 = lerp(y0, set ? e + P.overlap * u : e - P.overlap * u, grow);
          const h = Math.abs(y1 - y0), w = P.w * u;
          if (h < w) continue;
          const base = 0.75 + 0.25 * sd(st, j, set);
          pen.el(id++, set);
          outline(pen, rrPath(x, (y0 + y1) / 2, w, h, w / 2), 0, (s, xx, y) => base * (1 - P.fade + P.fade * gauss((y - e) / (240 * u))));
        }
      }
    },
  },

  alwaysOpenTrim: {
    label: 'Collateral Management',
    family: 'Collateral Management',
    group: 'Roles',
    blurb: 'Collateral that moves around the clock. One day in New York time runs left to right with the closed hours hatched. A single clock drives everything: the USDM1 burst marker tracks the time of day around the clock, while the market markers move with it only in open hours and stop at the close. The band under the cursor brightens.',
    layout: { wide: { x: 0.5, y: 0.5, s: 1 }, tall: SPLIT },
    params: {
      orient: p(0, 0, 1, 1, 'Orientation', { options: { 'Horizontal (left to right)': 0, 'Vertical (top to bottom)': 1 } }),
      openH: p(9.5, 0, 24, 0.25, 'Market opens (hour ET)'),
      closeH: p(16, 0, 24, 0.25, 'Market closes (hour ET)'),
      hatch: p(44, 12, 100, 1, 'Hatch gap'),
      lanes: p(2, 0, 6, 1, 'Market lanes'),
      spread: p(0.6, 0.2, 1, 0.01, 'Lane spread'),
      double: p(1, 0, 1, 1, 'USDM1 line', { options: { Single: 0, Double: 1 } }),
      mark: p(30, 12, 56, 1, 'USDM1 marker size'),
      speed: p(1, 0, 4, 0.05, 'Speed'),
      lean: p(1, 0, 3, 0.05, 'Cursor glow'),
    },
    init(c, P, rnd) { return seeds(rnd); },
    draw(c, pen, st, P) {
      const { u, t, I, W, H } = c, [X, Y] = art(c), mo = wake(t) * (0.3 + I);
      // Work in (along, across), as in the full 24/7: along is the direction time runs.
      const hz = !P.orient;
      const PX = (a, b) => X(hz ? a : b), PY = (a, b) => Y(hz ? b : a);
      const S = (a1, b1, a2, b2, al1, al2 = al1) => pen.seg(PX(a1, b1), PY(a1, b1), 0, al1, PX(a2, b2), PY(a2, b2), 0, al2);
      const half = (hz ? W : H) / 2 / u, ha = half + 30, hb = (hz ? H : W) / 2 / u + 40;
      const hx = (h) => -half + clamp(h, 0, 24) / 24 * 2 * half;
      const xo = hx(Math.min(P.openH, P.closeH)), xc = hx(Math.max(P.openH, P.closeH));
      const ca = hz ? (c.mx - c.ax) / u : (c.ay - c.my) / u, glow = P.lean * c.md * c.mouseAmt * (0.4 + I);
      let id = 0;
      // The two closed stretches: wide, light hatching with no edge rules of their own past the frame.
      const bandA = 0.7 * c.introAt(0), slide = (t * 4 * P.speed) % P.hatch;
      for (const [a, b] of [[-ha - 60, xo], [xc, ha + 60]]) {
        const k = 1 + 1.4 * glow * gauss((ca - clamp(ca, a, b)) / 40);
        pen.el(id++);
        S(a, -hb, a, hb, 0.35 * bandA * k); S(b, -hb, b, hb, 0.35 * bandA * k);
        pen.el(id++);
        for (let x = -hb - (b - a) + slide; x < hb; x += P.hatch) S(b, x, a, x + (b - a), 0.28 * bandA * k);
      }
      // Market lanes exist only in open hours, evenly on both sides of USDM1.
      const nl = Math.round(P.lanes), sp = P.spread * 2 * (hb - 40) / (nl + 1), left = Math.floor(nl / 2), lanes = [];
      for (let k = 0; k < nl; k++) lanes.push(k < left ? -(k + 1) * sp : (k - left + 1) * sp);
      const laneA = c.introAt(0.2);
      lanes.forEach((x, i) => { pen.el(id++); S(xo, x, xc, x, (0.45 + 0.15 * sd(st, i)) * laneA); });
      const ua = c.introAt(0.4);
      pen.el(id++);
      for (const dx of P.double ? [-2.5, 2.5] : [0]) S(-ha, dx, ha, dx, ua);
      // One clock drives every marker. "now" runs from just off the left edge to just off the right, so the USDM1 marker
      // never pops at midnight. Markers have fixed ids and are never "every other" shapes, so their stroke fill can't flip.
      const R = P.mark, span = 2 * half + 2 * R, v = 60 * P.speed, dayT = v > 0 ? span / v : 1;
      const d = v > 0 ? frac(t / dayT + 0.42) : 0.55, now = -half - R + d * span;
      const base = id, mark = (slot, a0, b0, r, a) => {
        pen.el(base + slot, false);
        pen.disc(PX(a0, b0), PY(a0, b0), 0, r * u); ring(pen, PX(a0, b0), PY(a0, b0), 2 * r * u, 0, () => a);
      };
      // USDM1: a ring holding the brand burst, always upright. Left out of the poster (the line stays): the marker is
      // the one part that ghosts when the live canvas fades in over the still.
      const a = ua * (1 + 0.4 * mo), sb = 0.72 * R / 15, bx = hz ? now : 0, by = hz ? 0 : now;
      if (!c.poster) mark(0, now, 0, R, a);
      if (!c.poster) for (const [deg, r0, r1] of BURST) {
        const th = deg * Math.PI / 180, ux = Math.cos(th), uy = Math.sin(th);
        pen.seg(X(bx + ux * r0 * sb), Y(by + uy * r0 * sb), 0, a, X(bx + ux * r1 * sb), Y(by + uy * r1 * sb), 0, a);
      }
      // Market markers move with the clock while open and stop just short of the close. Near midnight they shrink away at
      // the close while new ones grow at the open, ready for tomorrow.
      const r = 9, pad = r + 8, la = laneA * 0.8, sw = sstep(0.93, 0.995, d);
      const at = clamp(now, xo + pad, xc - pad);
      lanes.forEach((x, i) => {
        if (sw < 0.999) mark(1 + i * 2, at, x, r * (1 - sw), la);
        if (sw > 0.001) mark(2 + i * 2, xo + pad, x, r * sw, la);
      });
    },
  },
});

// Institution and role heroes are a single 2:3 image used at every breakpoint, so they always draw with the tall layout.
for (const C of Object.values(CONCEPTS)) if (C.group === 'Institutions' || C.group === 'Roles') C.only = 'tall';

// Variants: a concept with base shares that concept's drawing and controls, with its own defaults.
for (const [id, C] of Object.entries(CONCEPTS)) {
  if (!C.base) continue;
  const B = CONCEPTS[C.base];
  C.init = B.init; C.draw = B.draw;
  C.params = Object.fromEntries(Object.entries(B.params).map(([k, m]) => [k, C.defaults && k in C.defaults ? { ...m, v: C.defaults[k] } : m]));
}

// ---------- Config ----------
const FILL = { solid: 0, gradient: 1, alternate: 2 };
export const DEFAULTS = {
  v: 1,
  concept: 'orbit',
  seed: 7,
  look: {
    bg: '#121316', stroke: '#d5e3f6', opacity: 1, back: '#8dadd3', backOpacity: 0.5,
    // width: stroke width, 1 to 3. 1 = hairline (1 device pixel, the original look). Each step above 1 adds
    // that many px at a 900px-tall frame, scaling with the hero.
    width: 1,
    // Stroke fill: 'solid', 'gradient' (each shape fades to clear across itself, like a Figma linear gradient stroke)
    // or 'alternate' (every other shape). gradAngle: the direction it fades toward, 0 = right, 90 = up.
    // gradReach: how far across the shape it reaches clear (1 = at the far edge).
    fill: 'solid', gradAngle: 166, gradReach: 1,
    offsetX: -2, offsetY: 0, fade: 0, fadeAngle: 0, fadeFrom: 0, fadeTo: 0.7,
    vignette: 0, accent: '#ffffff', spot: 0.35, blend: 'normal',
    // Legibility band (Figma "gradient" layer): bg color fading in and out across a diagonal, over the art.
    band: 0.8, bandAngle: 60, bandWidth: 2.2, bandX: 0.5, bandY: 0.5,
  },
  motion: { intensity: 0.35, speed: 1, intro: false },
  interact: { mouse: 0.5, glow: 0.6, glowRadius: 0.22, touch: true, scrollSweep: 0.7 },
  camera: { fov: 30, tilt: 0, orbit: 0 },
  // Texture layers shared by every concept: hairline grid and film grain.
  grid: { on: false, strength: 0.35, step: 32, depth: 160, fx: 0.5, fy: 0.5, focus: 1, grainOn: true, grain: 0.03 },
  render: { dpr: 2 },
  poster: '',
  // Optional portrait overrides, used whenever the container is taller than wide (mobile, hero split).
  // null = portrait uses the same settings as full bleed.
  portrait: null,
};
export const PORTRAIT_SECTIONS = ['params', 'look', 'motion', 'interact', 'camera', 'grid'];

const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
// Deep: nested objects from a are copied too, so a merged config never shares objects with DEFAULTS
// (editing one would otherwise edit the defaults).
function merge(a, b) {
  const out = Array.isArray(a) ? a.slice() : { ...a };
  for (const k of Object.keys(out)) if (isObj(out[k])) out[k] = merge(out[k]);
  if (!isObj(b)) return out;
  for (const k of Object.keys(b)) out[k] = isObj(a?.[k]) && isObj(b[k]) ? merge(a[k], b[k]) : b[k];
  return out;
}
export function conceptDefaults(id) {
  const C = CONCEPTS[id] || CONCEPTS.orbit;
  const params = {};
  for (const [k, m] of Object.entries(C.params)) params[k] = m.v;
  return { params, layout: JSON.parse(JSON.stringify(C.layout)) };
}
export function normalize(cfg = {}) {
  const concept = CONCEPTS[cfg.concept] ? cfg.concept : DEFAULTS.concept;
  const d = conceptDefaults(concept);
  const out = merge(DEFAULTS, cfg);
  out.concept = concept;
  out.params = merge(d.params, cfg.params || {});
  out.layout = merge(d.layout, cfg.layout || {});
  // The grid used to belong to Depth Tunnel only; carry old tunnel settings over to the shared grid.
  if (!isObj(cfg.grid) && concept === 'tunnel') {
    const g = cfg.params && cfg.params.grid != null ? +cfg.params.grid : 0.35;
    out.grid = merge(out.grid, { on: g > 0.001, strength: g || 0.35, step: (cfg.params && cfg.params.gridStep) || 40 });
  }
  delete out.params.grid; delete out.params.gridStep;
  // Grain used to live under look; it now sits with the grid.
  const oldGrain = (c) => (isObj(c) && isObj(c.look) && c.look.grain != null && !(isObj(c.grid) && c.grid.grain != null) ? +c.look.grain : null);
  if (oldGrain(cfg) != null) out.grid.grain = oldGrain(cfg);
  delete out.look.grain;
  out.portrait = isObj(cfg.portrait)
    ? Object.fromEntries(PORTRAIT_SECTIONS.map((k) => [k, merge(out[k], cfg.portrait[k] || {})]))
    : null;
  if (out.portrait) {
    delete out.portrait.params.grid; delete out.portrait.params.gridStep; delete out.portrait.look.grain;
    if (oldGrain(cfg.portrait) != null) out.portrait.grid.grain = oldGrain(cfg.portrait);
  }
  // Stroke width runs 1 (hairline) to 3; early drafts used 0 for the hairline.
  for (const c of [out, out.portrait]) if (c) c.look.width = Math.min(3, Math.max(1, +c.look.width || 1));
  // The vignette is retired: always off, even for configs saved with one.
  for (const c of [out, out.portrait]) if (c) c.look.vignette = 0;
  // Roles and Institutions (tall-only art beside the copy) never use the legibility band, even in older saved configs.
  if (CONCEPTS[concept].only === 'tall') for (const c of [out, out.portrait]) if (c) c.look.band = 0;
  return out;
}
// Effective settings for one orientation.
export function resolve(cfg, tall) {
  if (!tall || !isObj(cfg.portrait)) return cfg;
  const out = { ...cfg };
  for (const k of PORTRAIT_SECTIONS) if (isObj(cfg.portrait[k])) out[k] = merge(cfg[k], cfg.portrait[k]);
  return out;
}

// ---------- Shaders ----------
const COMMON = /* glsl */`
uniform vec2 uRes; uniform vec2 uMouse; uniform float uGlow, uGlowR, uFade, uFadeFrom, uFadeTo, uVig, uIntro;
uniform vec2 uFadeDir; uniform vec3 uColor, uAccent; uniform float uOpacity;
vec4 shade(float a){
  vec2 uv = gl_FragCoord.xy / uRes;
  float s = dot(uv - 0.5, uFadeDir) + 0.5;
  float m = mix(1.0, smoothstep(uFadeFrom, uFadeTo, s), uFade);
  vec2 dv = (gl_FragCoord.xy - uMouse) / uRes.y;
  float g = uGlow * exp(-dot(dv, dv) / (uGlowR * uGlowR));
  float v = 1.0 - uVig * smoothstep(0.35, 0.95, length((uv - 0.5) * vec2(uRes.x / uRes.y, 1.0)) / max(1.0, uRes.x / uRes.y) * 1.4);
  float al = a * uOpacity * m * v * (1.0 + g * 2.2) * uIntro;
  return vec4(mix(uColor, uAccent, clamp(g * 0.8, 0.0, 1.0)), clamp(al, 0.0, 1.0));
}`;
// Stacking: depth comes from a shape's layer, not its position, so a fill (painted in the background) hides the
// lines of every shape below it. A shape's own lines sit just in front of its fill. Layer -1 sits behind all fills.
const DEP = /* glsl */`float dep(float k){ return k < 0.0 ? 0.99 : 0.9 - min(k, 3.5e5) * 2.5e-6; }`;
const LINE_VS = DEP + /* glsl */`
attribute float aA; attribute float aK; varying float vA; uniform vec2 uOffset; uniform vec2 uRes;
void main(){ vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); p.xy += uOffset * 2.0 / uRes * p.w; p.z = (dep(aK) - 1e-6) * p.w; gl_Position = p; vA = aA; }`;
const FILL_VS = DEP + /* glsl */`
attribute float aK;
void main(){ vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); p.z = dep(aK) * p.w; gl_Position = p; }`;
// Wider strokes: each segment is a quad expanded in screen space. position.x picks the end (0 start, 1 end),
// position.y the side. Below 1 device pixel the quad stays 1px wide and fades instead, so thin widths stay smooth.
const QLINE_VS = DEP + /* glsl */`
attribute vec3 iA; attribute vec3 iB; attribute vec3 iP; attribute vec3 iN; attribute float iAA; attribute float iAB; attribute float iK;
uniform vec2 uOffset; uniform vec2 uRes; uniform float uWidth; varying float vA;
vec2 scr(vec3 q){ vec4 c = projectionMatrix * modelViewMatrix * vec4(q, 1.0); return c.xy / c.w * uRes * 0.5; }
vec2 nrm(vec2 d){ float l = length(d); return l > 1e-4 ? vec2(-d.y, d.x) / l : vec2(0.0); }
void main(){
  bool st = position.x < 0.5;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(st ? iA : iB, 1.0);
  vec2 sa = scr(iA), sb = scr(iB);
  vec2 n = nrm(sb - sa); if (dot(n, n) < 0.5) n = vec2(0.0, 1.0);
  vec2 n2 = nrm(st ? sa - scr(iP) : scr(iN) - sb); // the neighboring segment, in drawing order
  float hw = 0.5 * max(uWidth, 1.0);
  vec2 off = n * position.y * hw;
  if (dot(n2, n2) > 0.5) { // joined: miter so neighbors meet exactly, with no gap or overlap (limit 4x, else butt)
    vec2 m = normalize(n + n2); float k = dot(m, n);
    if (k > 0.25) off = m * position.y * hw / k;
  }
  p.xy += (off + uOffset) * 2.0 / uRes * p.w;
  p.z = (dep(iK) - 1e-6) * p.w;
  gl_Position = p;
  vA = (st ? iAA : iAB) * min(uWidth, 1.0);
}`;
const LINE_FS = COMMON + `varying float vA; void main(){ gl_FragColor = shade(vA); }`;
const PT_VS = /* glsl */`
attribute float aA; attribute float aS; varying float vA; varying float vSoft; uniform float uDpr;
void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = abs(aS) * uDpr; vA = aA; vSoft = aS < 0.0 ? 1.0 : 0.0; }`;
const PT_FS = COMMON + `varying float vA; varying float vSoft;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; float d = vSoft > 0.5 ? exp(-r * r * 4.0) * (1.0 - smoothstep(0.9, 1.0, r)) : 1.0 - smoothstep(0.6, 1.0, r); gl_FragColor = shade(vA * d); }`;
const BG_VS = `void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`;
// Legibility band: transparent -> bg -> transparent across the band, like the Figma gradient layer.
const BAND_FS = /* glsl */`
uniform vec2 uRes, uC, uN; uniform vec3 uBg; uniform float uAmt, uW;
float hash(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main(){
  vec2 p = (gl_FragCoord.xy - uC * uRes) / uRes.y;
  float d = abs(dot(p, uN)) / max(uW * 0.5, 1e-3);
  float a = uAmt * clamp(1.0 - d, 0.0, 1.0);
  a += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(uBg, clamp(a, 0.0, 1.0));
}`;
const BG_FS = /* glsl */`
uniform vec3 uBg, uAccent; uniform vec2 uRes, uMouse; uniform float uSpot, uGrain, uTime, uVig;
float hash(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes; vec3 c = uBg;
  vec2 dv = (gl_FragCoord.xy - uMouse) / uRes.y;
  c += uAccent * uSpot * 0.05 * exp(-dot(dv, dv) / 0.12);
  c *= 1.0 - uVig * 0.35 * smoothstep(0.3, 0.95, length(uv - 0.5) * 1.3);
  float fr = mod(floor(uTime * 24.0), 509.0);
  float n = hash(vec3(gl_FragCoord.xy, fr)) - 0.5;
  float n2 = hash(vec3(gl_FragCoord.yx + 17.0, fr + 3.0)) - 0.5;
  c += n * uGrain + (n + n2) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`;

function lineMat(blend, vs = LINE_VS) {
  return new THREE.ShaderMaterial({
    vertexShader: vs, fragmentShader: LINE_FS, transparent: true, depthTest: true, depthWrite: false,
    blending: blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      uRes: { value: new THREE.Vector2() }, uMouse: { value: new THREE.Vector2(-1e4, -1e4) }, uOffset: { value: new THREE.Vector2() },
      uGlow: { value: 0 }, uGlowR: { value: 0.2 }, uFade: { value: 0 }, uFadeFrom: { value: 0 }, uFadeTo: { value: 1 }, uFadeDir: { value: new THREE.Vector2(1, 0) },
      uVig: { value: 0 }, uIntro: { value: 1 }, uColor: { value: new THREE.Color() }, uAccent: { value: new THREE.Color() }, uOpacity: { value: 1 },
      uWidth: { value: 1 },
    },
  });
}

// ---------- Engine ----------
export function createHero(el, config = {}, options = {}) {
  const opt = Object.assign({ reducedMotion: 'auto', observe: true, interactive: true }, options);
  let base = normalize(config), isTall = false;
  let cfg = resolve(base, isTall);
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.style.backgroundColor = cfg.look.bg;

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    if (cfg.poster) { el.style.backgroundImage = `url("${cfg.poster}")`; el.style.backgroundSize = 'cover'; el.style.backgroundPosition = 'center'; }
    return { fallback: true, setConfig() {}, destroy() {}, snapshot: async () => null, resize() {}, replay() {}, getConfig: () => cfg, canvas: null };
  }
  el.appendChild(canvas);
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0); // the background pass paints every pixel opaque; transparent stills skip it
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  const scene = new THREE.Scene(), root = new THREE.Group(); scene.add(root);
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 10000);
  const bgScene = new THREE.Scene(), bgCam = new THREE.Camera();
  const bgMat = new THREE.ShaderMaterial({
    vertexShader: BG_VS, fragmentShader: BG_FS, depthTest: false, depthWrite: false,
    uniforms: { uBg: { value: new THREE.Color() }, uAccent: { value: new THREE.Color() }, uRes: { value: new THREE.Vector2() }, uMouse: { value: new THREE.Vector2() }, uSpot: { value: 0 }, uGrain: { value: 0 }, uTime: { value: 0 }, uVig: { value: 0 } },
  });
  const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat); bgMesh.frustumCulled = false; bgScene.add(bgMesh);
  const bandScene = new THREE.Scene();
  const bandMat = new THREE.ShaderMaterial({
    vertexShader: BG_VS, fragmentShader: BAND_FS, transparent: true, depthTest: false, depthWrite: false,
    uniforms: { uRes: { value: new THREE.Vector2() }, uC: { value: new THREE.Vector2(0.5, 0.5) }, uN: { value: new THREE.Vector2(1, 0) }, uBg: { value: new THREE.Color() }, uAmt: { value: 0 }, uW: { value: 1 } },
  });
  const bandMesh = new THREE.Mesh(bgMesh.geometry, bandMat); bandMesh.frustumCulled = false; bandScene.add(bandMesh);

  const pen = new Pen();
  const lGeo = new THREE.BufferGeometry(), pGeo = new THREE.BufferGeometry();
  const bindL = () => {
    lGeo.setAttribute('position', new THREE.BufferAttribute(pen.L.pos, 3).setUsage(THREE.DynamicDrawUsage));
    lGeo.setAttribute('aA', new THREE.BufferAttribute(pen.L.a, 1).setUsage(THREE.DynamicDrawUsage));
    lGeo.setAttribute('aK', new THREE.BufferAttribute(pen.L.k, 1).setUsage(THREE.DynamicDrawUsage));
  };
  const fGeo = new THREE.BufferGeometry();
  const bindF = () => {
    fGeo.setAttribute('position', new THREE.BufferAttribute(pen.F.pos, 3).setUsage(THREE.DynamicDrawUsage));
    fGeo.setAttribute('aK', new THREE.BufferAttribute(pen.F.k, 1).setUsage(THREE.DynamicDrawUsage));
  };
  const bindP = () => {
    pGeo.setAttribute('position', new THREE.BufferAttribute(pen.P.pos, 3).setUsage(THREE.DynamicDrawUsage));
    pGeo.setAttribute('aA', new THREE.BufferAttribute(pen.P.a, 1).setUsage(THREE.DynamicDrawUsage));
    pGeo.setAttribute('aS', new THREE.BufferAttribute(pen.P.s, 1).setUsage(THREE.DynamicDrawUsage));
  };
  bindL(); bindP(); bindF();
  let backMat = lineMat(cfg.look.blend), frontMat = lineMat(cfg.look.blend);
  const back = new THREE.LineSegments(lGeo, backMat), front = new THREE.LineSegments(lGeo, frontMat);
  const ptMat = new THREE.ShaderMaterial({ vertexShader: PT_VS, fragmentShader: PT_FS, transparent: true, depthTest: false, depthWrite: false, uniforms: { ...THREE.UniformsUtils.clone(frontMat.uniforms), uDpr: { value: 1 } } });
  const points = new THREE.Points(pGeo, ptMat);
  // Stroke width above a hairline: the same segments drawn as instanced quads (WebGL lines are always 1 device pixel).
  const qGeo = new THREE.InstancedBufferGeometry();
  qGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0], 3));
  qGeo.setIndex([0, 2, 1, 1, 2, 3]);
  let qPos = null, qA = null, qN = null, qK = null;
  const bindQ = () => {
    qPos = new THREE.InstancedInterleavedBuffer(pen.L.pos, 6).setUsage(THREE.DynamicDrawUsage);
    qA = new THREE.InstancedInterleavedBuffer(pen.L.a, 2).setUsage(THREE.DynamicDrawUsage);
    qGeo.setAttribute('iA', new THREE.InterleavedBufferAttribute(qPos, 3, 0));
    qGeo.setAttribute('iB', new THREE.InterleavedBufferAttribute(qPos, 3, 3));
    qGeo.setAttribute('iAA', new THREE.InterleavedBufferAttribute(qA, 1, 0));
    qGeo.setAttribute('iAB', new THREE.InterleavedBufferAttribute(qA, 1, 1));
    qK = new THREE.InstancedInterleavedBuffer(pen.L.k, 2).setUsage(THREE.DynamicDrawUsage);
    qGeo.setAttribute('iK', new THREE.InterleavedBufferAttribute(qK, 1, 0));
    qN = new THREE.InstancedInterleavedBuffer(pen.L.nb, 6).setUsage(THREE.DynamicDrawUsage);
    qGeo.setAttribute('iP', new THREE.InterleavedBufferAttribute(qN, 3, 0));
    qGeo.setAttribute('iN', new THREE.InterleavedBufferAttribute(qN, 3, 3));
  };
  bindQ();
  const qBackMat = lineMat(cfg.look.blend, QLINE_VS), qFrontMat = lineMat(cfg.look.blend, QLINE_VS);
  const qBack = new THREE.Mesh(qGeo, qBackMat), qFront = new THREE.Mesh(qGeo, qFrontMat);
  const allMats = [backMat, frontMat, qBackMat, qFrontMat, ptMat];
  // Fills paint the background itself (same shader and uniforms), so grain, glow and vignette line up exactly.
  const fillMat = new THREE.ShaderMaterial({ vertexShader: FILL_VS, fragmentShader: BG_FS, uniforms: bgMat.uniforms, depthTest: true, depthWrite: true });
  const fills = new THREE.Mesh(fGeo, fillMat);
  [[fills, -1], [back, 0], [qBack, 0], [front, 1], [qFront, 1], [points, 2]].forEach(([o, i]) => { o.frustumCulled = false; o.renderOrder = i; root.add(o); });
  const thick = () => (cfg.look.width || 1) > 1;

  let W = 1, H = 1, dpr = 1, state = null, concept = null, settled = false, artN = 0;
  let t = 0, last = performance.now(), born = last, running = false, raf = 0, visible = true, destroyed = false;
  const mouse = { tx: 0, ty: 0, x: 0, y: 0, tin: 0, in: 0 };
  const reduceMQ = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let poster = false; // true only while snapshot() renders, so a concept can leave out parts that don't hand off well
  const reduced = () => opt.reducedMotion === 'force' || (opt.reducedMotion === 'auto' && reduceMQ && reduceMQ.matches);

  function rebuild() {
    concept = CONCEPTS[cfg.concept];
    state = concept.init({}, cfg.params, makeRng(cfg.seed * 9973 + 17));
  }
  function applyLook() {
    const L = cfg.look;
    el.style.backgroundColor = L.bg;
    const blend = L.blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending;
    for (const m of allMats) m.blending = blend;
    bgMat.uniforms.uBg.value.set(L.bg); bgMat.uniforms.uAccent.value.set(L.accent);
    bgMat.uniforms.uSpot.value = L.spot; bgMat.uniforms.uGrain.value = cfg.grid.grainOn ? cfg.grid.grain : 0; bgMat.uniforms.uVig.value = L.vignette;
    const ang = L.fadeAngle * Math.PI / 180;
    for (const m of allMats) {
      const U = m.uniforms;
      U.uFade.value = L.fade; U.uFadeFrom.value = L.fadeFrom; U.uFadeTo.value = Math.max(L.fadeTo, L.fadeFrom + 0.001);
      U.uFadeDir.value.set(Math.cos(ang), Math.sin(ang)); U.uVig.value = L.vignette; U.uAccent.value.set(L.accent);
      U.uGlowR.value = cfg.interact.glowRadius;
    }
    for (const m of [backMat, qBackMat]) { m.uniforms.uColor.value.set(L.back); m.uniforms.uOpacity.value = L.backOpacity; }
    for (const m of [frontMat, qFrontMat]) { m.uniforms.uColor.value.set(L.stroke); m.uniforms.uOpacity.value = L.opacity; }
    ptMat.uniforms.uColor.value.set(L.stroke); ptMat.uniforms.uOpacity.value = Math.min(1, L.opacity * 2.2);
    const wide = thick();
    // The back stroke only draws with a solid fill; gradient shapes read as one clean line.
    const backOn = L.backOpacity > 0.001 && (!L.fill || L.fill === 'solid');
    back.visible = !wide && backOn; qBack.visible = wide && backOn;
    front.visible = !wide; qFront.visible = wide;
    const B = bandMat.uniforms, ba = (L.bandAngle || 0) * Math.PI / 180;
    B.uBg.value.set(L.bg); B.uAmt.value = L.band || 0; B.uW.value = L.bandWidth;
    B.uC.value.set(L.bandX, 1 - L.bandY); B.uN.value.set(-Math.sin(ba), Math.cos(ba));
  }
  function setSize(w, h, pr) {
    W = Math.max(1, w); H = Math.max(1, h); dpr = pr;
    renderer.setPixelRatio(dpr); renderer.setSize(W, H, false);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    if ((W / H < 1) !== isTall) { isTall = W / H < 1; useEffective(); }
  }
  // Swap to the settings for the current orientation; rebuild geometry only if params differ.
  function useEffective() {
    const prev = cfg;
    cfg = resolve(base, isTall);
    if (!state || prev.concept !== cfg.concept || prev.seed !== cfg.seed || JSON.stringify(prev.params) !== JSON.stringify(cfg.params)) rebuild();
    applyLook();
  }
  function resize() {
    const r = el.getBoundingClientRect();
    setSize(Math.round(r.width), Math.round(r.height), Math.min(cfg.render.dpr, window.devicePixelRatio || 1));
    if (!running) renderFrame();
  }

  // Transparent stills: skip the background pass, keep alpha correct for additive strokes,
  // and let the legibility band erase the lines instead of painting slate over them.
  let clearBg = false;
  function see(on) {
    clearBg = on;
    for (const m of allMats) {
      if (on && cfg.look.blend === 'add') {
        m.blending = THREE.CustomBlending;
        m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneFactor;
        m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneFactor;
      }
      m.needsUpdate = true;
    }
    if (on) {
      bandMat.blending = THREE.CustomBlending;
      bandMat.blendSrc = THREE.ZeroFactor; bandMat.blendDst = THREE.OneMinusSrcAlphaFactor;
      bandMat.blendSrcAlpha = THREE.ZeroFactor; bandMat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    } else {
      bandMat.blending = THREE.NormalBlending;
      applyLook();
    }
    bandMat.needsUpdate = true;
  }
  function renderFrame() {
    const I = cfg.motion.intensity;
    const elapsed = settled || reduced() || !cfg.motion.intro ? 99 : (performance.now() - born) / 1000;
    const introAt = (d) => ease((elapsed - d) / 2.2);
    const fov = cfg.camera.fov;
    const D = (H / 2) / Math.tan((fov * Math.PI / 180) / 2);
    camera.fov = fov; camera.near = Math.max(1, D * 0.02); camera.far = D * 6;
    camera.position.set(0, 0, D); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
    const mouseAmt = opt.interactive ? cfg.interact.mouse : 0;
    const md = mouse.in;
    const mnx = clamp(mouse.x / (W / 2), -1, 1), mny = clamp(mouse.y / (H / 2), -1, 1);
    const tilt = mouseAmt * (0.03 + 0.2 * I);
    root.rotation.x = cfg.camera.tilt * Math.PI / 180 - mny * md * tilt;
    root.rotation.y = cfg.camera.orbit * Math.PI / 180 + mnx * md * tilt;
    const lay = W / H < 1 || concept.only === 'tall' ? cfg.layout.tall : cfg.layout.wide;
    const ctx = {
      W, H, D, t, I, u: (H / 900) * lay.s, ax: (lay.x - 0.5) * W, ay: (0.5 - lay.y) * H,
      mx: mouse.x, my: mouse.y, md, mn: { x: mnx, y: mny }, mouseAmt, introAt, poster,
      dpr, lw: 1 + Math.max(0, (cfg.look.width || 1) - 1) * (H / 900) * dpr, // device px per line, as the stroke shader draws it
    };
    pen.reset();
    concept.draw(ctx, pen, state, cfg.params);
    artN = pen.L.n;
    pen.el(-1);
    pen.shade(FILL[cfg.look.fill] || 0, (cfg.look.gradAngle || 0) * Math.PI / 180, cfg.look.gradReach ?? 1);
    if (cfg.grid.on) drawGrid(ctx, pen, cfg.grid);
    const wide = thick();
    if (pen.grewL) { bindL(); bindQ(); pen.grewL = false; }
    else if (wide) { qPos.needsUpdate = true; qA.needsUpdate = true; qN.needsUpdate = true; qK.needsUpdate = true; }
    else { lGeo.attributes.position.needsUpdate = true; lGeo.attributes.aA.needsUpdate = true; lGeo.attributes.aK.needsUpdate = true; }
    if (pen.grewF) { bindF(); pen.grewF = false; } else if (pen.F.n) { fGeo.attributes.position.needsUpdate = true; fGeo.attributes.aK.needsUpdate = true; }
    fGeo.setDrawRange(0, pen.F.n); fills.visible = pen.F.n > 0;
    fillMat.colorWrite = !clearBg; // transparent stills: fills still hide what is behind them, but leave the pixels clear
    qGeo.instanceCount = pen.L.n / 2;
    if (pen.grewP) { bindP(); pen.grewP = false; } else { pGeo.attributes.position.needsUpdate = true; pGeo.attributes.aA.needsUpdate = true; pGeo.attributes.aS.needsUpdate = true; }
    lGeo.setDrawRange(0, pen.L.n); pGeo.setDrawRange(0, pen.P.n);

    const bw = W * dpr, bh = H * dpr;
    const mxp = (mouse.x + W / 2) * dpr, myp = (mouse.y + H / 2) * dpr;
    const glow = cfg.interact.glow * md * (0.5 + I) * (opt.interactive ? 1 : 0);
    const introA = ease(elapsed / 1.2);
    for (const m of allMats) {
      const U = m.uniforms;
      U.uRes.value.set(bw, bh); U.uMouse.value.set(mxp, myp); U.uGlow.value = glow; U.uIntro.value = introA;
    }
    for (const m of [backMat, qBackMat]) m.uniforms.uOffset.value.set(cfg.look.offsetX * dpr, cfg.look.offsetY * dpr);
    qBackMat.uniforms.uWidth.value = qFrontMat.uniforms.uWidth.value = 1 + Math.max(0, (cfg.look.width || 1) - 1) * (H / 900) * dpr;
    ptMat.uniforms.uDpr.value = dpr;
    bgMat.uniforms.uRes.value.set(bw, bh); bgMat.uniforms.uMouse.value.set(mxp, myp); bgMat.uniforms.uTime.value = t;
    bgMat.uniforms.uSpot.value = cfg.look.spot * md * (opt.interactive ? 1 : 0);
    renderer.clear();
    if (!clearBg) renderer.render(bgScene, bgCam);
    renderer.render(scene, camera);
    if (cfg.look.band > 0.001) { bandMat.uniforms.uRes.value.set(bw, bh); renderer.render(bandScene, bgCam); }
  }

  function tick(now) {
    if (destroyed) return;
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!reduced()) t += dt * cfg.motion.speed;
    const k = 1 - Math.exp(-dt * 3.5);
    mouse.x += (mouse.tx - mouse.x) * k; mouse.y += (mouse.ty - mouse.y) * k; mouse.in += (mouse.tin - mouse.in) * (1 - Math.exp(-dt * 2.5));
    renderFrame();
  }
  function start() { if (running || destroyed) return; running = true; last = performance.now(); raf = requestAnimationFrame(tick); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  function sync() { (visible && !reduced()) ? start() : (stop(), renderFrame()); }

  function onPointer(e) {
    if (!opt.interactive) return;
    if (e.pointerType === 'touch' && !cfg.interact.touch) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const inside = x >= 0 && y >= 0 && x <= r.width && y <= r.height;
    mouse.tin = inside ? 1 : 0;
    if (inside) { mouse.tx = x - r.width / 2; mouse.ty = r.height / 2 - y; }
    if (!running) renderFrame();
  }
  function onLeave() { mouse.tin = 0; }
  // Touch screens have no hover, so scrolling stands in for it: a virtual cursor sweeps down the
  // middle of the art as the page scrolls (back up when scrolling up) and fades out once scrolling stops.
  const touchMQ = window.matchMedia ? matchMedia('(hover: none) and (pointer: coarse)') : null;
  let sweepIdle = 0;
  function onScroll() {
    const amt = cfg.interact.scrollSweep || 0;
    if (!opt.interactive || !amt || !touchMQ || !touchMQ.matches || !running) return;
    const r = el.getBoundingClientRect(), vh = innerHeight;
    if (r.bottom < 0 || r.top > vh) return;
    const from = Math.min(vh, Math.max(0, r.top + scrollY)); // sweep starts where the art sits at load, or as it enters
    const f = clamp((from - r.top) / (from + 0.6 * r.height), 0, 1);
    mouse.tx = 0; mouse.ty = r.height / 2 - f * r.height; mouse.tin = amt;
    if (mouse.in < 0.05) { mouse.x = mouse.tx; mouse.y = mouse.ty; } // faded out: start at the scroll position, not where the last sweep ended
    clearTimeout(sweepIdle); sweepIdle = setTimeout(() => { mouse.tin = 0; }, 700);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('pointermove', onPointer, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  reduceMQ && reduceMQ.addEventListener && reduceMQ.addEventListener('change', sync);
  const ro = new ResizeObserver(() => resize()); ro.observe(el);
  let io = null;
  if (opt.observe && 'IntersectionObserver' in window) {
    io = new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; sync(); }, { rootMargin: '100px' });
    io.observe(el);
  }

  rebuild(); applyLook(); resize(); sync();

  return {
    canvas,
    get config() { return base; },
    getConfig: () => JSON.parse(JSON.stringify(base)),
    setConfig(next, { replay = false } = {}) {
      const prevConcept = cfg.concept, prevDpr = cfg.render.dpr;
      base = normalize(next);
      useEffective();
      if (replay || prevConcept !== cfg.concept) born = performance.now();
      const prev = { render: { dpr: prevDpr } };
      if (prev.render.dpr !== cfg.render.dpr) resize();
      sync();
      if (!running) renderFrame();
    },
    replay() { born = performance.now(); if (!running) renderFrame(); },
    // Screen bounds of the visible strokes as fractions of the frame (0..1, y down), with the intro finished and the cursor ignored.
    measure() {
      const keep = { tin: mouse.tin, in: mouse.in };
      mouse.tin = mouse.in = 0; settled = true;
      renderFrame();
      settled = false; mouse.tin = keep.tin; mouse.in = keep.in;
      root.updateMatrixWorld(); camera.updateMatrixWorld();
      const v = new THREE.Vector3();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, amax = 0;
      const sets = [pen.L, pen.P];
      const count = (S) => (S === pen.L ? artN : S.n); // grid lines don't count toward the design's bounds
      for (const S of sets) for (let i = 0; i < count(S); i++) amax = Math.max(amax, S.a[i]);
      const th = amax * 0.15;
      for (const S of sets) for (let i = 0; i < count(S); i++) {
        if (S.a[i] < th) continue;
        v.set(S.pos[i * 3], S.pos[i * 3 + 1], S.pos[i * 3 + 2]).applyMatrix4(root.matrixWorld).project(camera);
        const x = (v.x + 1) / 2, y = (1 - v.y) / 2;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (!isFinite(x0)) return null;
      return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    },
    setPaused(b) { if (b) { visible = false; } else { visible = true; } sync(); },
    resize,
    // clean: true leaves out the grid and grain for this still only.
    // transparent: true leaves out the background color, so only the lines remain on a transparent PNG.
    async snapshot({ width, height, scale = 1, clean = false, transparent = false } = {}) {
      const prev = [W, H, dpr];
      setSize(width || W, height || H, scale);
      const G = cfg.grid, keep = [G.on, G.grainOn];
      if (clean) { G.on = false; G.grainOn = false; applyLook(); }
      if (transparent) see(true);
      poster = true; renderFrame(); poster = false;
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      if (transparent) see(false);
      if (clean) { [G.on, G.grainOn] = keep; applyLook(); }
      setSize(...prev); renderFrame();
      return blob;
    },
    destroy() {
      destroyed = true; stop();
      window.removeEventListener('pointermove', onPointer); window.removeEventListener('scroll', onScroll); clearTimeout(sweepIdle);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      reduceMQ && reduceMQ.removeEventListener && reduceMQ.removeEventListener('change', sync);
      ro.disconnect(); io && io.disconnect();
      lGeo.dispose(); pGeo.dispose(); qGeo.dispose(); fGeo.dispose(); fillMat.dispose(); allMats.forEach((m) => m.dispose()); bgMat.dispose(); bandMat.dispose();
      renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    },
  };
}

// Built-in starting points mapped to the Figma hero families
export const PRESETS = [
  { name: 'Institutions', cfg: { concept: 'orbit' } },
  { name: 'RMI', cfg: { concept: 'tunnel' } },
  { name: 'Ecosystem', cfg: { concept: 'frames', look: { band: 0 }, portrait: { params: { count: 4, lobes: 1, angle: 225, focus: 4, contrast: 1 } } } },
  { name: 'Settlement', cfg: { concept: 'burst' } },
  { name: 'Newsroom', cfg: { concept: 'network' } },
  { name: 'Treasury Operations', cfg: { concept: 'tiles' } },
  { name: 'Repo', cfg: { concept: 'repo' } },
  { name: 'Roles: Circles', cfg: { concept: 'tiles', params: { shape: 1, pitchX: 64, pitchY: 64, w: 50, h: 50, alt: 0, stagger: 0.5, lens: 1.6, lensR: 0.25, wave: 0.8 } } },
  { name: 'Collateral Mobility', cfg: { concept: 'bars' } },
  { name: 'Repo Cash', cfg: { concept: 'waves', portrait: { params: { height: 1184 } } } },
  { name: 'Roles: Vertical Bars', cfg: { concept: 'bars', params: { orient: 1, count: 18, pitch: 34, thick: 0, len: 560, lenVar: 0.45, slant: 0, solid: 1, slide: 0.6, highlight: 1.4 }, layout: { wide: { x: 0.5, y: 0.78 }, tall: { x: 0.5, y: 0.8 } } } },
];
