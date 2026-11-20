'use strict';
// App: animation loop, morphing between "sheep", controls, sharing.

(() => {
  const canvas = document.getElementById('art');
  const ctx = canvas.getContext('2d');
  const ui = document.getElementById('ui');
  const statusEl = document.getElementById('status');

  const settings = {
    resolution: 0.6,   // fraction of screen pixels rendered while animating
    brightness: 1.6,
    gamma: 2.2,
    trails: 0.85,      // histogram decay per frame
    speed: 1,          // rotation speed multiplier
    holdSeconds: 12,   // time on each sheep before morphing
    morphSeconds: 6,
  };

  let W = 0, H = 0, hist = null, img = null;
  let current = null, target = null;
  let morphT = 0, holdT = 0, phase = 0;
  let dreaming = true;
  let iterBudget = 40000;
  let stillSamples = 0;
  const STILL_LIMIT = 40e6;

  function aspect() { return window.innerWidth / window.innerHeight; }

  function resize() {
    const res = dreaming ? settings.resolution : Math.min(1, (window.devicePixelRatio || 1));
    W = Math.max(64, Math.floor(window.innerWidth * res));
    H = Math.max(64, Math.floor(window.innerHeight * res));
    canvas.width = W; canvas.height = H;
    hist = Flame.makeHist(W, H);
    img = ctx.createImageData(W, H);
    stillSamples = 0;
  }

  function newSheep(immediate) {
    const g = Flame.randomGenome(aspect());
    if (immediate || !current) {
      current = g; target = null;
      if (hist) Flame.clearHist(hist);
      stillSamples = 0;
    } else {
      target = g; morphT = 0;
    }
    holdT = 0;
  }

  function displayed() {
    if (!target) return current;
    const t = morphT * morphT * (3 - 2 * morphT); // smoothstep
    return Flame.lerpGenome(current, target, t);
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    if (dreaming) {
      phase += dt * 0.25 * settings.speed;
      if (target) {
        morphT += dt / settings.morphSeconds;
        if (morphT >= 1) { current = target; target = null; holdT = 0; }
      } else {
        holdT += dt;
        if (holdT > settings.holdSeconds) newSheep(false);
      }
    }

    const doIterate = dreaming || stillSamples < STILL_LIMIT;
    if (doIterate) {
      const cg = Flame.compile(displayed(), phase);
      const t0 = performance.now();
      Flame.iterate(cg, hist, { w: W, h: H }, iterBudget);
      const spent = performance.now() - t0;
      // Adapt work to keep ~60fps.
      const goal = dreaming ? 11 : 30;
      iterBudget = Math.max(5000, Math.min(2e6, iterBudget * Math.min(1.5, Math.max(0.5, goal / Math.max(spent, 0.1)))));
      if (!dreaming) stillSamples += iterBudget;

      Flame.render(hist, img, {
        brightness: settings.brightness,
        gamma: settings.gamma,
        decay: dreaming ? settings.trails : 1,
      });
      ctx.putImageData(img, 0, 0);
    }

    if (!dreaming) {
      const pct = Math.min(100, Math.round(stillSamples / STILL_LIMIT * 100));
      statusEl.textContent = pct < 100 ? `Rendering still… ${pct}%` : 'Still complete';
    } else {
      statusEl.textContent = target ? 'Morphing…' : '';
    }
    requestAnimationFrame(frame);
  }

  // ---------- Actions ----------

  function setDreaming(on) {
    dreaming = on;
    if (!on && target) { current = displayed(); target = null; } // freeze mid-morph
    if (!on) {
      // Bake the current rotation into the still so it matches what was on screen.
      current = bakeRotation(current, phase);
      phase = 0;
    }
    resize();
    document.getElementById('btn-dream').textContent = on ? 'Pause ❚❚' : 'Dream ▶';
  }

  function bakeRotation(g, ph) {
    const cg = Flame.compile(g, ph);
    const out = JSON.parse(JSON.stringify(g));
    let j = 0;
    out.xforms.forEach((x) => {
      if (x.w <= 0) return;
      const c = cg.xforms[j++];
      x.coefs = [c.a, c.b, c.c, c.d, c.e, c.f];
    });
    return out;
  }

  function savePng() {
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `flame-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }

  function shareLink() {
    const g = bakeRotation(target ? displayed() : current, phase);
    const json = JSON.stringify(g, (k, v) => typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v);
    const hash = btoa(unescape(encodeURIComponent(json)));
    history.replaceState(null, '', '#' + hash);
    const url = location.href;
    if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
    flash('Link copied — this exact sheep');
  }

  function loadFromHash() {
    if (location.hash.length < 2) return false;
    try {
      const g = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1)))));
      if (!g.xforms || !g.pal) return false;
      current = g; target = null; phase = 0;
      return true;
    } catch { return false; }
  }

  let flashTimer = 0;
  function flash(msg) {
    const el = document.getElementById('flash');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---------- Controls ----------

  document.getElementById('btn-new').onclick = () => newSheep(!dreaming);
  document.getElementById('btn-dream').onclick = () => setDreaming(!dreaming);
  document.getElementById('btn-save').onclick = savePng;
  document.getElementById('btn-share').onclick = shareLink;
  document.getElementById('btn-full').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };

  function bindSlider(id, key) {
    const el = document.getElementById(id);
    el.value = settings[key];
    el.oninput = () => { settings[key] = parseFloat(el.value); if (!dreaming) stillSamples = Math.min(stillSamples, STILL_LIMIT - 1); };
  }
  bindSlider('sl-trails', 'trails');
  bindSlider('sl-speed', 'speed');
  bindSlider('sl-bright', 'brightness');

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key.toLowerCase()) {
      case ' ': e.preventDefault(); setDreaming(!dreaming); break;
      case 'n': newSheep(!dreaming); break;
      case 's': savePng(); break;
      case 'l': shareLink(); break;
      case 'f': document.getElementById('btn-full').click(); break;
      case 'h': ui.classList.toggle('hidden'); break;
    }
  });

  // Auto-hide controls when the mouse is idle.
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

  // ---------- Start ----------
  resize();
  if (!loadFromHash()) newSheep(true);
  else setDreaming(false);
  requestAnimationFrame(frame);
})();
