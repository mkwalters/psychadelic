'use strict';
// Liquid light show: a 60s concert-projection / tie-dye shader with a melting
// feedback loop. Pass 1 draws the scene blended over a warped copy of the
// previous frame (so everything smears, flows and colour-shifts); pass 2 adds
// chromatic fringing, glow, fabric grain and vignette.

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
    drift: 0.012,   // hue rotation of trails per frame (radians)
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
  `;

  const SIM = COMMON + `
  uniform sampler2D uPrev;
  uniform vec2 uRes;
  uniform float uTime, uMelt, uDrift, uFlow, uMix;
  uniform vec2 uMouse, uMouseVel;
  uniform vec4 uA0, uA1, uA2, uB0, uB1, uB2;

  vec3 pal(float t, float c, vec3 d) {
    return 0.55 + 0.45 * cos(6.2831853 * (c * t + d));
  }

  vec3 scene(vec2 p, float t, vec4 P0, vec4 P1, vec4 P2) {
    float sym = P0.x, warp = P0.y, scale = P0.z, spiral = P0.w;
    float bands = P1.x, mode = P1.y, crinkle = P1.z, palC = P1.w;
    vec3 palD = P2.xyz;
    float hue = t * P2.w;

    float r = length(p);
    float a = atan(p.y, p.x) + t * 0.03;
    if (sym > 0.5) {               // kaleidoscope fold
      float seg = 6.2831853 / sym;
      a = abs(mod(a, seg) - seg * 0.5);
    }
    vec2 k = r * vec2(cos(a), sin(a));

    // Domain-warped noise: the "liquid".
    vec2 q = k * scale;
    vec2 w1 = vec2(fbm(q + vec2(0.0, t * 0.13)), fbm(q + vec2(5.2, 1.3) - t * 0.10));
    vec2 w2 = vec2(fbm(q + warp * w1 + vec2(1.7, 9.2) + t * 0.08),
                   fbm(q + warp * w1 + vec2(8.3, 2.8) - t * 0.06));
    float f = fbm(q + warp * w2);

    // Tie-dye: spiral bands that bleed along radial fabric creases.
    float n = noise(vec2(a * 24.0, r * 5.0 - t * 0.2));
    float s = a / 6.2831853 + spiral * log(r + 0.08)
            + 0.3 * warp * (f - 0.5) + crinkle * 0.18 * (n - 0.5) - t * 0.02;
    float b = s * bands;
    float bi = floor(b), bf = fract(b);
    vec3 dye = mix(pal(bi / bands + hue, palC, palD),
                   pal((bi + 1.0) / bands + hue, palC, palD),
                   smoothstep(0.6, 1.0, bf));
    dye *= mix(1.0, 0.55, smoothstep(0.78, 0.97, bf));       // dye pools at the edge
    float gap = 1.0 - smoothstep(0.0, 0.05 + 0.08 * n, bf);  // undyed tie lines
    dye = mix(dye, vec3(0.97, 0.92, 0.82), gap * 0.7 * crinkle);
    dye = mix(dye, dye * dye * 1.4, 0.35 * f);

    // Oil projection: saturated blobs, inky membranes, thin-film shimmer.
    float v = f + 0.6 * length(w1 - 0.5);
    vec3 oil = pal(v * 1.6 + hue, palC, palD + 0.15);
    float d = abs(fract(v * 4.0 - t * 0.05) - 0.5);
    float line = smoothstep(0.40, 0.48, d);
    vec3 irid = 0.5 + 0.5 * cos(6.2831853 * (v * 7.0 + vec3(0.0, 0.33, 0.67)));
    oil *= 0.5 + 0.75 * smoothstep(0.25, 0.75, f);
    oil += irid * 0.35 * smoothstep(0.28, 0.40, d) * (1.0 - line);
    oil *= 1.0 - 0.85 * line;
    float ol = dot(oil, vec3(0.299, 0.587, 0.114));
    oil = mix(vec3(ol), oil, 1.6) * 1.1;                      // projector-bright dyes

    vec3 col = mix(dye, oil, mode);
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    return clamp(mix(vec3(l), col, 1.35), 0.0, 1.2);
  }

  vec3 hueRotate(vec3 c, float h) {
    const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
    const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
    vec3 y = toYIQ * c;
    float cs = cos(h), sn = sin(h);
    y.yz = mat2(cs, sn, -sn, cs) * y.yz;
    return toRGB * y;
  }

  void main() {
    vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
    float t = uTime;

    float breath = 0.5 + 0.5 * sin(t * 0.5);   // slow in-and-out, ~12s
    vec2 sp = p * (1.0 + 0.08 * breath);
    vec3 s = scene(sp, t, uA0, uA1, uA2);
    if (uMix > 0.001) s = mix(s, scene(sp, t, uB0, uB1, uB2), uMix);

    // Where to pull the previous frame from: zoom + twist + curl-noise flow,
    // so old colour streams outward and swirls like oil on water.
    vec2 np = p * 1.5 + t * 0.05;
    float e = 0.02, n0 = noise(np);
    vec2 g = vec2(noise(np + vec2(e, 0.0)) - n0, noise(np + vec2(0.0, e)) - n0) / e;
    vec2 fp = p * (1.0 - 0.005 * uFlow);
    float ra = 0.0015 * uFlow;
    fp = mat2(cos(ra), sin(ra), -sin(ra), cos(ra)) * fp;
    fp += vec2(g.y, -g.x) * 0.002 * uFlow;
    vec2 md = p - uMouse;
    fp -= uMouseVel * exp(-dot(md, md) * 14.0);   // stir with the pointer

    vec2 fuv = vec2(fp.x * uRes.y / uRes.x, fp.y) + 0.5;
    vec3 prev = hueRotate(texture(uPrev, fuv).rgb, uDrift);
    float m = uMelt * (0.88 + 0.12 * noise(p * 2.0 - t * 0.1));
    outColor = vec4(clamp(mix(s, prev, m), 0.0, 1.5), 1.0);
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
      u[name] = gl.getUniformLocation(p, name);
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
    if (paused) step(0, true);
  }

  // ---------- Scenes ("vibes") ----------
  // 12 numbers: sym, warp, scale, spiral | bands, mode, crinkle, palC | palD.rgb, hueSpeed

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const PALETTES = [
    [0.0, 0.33, 0.67],   // classic rainbow tie-dye
    [0.0, 0.1, 0.2],     // fire: red, orange, gold
    [0.5, 0.2, 0.25],    // magenta / teal
    [0.8, 0.9, 0.3],     // acid lime / violet
    [0.3, 0.2, 0.2],     // blood orange / turquoise
  ];

  function randomScene() {
    const m = Math.random();
    const mode = m < 0.4 ? rand(0, 0.15) : m < 0.8 ? rand(0.85, 1) : rand(0.3, 0.7);
    const d = Math.random() < 0.6 ? pick(PALETTES) : [Math.random(), Math.random(), Math.random()];
    return [
      pick([0, 0, 3, 4, 5, 6, 6, 8, 10, 12]), rand(1, 3.5), rand(0.8, 2.2), rand(-1.8, 1.8),
      Math.floor(rand(3, 9)), mode, rand(0.3, 1), Math.floor(rand(1, 4)),
      d[0], d[1], d[2], rand(0.01, 0.05) * (Math.random() < 0.5 ? -1 : 1),
    ];
  }

  let sceneA = randomScene(), sceneB = null;
  let holdT = 0, fadeT = 0;

  function nextVibe() {
    if (sceneB) { if (fadeT > 0.5) sceneA = sceneB; }
    sceneB = randomScene();
    fadeT = 0; holdT = 0;
  }

  // ---------- Pointer stirring ----------

  const mouse = [10, 10];
  let pendingVel = [0, 0], mouseVel = [0, 0];
  function toScene(e) {
    return [(e.clientX - window.innerWidth / 2) / window.innerHeight,
            -(e.clientY - window.innerHeight / 2) / window.innerHeight];
  }
  window.addEventListener('pointermove', (e) => {
    const p = toScene(e);
    if (mouse[0] < 5) { pendingVel[0] += p[0] - mouse[0]; pendingVel[1] += p[1] - mouse[1]; }
    mouse[0] = p[0]; mouse[1] = p[1];
  });

  // ---------- Loop ----------

  let time = Math.random() * 100;
  let paused = false;

  function setScene(prefix, s) {
    gl.uniform4f(sim.u[prefix + '0'], s[0], s[1], s[2], s[3]);
    gl.uniform4f(sim.u[prefix + '1'], s[4], s[5], s[6], s[7]);
    gl.uniform4f(sim.u[prefix + '2'], s[8], s[9], s[10], s[11]);
  }

  function step(dt, fresh) {
    const mix = sceneB ? fadeT * fadeT * (3 - 2 * fadeT) : 0;

    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, W, H);
    gl.useProgram(sim.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, read.tex);
    gl.uniform1i(sim.u.uPrev, 0);
    gl.uniform2f(sim.u.uRes, W, H);
    gl.uniform1f(sim.u.uTime, time);
    gl.uniform1f(sim.u.uMelt, fresh ? 0 : settings.melt);
    gl.uniform1f(sim.u.uDrift, settings.drift);
    gl.uniform1f(sim.u.uFlow, settings.flow);
    gl.uniform1f(sim.u.uMix, mix);
    gl.uniform2f(sim.u.uMouse, mouse[0], mouse[1]);
    gl.uniform2f(sim.u.uMouseVel, mouseVel[0], mouseVel[1]);
    setScene('uA', sceneA);
    setScene('uB', sceneB || sceneA);
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

  let last = performance.now();
  function frame(now) {
    const rawDt = (now - last) / 1000;
    last = now;
    const dt = Math.min(0.1, rawDt);
    if (!paused) {
      if (rawDt < 0.1) adapt(rawDt);
      time += dt * settings.flow;
      if (sceneB) {
        fadeT += dt / settings.fadeSeconds;
        if (fadeT >= 1) { sceneA = sceneB; sceneB = null; fadeT = 0; holdT = 0; }
      } else {
        holdT += dt;
        if (holdT > settings.holdSeconds) nextVibe();
      }
      mouseVel = [pendingVel[0] * 0.6, pendingVel[1] * 0.6];
      pendingVel = [0, 0];
      step(dt, false);
    }
    requestAnimationFrame(frame);
  }

  // ---------- Controls ----------

  function setPaused(on) {
    paused = on;
    document.getElementById('btn-dream').textContent = on ? 'Flow ▶' : 'Pause ❚❚';
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

  document.getElementById('btn-new').onclick = nextVibe;
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
  bindSlider('sl-drift', 'drift');

  const ui = document.getElementById('ui');
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key.toLowerCase()) {
      case ' ': e.preventDefault(); setPaused(!paused); break;
      case 'n': nextVibe(); break;
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
