// M1 Hero runtime v1.2.0
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
    this.L = { pos: new Float32Array(3 * 16384), a: new Float32Array(16384), nb: new Float32Array(3 * 16384), e: new Int32Array(16384), n: 0, c0: 0 };
    // e: which shape each vertex belongs to, as id * 2 + (1 for every other shape), or -1 for lines that never take
    // the stroke gradient (grid, rules, moving light). Concepts set it with el() before drawing each shape.
    this.cur = -1; this.lo = new Float64Array(256); this.hi = new Float64Array(256);
    this.P = { pos: new Float32Array(3 * 1024), a: new Float32Array(1024), s: new Float32Array(1024), n: 0 };
    this.o = { x: 0, y: 0, z: 0, a: 1 };
    this.grewL = this.grewP = false;
  }
  reset() { this.L.n = 0; this.L.c0 = 0; this.P.n = 0; this.cur = -1; }
  // Start a shape: id groups its lines (the gradient spans the shape's own extent), odd marks every other shape.
  el(id, odd = id & 1) { this.cur = id < 0 ? -1 : id * 2 + (odd ? 1 : 0); }
  _growL(k) {
    const L = this.L;
    if (L.n + k <= L.a.length) return;
    const c = Math.max(L.a.length * 2, L.n + k);
    const p = new Float32Array(c * 3); p.set(L.pos); L.pos = p;
    const a = new Float32Array(c); a.set(L.a); L.a = a;
    const nb = new Float32Array(c * 3); nb.set(L.nb); L.nb = nb;
    const e = new Int32Array(c); e.set(L.e); L.e = e;
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
    L.a[L.n] = a1; L.a[L.n + 1] = a2; L.e[L.n] = L.e[L.n + 1] = this.cur; L.n += 2;
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
      A[i] *= Math.max(0, 1 - t / r);
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
    label: 'Orbit Arcs',
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
    label: 'Depth Tunnel',
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
    label: 'Frame Tunnel',
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
    label: 'Signal Burst',
    family: 'Settlement',
    blurb: 'Rays converge on one focal node. Light packets travel inward and flash on arrival, and the focal point leans toward the cursor.',
    layout: { wide: { x: 0.5, y: 0.765, s: 1 }, tall: { x: 0.5, y: 0.79, s: 0.8 } },
    params: {
      rays: p(7, 1, 30, 1, 'Rays per side'),
      spread: p(15, 1, 70, 0.5, 'Spread (deg)'),
      length: p(1, 0.3, 2.5, 0.01, 'Ray length'),
      vline: p(1, 0, 1.5, 0.01, 'Vertical line'),
      depth: p(260, 0, 1000, 5, 'Depth'),
      packets: p(7, 0, 40, 1, 'Packets'),
      pspeed: p(1, 0, 4, 0.05, 'Packet speed'),
      trail: p(0.12, 0.02, 0.5, 0.01, 'Trail length'),
      sway: p(1, 0, 4, 0.05, 'Sway'),
      node: p(5, 0, 14, 0.5, 'Node size'),
    },
    init(c, P, rnd) {
      const rays = [], n = Math.round(P.rays);
      for (const side of [-1, 1]) {
        for (let j = 0; j < n; j++) {
          const f = n > 1 ? (j + 0.5 + (rnd() - 0.5) * 0.8) / n : 0.5;
          rays.push({ side, ang: lerp(-P.spread, P.spread, f) * Math.PI / 180, len: 0.7 + rnd() * 0.6, b: 0.35 + rnd() * 0.65, z: (rnd() - 0.5) * 2, ph: rnd() * TAU });
        }
      }
      const packets = [];
      for (let k = 0; k < Math.round(P.packets); k++) packets.push({ ray: (rnd() * rays.length) | 0, ph: rnd(), sp: 0.7 + rnd() * 0.6 });
      return { rays, packets };
    },
    draw(c, pen, st, P) {
      const { u, t, I, W, H } = c;
      const fx = c.ax + (c.mx - c.ax) * 0.05 * I * c.md * c.mouseAmt;
      const fy = c.ay + (c.my - c.ay) * 0.05 * I * c.md * c.mouseAmt;
      const ends = st.rays.map((r) => {
        const th = r.ang + P.sway * (0.3 + I) * 0.025 * Math.sin(t * 0.3 + r.ph);
        const L = P.length * W * 0.55 * r.len * c.introAt(0.05);
        return [fx + r.side * Math.cos(th) * L, fy + Math.sin(th) * L, r.z * P.depth * u];
      });
      st.rays.forEach((r, i) => {
        const [ex, ey, ez] = ends[i];
        pen.el(i);
        pen.poly(24, (s, o) => {
          o.x = lerp(fx, ex, s); o.y = lerp(fy, ey, s); o.z = ez * s;
          o.a = r.b * (0.3 + 0.7 * sstep(0, 0.06, s)) * (1 - sstep(0.4, 1, s));
        });
      });
      pen.el(-1);
      if (P.vline > 0) {
        const up = 0.32 * H * P.vline * c.introAt(0.3), dn = 0.26 * H * P.vline * c.introAt(0.3);
        pen.poly(20, (s, o) => { o.x = fx; o.y = lerp(fy - dn, fy + up, s); const k = s < dn / (up + dn) ? 1 - s / (dn / (up + dn)) : (s - dn / (up + dn)) / (1 - dn / (up + dn)); o.a = 0.7 * Math.pow(1 - k, 1.6); });
      }
      let flash = 0;
      const vis = clamp(0.35 + I, 0, 1) * c.introAt(0.6);
      st.packets.forEach((k) => {
        const [ex, ey, ez] = ends[k.ray];
        const q = 1 - frac(t * 0.07 * P.pspeed * k.sp + k.ph);
        const tl = P.trail;
        const far = 1 - sstep(0.75, 1, q);
        pen.poly(10, (s, o) => {
          const w = clamp(q + tl * s, 0, 1);
          o.x = lerp(fx, ex, w); o.y = lerp(fy, ey, w); o.z = ez * w;
          o.a = vis * far * 1.4 * Math.pow(1 - s, 2);
        });
        pen.point(lerp(fx, ex, q), lerp(fy, ey, q), ez * q, 2.5, vis * far);
        flash += gauss(q / 0.035);
      });
      if (P.node > 0) {
        pen.point(fx, fy, 0, P.node, 0.95 * c.introAt(0));
        pen.point(fx, fy, 0, -P.node * 6, (0.08 + 0.35 * Math.min(1, flash)) * c.introAt(0));
      }
    },
  },

  network: {
    label: 'Signal Network',
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
    label: 'Tile Field',
    family: 'Treasury, Repo, Roles',
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
    label: 'Ledger Bars',
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
    label: 'Crossing Waves',
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

// ---------- Config ----------
const FILL = { solid: 0, gradient: 1, alternate: 2 };
export const DEFAULTS = {
  v: 1,
  concept: 'orbit',
  seed: 7,
  look: {
    bg: '#121316', stroke: '#d5e3f6', opacity: 0.7, back: '#8dadd3', backOpacity: 0.5,
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
  motion: { intensity: 0.35, speed: 1, intro: true },
  interact: { mouse: 1, glow: 0.6, glowRadius: 0.22, touch: true },
  camera: { fov: 30, tilt: 0, orbit: 0 },
  // Texture layers shared by every concept: hairline grid and film grain.
  grid: { on: false, strength: 0.35, step: 40, depth: 160, fx: 0.5, fy: 0.5, focus: 1, grainOn: true, grain: 0.03 },
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
const LINE_VS = /* glsl */`
attribute float aA; varying float vA; uniform vec2 uOffset; uniform vec2 uRes;
void main(){ vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); p.xy += uOffset * 2.0 / uRes * p.w; gl_Position = p; vA = aA; }`;
// Wider strokes: each segment is a quad expanded in screen space. position.x picks the end (0 start, 1 end),
// position.y the side. Below 1 device pixel the quad stays 1px wide and fades instead, so thin widths stay smooth.
const QLINE_VS = /* glsl */`
attribute vec3 iA; attribute vec3 iB; attribute vec3 iP; attribute vec3 iN; attribute float iAA; attribute float iAB;
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
    vertexShader: vs, fragmentShader: LINE_FS, transparent: true, depthTest: false, depthWrite: false,
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
  };
  const bindP = () => {
    pGeo.setAttribute('position', new THREE.BufferAttribute(pen.P.pos, 3).setUsage(THREE.DynamicDrawUsage));
    pGeo.setAttribute('aA', new THREE.BufferAttribute(pen.P.a, 1).setUsage(THREE.DynamicDrawUsage));
    pGeo.setAttribute('aS', new THREE.BufferAttribute(pen.P.s, 1).setUsage(THREE.DynamicDrawUsage));
  };
  bindL(); bindP();
  let backMat = lineMat(cfg.look.blend), frontMat = lineMat(cfg.look.blend);
  const back = new THREE.LineSegments(lGeo, backMat), front = new THREE.LineSegments(lGeo, frontMat);
  const ptMat = new THREE.ShaderMaterial({ vertexShader: PT_VS, fragmentShader: PT_FS, transparent: true, depthTest: false, depthWrite: false, uniforms: { ...THREE.UniformsUtils.clone(frontMat.uniforms), uDpr: { value: 1 } } });
  const points = new THREE.Points(pGeo, ptMat);
  // Stroke width above a hairline: the same segments drawn as instanced quads (WebGL lines are always 1 device pixel).
  const qGeo = new THREE.InstancedBufferGeometry();
  qGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0], 3));
  qGeo.setIndex([0, 2, 1, 1, 2, 3]);
  let qPos = null, qA = null, qN = null;
  const bindQ = () => {
    qPos = new THREE.InstancedInterleavedBuffer(pen.L.pos, 6).setUsage(THREE.DynamicDrawUsage);
    qA = new THREE.InstancedInterleavedBuffer(pen.L.a, 2).setUsage(THREE.DynamicDrawUsage);
    qGeo.setAttribute('iA', new THREE.InterleavedBufferAttribute(qPos, 3, 0));
    qGeo.setAttribute('iB', new THREE.InterleavedBufferAttribute(qPos, 3, 3));
    qGeo.setAttribute('iAA', new THREE.InterleavedBufferAttribute(qA, 1, 0));
    qGeo.setAttribute('iAB', new THREE.InterleavedBufferAttribute(qA, 1, 1));
    qN = new THREE.InstancedInterleavedBuffer(pen.L.nb, 6).setUsage(THREE.DynamicDrawUsage);
    qGeo.setAttribute('iP', new THREE.InterleavedBufferAttribute(qN, 3, 0));
    qGeo.setAttribute('iN', new THREE.InterleavedBufferAttribute(qN, 3, 3));
  };
  bindQ();
  const qBackMat = lineMat(cfg.look.blend, QLINE_VS), qFrontMat = lineMat(cfg.look.blend, QLINE_VS);
  const qBack = new THREE.Mesh(qGeo, qBackMat), qFront = new THREE.Mesh(qGeo, qFrontMat);
  const allMats = [backMat, frontMat, qBackMat, qFrontMat, ptMat];
  [[back, 0], [qBack, 0], [front, 1], [qFront, 1], [points, 2]].forEach(([o, i]) => { o.frustumCulled = false; o.renderOrder = i; root.add(o); });
  const thick = () => (cfg.look.width || 1) > 1;

  let W = 1, H = 1, dpr = 1, state = null, concept = null, settled = false, artN = 0;
  let t = 0, last = performance.now(), born = last, running = false, raf = 0, visible = true, destroyed = false;
  const mouse = { tx: 0, ty: 0, x: 0, y: 0, tin: 0, in: 0 };
  const reduceMQ = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
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
    const lay = W / H < 1 ? cfg.layout.tall : cfg.layout.wide;
    const ctx = {
      W, H, D, t, I, u: (H / 900) * lay.s, ax: (lay.x - 0.5) * W, ay: (0.5 - lay.y) * H,
      mx: mouse.x, my: mouse.y, md, mn: { x: mnx, y: mny }, mouseAmt, introAt,
    };
    pen.reset();
    concept.draw(ctx, pen, state, cfg.params);
    artN = pen.L.n;
    pen.el(-1);
    pen.shade(FILL[cfg.look.fill] || 0, (cfg.look.gradAngle || 0) * Math.PI / 180, cfg.look.gradReach ?? 1);
    if (cfg.grid.on) drawGrid(ctx, pen, cfg.grid);
    const wide = thick();
    if (pen.grewL) { bindL(); bindQ(); pen.grewL = false; }
    else if (wide) { qPos.needsUpdate = true; qA.needsUpdate = true; qN.needsUpdate = true; }
    else { lGeo.attributes.position.needsUpdate = true; lGeo.attributes.aA.needsUpdate = true; }
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
      renderFrame();
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      if (transparent) see(false);
      if (clean) { [G.on, G.grainOn] = keep; applyLook(); }
      setSize(...prev); renderFrame();
      return blob;
    },
    destroy() {
      destroyed = true; stop();
      window.removeEventListener('pointermove', onPointer);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      reduceMQ && reduceMQ.removeEventListener && reduceMQ.removeEventListener('change', sync);
      ro.disconnect(); io && io.disconnect();
      lGeo.dispose(); pGeo.dispose(); qGeo.dispose(); allMats.forEach((m) => m.dispose()); bgMat.dispose(); bandMat.dispose();
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
  { name: 'Repo', cfg: { concept: 'tiles', params: { shape: 2, cols: 1, pitchX: 300, pitchY: 240, h: 240, rules: 0.8, alt: 0, stagger: 0, lens: 1.4, wave: 0.2 }, layout: { wide: { x: 0.44, y: 0.13 }, tall: { x: 0.5, y: 0.1 } } } },
  { name: 'Roles: Circles', cfg: { concept: 'tiles', params: { shape: 1, pitchX: 64, pitchY: 64, w: 50, h: 50, alt: 0, stagger: 0.5, lens: 1.6, lensR: 0.25, wave: 0.8 } } },
  { name: 'Collateral Mobility', cfg: { concept: 'bars' } },
  { name: 'Repo Cash', cfg: { concept: 'waves', portrait: { params: { height: 1184 } } } },
  { name: 'Roles: Vertical Bars', cfg: { concept: 'bars', params: { orient: 1, count: 18, pitch: 34, thick: 0, len: 560, lenVar: 0.45, slant: 0, solid: 1, slide: 0.6, highlight: 1.4 }, layout: { wide: { x: 0.5, y: 0.78 }, tall: { x: 0.5, y: 0.8 } } } },
];
