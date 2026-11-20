'use strict';
// Liquid light show: a 60s concert-projection / tie-dye shader with a melting
// feedback loop. Pass 1 draws the scene blended over a warped copy of the
// previous frame (so everything smears, flows and drips); pass 2 adds a wet
// glossy sheen, chromatic fringing, glow, fabric grain and vignette.

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

  const settings = {
    flow: 1,        // overall speed
    melt: 0.9,      // feedback amount (trail length)
    cycle: 1,       // colour cycling speed
    holdSeconds: 18,
    fadeSeconds: 9,
  };

  // ---------- Shaders ----------

  const VERT = `#version 300 es
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const COMMON = `#version 300 es
  precision highp float;
  out vec4 outColor;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
      s += a * noise(p);
      p = ROT * p * 2.03 + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return s;
  }
  vec2 rot(vec2 v, float a) {
    float c = cos(a), s = sin(a);
    return mat2(c, s, -s, c) * v;
  }
  float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  `;

  const SIM = COMMON + `
  uniform sampler2D uPrev;
  uniform vec2 uRes;
  uniform float uTime, uClock, uMelt, uDrift, uFlow, uMix, uHueMul;
  uniform vec2 uMouse, uMouseVel, uCenter;
  uniform float uPresence, uHold;
  uniform vec4 uA0, uA1, uA2, uB0, uB1, uB2;
  uniform vec3 uPalA[5], uPalB[5];
  uniform float uFlowW[6];
  uniform vec4 uDrops[8];   // x, y, age, colour seed

  // Cyclic 5-colour gradient. Low "soft" keeps colours pure with quick
  // transitions (tie-dye); high soft blends smoothly (oil).
  vec3 grad(vec3 P[5], float t, float soft) {
    t = fract(t) * 5.0;
    int i = min(int(t), 4);
    int j = i == 4 ? 0 : i + 1;
    float f = smoothstep(0.5 - soft, 0.5 + soft, fract(t));
    return mix(P[i], P[j], f);
  }
  vec3 ink(float t) {
    return mix(grad(uPalA, t, 0.25), grad(uPalB, t, 0.25), uMix);
  }

  vec3 scene(vec2 p, float t, vec4 P0, vec4 P1, vec4 P2, vec3 pal[5]) {
    float sym = P0.x, warp = P0.y, scale = P0.z, spiral = P0.w;
    float bands = P1.x, mode = P1.y, crinkle = P1.z;
    float hue = t * P2.w * uHueMul;

    float r = length(p);
    float a = atan(p.y, p.x) + t * 0.03;
    if (sym > 0.5) {               // kaleidoscope fold
      float seg = 6.2831853 / sym;
      a = abs(mod(a, seg) - seg * 0.5);
    }
    vec2 dir = vec2(cos(a), sin(a));
    vec2 k = r * dir;

    // Domain-warped noise: the "liquid".
    vec2 q = k * scale;
    vec2 w1 = vec2(fbm(q + vec2(0.0, t * 0.13)), fbm(q + vec2(5.2, 1.3) - t * 0.10));
    vec2 w2 = vec2(fbm(q + warp * w1 + vec2(1.7, 9.2) + t * 0.08),
                   fbm(q + warp * w1 + vec2(8.3, 2.8) - t * 0.06));
    float f = fbm(q + warp * w2);

    // Tie-dye: spiral bands of pure palette colour that bleed along creases.
    float n = noise(dir * 3.8 + vec2(r * 5.0 - t * 0.2, r * 3.0));
    float s = a / 6.2831853 + spiral * log(r + 0.08)
            + 0.3 * warp * (f - 0.5) + crinkle * 0.18 * (n - 0.5) - t * 0.02;
    float b = s * bands;
    float bi = floor(b), bf = fract(b);
    vec3 dye = mix(grad(pal, (bi + 0.5) / 5.0 + hue, 0.08),
                   grad(pal, (bi + 1.5) / 5.0 + hue, 0.08),
                   smoothstep(0.6, 1.0, bf));
    dye *= mix(1.0, 0.55, smoothstep(0.78, 0.97, bf));       // dye pools at the edge
    float gap = 1.0 - smoothstep(0.0, 0.05 + 0.08 * n, bf);  // undyed tie lines
    dye = mix(dye, vec3(0.97, 0.93, 0.85), gap * 0.6 * crinkle);
    dye = mix(dye, dye * dye * 1.4, 0.3 * f);

    // Oil projection: palette blobs, inky membranes, thin-film shimmer.
    float v = f + 0.6 * length(w1 - 0.5);
    vec3 oil = grad(pal, v * 1.3 + hue, 0.45);
    float d = abs(fract(v * 4.0 - t * 0.05) - 0.5);
    float line = smoothstep(0.40, 0.48, d);
    vec3 irid = grad(pal, v * 5.0 + 0.4, 0.4);
    oil *= 0.55 + 0.7 * smoothstep(0.25, 0.75, f);
    oil += irid * 0.4 * smoothstep(0.28, 0.40, d) * (1.0 - line);
    oil *= 1.0 - 0.85 * line;
    oil = mix(vec3(lum(oil)), oil, 1.2);

    return clamp(mix(dye, oil, mode), 0.0, 1.2);
  }

  vec3 hueRotate(vec3 c, float h) {
    const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
    const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
    vec3 y = toYIQ * c;
    y.yz = rot(y.yz, h);
    return toRGB * y;
  }

  void main() {
    vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
    float t = uTime;

    // Cursor lens: bulge + ripples like a fingertip in the oil.
    vec2 md = p - uMouse;
    float mr = length(md);
    vec2 mdir = md / (mr + 1e-4);
    float near = exp(-mr * mr * 6.0) * uPresence;
    vec2 lp = uMouse + md * (1.0 - 0.35 * near);
    lp += mdir * sin(mr * 40.0 - uClock * 4.0) * 0.022 * near;

    float breath = 0.5 + 0.5 * sin(t * 0.5);   // slow in-and-out, ~12s
    vec2 sp = (lp - uCenter) * (1.0 + 0.08 * breath);
    vec3 s = scene(sp, t, uA0, uA1, uA2, uPalA);
    if (uMix > 0.001) s = mix(s, scene(sp, t, uB0, uB1, uB2, uPalB), uMix);

    // ---- Flow patterns: where each pixel pulls last frame's paint from ----
    float F = uFlow;
    vec2 q = p - uCenter;
    vec2 np = p * 1.5 + t * 0.05;
    float e = 0.02, n0 = noise(np);
    vec2 curl = vec2(noise(np + vec2(0.0, e)) - n0, -(noise(np + vec2(e, 0.0)) - n0)) / e;
    vec2 off = vec2(0.0);
    // 0 bloom: outward from the centre
    off += uFlowW[0] * (rot(q * (1.0 - 0.005 * F), 0.0015 * F) - q + curl * 0.002 * F);
    // 1 tunnel: inward, counter-twisting
    off += uFlowW[1] * (rot(q * (1.0 + 0.006 * F), -0.003 * F) - q + curl * 0.002 * F);
    // 2 drip: paint runs down in uneven streaks
    float dn = noise(vec2(p.x * 9.0, t * 0.15));
    off += uFlowW[2] * (vec2(0.0008 * sin(p.y * 8.0 + t), 0.002 + 0.009 * dn * dn) + curl * 0.001) * F;
    // 3 twin vortex: two whirlpools circling each other
    vec2 v1 = 0.45 * vec2(cos(t * 0.1), 0.6 * sin(t * 0.13));
    vec2 d1 = q - v1, d2 = q + v1;
    off += uFlowW[3] * (rot(d1, 0.03 * F * exp(-dot(d1, d1) * 5.0)) - d1
                      + rot(d2, -0.03 * F * exp(-dot(d2, d2) * 5.0)) - d2 + curl * 0.0015 * F);
    // 4 marble: sideways curl-noise currents
    off += uFlowW[4] * (curl * 0.007 + vec2(0.0015, 0.0)) * F;
    // 5 galaxy: tight spiral arms
    off += uFlowW[5] * (rot(q * (1.0 - 0.003 * F), (0.012 * exp(-dot(q, q) * 1.5) + 0.002) * F) - q);
    vec2 fp = p + off;

    // Whirlpool under the cursor (always on, stronger while holding).
    float cf = min(F * F, 1.5);             // follows the Flow slider (squared: fades out fast)
    float vort = (0.02 + 0.03 * uHold) * near * cf;
    vec2 rel = (fp - uMouse) * (1.0 - (0.006 + 0.006 * uHold) * near * cf);
    fp = uMouse + rot(rel, vort);
    fp -= uMouseVel * exp(-mr * mr * 8.0);   // drag the paint with the pointer

    // Splash shockwaves push old paint outward.
    for (int i = 0; i < 8; i++) {
      vec4 D = uDrops[i];
      if (D.z > 4.0) continue;
      vec2 dv = p - D.xy;
      float dl = length(dv);
      float ring = exp(-pow((dl - D.z * 0.5) * 18.0, 2.0)) * exp(-D.z * 1.5);
      fp -= dv / (dl + 1e-4) * ring * 0.012;
    }

    vec2 fuv = vec2(fp.x * uRes.y / uRes.x, fp.y) + 0.5;
    vec3 prev = hueRotate(texture(uPrev, fuv).rgb, uDrift);

    float boost = uFlowW[1] * 0.2 + uFlowW[2] * 0.75 + uFlowW[3] * 0.4 + uFlowW[4] * 0.55 + uFlowW[5] * 0.3;
    float m = uMelt * (0.88 + 0.12 * noise(p * 2.0 - t * 0.1));
    m = max(m, mix(m, 0.985, boost * smoothstep(0.3, 0.7, noise(p * 1.3 + t * 0.04))));
    m = max(m, mix(m, 0.97, near * 0.7));     // cursor swirls linger
    vec3 col = mix(s, prev, m);

    // Splashes: a blob with a ragged crown, flung droplets and a bright ring.
    for (int i = 0; i < 8; i++) {
      vec4 D = uDrops[i];
      if (D.z > 4.0) continue;
      float age = D.z;
      vec2 dv = p - D.xy;
      float dl = length(dv);
      vec3 c = ink(D.w) * 1.15;
      float rad = (0.02 + 0.08 * (1.0 - exp(-age * 5.0))) * (0.7 + 0.6 * noise(dv / (dl + 1e-4) * 2.5 + D.w * 50.0));
      float blob = (1.0 - smoothstep(rad - 0.012, rad, dl)) * exp(-age * 3.0);
      col = mix(col, c, blob * 0.55);
      float ring = exp(-pow((dl - age * 0.5) * 22.0, 2.0)) * exp(-age * 2.0);
      col += ink(D.w + 0.4) * ring * 0.2;
      for (int j = 0; j < 3; j++) {
        float fj = float(j);
        float aj = D.w * 40.0 + fj * 1.37 + fj * fj * 0.31;
        float dj = (0.06 + 0.06 * fract(D.w * 13.0 + fj * 0.618)) * (1.0 - exp(-age * 6.0));
        vec2 sat = D.xy + dj * vec2(cos(aj), sin(aj));
        float sr = 0.01 * (0.6 + 0.8 * fract(D.w * 7.0 + fj * 0.37)) * exp(-age * 1.5);
        float drop = 1.0 - smoothstep(sr * 0.4, sr, length(p - sat));
        col = mix(col, c, drop * 0.6 * exp(-age * 2.5));
      }
    }

    outColor = vec4(clamp(col, 0.0, 1.5), 1.0);
  }`;

  const POST = COMMON + `
  uniform sampler2D uTex;
  uniform vec2 uRes;
  uniform float uTime;

  void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec2 c = uv - 0.5;

    // Chromatic fringing, stronger toward the edges (that 60s "vibrating" look).
    vec2 off = c * (0.004 + 0.02 * dot(c, c));
    vec3 col = vec3(texture(uTex, uv - off).r, texture(uTex, uv).g, texture(uTex, uv + off).b);

    // Wet paint: treat brightness as height, light it, add glossy highlights.
    vec2 tx = 1.5 / uRes;
    float hL = lum(texture(uTex, uv - vec2(tx.x, 0.0)).rgb);
    float hR = lum(texture(uTex, uv + vec2(tx.x, 0.0)).rgb);
    float hD = lum(texture(uTex, uv - vec2(0.0, tx.y)).rgb);
    float hU = lum(texture(uTex, uv + vec2(0.0, tx.y)).rgb);
    vec3 N = normalize(vec3((hL - hR) * 4.0, (hD - hU) * 4.0, 1.0));
    vec3 L = normalize(vec3(-0.5, 0.6, 0.8));
    float shade = dot(N, L) / L.z;
    col *= mix(1.0, shade, 0.3);
    float spec = pow(max(dot(N, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 48.0);
    col += spec * 0.4 * vec3(1.0, 0.96, 0.9);

    // Cheap glow.
    vec3 glow = vec3(0.0);
    vec2 asp = vec2(uRes.y / uRes.x, 1.0);
    for (int i = 0; i < 8; i++) {
      float an = float(i) * 0.785398 + 0.3;
      glow += texture(uTex, uv + vec2(cos(an), sin(an)) * asp * 0.014).rgb;
    }
    glow /= 8.0;
    col += glow * glow * 0.4;

    col = col / (1.0 + col * 0.25) * 1.12;      // soft shoulder

    // Fabric / poster-paper texture and film grain.
    vec2 px = gl_FragCoord.xy;
    float fiber = noise(px * vec2(0.35, 0.05)) * 0.6 + noise(px * vec2(0.06, 0.4)) * 0.4;
    col *= 0.9 + 0.14 * fiber;
    float grain = fract(sin(dot(px + fract(uTime * 7.0) * 113.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    col += grain * 0.05;

    col *= 1.0 - 0.9 * dot(c, c);                // vignette
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

  let W = 0, H = 0, read = null, write = null;
  let renderScale = Math.min(1, window.devicePixelRatio || 1) * 0.8;

  function makeTarget(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (floatTargets) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
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

  function resize() {
    W = Math.max(64, Math.floor(window.innerWidth * renderScale));
    H = Math.max(64, Math.floor(window.innerHeight * renderScale));
    canvas.width = W; canvas.height = H;
    freeTarget(read); freeTarget(write);
    read = makeTarget(W, H);
    write = makeTarget(W, H);
    if (paused) step(true);
  }

  // ---------- Palettes ----------
  // Hand-picked 5-colour sets: each has a dark anchor, a mid and bright pops,
  // ordered so neighbours blend cleanly (the gradient also wraps last→first).

  const PALETTES = [
    ['Fillmore',      '2b0f54', 'ab1f65', 'ff4f4f', 'ff9a3c', 'ffd23f'],
    ['Neon candy',    '9b5de5', 'f15bb5', 'fee440', '00bbf9', '00f5d4'],
    ['Tie-dye',       'a34dff', 'ff1f5a', 'ffb800', '3ddc84', '1e90ff'],
    ['Violet ember',  '10002b', '3c096c', '9d4edd', 'ff6d00', 'ffba08'],
    ['Lagoon',        '012a4a', '01497c', '2a9d8f', 'e9c46a', 'f4a261'],
    ['Wildfire',      '370617', '9d0208', 'e85d04', 'faa307', 'ffdd55'],
    ['Acid',          '1b0c3d', '7a1fa2', 'ff4ecd', 'c6ff00', '3ddc97'],
    ['Cosmic',        '03071e', '3a0ca3', '4361ee', '4cc9f0', 'f72585'],
    ['Electric',      '2d00f7', '8900f2', 'db00b6', 'ff4d6d', 'ffb703'],
    ['Mango',         '3d0c11', 'd1495b', 'edae49', '00798c', '30638e'],
    ['Dream',         '6a4c93', 'ff99c8', 'fcf6bd', 'a9def9', '1982c4'],
    ['Synthwave',     '0d0221', '541388', 'f72585', 'ff8500', '2de2e6'],
    ['Garden',        '073b4c', '118ab2', '06d6a0', 'ffd166', 'ef476f'],
    ['Aurora',        '001219', '0a9396', '94d2bd', 'ee9b00', 'ae2012'],
    ['Rose quartz',   '2a0a29', '7b1e5a', 'e05297', 'ffb3c6', 'ffe5ec'],
    ['Deep jungle',   '081c15', '1b4332', '52b788', 'd8f3dc', 'ff7b54'],
  ].map(([name, ...hex]) => ({
    name,
    rgb: new Float32Array(hex.flatMap((h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255))),
  }));

  // ---------- Flow patterns ----------

  const PATTERNS = ['Bloom', 'Tunnel', 'Drip', 'Twin vortex', 'Marble', 'Galaxy'];
  let patternChoice = -1;           // -1 = auto (changes with each vibe)
  let activePattern = 0;
  const flowW = new Float32Array([1, 0, 0, 0, 0, 0]);

  function autoPattern() {
    // Mostly the classic outward bloom, sometimes something else.
    return Math.random() < 0.45 ? 0 : 1 + Math.floor(Math.random() * (PATTERNS.length - 1));
  }

  // ---------- Scenes ("vibes") ----------
  // p: sym, warp, scale, spiral | bands, mode, crinkle, - | -, -, -, hueSpeed

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function randomScene(prev) {
    const m = Math.random();
    const mode = m < 0.4 ? rand(0, 0.15) : m < 0.8 ? rand(0.85, 1) : rand(0.3, 0.7);
    const sym = pick([0, 0, 3, 4, 5, 6, 6, 8, 10, 12]);
    // Without a kaleidoscope, band counts must be multiples of 5 to avoid a seam.
    const bands = sym === 0 ? pick([5, 10]) : Math.floor(rand(3, 9));
    let pal;
    do { pal = Math.floor(Math.random() * PALETTES.length); } while (prev && pal === prev.pal);
    const pattern = patternChoice >= 0 ? patternChoice : autoPattern();
    return {
      p: [sym, rand(1, 3.5), rand(0.8, 2.2), rand(-1.8, 1.8),
          bands, mode, rand(0.3, 1), 0,
          0, 0, 0, rand(0.01, 0.04) * (Math.random() < 0.5 ? -1 : 1)],
      pal,
      pattern,
      // How far the centre wanders: the bloom often stays put, others roam.
      wander: pattern === 0 && Math.random() < 0.5 ? 0 : rand(0.4, 1),
    };
  }

  let sceneA = randomScene(null), sceneB = null;
  let holdT = 0, fadeT = 0;
  let wander = sceneA.wander;
  activePattern = sceneA.pattern;

  function nextVibe() {
    if (sceneB && fadeT > 0.5) sceneA = sceneB;
    sceneB = randomScene(sceneA);
    activePattern = sceneB.pattern;
    fadeT = 0; holdT = 0;
  }

  // ---------- Pointer: stir, splash, pour ----------

  const mouse = [10, 10];
  let pendingVel = [0, 0], mouseVel = [0, 0];
  let presence = 0, presenceTarget = 0;   // fades the cursor effect in/out
  let holding = false, hold = 0, pourT = 0;
  let cursorFx = true;                    // stir / splash / pour enabled
  const drops = [];                       // {x, y, age, seed}
  const dropData = new Float32Array(32);

  function toScene(e) {
    return [(e.clientX - window.innerWidth / 2) / window.innerHeight,
            -(e.clientY - window.innerHeight / 2) / window.innerHeight];
  }
  function trackPointer(e) {
    const p = toScene(e);
    if (cursorFx && mouse[0] < 5) { pendingVel[0] += p[0] - mouse[0]; pendingVel[1] += p[1] - mouse[1]; }
    mouse[0] = p[0]; mouse[1] = p[1];
    presenceTarget = cursorFx ? 1 : 0;
  }
  function addDrop() {
    drops.push({ x: mouse[0], y: mouse[1], age: 0, seed: Math.random() });
    if (drops.length > 8) drops.shift();
  }

  window.addEventListener('pointermove', trackPointer);
  canvas.addEventListener('pointerdown', (e) => {
    if (mouse[0] > 5) pendingVel = [0, 0];
    trackPointer(e);
    if (!cursorFx) return;
    holding = true; pourT = 0;
    addDrop();
  });
  window.addEventListener('pointerup', () => { holding = false; });
  window.addEventListener('pointercancel', () => { holding = false; });
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) presenceTarget = 0; });
  window.addEventListener('blur', () => { presenceTarget = 0; holding = false; });

  // ---------- Loop ----------

  let time = Math.random() * 100, clock = 0;
  let paused = false;
  const center = [0, 0];

  function setScene(prefix, sc) {
    const s = sc.p;
    gl.uniform4f(sim.u[prefix + '0'], s[0], s[1], s[2], s[3]);
    gl.uniform4f(sim.u[prefix + '1'], s[4], s[5], s[6], s[7]);
    gl.uniform4f(sim.u[prefix + '2'], s[8], s[9], s[10], s[11]);
  }

  function step(fresh) {
    const mix = sceneB ? fadeT * fadeT * (3 - 2 * fadeT) : 0;
    const B = sceneB || sceneA;

    for (let i = 0; i < 8; i++) {
      const d = drops[i];
      dropData.set(d ? [d.x, d.y, d.age, d.seed] : [0, 0, 99, 0], i * 4);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, W, H);
    gl.useProgram(sim.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, read.tex);
    const u = sim.u;
    gl.uniform1i(u.uPrev, 0);
    gl.uniform2f(u.uRes, W, H);
    gl.uniform1f(u.uTime, time);
    gl.uniform1f(u.uClock, clock);
    gl.uniform1f(u.uMelt, fresh ? 0 : settings.melt);
    gl.uniform1f(u.uDrift, 0.003 * settings.cycle);
    gl.uniform1f(u.uHueMul, settings.cycle);
    gl.uniform1f(u.uFlow, settings.flow);
    gl.uniform1f(u.uMix, mix);
    gl.uniform2f(u.uMouse, mouse[0], mouse[1]);
    gl.uniform2f(u.uMouseVel, mouseVel[0], mouseVel[1]);
    gl.uniform2f(u.uCenter, center[0], center[1]);
    gl.uniform1f(u.uPresence, presence);
    gl.uniform1f(u.uHold, hold);
    setScene('uA', sceneA);
    setScene('uB', B);
    gl.uniform3fv(u.uPalA, PALETTES[sceneA.pal].rgb);
    gl.uniform3fv(u.uPalB, PALETTES[B.pal].rgb);
    gl.uniform1fv(u.uFlowW, flowW);
    gl.uniform4fv(u.uDrops, dropData);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    [read, write] = [write, read];

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(post.p);
    gl.bindTexture(gl.TEXTURE_2D, read.tex);
    gl.uniform1i(post.u.uTex, 0);
    gl.uniform2f(post.u.uRes, W, H);
    gl.uniform1f(post.u.uTime, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // If the GPU can't keep up, quietly drop resolution.
  let slowFrames = 0;
  function adapt(dt) {
    if (dt > 0.026) slowFrames++;
    else slowFrames = Math.max(0, slowFrames - 1);
    if (slowFrames > 40 && renderScale > 0.35) {
      renderScale *= 0.85;
      slowFrames = 0;
      resize();
    }
  }

  function update(dt) {
    time += dt * settings.flow;
    clock += dt;

    if (sceneB) {
      fadeT += dt / Math.min(settings.fadeSeconds, Math.max(3, settings.holdSeconds * 0.6));
      if (fadeT >= 1) { sceneA = sceneB; sceneB = null; fadeT = 0; holdT = 0; }
    } else {
      holdT += dt;
      if (holdT > settings.holdSeconds) nextVibe();
    }

    // Ease between flow patterns and centre wander.
    const ease = Math.min(1, dt * 0.6);
    for (let i = 0; i < flowW.length; i++) flowW[i] += ((i === activePattern ? 1 : 0) - flowW[i]) * ease;
    wander += ((sceneB || sceneA).wander - wander) * ease;
    center[0] = wander * 0.35 * Math.sin(time * 0.11 + 1.3);
    center[1] = wander * 0.22 * Math.sin(time * 0.083 + 0.4);

    // Smooth the pointer's motion over a few frames: mouse events arrive
    // unevenly, which made slow drags look jerky.
    const k = 0.25;
    mouseVel = [mouseVel[0] * (1 - k) + pendingVel[0] * 0.8 * k,
                mouseVel[1] * (1 - k) + pendingVel[1] * 0.8 * k];
    pendingVel = [0, 0];
    presence += (presenceTarget - presence) * Math.min(1, dt * 2);
    hold += ((holding ? 1 : 0) - hold) * Math.min(1, dt * 4);

    // Holding the button pours a stream of splashes.
    if (holding) {
      pourT += dt;
      if (pourT > 0.25) { pourT = 0; addDrop(); }
    }
    for (const d of drops) d.age += dt;
    while (drops.length && drops[0].age > 4) drops.shift();
  }

  let last = performance.now();
  function frame(now) {
    const rawDt = (now - last) / 1000;
    last = now;
    if (!paused) {
      if (rawDt < 0.1) adapt(rawDt);
      update(Math.min(0.1, rawDt));
      step(false);
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
    flashTimer = setTimeout(() => el.classList.remove('show'), 1500);
  }

  function setPaused(on) {
    paused = on;
    document.getElementById('btn-dream').textContent = on ? 'Flow ▶' : 'Pause ❚❚';
  }
  function toggleCursor() {
    cursorFx = !cursorFx;
    if (!cursorFx) { presenceTarget = 0; holding = false; pendingVel = [0, 0]; }
    document.getElementById('btn-cursor').textContent = `Cursor: ${cursorFx ? 'On' : 'Off'}`;
    flash(cursorFx ? 'Cursor effects on' : 'Cursor effects off');
  }
  function cyclePattern() {
    patternChoice = patternChoice + 1 >= PATTERNS.length ? -1 : patternChoice + 1;
    const label = patternChoice < 0 ? 'Auto' : PATTERNS[patternChoice];
    if (patternChoice >= 0) activePattern = patternChoice;
    document.getElementById('btn-pattern').textContent = `Pattern: ${label}`;
    flash(patternChoice < 0 ? 'Pattern: Auto (changes with each vibe)' : `Pattern: ${label}`);
  }
  function newVibe() {
    nextVibe();
    flash(`${PALETTES[sceneB.pal].name} · ${PATTERNS[activePattern]}`);
  }
  function savePng() {
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `lightshow-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }

  document.getElementById('btn-new').onclick = newVibe;
  document.getElementById('btn-pattern').onclick = cyclePattern;
  document.getElementById('btn-cursor').onclick = toggleCursor;
  document.getElementById('btn-dream').onclick = () => setPaused(!paused);
  document.getElementById('btn-save').onclick = savePng;
  document.getElementById('btn-full').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };

  function bindSlider(id, key) {
    const el = document.getElementById(id);
    el.value = settings[key];
    el.oninput = () => { settings[key] = parseFloat(el.value); };
  }
  bindSlider('sl-flow', 'flow');
  bindSlider('sl-melt', 'melt');
  bindSlider('sl-cycle', 'cycle');

  // How long each design stays before morphing to the next (far right = never).
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

  const ui = document.getElementById('ui');
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key.toLowerCase()) {
      case ' ': e.preventDefault(); setPaused(!paused); break;
      case 'n': newVibe(); break;
      case 'p': cyclePattern(); break;
      case 'c': toggleCursor(); break;
      case 's': savePng(); break;
      case 'f': document.getElementById('btn-full').click(); break;
      case 'h': ui.classList.toggle('hidden'); break;
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

  resize();
  requestAnimationFrame(frame);
})();
