'use strict';
// Slider wobble, shared by the pages. Any `.ctl[data-key]` block holding a
// range input gets a ∿ button: when on, the slider drifts by itself around
// the position you set (the centre), with an adjustable Range and Speed.
// The motion blends three sines at unrelated rates so it never obviously
// repeats and different sliders never fall into step.
//
//   const wobble = SliderWobble({ settings, defaults, curves, flash });
//   wobble.update(dt)   // call every frame
//
// `settings[key]` receives the (curved) value. `curves[key]` optionally maps
// a 0…1 slider position onto the real value; `defaults[key]` gives
// { range, speed } and, with a curve, a `start` position.

window.SliderWobble = function SliderWobble({ settings, defaults = {}, curves = {}, flash = () => {} }) {
  const wobbleSeconds = (speed) => 60 * Math.pow(4 / 60, speed); // 60s … 4s per swing
  const fmtSeconds = (sec) => (sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`);
  const toValue = (w, x) => (w.curve ? w.curve(x) : x);
  const wobbles = [];

  function setup(ctl) {
    const key = ctl.dataset.key;
    const el = ctl.querySelector('input');
    const d = defaults[key] || {};
    const w = {
      key, el, ctl,
      curve: curves[key],
      min: parseFloat(el.min), max: parseFloat(el.max),
      center: d.start != null ? d.start : settings[key],
      on: false, open: false, dragging: false,
      engage: 0,
      phase: Math.random() * 100,
      p1: Math.random() * 6.28, p2: Math.random() * 6.28,
      range: d.range != null ? d.range : 0.3,
      speed: d.speed != null ? d.speed : 0.35,
    };
    wobbles.push(w);

    // Wrap the slider so a glowing bar underneath can show the wobble zone.
    const track = document.createElement('span');
    track.className = 'track';
    el.replaceWith(track);
    track.appendChild(el);
    w.zone = document.createElement('i');
    w.zone.className = 'zone';
    track.appendChild(w.zone);

    const btn = document.createElement('button');
    btn.className = 'wob';
    btn.title = `Wobble ${ctl.dataset.name}`;
    btn.innerHTML = '<span>∿</span>';
    ctl.appendChild(btn);

    const pop = document.createElement('div');
    pop.className = 'pop';
    pop.innerHTML = `
      <div class="pop-head">${ctl.dataset.name} wobble <button class="tgl"></button></div>
      <label title="How far it swings around where you set it"><span class="name">Range</span>
        <input class="w-range" type="range" min="0.02" max="1" step="0.01"><span class="val r-val"></span></label>
      <label title="How long one swing takes"><span class="name">Speed</span>
        <input class="w-speed" type="range" min="0" max="1" step="0.01"><span class="val s-val"></span></label>`;
    ctl.appendChild(pop);
    w.tgl = pop.querySelector('.tgl');
    const rEl = pop.querySelector('.w-range');
    const sEl = pop.querySelector('.w-speed');
    const rVal = pop.querySelector('.r-val');
    const sVal = pop.querySelector('.s-val');
    const showRS = () => {
      rVal.textContent = `±${Math.round(w.range * 50)}%`;
      sVal.textContent = fmtSeconds(wobbleSeconds(w.speed));
    };
    rEl.value = w.range;
    sEl.value = w.speed;
    rEl.oninput = () => { w.range = parseFloat(rEl.value); showRS(); drawZone(w); };
    sEl.oninput = () => { w.speed = parseFloat(sEl.value); showRS(); };
    showRS();

    btn.onclick = () => {
      if (w.open) { setOpen(w, false); return; }
      if (!w.on) setWobble(w, true); // first click means "make it wobble"
      setOpen(w, true);
    };
    w.tgl.onclick = () => setWobble(w, !w.on);

    // While you drag, the thumb follows your hand and becomes the new centre;
    // the wobble eases out and back in around it.
    el.value = w.center;
    settings[key] = toValue(w, w.center);
    el.oninput = () => {
      w.center = parseFloat(el.value);
      if (w.engage < 0.001) settings[key] = toValue(w, w.center);
      drawZone(w);
    };
    el.addEventListener('pointerdown', () => { w.dragging = true; });
    window.addEventListener('pointerup', () => { w.dragging = false; });
    window.addEventListener('pointercancel', () => { w.dragging = false; });
    setWobble(w, false);
  }

  function setWobble(w, on) {
    w.on = on;
    w.ctl.classList.toggle('wobbling', on);
    w.tgl.textContent = on ? 'On' : 'Off';
    w.tgl.classList.toggle('off', !on);
    drawZone(w);
  }
  function setOpen(w, open) {
    for (const o of wobbles) if (o !== w || !open) { o.open = false; o.ctl.classList.remove('open'); }
    w.open = open;
    w.ctl.classList.toggle('open', open);
  }
  function closeAll() { for (const w of wobbles) setOpen(w, false); }
  function toggleAll() {
    const on = wobbles.some((w) => !w.on);
    for (const w of wobbles) setWobble(w, on);
    flash(on ? `Wobble on: ${wobbles.map((w) => w.ctl.dataset.name).join(', ')}` : 'Wobble off');
  }

  // The zone always fits inside the slider: near either end the centre is
  // nudged inward rather than letting the swing get stuck against the stop.
  function wobbleZone(w) {
    const span = w.max - w.min;
    const amp = w.range * span * 0.5;
    const c = Math.min(w.max - amp, Math.max(w.min + amp, w.center));
    return { amp, c, span };
  }
  function drawZone(w) {
    const { amp, c, span } = wobbleZone(w);
    w.zone.style.setProperty('--lo', ((c - amp - w.min) / span).toFixed(4));
    w.zone.style.setProperty('--hi', ((c + amp - w.min) / span).toFixed(4));
  }

  function update(dt) {
    for (const w of wobbles) {
      const target = w.on && !w.dragging ? 1 : 0;
      const before = w.engage;
      w.engage += (target - w.engage) * Math.min(1, dt * 1.2);
      if (w.engage < 0.001 && target === 0) {
        w.engage = 0;
        if (before > 0) { settings[w.key] = toValue(w, w.center); if (!w.dragging) w.el.value = w.center; }
        continue;
      }
      w.phase += (dt * 2 * Math.PI) / wobbleSeconds(w.speed);
      const ph = w.phase;
      const s = 0.6 * Math.sin(ph) + 0.28 * Math.sin(ph * 1.618 + w.p1) + 0.12 * Math.sin(ph * 2.718 + w.p2);
      const { amp, c } = wobbleZone(w);
      const centre = w.center + (c - w.center) * w.engage;
      const v = centre + amp * s * w.engage;
      settings[w.key] = toValue(w, v);
      if (!w.dragging) w.el.value = v;
    }
  }

  document.querySelectorAll('.ctl[data-key]').forEach(setup);
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.ctl')) closeAll();
  });

  return { update, toggleAll, closeAll };
};
