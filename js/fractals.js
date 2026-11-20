'use strict';
// Fractal dreams: escape-time fractals (Mandelbrot dives, morphing Julia
// sets, Phoenix, Nova, Kali lace) rendered as crisp eye candy. Each scene
// picks a fractal, a colour scheme and a rendering style; many Julia scenes
// spiral forever into self-similar copies of themselves.
//
// Pass 1 renders the fractal and blends it with the previous frame, which is
// re-projected to follow the camera (temporal anti-aliasing). Pass 2 adds
// bloom (from the mip chain), fringing, grain and vignette, and on a scene
// change melts a snapshot of the old fractal away as the next one forms.

(() => {
  const canvas = document.getElementById('art');
  const statusEl = document.getElementById('status');
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false });
  if (!gl) {
    statusEl.textContent = 'This needs WebGL2: try a recent Chrome, Edge or Firefox.';
    statusEl.style.opacity = 1;
    return;
  }
  const floatTargets = !!gl.getExtension('EXT_color_buffer_float');
  const DEBUG = /[?&]debug\b/.test(location.search);

  const settings = {
    speed: 1,         // set from the Speed slider through its curve
    glow: 0.5,
    holdSeconds: 22,
    meltSeconds: 4.5, // scene-change melt
  };

  // ---------- Shaders ----------

  const VERT = `#version 300 es
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const SIM = `#version 300 es
  precision highp float;
  precision highp int;
  out vec4 outColor;

  uniform sampler2D uPrev;
  uniform vec2 uRes;
  uniform int uFam, uPow, uMaxIter;
  uniform vec2 uC, uP, uTrap;
  uniform vec2 uCamHi, uCamLo, uRotCS, uJit;
  uniform float uScale;
  uniform mat2 uRA;
  uniform vec2 uRB;
  uniform vec4 uStyle;   // weights: ribbons, lace, filament, nebula
  uniform vec4 uLook;    // band density, relief, interior glow, stripe frequency
  uniform float uCycle, uTrapK;
  uniform vec3 uBg, uGlow, uHi;
  uniform vec3 uRamp[5];
  uniform float uK, uMuShift;

  vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
  vec2 cdiv(vec2 a, vec2 b) { return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / dot(b, b); }

  // Direction of z/dz for relief lighting. dz overflows right at the set's
  // edge; fall back to a fixed direction instead of producing NaN.
  vec2 safeNormal(vec2 z, vec2 dz) {
    float m = max(abs(dz.x), abs(dz.y));
    if (!(m > 1e-30 && m < 1e30)) return vec2(0.6, 0.8);
    vec2 u = cdiv(z, dz / m);
    float l = length(u);
    return l > 1e-20 && l < 1e30 ? u / l : vec2(0.6, 0.8);
  }
  // Never let a NaN or infinity into the feedback buffer: it would spread
  // and, through the exposure average, black out the whole screen.
  vec3 safe(vec3 c) {
    if (any(isnan(c)) || any(isinf(c))) return vec3(0.0);
    return clamp(c, 0.0, 16.0);
  }

  struct Fr {
    float mu;      // smooth iteration count
    float de;      // distance to the set in fractal units (<0: unknown)
    float trap;    // closest approach to the orbit trap
    float stripe;  // stripe average (0…1)
    vec2 n;        // relief normal
    float inside;  // 1 inside the set
    float alt;     // extra value (Nova: which attractor)
  };

  // Mandelbrot / Julia / multi-power Julia, with derivative for distance
  // estimate and relief lighting, orbit trap and stripe average.
  Fr escape(vec2 pos, bool mandel) {
    Fr f = Fr(0.0, -1.0, 1e9, 0.0, vec2(0.0), 0.0, 0.0);
    vec2 z, dz, c;
    if (mandel) { c = pos; z = uC; dz = vec2(0.0); }
    else { c = uC; z = pos; dz = vec2(1.0, 0.0); }
    if (mandel && uPow == 2 && dot(uC, uC) < 1e-10) {
      float xq = c.x - 0.25, q = xq * xq + c.y * c.y;
      if (q * (q + xq) < 0.25 * c.y * c.y || (c.x + 1.0) * (c.x + 1.0) + c.y * c.y < 0.0625) {
        f.inside = 1.0; f.mu = float(uMaxIter); f.trap = 0.5; return f;
      }
    }
    float fp = float(uPow);
    bool stripes = uLook.w > 0.0;
    float st = 0.0, stPrev = 0.0;
    int n = 0;
    float r2 = dot(z, z);
    // Brent-style cycle check: an orbit that comes back to where it was is
    // trapped inside the set, so stop early (interiors are the costly part).
    vec2 zs = z;
    int per = 8, pc = 0;
    for (int k = 0; k < 2000; k++) {
      if (k >= uMaxIter) break;
      vec2 zp = z;
      for (int j = 2; j < 8; j++) { if (j >= uPow) break; zp = cmul(zp, z); }
      dz = fp * cmul(zp, dz) + (mandel ? vec2(1.0, 0.0) : vec2(0.0));
      z = cmul(zp, z) + c;
      r2 = dot(z, z);
      f.trap = min(f.trap, length(z - uTrap));
      if (stripes && k > 0) { stPrev = st; st += 0.5 + 0.5 * sin(uLook.w * atan(z.y, z.x)); }
      n = k + 1;
      if (r2 > 1e6) break;
      vec2 dd = z - zs;
      if (dot(dd, dd) < 1e-13) { n = uMaxIter; break; }
      if (++pc == per) { pc = 0; per *= 2; zs = z; }
    }
    if (r2 <= 1e6) { f.inside = 1.0; f.mu = float(n); return f; }
    float lr = 0.5 * log(r2);
    float nu = log(lr / log(1000.0)) / log(fp);
    // In a spiral zoom every loop adds the cycle's period to the count;
    // subtracting it keeps the colours self-similar so the loop is seamless.
    f.mu = max(float(n) + 1.0 - nu - uMuShift, 0.0);
    float ldz = length(dz);
    f.de = ldz < 1e30 ? 0.5 * sqrt(r2) * lr / max(ldz, 1e-30) : 0.0;
    f.n = safeNormal(z, dz);
    if (stripes) {
      float a = st / max(float(n - 1), 1.0), b = stPrev / max(float(n - 2), 1.0);
      f.stripe = mix(b, a, clamp(1.0 - nu, 0.0, 1.0));
    }
    return f;
  }

  // Phoenix: z' = z^2 + c + p * z_prev. Grows long drooping tendrils.
  Fr phoenix(vec2 pos) {
    Fr f = Fr(0.0, -1.0, 1e9, 0.0, vec2(0.0), 0.0, 0.0);
    vec2 z = pos, zo = vec2(0.0), dz = vec2(1.0, 0.0), dzo = vec2(0.0);
    int n = 0;
    float r2 = dot(z, z);
    for (int k = 0; k < 2000; k++) {
      if (k >= uMaxIter) break;
      vec2 zn = cmul(z, z) + uC + cmul(uP, zo);
      vec2 dn = 2.0 * cmul(z, dz) + cmul(uP, dzo);
      zo = z; dzo = dz; z = zn; dz = dn;
      r2 = dot(z, z);
      f.trap = min(f.trap, length(z - uTrap));
      n = k + 1;
      if (r2 > 1e6) break;
    }
    if (r2 <= 1e6) { f.inside = 1.0; f.mu = float(n); return f; }
    float lr = 0.5 * log(r2);
    f.mu = max(float(n) + 1.0 - log(lr / log(1000.0)) / log(2.0), 0.0);
    float ldz = length(dz);
    f.de = ldz < 1e30 ? 0.5 * sqrt(r2) * lr / max(ldz, 1e-30) : 0.0;
    f.n = safeNormal(z, dz);
    return f;
  }

  // Nova: Newton's method on z^3 - 1, plus a constant kick. Glassy basins
  // threaded with chains of tiny copies.
  Fr nova(vec2 pos) {
    Fr f = Fr(0.0, -1.0, 1e9, 0.0, vec2(0.0), 0.0, 0.0);
    vec2 z = pos;
    float d = 1.0, dp = 1.0;
    int n = 0;
    const float EPS = 1e-4;
    for (int k = 0; k < 400; k++) {
      if (k >= uMaxIter) break;
      vec2 z2 = cmul(z, z);
      vec2 zn = z - uP.x * cdiv(cmul(z2, z) - vec2(1.0, 0.0), 3.0 * z2) + uC;
      dp = d;
      d = length(zn - z);
      z = zn;
      f.trap = min(f.trap, length(z - uTrap));
      n = k + 1;
      if (d < EPS) break;
    }
    if (d >= EPS) { f.inside = 1.0; f.mu = float(n); return f; }
    // Interpolate the last step in log space: continuous whatever the
    // convergence rate (Nova converges linearly, so the usual formula bands).
    float ld = log(max(d, 1e-30)), lp = log(max(dp, 1e-30));
    float frac = clamp((lp - log(EPS)) / max(lp - ld, 1e-4), 0.0, 1.0);
    f.mu = max(float(n) - 1.0 + frac, 0.0);
    f.alt = atan(z.y, z.x) / 6.2831853 + 0.5;
    return f;
  }

  vec3 ramp(float t);

  // Kali lace: z' = |z| / |z|^2 + c folds space into filigree. Coloured
  // directly: each fold of the orbit draws glowing threads (where z crosses
  // the axes) in its own palette colour, so layers of lace get different hues.
  vec3 laceColor(vec2 pos) {
    vec2 z = pos;
    vec3 acc = vec3(0.0);
    float wsum = 0.0, body = 0.0;
    for (int k = 0; k < 64; k++) {
      if (k >= uMaxIter) break;
      z = abs(z) / dot(z, z) + uC;
      float tr = min(abs(z.x), abs(z.y));
      float w = exp(-tr * uTrapK);
      vec3 c = ramp(float(k) * uLook.x * 0.11 - uCycle);
      acc += c * w;
      wsum += w;
      body += exp(-length(z - uTrap) * 2.0);
    }
    float n = float(uMaxIter);
    vec3 col = uBg + acc * (2.6 / n);
    col += uGlow * smoothstep(0.0, 1.0, body / n) * 0.35;
    float lum = dot(col, vec3(0.3, 0.6, 0.1));
    return mix(col, col * smoothstep(0.0, 0.6, lum), 0.4);   // deepen the gaps
  }

  Fr fractal(vec2 pos) {
    if (uFam == 0) return escape(pos, true);
    if (uFam == 1) return escape(pos, false);
    if (uFam == 2) return phoenix(pos);
    return nova(pos);
  }

  vec3 ramp(float t) {
    t = fract(t) * 5.0;
    int i = int(t);
    return mix(uRamp[i], uRamp[(i + 1) % 5], smoothstep(0.0, 1.0, fract(t)));
  }

  vec3 colorize(Fr f) {
    float pix = uScale;
    // Distance to the set in pixels: from the distance estimate when there is
    // one, otherwise from how fast the iteration count changes on screen.
    vec2 gm = vec2(dFdx(f.mu), dFdy(f.mu));
    float g = length(gm);
    float dpx = f.de >= 0.0 ? f.de / pix : 0.6 / max(g, 1e-4);
    float line = exp(-dpx * 0.7);        // the boundary itself
    float glow = exp(-dpx * 0.15);       // tight glow hugging it
    float halo = exp(-dpx * 0.025);      // wide soft halo
    // Nearness needs both a short distance and a high iteration count, so
    // open space between dust and tendrils stays dark.
    float near = (1.0 - smoothstep(0.0, 4.6, log(1.0 + dpx))) * smoothstep(0.4, 2.8, log(f.mu + 1.0));

    // Relief light (normal from z/dz, or from the iteration gradient).
    vec2 nrm = f.de >= 0.0 ? f.n : -gm / max(g, 1e-6);
    vec2 L = normalize(vec2(0.7, 0.75));
    float relief = clamp((dot(nrm, L) + 1.15) / 2.15, 0.0, 1.0);
    relief = mix(1.0, relief * relief * 1.4, uLook.y);

    float bt = sqrt(f.mu) * uLook.x * 0.35 - uCycle + f.alt;   // band coordinate
    vec3 band = ramp(bt);
    float trapG = exp(-f.trap * uTrapK);

    if (f.inside > 0.5) {
      vec3 inner = uBg * 0.2;
      inner += uLook.z * ramp(f.trap * 0.7 - uCycle * 0.5) * (trapG * 0.22 + 0.03);
      return inner;
    }

    // Lace: dark field with dim wisps; saturated bands rise toward the set;
    // a tinted glow hugs the edge with a thin bright core.
    vec3 lc = uBg + band * 0.16 * smoothstep(0.0, 0.5, near);
    lc = mix(lc, band * (0.35 + 0.75 * relief), smoothstep(0.3, 0.85, near));
    lc = mix(lc, uGlow * (0.6 + 0.5 * relief), glow * 0.45);
    lc = mix(lc, uHi, line * 0.3);

    // Ribbons: bold candy bands with dark seams and rounded tube shading,
    // fading into the dark field far away; the edge becomes glowing lace.
    float q = bt * 4.0;
    float fb = fract(q);
    vec3 rc = ramp((floor(q) + 0.5) / 4.0 * 0.999);
    float seam = smoothstep(0.0, 0.09, fb) * smoothstep(1.0, 0.9, fb);
    float tube = 0.5 + 0.5 * sin(fb * 3.14159);
    vec3 rb = mix(uBg, rc * tube * (0.3 + 0.85 * relief), seam * smoothstep(0.08, 0.45, near));
    rb = mix(rb, uBg * 0.6 + uGlow * 0.3 * relief, smoothstep(0.85, 1.0, near) * 0.75);
    rb = mix(rb, uGlow, glow * 0.25);
    rb = mix(rb, uHi, line * 0.35);

    // Filament: orbit-trap threads and stripe-average sheen near the set.
    vec3 fl = uBg + band * 0.1 * near;
    fl += ramp(f.stripe * 0.6 + bt * 0.3) * f.stripe * f.stripe * smoothstep(0.2, 0.9, near) * 0.9 * relief;
    fl += uGlow * trapG * 1.1 * smoothstep(0.1, 0.7, near);
    fl = mix(fl, uGlow * 0.8, glow * 0.25);
    fl = mix(fl, uHi, line * 0.2);

    // Nebula: colour shifts with distance (cool far, warm close) and glows.
    vec3 nb = ramp(near * 0.7 + 0.04 * sin(bt * 6.2832) - uCycle * 0.3) * (0.06 + 0.85 * pow(near, 2.2)) * (0.6 + 0.4 * relief);
    nb += uGlow * halo * 0.1;
    nb = mix(nb, uGlow, glow * 0.35);
    nb = mix(nb, uHi, line * 0.15);
    nb = max(nb, uBg);

    vec3 col = rb * uStyle.x + lc * uStyle.y + fl * uStyle.z + nb * uStyle.w;
    // Where detail is finer than a pixel the band colours turn to noise that
    // averages to grey; give those regions one coherent glowing tint instead.
    float dense = 1.0 - smoothstep(0.25, 1.6, dpx);
    vec3 dc = uBg * 0.6 + mix(uGlow, band, 0.4) * (0.1 + 0.32 * relief);
    return mix(col, dc, dense * 0.75);
  }

  // Nova as candy glass: each attractor's basin takes its own palette hue,
  // shaded like glass from the convergence speed, with a glint on top; the
  // chaotic boundary between basins becomes dark lace.
  vec3 novaColor(Fr f) {
    vec2 gm = vec2(dFdx(f.mu), dFdy(f.mu));
    float g = length(gm);
    if (f.inside > 0.5) return uBg * 0.3;
    vec3 base = ramp(f.alt + 0.05 * f.mu * uLook.x - uCycle);
    vec2 nrm = -gm / max(g, 1e-5);
    float rel = clamp(0.5 + 0.5 * dot(nrm, normalize(vec2(0.7, 0.75))) * min(g * 6.0, 1.0), 0.0, 1.0);
    float band = 0.5 + 0.5 * cos(f.mu * 3.14159 * uLook.x);
    vec3 col = base * (0.2 + 0.8 * rel) * (0.5 + 0.5 * band);
    float edge = smoothstep(0.5, 2.5, g);
    col = mix(col, uBg * 0.4 + uGlow * 0.2, edge * 0.85);
    col += uHi * pow(rel, 14.0) * 0.45 * (1.0 - edge);
    col += uGlow * exp(-f.trap * uTrapK) * 0.25;
    return col;
  }

  void main() {
    vec2 px = gl_FragCoord.xy - 0.5 * uRes;
    vec2 sp = px + uJit;

    vec2 v = vec2(uRotCS.x * sp.x - uRotCS.y * sp.y, uRotCS.y * sp.x + uRotCS.x * sp.y) * uScale;
    vec2 pos = uCamHi + (uCamLo + v);
    vec3 fresh = safe(uFam == 4 ? laceColor(pos) : uFam == 3 ? novaColor(nova(pos)) : colorize(fractal(pos)));

    // Previous frame, re-projected so it follows the camera: blending with
    // it (plus the sub-pixel jitter) is temporal anti-aliasing.
    vec2 pp = uRA * px + uRB;
    vec3 prev = safe(textureLod(uPrev, (pp + 0.5 * uRes) / uRes, 0.0).rgb);
    vec3 col = mix(fresh, prev, uK);
    outColor = vec4(safe(col), 1.0);
  }`;

  const POST = `#version 300 es
  precision highp float;
  out vec4 outColor;
  uniform sampler2D uTex, uOld;
  uniform vec2 uRes;
  uniform float uTime, uBloom, uMeltT, uNewW, uOldW;
  uniform int uTrans;
  uniform vec2 uTransC;

  float hash(float x) { return fract(sin(x * 127.1) * 43758.5453); }
  float noise1(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash(i), hash(i + 1.0), f); }
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1, 0)), f.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm2(vec2 p) { return 0.5 * noise2(p) + 0.3 * noise2(p * 2.3 + 1.7) + 0.2 * noise2(p * 5.1 + 4.2); }

  void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec2 d = uv - 0.5;
    float ca = 0.004 * dot(d, d) * 4.0;
    vec3 col = vec3(textureLod(uTex, uv + d * ca, 0.0).r,
                    textureLod(uTex, uv, 0.0).g,
                    textureLod(uTex, uv - d * ca, 0.0).b);

    // Auto-exposure: the top of the mip chain is the frame's average colour.
    // Flooded frames are dimmed, very dark ones lifted a little.
    float avg = dot(textureLod(uTex, vec2(0.5), 12.0).rgb, vec3(0.3, 0.6, 0.1));
    if (!(avg >= 0.0 && avg < 100.0)) avg = 0.16;
    float expo = clamp(pow(0.16 / max(avg, 0.01), 0.55), 0.5, 1.35);
    col *= expo;

    vec3 bl = expo * (textureLod(uTex, uv, 2.0).rgb * 0.30 + textureLod(uTex, uv, 3.5).rgb * 0.30
                    + textureLod(uTex, uv, 5.0).rgb * 0.25 + textureLod(uTex, uv, 6.5).rgb * 0.20);
    col += uBloom * max(bl - 0.04, 0.0) * 0.9;

    // Scene change: the previous picture (a snapshot) melts and runs down in
    // uneven drips, softening as it goes, while the new one fades in beneath.
    // Scene change: the previous picture (a snapshot in uOld) leaves in one
    // of several ways while the new one arrives.
    if (uMeltT < 0.999) {
      float t = uMeltT;
      vec2 asp = vec2(uRes.x / uRes.y, 1.0);
      if (uTrans == 0) {
        // Drip melt: runs down the screen in uneven drips, softening.
        float n = noise1(uv.x * 22.0 + 3.0) * 0.7 + noise1(uv.x * 61.0) * 0.3;
        float run = 0.12 + 1.5 * n * n * n;
        vec2 ou = uv + vec2(0.003 * sin(uv.y * 20.0 + t * 6.0) * t, run * t * t * 0.7);
        vec3 oc = textureLod(uOld, min(ou, vec2(1.0)), t * 2.5).rgb * (1.0 - smoothstep(0.9, 1.0, ou.y));
        col = max(col * uNewW, oc * uOldW);
      } else if (uTrans == 1) {
        // Dive through: the old picture rushes toward you and blurs away.
        float z = 1.0 + 7.0 * t * t;
        vec2 dir = uv - 0.5;
        vec3 oc = vec3(0.0);
        for (int i = 0; i < 4; i++)      // streaks of speed toward the edges
          oc += textureLod(uOld, 0.5 + dir / (z * (1.0 + 0.06 * float(i) * t)), t * 3.0).rgb;
        oc *= 0.25;
        col = mix(col, oc, 1.0 - smoothstep(0.1, 0.8, t));
      } else if (uTrans == 2) {
        // Whirlpool: the old picture twists into a vortex and dissolves.
        vec2 q = (uv - uTransC) * asp;
        float r = length(q);
        float a = t * t * 9.0 * exp(-r * 2.2);
        vec2 w = vec2(cos(a) * q.x - sin(a) * q.y, sin(a) * q.x + cos(a) * q.y) * (1.0 + 0.6 * t * t);
        vec3 oc = textureLod(uOld, uTransC + w / asp, t * 3.0).rgb;
        col = mix(col, oc, 1.0 - smoothstep(0.15 + 0.5 * r, 0.75 + 0.5 * r, t + 0.25 * r));
      } else if (uTrans == 3) {
        // Iris bloom: the new picture opens out of a glowing, wobbly circle.
        vec2 q = (uv - uTransC) * asp;
        float ang = atan(q.y, q.x);
        float d = length(q) + 0.05 * (noise1(ang * 3.0 + 10.0) - 0.5) + 0.03 * sin(ang * 7.0 + t * 8.0);
        float R = t * t * 2.0;
        float mask = smoothstep(R - 0.03, R + 0.03, d);
        vec3 oc = textureLod(uOld, uv, 0.0).rgb;
        col = mix(col, oc, mask);
        col += vec3(1.0, 0.85, 1.0) * exp(-abs(d - R) * 35.0) * 0.7 * (1.0 - t);
      } else if (uTrans == 4) {
        // Ink dissolve: the new picture spreads like ink, with glowing rims.
        float f = fbm2(uv * asp * 3.5 + uTransC * 10.0);
        float th = t * 1.25 - 0.1;
        float mask = smoothstep(th - 0.04, th + 0.04, f);
        vec3 oc = textureLod(uOld, uv + (f - 0.5) * 0.03 * t, t * 1.5).rgb;
        col = mix(col, oc, mask);
        col += col * exp(-abs(f - th) * 45.0) * 1.2 * (1.0 - t);
      } else {
        // Ripple: the old picture wobbles away like a disturbed pond.
        vec2 q = (uv - uTransC) * asp;
        float r = length(q) + 1e-4;
        float wave = sin(r * 30.0 - t * 18.0) * 0.06 * t * exp(-r * 1.2);
        vec3 oc = textureLod(uOld, uv + (q / r) * wave / asp, t * 2.0).rgb;
        col = mix(col, oc, 1.0 - smoothstep(0.2, 0.95, t + 0.15 * sin(r * 10.0 - t * 6.0)));
      }
    }

    // Leave everything below 0.7 untouched; roll highlights off softly.
    col = mix(col, 0.7 + 0.3 * (1.0 - exp(-(col - 0.7) / 0.3)), step(0.7, col));
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(l), col, 1.12);                      // a touch more saturation

    float grain = fract(sin(dot(gl_FragCoord.xy + fract(uTime * 7.0) * 113.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    col += grain * 0.035;
    col *= 1.0 - 0.75 * dot(d, d) * 1.6;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }`;

  function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(fragSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name.replace('[0]', '')] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  let sim, post;
  try {
    sim = program(SIM);
    post = program(POST);
  } catch (err) {
    statusEl.textContent = 'Shader error (open the console, F12)';
    statusEl.style.opacity = 1;
    console.error(err);
    return;
  }
  gl.bindVertexArray(gl.createVertexArray());

  // ---------- Render targets ----------

  let W = 0, H = 0, read = null, write = null, old = null;
  let snapOld = false;
  const TRANSITIONS = 6;   // drip, dive through, whirlpool, iris, ink, ripple
  let transition = { kind: 3, c: [0.5, 0.5] };   // the very first scene opens like an iris
  let renderScale = DEBUG ? 1 : Math.min(1, window.devicePixelRatio || 1) * 0.85;

  function makeTarget(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (floatTargets) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    gl.generateMipmap(gl.TEXTURE_2D);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo };
  }
  function freeTarget(t) {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }

  let fresh = true;
  function resize() {
    W = Math.max(64, Math.floor(window.innerWidth * renderScale));
    H = Math.max(64, Math.floor(window.innerHeight * renderScale));
    canvas.width = W; canvas.height = H;
    freeTarget(read); freeTarget(write);
    freeTarget(old);
    old = makeTarget(W, H);
    read = makeTarget(W, H);
    write = makeTarget(W, H);
    fresh = true;
    if (paused) step(0);
  }

  // ---------- Colour schemes ----------
  // Each is designed as a whole: a dark field, a 5-colour ramp that loops
  // smoothly, a glow colour for halos and traps, and a highlight for edges.

  const hex = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const SCHEMES = [
    ['Ice lace',      '02040e', ['0a1a4a', '1d4fc4', '3aa6f0', '9ff0ff', '2a2f8f'], '4fd2ff', 'eafcff'],
    ['Ember vortex',  '020414', ['0b1d5c', '2a6df0', '8fd0ff', 'ffb04a', 'e8521a'], 'ff9a3c', 'fff1c8'],
    ['Copper & teal', '0b0204', ['3a0a06', 'c2410c', 'ff8c2e', '2ee6d6', '0f5560'], 'ff7a1a', 'b0fff6'],
    ['Candy',         '070b30', ['ff7eb6', 'ffb38a', 'fff27a', '7dffb0', 'a98bff'], '7fc8ff', 'ffffff'],
    ['Ultraviolet',   '05000c', ['2a0a5e', '7b2ff7', 'f72fd1', 'ff8fe6', '5a1fb0'], 'c56bff', 'fff0ff'],
    ['Toxic bloom',   '010802', ['053b1a', '12a150', 'b8ff3c', 'fff35c', '2ad1a3'], 'c8ff4a', 'f8ffe0'],
    ['Solar flare',   '0a0200', ['3d0a00', 'b3200e', 'ff6b1a', 'ffc23d', 'fff2b0'], 'ff9a2e', 'fff6dc'],
    ['Peacock',       '01060a', ['062a3a', '0f7c8c', '2fd0b5', 'e0c341', '1a4fb3'], '3ff0d0', 'fff7d0'],
    ['Rose gold',     '0a0306', ['3b0d1f', 'a3335b', 'f27c8f', 'ffc9a8', 'd89a4b'], 'ff9fb0', 'fff0e8'],
    ['Aurora',        '01040a', ['08304a', '11a37f', '5cf2a6', '8a5cf2', '2a1a6e'], '66ffcc', 'e8fff6'],
    ['Prism',         '07040f', ['ff3d7f', 'ffb03d', 'e8ff3d', '3dffb0', '6b5cff'], 'ff8ae0', 'ffffff'],
    ['Blood moon',    '050002', ['22000c', '8a0b1e', 'ff3b1f', 'ffb347', '4b0f6b'], 'ff5a2a', 'ffe2b8'],
    ['Gold leaf',     '050302', ['2b1a07', '8a5a12', 'e0a526', 'fff0b0', '6b3f0a'], 'ffcc55', 'fffbe8'],
    ['Deep sea',      '00030a', ['001a33', '00508a', '00b3c7', '7affe4', '1a2a8a'], '33e0ff', 'e0ffff'],
    ['Sherbet',       '14061f', ['ff6fa8', 'ff9e5e', 'ffd36b', '6be3ff', 'b07bff'], 'ffb3ec', 'ffffff'],
  ].map(([name, bg, ramp, glow, hi]) => ({
    name,
    bg: hex(bg), glow: hex(glow), hi: hex(hi),
    ramp: new Float32Array(ramp.flatMap(hex)),
  }));

  // ---------- Fractal families & places worth visiting ----------

  const FAMILIES = ['Mandelbrot', 'Julia', 'Phoenix', 'Nova', 'Lace'];

  // Mandelbrot dive spots: [x, y, deepest view height].
  const SPOTS = [
    [-0.743643887037151, 0.131825904205330, 0.0012],  // seahorse valley spirals
    [-0.7453, 0.1127, 0.0016],
    [0.2860, 0.0115, 0.004],                           // elephant valley
    [-0.0880, 0.6540, 0.01],                           // triple spirals
    [-1.7687788, -0.0017390, 0.003],                   // the needle
    [-0.1015, 0.9563, 0.004],                          // snowflake arms
    [-0.1600, 1.0405, 0.02],                           // feathers around a mini-brot
    [-0.7220, 0.2460, 0.015],
    [0.4325, 0.2261, 0.006],
    [-0.5480, 0.6260, 0.004],
    [-0.761574, -0.0847596, 0.004],                    // spiral with a tail
    [-1.62917, -0.0203968, 0.004],                     // branching cross
    [-0.170337, -1.06506, 0.003],                      // lightning vine
    [0.3245046418497685, 0.04855101129280834, 0.0025], // elephant filigree
    [-0.748, 0.1, 0.006],                              // seahorse tails
    [0.42884, -0.231345, 0.003],
    [-1.940157343, 0.0, 0.0012],                       // mini-brot crown with rays
    [-0.235125, 0.827215, 0.0008],
    [-0.6744, 0.3632, 0.003],                          // frond fan
    [-0.0452407411, 0.9868162204, 0.0015],
  ];


  // Julia constants with lots going on (c values hugging the Mandelbrot edge).
  const JULIAS = [
    [-0.7269, 0.1889], [-0.8, 0.156], [0.285, 0.01], [-0.4, 0.6], [-0.835, -0.2321],
    [-0.70176, -0.3842], [-0.75, 0.11], [-0.1, 0.651], [-0.54, 0.54], [0.355534, -0.337292],
    [-0.162, 1.04], [0.37, 0.1], [-0.12, -0.77], [0.28, 0.008], [-0.7499, 0.0], [-1.476, 0.0],
  ];

  let rng = Math.random;
  const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rand = (a, b) => a + rng() * (b - a);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  // CPU escape count, used to aim the camera at detail rather than empty space.
  function cpuIter(fam, x, y, c, p, pow, maxIt) {
    let zx, zy, cx, cy, ox = 0, oy = 0;
    if (fam === 0) { zx = c[0]; zy = c[1]; cx = x; cy = y; } else { zx = x; zy = y; cx = c[0]; cy = c[1]; }
    for (let i = 0; i < maxIt; i++) {
      let nx, ny;
      if (fam === 2) {
        nx = zx * zx - zy * zy + cx + p[0] * ox - p[1] * oy;
        ny = 2 * zx * zy + cy + p[0] * oy + p[1] * ox;
        ox = zx; oy = zy;
      } else {
        let px = zx, py = zy;
        for (let j = 1; j < pow; j++) { const t = px * zx - py * zy; py = px * zy + py * zx; px = t; }
        nx = px + cx; ny = py + cy;
      }
      zx = nx; zy = ny;
      if (zx * zx + zy * zy > 1e6) return i;
    }
    return maxIt;
  }

  // Spiral points. A repelling periodic point z* of z^n + c with multiplier
  // λ (the derivative of the p-fold map there) is a centre of exact
  // self-similarity: zooming in by |λ| while turning by arg λ shows the same
  // picture again. So the camera can spiral into smaller and smaller copies
  // forever, looping seamlessly, without running out of float precision.
  const cmul2 = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  function cycleStep(z, c, pow, p) {
    let w = z, d = [1, 0];
    for (let k = 0; k < p; k++) {
      let wp = [1, 0];
      for (let j = 1; j < pow; j++) wp = cmul2(wp, w);
      d = cmul2([pow * wp[0], pow * wp[1]], d);
      w = cmul2(wp, w);
      w = [w[0] + c[0], w[1] + c[1]];
    }
    return { w, d };
  }
  function spiralPoint(c, pow) {
    const found = [];
    for (let p = 1; p <= 6; p++) for (let t = 0; t < 25; t++) {
      let z = [rand(-1.4, 1.4), rand(-1.4, 1.4)], ok = false;
      for (let it = 0; it < 60; it++) {
        const { w, d } = cycleStep(z, c, pow, p);
        const gx = w[0] - z[0], gy = w[1] - z[1], dx = d[0] - 1, dy = d[1];
        const dd = dx * dx + dy * dy;
        if (!(dd > 1e-20)) break;
        const sx = (gx * dx + gy * dy) / dd, sy = (gy * dx - gx * dy) / dd;
        z = [z[0] - sx, z[1] - sy];
        if (!isFinite(z[0]) || Math.abs(z[0]) > 4) break;
        if (sx * sx + sy * sy < 1e-26) { ok = true; break; }
      }
      if (!ok) continue;
      let w = z, minimal = true;
      for (let k = 1; k < p; k++) {
        w = cycleStep(w, c, pow, 1).w;
        if (Math.hypot(w[0] - z[0], w[1] - z[1]) < 1e-7) { minimal = false; break; }
      }
      if (!minimal) continue;
      const lam = cycleStep(z, c, pow, p).d;
      const m = Math.hypot(lam[0], lam[1]), a = Math.atan2(lam[1], lam[0]);
      if (m < 1.8 || m > 8 || Math.abs(a) < 0.35 || Math.abs(a) > Math.PI - 0.35) continue;
      found.push({ z, m, a, p, twist: Math.abs(a) / Math.log(m) });
    }
    if (!found.length) return null;
    found.sort((x, y) => y.twist - x.twist);
    return pick(found.slice(0, Math.min(4, found.length)));
  }

  // CPU distance estimate to the set (0 inside), for judging empty space.
  function cpuDist(fam, x, y, c, p, pow, maxIt) {
    let zx, zy, cx, cy, dx, dy, ox = 0, oy = 0, odx = 0, ody = 0;
    if (fam === 0) { zx = c[0]; zy = c[1]; cx = x; cy = y; dx = 0; dy = 0; }
    else { zx = x; zy = y; cx = c[0]; cy = c[1]; dx = 1; dy = 0; }
    for (let i = 0; i < maxIt; i++) {
      let nx, ny, ndx, ndy;
      if (fam === 2) {
        ndx = 2 * (zx * dx - zy * dy) + p[0] * odx - p[1] * ody;
        ndy = 2 * (zx * dy + zy * dx) + p[0] * ody + p[1] * odx;
        nx = zx * zx - zy * zy + cx + p[0] * ox - p[1] * oy;
        ny = 2 * zx * zy + cy + p[0] * oy + p[1] * ox;
        ox = zx; oy = zy; odx = dx; ody = dy;
      } else {
        let px = 1, py = 0;
        for (let j = 1; j < pow; j++) { const t = px * zx - py * zy; py = px * zy + py * zx; px = t; }
        ndx = pow * (px * dx - py * dy) + (fam === 0 ? 1 : 0);
        ndy = pow * (px * dy + py * dx);
        nx = px * zx - py * zy + cx; ny = px * zy + py * zx + cy;
      }
      zx = nx; zy = ny; dx = ndx; dy = ndy;
      const r2 = zx * zx + zy * zy;
      if (r2 > 1e6) {
        const r = Math.sqrt(r2), dz = Math.hypot(dx, dy);
        return dz > 0 && isFinite(dz) ? 0.5 * r * Math.log(r) / dz : 0;
      }
    }
    return 0;
  }

  // Find a point inside the view that sits right on the fractal's frilly edge.
  function findDetail(fam, c, p, pow, cx, cy, h) {
    let best = null, bestScore = -1;
    for (let k = 0; k < 400; k++) {
      const x = cx + rand(-0.8, 0.8) * h, y = cy + rand(-0.45, 0.45) * h;
      const it = cpuIter(fam, x, y, c, p, pow, 300);
      if (it >= 300) continue;
      const score = it + rng() * 6;
      if (score > bestScore) { bestScore = score; best = [x, y]; }
    }
    return best || [cx, cy];
  }

  // Where the dive target sits on screen: off-centre, on the thirds.
  function composition() {
    if (rng() < 0.25) return [rand(-0.05, 0.05), rand(-0.05, 0.05)];
    return [pick([-1, 1]) * rand(0.18, 0.3), pick([-1, 1]) * rand(0.1, 0.18)];
  }

  function styleFor() {
    // weights: ribbons, lace, filament, nebula — mostly one style with a bit of another
    const styles = [[1, 0.25, 0, 0], [0, 1, 0.3, 0], [0, 0.3, 1, 0], [0.2, 0.6, 0, 0.5], [0, 0, 0.6, 0.6], [0, 0.3, 0, 1]];
    const s = pick(styles).slice();
    const sum = s.reduce((a, b) => a + b, 0);
    return s.map((x) => x / sum * 1.0);
  }

  let familyChoice = -1;           // -1 = auto
  const recentSchemes = [];        // colour schemes shown lately (not repeated for a while)

  function pickFamily(prev) {
    if (familyChoice >= 0) return FAMILIES[familyChoice];
    let famName;
    do { famName = pick(['Mandelbrot', 'Mandelbrot', 'Mandelbrot', 'Julia', 'Julia', 'Julia', 'Phoenix', 'Nova', 'Lace']); }
    while (prev && famName === prev.famName && rng() < 0.8);
    return famName;
  }

  function randomScene(prev, famName = pickFamily(prev)) {
    const fam = FAMILIES.indexOf(famName);

    let scheme;
    do { scheme = Math.floor(rng() * SCHEMES.length); } while (recentSchemes.includes(scheme));

    const s = {
      fam, famName, scheme,
      c0: [0, 0], cR: 0, cW: 0, cPh: rand(0, 6.28),
      p: [0, 0], pow: 2,
      trap: [rand(-0.5, 0.5), rand(-0.5, 0.5)], trapK: rand(5, 14),
      style: styleFor(),
      look: [rand(0.8, 2.2), rand(0.5, 1), rng() < 0.5 ? 1 : 0, rng() < 0.6 ? pick([3, 5, 7]) : 0],
      cycleSpeed: rand(0.035, 0.08) * pick([-1, 1]),
      rot0: rand(0, 6.28), rotSpeed: rand(0.01, 0.03) * pick([-1, 1]),
      target: [0, 0], screen: composition(),
      hOut: 3, hIn: 0.5, period: rand(55, 85), phase0: rand(0.05, 0.2),
      maxIter: 220,
    };

    if (famName === 'Mandelbrot') {
      const spot = pick(SPOTS);
      s.target = [spot[0], spot[1]];
      s.hIn = Math.max(spot[2] * rand(0.4, 1), 3.5e-4);
      s.hOut = s.hIn * rand(30, 80);
      s.period = rand(40, 60);
      s.maxIter = 500;
      s.trap = [rand(-0.3, 0.3), rand(-0.3, 0.3)];
    } else if (famName === 'Julia') {
      if (rng() < 0.35) {
        s.pow = pick([3, 4, 5, 6]);
        s.c0 = multiC(s.pow);
      } else {
        s.c0 = rng() < 0.6 ? pick(JULIAS).slice() : boundaryC();
      }
      s.cR = rand(0.004, 0.02); s.cW = rand(0.04, 0.1);
      s.hOut = rand(1.7, 2.3);
      s.hIn = rand(0.12, 0.5);
      s.target = rng() < 0.25 ? [0, 0] : findDetail(1, s.c0, s.p, s.pow, 0, 0, 1.6);
      if (s.target[0] === 0 && s.target[1] === 0) s.screen = [0, 0];
      // Most Julia scenes spiral forever into a self-similar point.
      const sp = rng() < 0.7 ? spiralPoint(s.c0, s.pow) : null;
      if (sp) {
        s.cR = 0;
        s.spiral = { z: sp.z, m: sp.m, a: sp.a, p: sp.p, u: rng() * 0.5,
                     rate: rand(0.16, 0.28) };     // e-folds of zoom per second
        s.target = sp.z;
        // Self-similarity is exact only near z*: the wider the zoom step, the
        // smaller the neighbourhood that matches itself, so frame accordingly.
        s.hOut = Math.max(rand(0.3, 0.6) / Math.sqrt(sp.m) / Math.sqrt(sp.p), 0.0006 * sp.m);
        s.hIn = s.hOut / sp.m;
        s.phase0 = 0;
        s.rotSpeed = 0;
        s.maxIter = 300;
      }
    } else if (famName === 'Phoenix') {
      s.c0 = [rand(0.53, 0.58), rand(-0.02, 0.02)];
      s.p = [rand(-0.55, -0.45), rand(-0.03, 0.03)];
      s.cR = rand(0.003, 0.01); s.cW = rand(0.04, 0.08);
      s.hOut = rand(1.1, 1.5); s.hIn = rand(0.45, 0.8);
      s.rot0 = Math.PI / 2 + rand(-0.2, 0.2); s.rotSpeed *= 0.3;
      s.target = findDetail(2, s.c0, s.p, 2, 0, 0, 1.1);
      s.maxIter = 200;
    } else if (famName === 'Nova') {
      s.c0 = [rand(-0.5, 0.5), rand(-0.5, 0.5)];
      s.p = [1, 0];
      s.cR = rand(0.02, 0.08); s.cW = rand(0.03, 0.07);
      s.hOut = rand(2.5, 4); s.hIn = rand(0.4, 1.2);
      s.target = [rand(-0.5, 0.5), rand(-0.5, 0.5)];
      s.maxIter = 60;
      s.look[0] = rand(0.5, 1.2);
    } else {
      s.c0 = [rand(-1.1, -0.45), rand(-0.7, -0.2)];
      s.cR = rand(0.01, 0.04); s.cW = rand(0.03, 0.06);
      s.hOut = rand(2.2, 3.0); s.hIn = rand(1.2, 1.8);
      s.target = [rand(-0.4, 0.4), rand(-0.4, 0.4)];
      s.maxIter = Math.floor(rand(8, 12));
      s.trap = [rand(-1, 1), rand(-1, 1)];
      s.trapK = rand(9, 16);
      s.look[0] = rand(0.7, 1.4);
    }
    if (s.style[2] < 0.05) s.look[3] = 0;          // stripe average only feeds the filament style
    else if (!s.look[3]) s.look[3] = pick([3, 5, 7]);
    return s;
  }

  // A c just outside the Mandelbrot set: its Julia is a spray of spirals.
  function boundaryC() {
    for (let k = 0; k < 2000; k++) {
      const a = rand(0, 6.28), r = rand(0.3, 1.0);
      const x = -0.25 + Math.cos(a) * r * 1.1, y = Math.sin(a) * r * 1.1;
      const it = cpuIter(0, x, y, [0, 0], [0, 0], 2, 400);
      if (it > 40 && it < 400) return [x, y];
    }
    return pick(JULIAS).slice();
  }
  // Same idea for z^n + c (the multibrot of that power).
  function multiC(pow) {
    for (let k = 0; k < 3000; k++) {
      const x = rand(-1.3, 1.3), y = rand(-1.3, 1.3);
      const it = cpuIter(0, x, y, [0, 0], [0, 0], pow, 300);
      if (it > 25 && it < 300) return [x, y];
    }
    return [0.5, 0.3];
  }

  // Does this scene's view stay interesting through the whole dive? Samples
  // a grid of the view at the start, middle and deepest point and rejects
  // views that are mostly inside the set or nearly featureless.
  // Nova convergence count on the CPU (for judging flat, featureless views).
  function cpuNova(x, y, c, maxIt) {
    let zx = x, zy = y;
    for (let i = 0; i < maxIt; i++) {
      const z2x = zx * zx - zy * zy, z2y = 2 * zx * zy;
      const z3x = z2x * zx - z2y * zy - 1, z3y = z2x * zy + z2y * zx;
      const dx = 3 * z2x, dy = 3 * z2y, dd = dx * dx + dy * dy;
      if (dd < 1e-20) return i;
      const qx = (z3x * dx + z3y * dy) / dd, qy = (z3y * dx - z3x * dy) / dd;
      const nx = zx - qx + c[0], ny = zy - qy + c[1];
      const step = Math.hypot(nx - zx, ny - zy);
      zx = nx; zy = ny;
      if (step < 1e-4) return i;
    }
    return maxIt;
  }

  function viewOk(s) {
    if (s.fam === 4) return true;
    if (s.fam === 3) {
      // Nova: reject views dominated by one smooth, fast-converging basin.
      for (const ph of [s.phase0, 0.25, 0.5]) {
        const dive = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
        const h = Math.exp(Math.log(s.hOut) + (Math.log(s.hIn) - Math.log(s.hOut)) * dive);
        const NX = 16, NY = 10, g = [];
        for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
          const u = (i / (NX - 1) - 0.5) * 1.7, v = (j / (NY - 1) - 0.5) * 0.98;
          g.push(cpuNova(s.target[0] + u * h, s.target[1] + v * h, s.c0, s.maxIter));
        }
        // Busy samples sit where the count jumps between neighbours (the
        // glassy boundary); smooth basins have none. Need enough of them.
        let busy = 0;
        for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
          const n0 = g[i * NY + j];
          const nb = [i > 0 && g[(i - 1) * NY + j], i < NX - 1 && g[(i + 1) * NY + j], j > 0 && g[i * NY + j - 1], j < NY - 1 && g[i * NY + j + 1]];
          if (nb.some((n) => n !== false && Math.abs(n - n0) >= 3)) busy++;
        }
        if (busy / (NX * NY) < 0.4) return false;
      }
      return true;
    }
    // Julia constants drift during a scene: check along the drift too.
    if (s.fam === 1 && s.cR > 0) {
      for (const k of [0, 2.1, 4.2]) {
        const ph = s.cPh + k;
        const c = [s.c0[0] + s.cR * Math.cos(ph), s.c0[1] + s.cR * Math.sin(ph * 1.3)];
        if (!viewOkAt(s, c)) return false;
      }
      return true;
    }
    return viewOkAt(s, s.c0);
  }
  function viewOkAt(s, cJ) {
    const fam = s.fam === 0 ? 0 : s.fam === 1 ? 1 : 2;
    const zc = s.fam === 0 ? [0, 0] : cJ;
    const phases = s.spiral ? [0, 0.25, 0.5] : [s.phase0, 0.25, 0.5];
    for (const ph of phases) {
      const dive = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
      const h = s.spiral ? s.hOut * Math.pow(s.spiral.m, -ph * 2)
        : Math.exp(Math.log(s.hOut) + (Math.log(s.hIn) - Math.log(s.hOut)) * dive);
      const rot = s.spiral ? s.rot0 - s.spiral.a * ph * 2 : s.rot0 + s.rotSpeed * (ph - s.phase0) * s.period;
      const cs = Math.cos(rot), sn = Math.sin(rot);
      let inside = 0, n = 0, far = 0;
      const seen = new Set();
      for (let i = 0; i < 14; i++) for (let j = 0; j < 9; j++) {
        const u = (i / 13 - 0.5) * 1.7 - s.screen[0], v = (j / 8 - 0.5) * 0.98 - s.screen[1];
        const x = s.target[0] + (cs * u - sn * v) * h, y = s.target[1] + (sn * u + cs * v) * h;
        const it = cpuIter(fam, x, y, zc, s.p, s.pow, s.maxIter);
        n++;
        if (it >= s.maxIter) { inside++; continue; }
        seen.add(it);
        // Far from any structure (by more than ~8% of the screen) reads as
        // empty space: keep that to a minority of the view.
        if (cpuDist(fam, x, y, zc, s.p, s.pow, s.maxIter) > 0.08 * h) far++;
      }
      // Phoenix's escape counts cluster, so it needs fewer distinct values;
      // otherwise it must fill the screen like everything else (if it can't,
      // goodScene falls back to another family).
      const px = s.fam === 2;
      if (inside / n > 0.4 || seen.size < (px ? 8 : 12) || far / n > 0.35) return false;
    }
    return true;
  }
  function goodScene(prev) {
    let famName = pickFamily(prev), s;
    for (let i = 0; i < 80; i++) {
      // If a family can't find a good view, fall back to one that always can.
      if (i === 40 && familyChoice < 0) famName = pick(['Julia', 'Mandelbrot']);
      s = randomScene(prev, famName);
      if (viewOk(s)) return s;
    }
    return s;
  }

  // ---------- State ----------

  let scene = goodScene(null);
  recentSchemes.push(scene.scheme);
  let sceneT = 0;            // seconds in this scene (speed-scaled)
  let holdT = 0;             // wall seconds in this scene
  let meltT = 0;             // 0→1 during a scene change (starts by condensing out of black)
  let time = 0;
  let paused = false;
  let morph = false;
  let mouseN = [0, 0], morphV = [0, 0];
  let userPan = [0, 0], userZoom = 1;
  let prevCam = null;


  function camera(s, t) {
    let h, rot;
    if (s.spiral) {
      // Zoom by |λ| and turn by arg λ per loop; u wraps 1 → 0 seamlessly.
      const u = s.spiral.u;
      h = s.hOut * Math.pow(s.spiral.m, -u) / userZoom;
      rot = s.rot0 - s.spiral.a * u;
    } else {
      const ph = s.phase0 + t / s.period;
      const dive = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
      h = Math.exp(Math.log(s.hOut) + (Math.log(s.hIn) - Math.log(s.hOut)) * dive) / userZoom;
      rot = s.rot0 + s.rotSpeed * t;
    }
    h = Math.max(h, 3e-4 * Math.max(1, H / 1000));
    const scale = h / H;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    // Keep the dive target pinned at its spot on screen.
    const sx = s.screen[0] * H, sy = s.screen[1] * H;
    const cx = s.target[0] - (cs * sx - sn * sy) * scale + userPan[0];
    const cy = s.target[1] - (sn * sx + cs * sy) * scale + userPan[1];
    return { cx, cy, scale, rot };
  }

  function setScene(s) {
    scene = s;
    recentSchemes.push(s.scheme);
    if (recentSchemes.length > 4) recentSchemes.shift();
    sceneT = 0; holdT = 0; meltT = 0;
    userPan = [0, 0]; userZoom = 1;
    snapOld = true;
    // A different transition each time (never the same twice running).
    let kind;
    do { kind = Math.floor(Math.random() * TRANSITIONS); } while (kind === transition.kind);
    transition = { kind, c: [0.3 + 0.4 * Math.random(), 0.3 + 0.4 * Math.random()] };
  }
  function nextScene() { setScene(goodScene(scene)); }

  // ---------- Frame ----------

  let jitterI = 0;
  function step(dt) {
    const s = scene;
    const cam = camera(s, sceneT);
    const ph = s.cPh + sceneT * s.cW;
    let c = [s.c0[0] + s.cR * Math.cos(ph), s.c0[1] + s.cR * Math.sin(ph * 1.3)];
    let p = s.p.slice();
    // Morph: the cursor nudges the fractal's constant, reshaping it live.
    if (s.famName === 'Mandelbrot') c = [morphV[0] * 0.25, morphV[1] * 0.25];
    else if (s.famName === 'Phoenix') { p[0] += morphV[0] * 0.08; p[1] += morphV[1] * 0.08; }
    else { c[0] += morphV[0] * (s.famName === 'Julia' ? 0.05 : 0.12); c[1] += morphV[1] * (s.famName === 'Julia' ? 0.05 : 0.12); }

    // A spiral loop just wrapped: the view jumped back out by λ, which shows
    // the same picture, so map last frame's camera through the same jump.
    if (s.spiral && s.spiral.wrapped && prevCam) {
      const { z, m, a } = s.spiral;
      const dx = prevCam.cx - z[0], dy = prevCam.cy - z[1];
      const lr = m * Math.cos(a), li = m * Math.sin(a);
      prevCam = { cx: z[0] + lr * dx - li * dy, cy: z[1] + li * dx + lr * dy, scale: prevCam.scale * m, rot: prevCam.rot + a };
    }
    if (s.spiral) s.spiral.wrapped = false;

    // Reprojection: previous pixel = A * pixel + B.
    let A = [1, 0, 0, 1], B = [0, 0];
    if (prevCam) {
      const dr = cam.rot - prevCam.rot, k = cam.scale / prevCam.scale;
      const c1 = Math.cos(dr) * k, s1 = Math.sin(dr) * k;
      A = [c1, s1, -s1, c1]; // column-major mat2
      const dx = (cam.cx - prevCam.cx) / prevCam.scale, dy = (cam.cy - prevCam.cy) / prevCam.scale;
      const pc = Math.cos(-prevCam.rot), ps = Math.sin(-prevCam.rot);
      B = [pc * dx - ps * dy, ps * dx + pc * dy];
    }
    prevCam = cam;

    // Temporal anti-aliasing: blend each new jittered frame into the
    // re-projected history (frame-rate independent).
    const dt60 = Math.min(3, dt * 60);
    let k = 0.72;
    // Scene change: keep a snapshot of the old picture for the post pass to
    // melt away, and start the history over with only the new scene.
    if (snapOld && read) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, old.fbo);
      gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, old.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      snapOld = false;
      fresh = true;
    }
    if (fresh) k = 0;
    k = Math.pow(k, dt60 || 1);

    const jit = [((jitterI * 0.618034) % 1) - 0.5, ((jitterI * 0.754878) % 1) - 0.5];
    jitterI++;

    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, W, H);
    gl.useProgram(sim.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, read.tex);
    const u = sim.u;
    const sc = SCHEMES[s.scheme];
    const hi = Math.fround(cam.cx), hj = Math.fround(cam.cy);
    gl.uniform1i(u.uPrev, 0);
    gl.uniform2f(u.uRes, W, H);
    gl.uniform1f(u.uTime, time);
    gl.uniform1i(u.uFam, s.fam);
    gl.uniform1i(u.uPow, s.pow);
    gl.uniform1i(u.uMaxIter, s.maxIter);
    gl.uniform2f(u.uC, c[0], c[1]);
    gl.uniform2f(u.uP, p[0], p[1]);
    gl.uniform2f(u.uTrap, s.trap[0], s.trap[1]);
    gl.uniform2f(u.uCamHi, hi, hj);
    gl.uniform2f(u.uCamLo, cam.cx - hi, cam.cy - hj);
    gl.uniform2f(u.uRotCS, Math.cos(cam.rot), Math.sin(cam.rot));
    gl.uniform2f(u.uJit, jit[0], jit[1]);
    gl.uniform1f(u.uScale, cam.scale);
    gl.uniformMatrix2fv(u.uRA, false, A);
    gl.uniform2f(u.uRB, B[0], B[1]);
    gl.uniform4fv(u.uStyle, s.style);
    gl.uniform4fv(u.uLook, s.look);
    gl.uniform1f(u.uCycle, s.cycleSpeed * sceneT);
    gl.uniform1f(u.uTrapK, s.trapK);
    gl.uniform3fv(u.uBg, sc.bg);
    gl.uniform3fv(u.uGlow, sc.glow);
    gl.uniform3fv(u.uHi, sc.hi);
    gl.uniform3fv(u.uRamp, sc.ramp);
    gl.uniform1f(u.uK, k);
    gl.uniform1f(u.uMuShift, s.spiral ? s.spiral.p * s.spiral.u : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    [read, write] = [write, read];
    fresh = false;

    gl.bindTexture(gl.TEXTURE_2D, read.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(post.p);
    gl.uniform1i(post.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, old.tex);
    gl.uniform1i(post.u.uOld, 1);
    gl.activeTexture(gl.TEXTURE0);
    const mt = Math.min(1, meltT);
    gl.uniform1f(post.u.uMeltT, mt);
    gl.uniform1i(post.u.uTrans, transition.kind);
    gl.uniform2f(post.u.uTransC, transition.c[0], transition.c[1]);
    gl.uniform1f(post.u.uNewW, mt < 1 ? Math.min(1, mt / 0.35) ** 1.2 : 1);
    gl.uniform1f(post.u.uOldW, mt < 1 ? 1 - (Math.max(0, mt - 0.15) / 0.85) ** 1.3 : 0);
    gl.uniform2f(post.u.uRes, W, H);
    gl.uniform1f(post.u.uTime, time);
    gl.uniform1f(post.u.uBloom, settings.glow * 1.6);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // If the GPU can't keep up, quietly drop resolution; if a heavy scene
  // forced it down, climb back once frames have been quick for a while.
  const baseScale = renderScale;
  let slowFrames = 0, fastTime = 0, upWait = 8;   // upWait doubles after each failed climb
  function adapt(dt) {
    if (DEBUG) return;
    if (dt > 0.026) slowFrames++;
    else slowFrames = Math.max(0, slowFrames - 1);
    fastTime = dt < 0.0185 ? fastTime + dt : 0;
    if (slowFrames > 40 && renderScale > 0.35) {
      renderScale *= 0.85;
      slowFrames = 0; fastTime = 0; upWait *= 2;
      resize();
    } else if (fastTime > upWait && renderScale < baseScale) {
      renderScale = Math.min(baseScale, renderScale / 0.85);
      fastTime = 0;
      resize();
    }
  }

  function update(dt) {
    const sdt = dt * settings.speed;
    time += sdt;
    sceneT += sdt;
    holdT += dt;
    if (meltT < 1) meltT = Math.min(1, meltT + dt / settings.meltSeconds);
    const sp = scene.spiral;
    if (sp) {
      sp.u += sdt * sp.rate / Math.log(sp.m);
      if (sp.u >= 1) { sp.u -= 1; sp.wrapped = true; }
    }
    if (holdT > settings.holdSeconds && !DEBUG) nextScene();
    const target = morph ? mouseN : [0, 0];
    morphV = [morphV[0] + (target[0] - morphV[0]) * Math.min(1, dt * 3),
              morphV[1] + (target[1] - morphV[1]) * Math.min(1, dt * 3)];
  }

  let last = performance.now();
  function frame(now) {
    const rawDt = (now - last) / 1000;
    last = now;
    if (!paused) {
      if (rawDt < 0.1) adapt(rawDt);
      const dt = Math.min(0.1, rawDt);
      update(dt);
      wobble.update(dt);
      step(dt);
    }
    requestAnimationFrame(frame);
  }

  // ---------- Controls ----------

  let flashTimer = 0;
  function flash(msg) {
    const el = document.getElementById('flash');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('show'), 1600);
  }

  const wobble = window.SliderWobble({
    settings,
    flash,
    curves: { speed: (x) => 0.08 + 1.92 * Math.pow(x, 1.5) },   // 0.08× … 2×, start ≈ 1×
    defaults: {
      speed: { start: 0.62, range: 0.3, speed: 0.3 },
      glow: { start: 0.5, range: 0.5, speed: 0.35 },
    },
  });

  function describe(s) {
    const fam = s.famName === 'Julia' && s.pow > 2 ? `Julia ×${s.pow}` : s.famName;
    return `${fam} · ${SCHEMES[s.scheme].name}`;
  }
  function setPaused(on) {
    paused = on;
    document.getElementById('btn-dream').textContent = on ? 'Flow ▶' : 'Pause ❚❚';
  }
  function toggleMorph() {
    morph = !morph;
    document.getElementById('btn-cursor').textContent = `Morph: ${morph ? 'On' : 'Off'}`;
    flash(morph ? 'Morph on: move the cursor to reshape the fractal' : 'Morph off');
  }
  function cycleFamily() {
    familyChoice = familyChoice + 1 >= FAMILIES.length ? -1 : familyChoice + 1;
    const label = familyChoice < 0 ? 'Auto' : FAMILIES[familyChoice];
    document.getElementById('btn-family').textContent = `Fractal: ${label}`;
    nextScene();
    flash(familyChoice < 0 ? `Fractal: Auto · ${describe(scene)}` : describe(scene));
  }
  function newVibe() {
    nextScene();
    flash(describe(scene));
  }
  function savePng() {
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `fractal-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }

  document.getElementById('btn-new').onclick = newVibe;
  document.getElementById('btn-family').onclick = cycleFamily;
  document.getElementById('btn-cursor').onclick = toggleMorph;
  document.getElementById('btn-dream').onclick = () => setPaused(!paused);
  document.getElementById('btn-save').onclick = savePng;
  document.getElementById('btn-full').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };

  const holdEl = document.getElementById('sl-hold');
  const holdVal = document.getElementById('hold-val');
  function setHold() {
    const v = parseFloat(holdEl.value);
    const never = v >= parseFloat(holdEl.max);
    settings.holdSeconds = never ? Infinity : v;
    holdVal.textContent = never ? 'never' : v < 60 ? `${v}s` : `${Math.floor(v / 60)}m${v % 60 ? ` ${v % 60}s` : ''}`;
  }
  holdEl.value = settings.holdSeconds;
  holdEl.oninput = setHold;
  setHold();

  // Drag to pan, scroll to zoom (both reset with the next scene).
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    mouseN = [(e.clientX / window.innerWidth) * 2 - 1, 1 - (e.clientY / window.innerHeight) * 2];
    if (!drag) return;
    const cam = camera(scene, sceneT);
    const dx = (e.clientX - drag.x) * renderScale, dy = -(e.clientY - drag.y) * renderScale;
    const cs = Math.cos(cam.rot), sn = Math.sin(cam.rot);
    userPan[0] -= (cs * dx - sn * dy) * cam.scale;
    userPan[1] -= (sn * dx + cs * dy) * cam.scale;
    drag = { x: e.clientX, y: e.clientY };
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    userZoom = Math.min(400, Math.max(0.3, userZoom * Math.exp(-e.deltaY * 0.0015)));
  }, { passive: false });

  const ui = document.getElementById('ui');
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key.toLowerCase()) {
      case ' ': e.preventDefault(); setPaused(!paused); break;
      case 'n': newVibe(); break;
      case 'p': cycleFamily(); break;
      case 'c': toggleMorph(); break;
      case 'w': wobble.toggleAll(); break;
      case 's': savePng(); break;
      case 'f': document.getElementById('btn-full').click(); break;
      case 'h': ui.classList.toggle('hidden'); break;
      case 't': location.href = 'lightshow.html'; break;
      case 'escape': wobble.closeAll(); break;
    }
  });

  let idleTimer = 0;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
  }
  window.addEventListener('mousemove', wake);
  window.addEventListener('touchstart', wake);
  wake();

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  // Debug hook for screenshots: FX.show({...overrides}, seconds, frames).
  if (DEBUG) {
    ui.style.display = 'none';
    window.FX = {
      SCHEMES, FAMILIES, SPOTS, JULIAS, randomScene, describe, settings,
      show(over = {}, t = 10, frames = 1, seed = 1) {
        rng = mulberry(seed);
        const fc = familyChoice;
        if (over.famName) familyChoice = FAMILIES.indexOf(over.famName);
        const s = Object.assign(randomScene(null), over);
        familyChoice = fc;
        rng = Math.random;
        setScene(s);
        meltT = 1; fresh = true; prevCam = null;
        sceneT = t; time = t;
        if (s.spiral) s.spiral.u = (t * s.spiral.rate / Math.log(s.spiral.m)) % 1;
        for (let i = 0; i < frames; i++) { step(1 / 60); sceneT += 1 / 60; time += 1 / 60; }
        return describe(s);
      },
      run(frames, dt = 1 / 60) { for (let i = 0; i < frames; i++) { update(dt); step(dt); } },
      get scene() { return scene; },
      next(over = {}, seed = 7) {
        rng = mulberry(seed);
        const fc = familyChoice;
        if (over.famName) familyChoice = FAMILIES.indexOf(over.famName);
        const { famName, trans, ...rest } = over;
        setScene(Object.assign(goodScene(scene), rest));
        if (trans != null) transition.kind = trans;
        familyChoice = fc;
        rng = Math.random;
        return describe(scene);
      },
      pause() { setPaused(true); },
    };
    paused = true;
  }

  resize();
  if (!DEBUG) flash(describe(scene));
  requestAnimationFrame(frame);
})();
