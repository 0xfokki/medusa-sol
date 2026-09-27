// The hero's jellyfish on her own, for pages that want the same body the front page shows
// without the hero around it (no thoughts, no trades, no intake). Same geometry, same
// light and the same lime as index.html's NewJelly (ported from для обновы/medusa-single);
// only the size is the caller's.
//
//   jellyHero(canvasElement, { size: .16, tilt: .78, cy: .5 })
//   size = bell radius as a share of the canvas's shorter side, tilt in radians (the hero's
//   own is .78), cy = where her centre sits down the canvas (0..1)
//
// It breathes, turns, sparks, and the drifting stream of particles bends around the bell
// and lights it where it hits - presence, nothing more.
(() => {
"use strict";
const TAU = Math.PI * 2;
const PAL = { spark: [134, 239, 172], glow: 'lime', tint: '134,239,172', bright: '187,247,208' };

window.jellyHero = function(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const SIZE = opts.size || .16, CY = opts.cy == null ? .5 : opts.cy;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const textures = {};
  for (const [name, rgb] of Object.entries({ lime: '134,239,172', white: '233,239,241' })) {
    const size = 64, mid = size / 2;
    const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
    const grad = g.createRadialGradient(mid, mid, 0, mid, mid, mid);
    grad.addColorStop(0, `rgba(${rgb},.92)`); grad.addColorStop(.22, `rgba(${rgb},.55)`); grad.addColorStop(.55, `rgba(${rgb},.14)`); grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad; g.fillRect(0, 0, size, size);
    const blurred = document.createElement('canvas'); blurred.width = blurred.height = size;
    const bg = blurred.getContext('2d'); bg.filter = 'blur(5px)'; bg.drawImage(c, 0, 0);
    textures[name] = blurred;
  }
  function dot(x, y, r, a, rgb) { ctx.fillStyle = `rgba(${rgb || '224,233,250'},${Math.max(0, Math.min(1, a))})`; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
  function glow(x, y, r, a, name) { ctx.globalAlpha = a; ctx.drawImage(textures[name || 'white'], x - r, y - r, r * 2, r * 2); ctx.globalAlpha = 1; }
  const hash = n => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
  function spark(tt, id) {
    const clock = tt / (1.4 + hash(id) * 3.4) + hash(id + 7) * 23;
    const cycle = Math.floor(clock), phase = clock - cycle;
    const duration = .13 + hash(id * 3 + cycle * 19) * .20;
    if (phase > duration) return 0;
    return Math.pow(Math.sin(Math.PI * phase / duration), 1.35);
  }
  function particle(x, y, r, a, id, tt, burst, base) {
    base = base || [232, 238, 242];
    const light = spark(tt, id) * (1 + burst * .3), amount = Math.min(1, light * 1.35);
    const rgb = base.map((v, i) => Math.round(v + (PAL.spark[i] - v) * amount)).join(',');
    dot(x, y, r * (1 + amount * .12), Math.min(1, a + amount * .8), rgb);
    if (light > .72) glow(x, y, Math.min(3.5, r * 2.5), light * .34, PAL.glow);
  }
  function yaw(tt) { return Math.sin(tt * .32) * .26 + Math.sin(tt * .117) * .065; }
  function geometry(tt, burst, u, a, squash, j) {
    squash = squash === undefined ? .75 : squash; j = j || 0;
    const breath = Math.sin(tt * 1.65), radius = 164 * (1 + .035 * breath + burst * .025);
    const yy = Math.sqrt(Math.max(0, 1 - u * u));
    const angle = a + yaw(tt);
    const rib = Math.cos(a * 10 + u * .48 + Math.sin(tt * .6) * .12);
    const fold = 1 + .065 * rib * Math.pow(u, .7) + .012 * Math.sin(a * 12 + tt * 1.2) * u * u;
    const r = radius * u * fold;
    const x = Math.cos(angle) * r * squash, z = Math.sin(angle) * r;
    const ripple = (Math.sin(a * 9 - tt * 1.7) + Math.sin(a * 17 + tt * .9)) * (u * u * 2.2);
    const y = -yy * (128 - 4 * breath) - rib * 10 * Math.sin(u * Math.PI * .93) + ripple + (j - .5) * 3;
    return { x: x + Math.sin(tt * .31) * 6, y: y + z * .28 + Math.sin(tt * 1.65) * 5, z, yy, angle };
  }
  function makeSeed(n) { let s = n >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function makeBody(seedBase) {
    const rand = makeSeed(seedBase);
    const dots = Array.from({ length: 2800 }, () => ({ u: rand(), a: rand() * TAU, j: rand(), s: .36 + rand() * .72, phase: rand() * TAU }));
    const rim = Array.from({ length: 420 }, () => ({ a: rand() * TAU, u: .965 + rand() * .035, j: rand(), s: .3 + rand() * .6, phase: rand() * TAU }));
    const nerves = Array.from({ length: 16 }, () => ({ u: .1 + rand() * .8, a: rand() * TAU, s: 1 + rand() * 1.7, phase: rand() * TAU }));
    const strands = Array.from({ length: 14 }, (_, i) => ({ a: i / 14 * TAU, len: (118 + rand() * 112) * 1.68, phase: rand() * TAU, beads: Math.round((20 + Math.floor(rand() * 12)) * 1.2) }));
    return { dots, rim, nerves, strands, timeOffset: rand() * 40 };
  }
  const body = makeBody(424242);
  const TILT = opts.tilt == null ? .78 : opts.tilt;
  const stream = Array.from({ length: 70 }, () => ({ x: 0, y: 0, px: 0, py: 0, s: .6 + Math.random() * 1.9, seed: Math.random() * 90000, ang: (Math.random() - .5) * .85, spd: .75 + Math.random() * .6, hit: 0, inside: false }));
  let ripples = [];
  const RIPPLE_LIFETIME = .35, RIPPLE_SPEED = 80, RIPPLE_WIDTH = 8;
  let t = 0, last = 0, dpr = 1, vw = 0, vh = 0, cx = 0, cy = 0, scale = 1, squashNow = .75, burst = 0, baseScale = 1;
  // She only draws while she can be seen: off-screen (the visitor scrolled to the read) or in
  // a hidden tab the loop stops, and it picks up where it was when she is back.
  let visible = true, running = false, DPR_CAP = Math.min(opts.dprCap || 1.5, 2), slow = 0;

  function toLocal(px, py) {
    const dx = px - cx, dy = py - cy, cosR = Math.cos(-TILT), sinR = Math.sin(-TILT);
    const rx = dx * cosR - dy * sinR, ry = dx * sinR + dy * cosR;
    return { x: rx / scale, y: ry / scale };
  }
  function updateStream(dt) {
    const size = Math.max(vw, vh), speed = size * .085, baseAngle = Math.PI - TILT;
    const rad = 164 * scale * 1.45, hitRad = 164 * scale * .92;
    for (const p of stream) {
      p.px = p.x; p.py = p.y;
      const angle = baseAngle + p.ang, vx = Math.cos(angle) * speed * p.spd, vy = Math.sin(angle) * speed * p.spd;
      p.x += vx * dt; p.y += vy * dt;
      const ddx = p.x - cx, ddy = p.y - cy, dist = Math.hypot(ddx, ddy) || 1;
      const wasIn = p.inside; p.inside = dist < hitRad;
      if (p.inside && !wasIn) { p.hit = 1; const loc = toLocal(p.x, p.y); ripples.push({ x: loc.x, y: loc.y, startT: t }); }
      p.hit = Math.max(0, p.hit - dt * 2.4);
      if (dist < rad) {
        const nx = ddx / dist, ny = ddy / dist, tx = -ny, ty = nx, strength = (1 - dist / rad) * size * .09;
        p.x += (tx * strength + nx * strength * .35) * dt;
        p.y += (ty * strength + ny * strength * .35) * dt;
      }
      if (p.x < -30) { p.x += vw + 60; p.px = p.x; } else if (p.x > vw + 30) { p.x -= vw + 60; p.px = p.x; }
      if (p.y < -30) { p.y += vh + 60; p.py = p.y; } else if (p.y > vh + 30) { p.y -= vh + 60; p.py = p.y; }
      if (Math.hypot(p.x - p.px, p.y - p.py) > size * .1) { p.px = p.x; p.py = p.y; }
    }
    ripples = ripples.filter(r => t - r.startT < RIPPLE_LIFETIME);
    if (ripples.length > 6) ripples.splice(0, ripples.length - 6);
  }
  function drawStream() {
    for (const p of stream) {
      if (p.hit > .02) {
        ctx.strokeStyle = `rgba(70,200,255,${.16 + p.hit * .4})`; ctx.lineWidth = 1 + p.hit; ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(p.x, p.y); ctx.stroke();
        dot(p.x, p.y, p.s * (1 + p.hit * 1.3), Math.min(1, .4 + p.hit * .9), '70,200,255');
        glow(p.x, p.y, p.s * 3 + p.hit * 7, p.hit * .65, 'lime');
      } else {
        ctx.strokeStyle = `rgba(${PAL.tint},.16)`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(p.x, p.y); ctx.stroke();
        particle(p.x, p.y, p.s, .22, p.seed, t, 0);
      }
    }
  }
  function drawBody() {
    const tt = t + body.timeOffset;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.sin(tt * .57) * .045 + Math.sin(tt * .23) * .018 + TILT);
    ctx.scale(scale, scale);
    const tint = PAL.tint;
    for (const s of body.strands) {
      const base = geometry(tt, burst, 1, s.a, squashNow), front = (Math.sin(base.angle) + 1) / 2;
      let prev = null;
      for (let k = 0; k < s.beads; k++) {
        const q = k / (s.beads - 1), wave = tt * 1.25 - q * 4.5 + s.phase;
        const lag = yaw(tt - q * 1.6) - yaw(tt);
        const twistX = (Math.cos(base.angle + lag) - Math.cos(base.angle)) * 164 * squashNow;
        const twistZ = (Math.sin(base.angle + lag) - Math.sin(base.angle)) * 164;
        const x = base.x + twistX + Math.sin(wave) * (3 + q * 20) + Math.sin(q * 10 - tt * .85 + s.phase) * q * 6 - q * 12;
        const y = base.y + twistZ * .28 + q * s.len * (1 + .025 * Math.sin(tt * 1.65 - .7));
        const light = spark(tt, 20000 + s.phase * 103 + k * 17);
        const a = Math.min(1, (.28 + front * .48) * (1 - q * .63) * (.72 + .28 * Math.pow(Math.sin(q * 11 - tt * 2 + s.phase), 2)) + light * .75);
        if (prev) { ctx.strokeStyle = `rgba(${tint},${a * .25})`; ctx.lineWidth = 1.15; ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, y); ctx.stroke(); }
        const r = (1.95 + front * 1.05) * (1 - q * .6);
        dot(x, y, r * (1 + light * .22), a, light > .3 ? PAL.bright : tint);
        if (light > .6) glow(x, y, 3.5 + light * 2, light * .45, PAL.glow);
        if (k % 5 === 0 || light > .65) dot(x, y, r * (.4 + light * .2), a * .95, '238,255,186');
        prev = { x, y };
      }
    }
    for (const p of body.dots) {
      const u = Math.sqrt(1 - (1 - p.u) * (1 - p.u)); const v = geometry(tt, burst, u, p.a, squashNow, p.j);
      const normal = Math.abs(Math.sin(v.angle) * u - .28 * v.yy) / 1.04;
      const edge = Math.pow(1 - Math.min(1, normal), 7);
      const twinkle = .65 + .35 * Math.pow(Math.sin(tt * (.9 + p.j) + p.phase), 2);
      const ribLight = .64 + .36 * (.5 + .5 * Math.cos(p.a * 10 + u * .48 + Math.sin(tt * .6) * .12));
      const a = (.31 + .68 * edge + burst * .12) * twinkle * ribLight;
      let rippleBoost = 0;
      for (const r of ripples) {
        const age = t - r.startT;
        if (age < 0 || age > RIPPLE_LIFETIME) continue;
        const ringR = age * RIPPLE_SPEED, band = Math.abs(Math.hypot(v.x - r.x, v.y - r.y) - ringR);
        if (band < RIPPLE_WIDTH) { const s = (1 - band / RIPPLE_WIDTH) * (1 - age / RIPPLE_LIFETIME); if (s > rippleBoost) rippleBoost = s; }
      }
      particle(v.x, v.y, p.s * (1.08 + edge * .35) * (1 + rippleBoost * .6), Math.min(1, a + rippleBoost * .7), p.phase * 1137 + p.j * 7919, tt, burst);
      if (rippleBoost > .12) glow(v.x, v.y, 3 + rippleBoost * 4, rippleBoost * .5, 'lime');
    }
    for (let rib = 0; rib < 10; rib++) {
      for (let k = 5; k < 75; k += 2) {
        const u = k / 75, a = (rib * TAU - u * .48 - Math.sin(tt * .6) * .12) / 10;
        const v = geometry(tt, burst, u, a, squashNow), front = (Math.sin(v.angle) + 1) / 2;
        particle(v.x, v.y, .6 + .24 * Math.sin(u * Math.PI), (.2 + front * .3) * Math.sin(u * Math.PI * .92), 31000 + rib * 173 + k * 13, tt, burst);
      }
    }
    for (const p of body.rim) {
      const v = geometry(tt, burst, p.u, p.a, squashNow, p.j), front = (Math.sin(v.angle) + 1) / 2;
      particle(v.x, v.y, p.s * 1.2, .22 + front * .32, 41000 + p.phase * 897 + p.j * 691, tt, burst);
    }
    for (const p of body.nerves) {
      const v = geometry(tt, burst, p.u, p.a, squashNow, p.phase * .1); const a = .17 + .23 * (1 + Math.sin(tt * 1.4 + p.phase)) / 2;
      particle(v.x, v.y, p.s * .65, a * .8, 51000 + p.phase * 117, tt, burst);
    }
    ctx.restore();
  }

  function layout() {
    const r = canvas.getBoundingClientRect();
    vw = Math.round(r.width); vh = Math.round(r.height);
    if (!vw || !vh) return;
    dpr = Math.min(devicePixelRatio || 1, DPR_CAP);
    canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
    cx = vw / 2; cy = vh * CY;
    baseScale = Math.max(.25, Math.min(1.6, Math.min(vw, vh) * SIZE / 164));
    for (const p of stream) { p.x = Math.random() * vw; p.y = Math.random() * vh; p.px = p.x; p.py = p.y; }
    draw();
  }
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, vw, vh);
    drawStream();
    drawBody();
  }
  function frame(now) {
    if (!visible || document.hidden) { running = false; return; }
    const raw = (now - last) || 0, dt = Math.min(raw / 1000, .05); last = now;
    // frames over 30 ms for three seconds straight: step the resolution down once, never back up
    if (raw > 30 && DPR_CAP > 1) { slow += raw; if (slow > 3000) { DPR_CAP = 1; layout(); slow = 0; } } else slow = 0;
    t += dt;
    const pulse = Math.sin(t * 1.1);
    scale = baseScale * (1 + pulse * .07);
    squashNow = .75 + Math.sin(t * .31) * .05;
    burst = Math.max(0, pulse) * .3;
    updateStream(dt);
    draw();
    requestAnimationFrame(frame);
  }
  function start() { if (still || running || !visible || document.hidden) return; running = true; last = performance.now(); requestAnimationFrame(frame); }
  addEventListener('resize', layout);
  layout();
  if ('IntersectionObserver' in window) new IntersectionObserver(es => { visible = es.some(e => e.isIntersecting); if (visible) start(); }, { threshold: 0 }).observe(canvas);
  document.addEventListener('visibilitychange', start);
  start();
};
})();
