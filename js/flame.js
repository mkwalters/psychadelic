'use strict';
// Fractal flame engine: genomes, chaos-game iteration, log-density tone mapping.
// Based on the published fractal flame algorithm (Draves & Reckase).

const Flame = (() => {
  const TAU = Math.PI * 2;

  const VARIATIONS = [
    'linear', 'sinusoidal', 'spherical', 'swirl', 'horseshoe', 'polar',
    'handkerchief', 'heart', 'disc', 'spiral', 'hyperbolic', 'diamond',
    'ex', 'julia', 'bent', 'fisheye', 'exponential', 'power', 'cosine',
    'bubble', 'cylinder', 'eyefish', 'tangent', 'cross',
  ];
  const NV = VARIATIONS.length;

  const rand = (a, b) => a + Math.random() * (b - a);
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------- Genomes ----------

  function randomPalette() {
    // Cosine palette: a + b*cos(2π(c*t + d)) — bright, cycling, psychedelic.
    return {
      a: [rand(0.4, 0.6), rand(0.4, 0.6), rand(0.4, 0.6)],
      b: [rand(0.35, 0.55), rand(0.35, 0.55), rand(0.35, 0.55)],
      c: [rand(0.8, 2.5), rand(0.8, 2.5), rand(0.8, 2.5)].map(v => Math.round(v * 2) / 2),
      d: [Math.random(), Math.random(), Math.random()],
    };
  }

  function randomXform() {
    const vars = {};
    const count = 1 + Math.floor(Math.random() * 3);
    let total = 0;
    for (let i = 0; i < count; i++) {
      const v = Math.floor(Math.random() * NV);
      const w = rand(0.2, 1);
      vars[v] = (vars[v] || 0) + w;
      total += w;
    }
    for (const k in vars) vars[k] /= total;
    return {
      w: rand(0.2, 1),
      color: Math.random(),
      coefs: [rand(-1, 1), rand(-1, 1), rand(-1, 1), rand(-1, 1), rand(-1, 1), rand(-1, 1)],
      vars,
      spin: Math.random() < 0.25 ? 0 : (Math.random() < 0.5 ? -1 : 1),
    };
  }

  function rawRandomGenome() {
    const n = 2 + Math.floor(Math.random() * 4);
    const xforms = [];
    for (let i = 0; i < n; i++) xforms.push(randomXform());
    const r = Math.random();
    const sym = r < 0.35 ? 1 : r < 0.55 ? 2 : 3 + Math.floor(Math.random() * 6);
    return {
      xforms,
      pal: randomPalette(),
      sym,
      mirror: Math.random() < 0.3,
      cx: 0, cy: 0, size: 4,
    };
  }

  // Generate random genomes until one looks interesting (spread out, not degenerate).
  function randomGenome(aspect) {
    let best = null, bestScore = -1;
    for (let attempt = 0; attempt < 60; attempt++) {
      const g = rawRandomGenome();
      const fit = fitCamera(g, aspect);
      if (!fit) continue;
      if (fit.score > bestScore) { best = g; bestScore = fit.score; }
      if (fit.score > 0.2) break;
    }
    return best || rawRandomGenome();
  }

  // Sample points, frame them, and score how much of the frame they cover.
  function fitCamera(g, aspect) {
    const pts = [];
    iterate(compile(g, 0), null, null, 6000, pts);
    const n = pts.length / 2;
    if (n < 2000) return null;
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = pts[2 * i]; ys[i] = pts[2 * i + 1]; }
    xs.sort(); ys.sort();
    const lo = Math.floor(n * 0.03), hi = Math.floor(n * 0.97);
    const x0 = xs[lo], x1 = xs[hi], y0 = ys[lo], y1 = ys[hi];
    const wx = x1 - x0, wy = y1 - y0;
    if (!(wx > 1e-3 && wy > 1e-3 && wx < 1e4 && wy < 1e4)) return null;
    g.cx = (x0 + x1) / 2;
    g.cy = (y0 + y1) / 2;
    g.size = Math.max(wy, wx / aspect) / 0.85;

    // Coverage score on a coarse grid.
    const G = 24, grid = new Uint8Array(G * G);
    const sw = g.size * aspect, sh = g.size;
    let filled = 0;
    for (let i = 0; i < n; i++) {
      const gx = Math.floor(((pts[2 * i] - g.cx) / sw + 0.5) * G);
      const gy = Math.floor(((pts[2 * i + 1] - g.cy) / sh + 0.5) * G);
      if (gx >= 0 && gx < G && gy >= 0 && gy < G && !grid[gy * G + gx]) { grid[gy * G + gx] = 1; filled++; }
    }
    return { score: filled / (G * G) };
  }

  // Blend two genomes; missing xforms fade in/out via zero weight.
  function lerpGenome(A, B, t) {
    const n = Math.max(A.xforms.length, B.xforms.length);
    const xforms = [];
    for (let i = 0; i < n; i++) {
      const xa = A.xforms[i] || { ...B.xforms[i], w: 0 };
      const xb = B.xforms[i] || { ...A.xforms[i], w: 0 };
      const vars = {};
      for (const k in xa.vars) vars[k] = xa.vars[k] * (1 - t);
      for (const k in xb.vars) vars[k] = (vars[k] || 0) + xb.vars[k] * t;
      xforms.push({
        w: lerp(xa.w, xb.w, t),
        color: lerp(xa.color, xb.color, t),
        coefs: xa.coefs.map((c, j) => lerp(c, xb.coefs[j], t)),
        vars,
        spin: t < 0.5 ? xa.spin : xb.spin,
      });
    }
    const lp = (k) => A.pal[k].map((v, j) => lerp(v, B.pal[k][j], t));
    return {
      xforms,
      pal: { a: lp('a'), b: lp('b'), c: lp('c'), d: lp('d') },
      sym: t < 0.5 ? A.sym : B.sym,
      mirror: t < 0.5 ? A.mirror : B.mirror,
      cx: lerp(A.cx, B.cx, t),
      cy: lerp(A.cy, B.cy, t),
      size: Math.exp(lerp(Math.log(A.size), Math.log(B.size), t)),
    };
  }

  // Turn a genome into flat arrays for the hot loop. `phase` rotates spinning xforms.
  function compile(g, phase) {
    const xforms = [];
    let total = 0;
    for (const x of g.xforms) {
      if (x.w <= 0) continue;
      let [a, b, c, d, e, f] = x.coefs;
      if (x.spin) {
        const ang = phase * x.spin, cs = Math.cos(ang), sn = Math.sin(ang);
        [a, b, d, e] = [cs * a - sn * d, cs * b - sn * e, sn * a + cs * d, sn * b + cs * e];
      }
      const vi = [], vw = [];
      for (const k in x.vars) if (x.vars[k] > 1e-4) { vi.push(+k); vw.push(x.vars[k]); }
      total += x.w;
      xforms.push({ a, b, c, d, e, f, color: x.color, vi, vw, cum: total });
    }
    const pal = new Float32Array(256 * 3);
    const P = g.pal;
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      for (let ch = 0; ch < 3; ch++) {
        const v = P.a[ch] + P.b[ch] * Math.cos(TAU * (P.c[ch] * t + P.d[ch]));
        pal[i * 3 + ch] = Math.min(1, Math.max(0, v));
      }
    }
    const symCos = [], symSin = [];
    for (let k = 0; k < g.sym; k++) {
      symCos.push(Math.cos(TAU * k / g.sym));
      symSin.push(Math.sin(TAU * k / g.sym));
    }
    return { xforms, total, pal, symCos, symSin, mirror: g.mirror, cx: g.cx, cy: g.cy, size: g.size };
  }

  // ---------- Chaos game ----------

  // Runs n iterations. Either accumulates into `hist` (with view {w,h}) or pushes points into `pts`.
  function iterate(cg, hist, view, n, pts) {
    const xf = cg.xforms, nx = xf.length;
    if (!nx) return;
    const total = cg.total, pal = cg.pal;
    const symCos = cg.symCos, symSin = cg.symSin, ns = symCos.length, mirror = cg.mirror;
    let W = 0, H = 0, scale = 0, hR, hG, hB, hA;
    if (hist) {
      W = view.w; H = view.h; scale = H / cg.size;
      hR = hist.r; hG = hist.g; hB = hist.b; hA = hist.a;
    }
    const cx = cg.cx, cy = cg.cy, halfW = W * 0.5, halfH = H * 0.5;

    let x = Math.random() * 2 - 1, y = Math.random() * 2 - 1, c = Math.random();
    for (let i = -20; i < n; i++) {
      const r = Math.random() * total;
      let k = 0;
      while (k < nx - 1 && r > xf[k].cum) k++;
      const t = xf[k];
      const ax = t.a * x + t.b * y + t.c;
      const ay = t.d * x + t.e * y + t.f;
      const r2 = ax * ax + ay * ay + 1e-12;
      const rr = Math.sqrt(r2);
      const th = Math.atan2(ax, ay);
      let px = 0, py = 0;
      const vi = t.vi, vw = t.vw;
      for (let v = 0; v < vi.length; v++) {
        const w = vw[v];
        switch (vi[v]) {
          case 0: px += w * ax; py += w * ay; break;
          case 1: px += w * Math.sin(ax); py += w * Math.sin(ay); break;
          case 2: px += w * ax / r2; py += w * ay / r2; break;
          case 3: { const s = Math.sin(r2), co = Math.cos(r2); px += w * (ax * s - ay * co); py += w * (ax * co + ay * s); break; }
          case 4: px += w * (ax - ay) * (ax + ay) / rr; py += w * 2 * ax * ay / rr; break;
          case 5: px += w * th / Math.PI; py += w * (rr - 1); break;
          case 6: px += w * rr * Math.sin(th + rr); py += w * rr * Math.cos(th - rr); break;
          case 7: px += w * rr * Math.sin(th * rr); py -= w * rr * Math.cos(th * rr); break;
          case 8: { const q = th / Math.PI; px += w * q * Math.sin(Math.PI * rr); py += w * q * Math.cos(Math.PI * rr); break; }
          case 9: px += w * (Math.cos(th) + Math.sin(rr)) / rr; py += w * (Math.sin(th) - Math.cos(rr)) / rr; break;
          case 10: px += w * Math.sin(th) / rr; py += w * rr * Math.cos(th); break;
          case 11: px += w * Math.sin(th) * Math.cos(rr); py += w * Math.cos(th) * Math.sin(rr); break;
          case 12: { const p0 = Math.sin(th + rr), p1 = Math.cos(th - rr), a3 = p0 * p0 * p0, b3 = p1 * p1 * p1; px += w * rr * (a3 + b3); py += w * rr * (a3 - b3); break; }
          case 13: { const sr = Math.sqrt(rr), om = Math.random() < 0.5 ? 0 : Math.PI; px += w * sr * Math.cos(th / 2 + om); py += w * sr * Math.sin(th / 2 + om); break; }
          case 14: px += w * (ax < 0 ? 2 * ax : ax); py += w * (ay < 0 ? ay / 2 : ay); break;
          case 15: { const q = 2 / (rr + 1); px += w * q * ay; py += w * q * ax; break; }
          case 16: { const q = Math.exp(ax - 1); px += w * q * Math.cos(Math.PI * ay); py += w * q * Math.sin(Math.PI * ay); break; }
          case 17: { const st = Math.sin(th), q = Math.pow(rr, st); px += w * q * Math.cos(th); py += w * q * st; break; }
          case 18: px += w * Math.cos(Math.PI * ax) * Math.cosh(ay); py -= w * Math.sin(Math.PI * ax) * Math.sinh(ay); break;
          case 19: { const q = 4 / (r2 + 4); px += w * q * ax; py += w * q * ay; break; }
          case 20: px += w * Math.sin(ax); py += w * ay; break;
          case 21: { const q = 2 / (rr + 1); px += w * q * ax; py += w * q * ay; break; }
          case 22: px += w * Math.sin(ax) / Math.cos(ay); py += w * Math.tan(ay); break;
          case 23: { const d = ax * ax - ay * ay, q = Math.sqrt(1 / (d * d + 1e-12)); px += w * q * ax; py += w * q * ay; break; }
        }
      }
      x = px; y = py;
      c = (c + t.color) * 0.5;

      // Escaped or NaN: restart the orbit.
      if (!(x > -1e6 && x < 1e6 && y > -1e6 && y < 1e6)) {
        x = Math.random() * 2 - 1; y = Math.random() * 2 - 1;
        continue;
      }
      if (i < 0) continue;

      const ci = ((c * 255) | 0) * 3;
      const cr = pal[ci], cgc = pal[ci + 1], cb = pal[ci + 2];
      for (let s = 0; s < ns; s++) {
        const sx = x * symCos[s] - y * symSin[s];
        const sy = x * symSin[s] + y * symCos[s];
        for (let m = 0; m < (mirror ? 2 : 1); m++) {
          const mx = m ? -sx : sx;
          if (pts) { pts.push(mx, sy); continue; }
          const fx = (mx - cx) * scale + halfW;
          const fy = (sy - cy) * scale + halfH;
          if (fx >= 0 && fx < W && fy >= 0 && fy < H) {
            const idx = (fy | 0) * W + (fx | 0);
            hR[idx] += cr; hG[idx] += cgc; hB[idx] += cb; hA[idx] += 1;
          }
        }
      }
    }
  }

  // ---------- Tone mapping ----------

  function makeHist(w, h) {
    const n = w * h;
    return { r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n), a: new Float32Array(n) };
  }

  function clearHist(hist) {
    hist.r.fill(0); hist.g.fill(0); hist.b.fill(0); hist.a.fill(0);
  }

  // Log-density display with gamma. Optionally decays the histogram (motion trails).
  function render(hist, img, opts) {
    const { r, g, b, a } = hist;
    const data = img.data, n = a.length;
    let maxA = 0;
    for (let i = 0; i < n; i++) if (a[i] > maxA) maxA = a[i];
    const k = maxA > 0 ? opts.brightness / Math.log1p(maxA) : 0;
    const invGamma = 1 / opts.gamma;
    const decay = opts.decay;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const A = a[i];
      if (A > 0) {
        let lum = Math.log1p(A) * k;
        if (lum > 1) lum = 1;
        const s = Math.pow(lum, invGamma) * 255 / A;
        data[j] = r[i] * s; data[j + 1] = g[i] * s; data[j + 2] = b[i] * s;
        if (decay < 1) { r[i] *= decay; g[i] *= decay; b[i] *= decay; a[i] *= decay; }
      } else {
        data[j] = 0; data[j + 1] = 0; data[j + 2] = 0;
      }
      data[j + 3] = 255;
    }
  }

  return { VARIATIONS, randomGenome, fitCamera, lerpGenome, compile, iterate, makeHist, clearHist, render };
})();
