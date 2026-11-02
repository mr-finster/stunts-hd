// Logitech wheel with force feedback, over WebHID (Chrome or Edge), for the classic-protocol Logitech wheels
// (Driving Force / EX / Pro / GT, MOMO, G25, G27, G29, G923 PlayStation). The game itself is untouched: the wheel
// steers it the way the gamepad does (qol.js), by holding the arrow keys until the car's own steering angle reaches the
// wheel's, and the force is made here from the car's state, read each tick from the game's memory.
//
// Everything is in the Wheel menu: a button on the game's Options screen (see wheelMenu below). There: pick the wheel
// ("Select a Logitech FFB device": the browser's list; it reconnects by itself after that) or let it go ("Disconnect FFB
// device"), the force, the centring spring, the rotation, the switches below, and the two setups: "Set up pedals" (the
// throttle and the brake) and "Set up buttons" (the gear paddles and the buttons below), each started only from there
// and each keeping what the other learnt.
// The wheel's own controls: the pedals and paddles; its d-pad (the descriptor's hat switch) is the arrow keys in the
// menus; learnt buttons for Start (Esc: the race menu), Confirm (Enter), Back (Esc), Camera (C), Restart (R).
// The pedals are analog: part way down, their key is held on that share of the game's ticks (see pedals()).
// With 1:1 steering on, the page's rewind (Q) is off: the race wound back would play on from keys that never steered it.
// The keys, for quick changes:
//   [ / ]          force strength down / up
//   Shift+[ / ]    wheel rotation (lock to lock) down / up: set in the wheel on those that can (G25, G27, DFGT, G29,
//                  G923), a soft lock (a spring at the chosen rotation's ends) on the others (see setSoftLock)
//
// The wheel's four force slots:
//   1  a constant force (classic command 11 00), worked out here a few hundred times a second (below)
//   2  the soft lock, on wheels that can't set their rotation: a spring at the chosen rotation's ends, always at full
//      strength (setSoftLock)
//   3  the centring spring: a spring to the rim's centre, whatever the car does, stronger with speed (setCentre)
//   4  the damper: the wheel's own, a drag on the rim's turning, stronger with speed (setDamper)
// The constant force:
//   - a spring toward where the car's front wheels really are (the game turns them at a limited rate: the rim feels the
//     car catching up instead of running ahead of it), stiffer with speed
//   - aligning torque: a pull to centre that grows with cornering load (the grip the corner demands against the grip
//     the four tyres' surfaces give, car_demandedGrip / car_surfacegrip_sum) and goes light when the car slides
//   - texture: a rumble on grass and dirt, a buzz while skidding, a hard rattle over the red and white kerbs (HD view
//     only: the kerbs are paint, the physics sees grass there; the HD view finds the paint under each wheel, view.wheelMat)
//   - jolts on the game's own per-tick events: wall contact, hard landings, crashes, roadside objects knocked down
//   In the air: no force at all (the rim free; the centring spring and the damper stopped too), but for the landing's jolt on touchdown.
// Uses the page's globals: mem, k, SCAN, view, StuntsCode (main.js) and qolSay (qol.js).
'use strict';
(function () {
  if (!('hid' in navigator)) return;
  const D = StuntsCode.DSEG << 4, S = StuntsCode.SYM;
  const PS = S.state + 0x152;                     // state.playerstate (struct CARSTATE, 208 bytes)
  const GAME_FRAME = S.state + 320;               // state.game_frame
  // CARSTATE offsets (restunts gamestate.h)
  const C_STEER = 0x20, C_SPEED = 0x2C, C_SLIDEYAW = 0x3E, C_DEMAND = 0x44, C_GRIPSUM = 0x46;
  const C_SUSP = 0x54, C_SURFALL = 0xC1, C_SURF = 0xC2, C_SLIDING = 0xC7, C_CRASH = 0xC9, C_SOUND = 0xCF;
  const SND_SKID = 2 | 4, SND_WALL = 16, SND_LANDING = 32;
  const SURF_DIRT = 2, SURF_ICE = 3, SURF_GRASS = 4;
  const OBJ_FROM = 0x2FE, OBJ_TO = 0x3F4;           // GAMESTATE: the knocked-down objects' lists and their count
  const STEER_MAX = 240;                          // the game's steering angle limit

  const r8 = o => mem[D + (o & 0xFFFF)], r16 = o => r8(o) | (r8(o + 1) << 8), s16 = v => (v << 16) >> 16, s8 = v => (v << 24) >> 24;
  // (wheel messages in the middle of the screen for a few seconds; not over the setup steps)
  let sayT = 0;
  const say = t => { console.log('[wheel] ' + t); if (learn) return; show('Wheel', t.replace(/^Wheel:? */, '')); clearTimeout(sayT); sayT = setTimeout(hide, 3000); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const store = (key, v) => { try { localStorage.setItem(key, v); } catch (_) {} };
  const load = key => { try { return localStorage.getItem(key); } catch (_) { return null; } };
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const racing = () => typeof view !== 'undefined' && view && view.raceView && performance.now() - (view.lastFrame || 0) < 400 && r8(S.game_replay_mode) === 0;

  // ---- keys into the game, as the keyboard sends them
  function send(code, down) {
    const sc = SCAN[code];
    if (sc == null) return;
    const wr = Atomics.load(k, 0);
    const ascii = down && /^Key[A-Z]$/.test(code) ? code.charCodeAt(3) + 32 : 0;   // (A and Z shift gears by their character, as qol.js sends them)
    k[2 + wr] = (sc & 0xFFFF) | (down ? 1 << 16 : 0) | (ascii << 17);
    Atomics.store(k, 0, (wr + 1) & 1023);
  }
  const keys = {
    down: new Map(),
    set(code, on) { if (!!this.down.get(code) === on) return; this.down.set(code, on); send(code, on); },
    release() { for (const [c, on] of this.down) if (on) send(c, false); this.down.clear(); },
  };
  const tap = async code => { send(code, true); await sleep(70); send(code, false); };

  // ---- the wheel
  const CLASSIC = {
    0xC20E: 'WingMan Formula GP', 0xC293: 'WingMan Formula Force GP / GT Force', 0xC294: 'Driving Force / EX / RX',
    0xC295: 'MOMO Force', 0xCA03: 'MOMO Racing', 0xC298: 'Driving Force Pro', 0xC299: 'G25', 0xC29A: 'Driving Force GT',
    0xC29B: 'G27', 0xC29C: 'Speed Force Wireless', 0xC24F: 'G29', 0xC260: 'G29 (PS4 mode)', 0xC266: 'G923 PlayStation',
    0xC267: 'G923 PlayStation (PS4 mode)',
  };
  const HIDPP = { 0xC261: 'G920', 0xC262: 'G920', 0xC26D: 'G923 Xbox', 0xC26E: 'G923 Xbox' };
  const SET_RANGE = new Set([0xC299, 0xC29A, 0xC29B, 0xC24F, 0xC260, 0xC266, 0xC267]);   // F8 81 lo hi: rotation in degrees
  let dev = null, lay = null, report = null, wheelPos = 0, wheelVel = 0, lastPosT = 0;

  // The report layout from the HID report descriptor (WebHID's device.collections): the steering axis (Generic Desktop
  // X), the other axes (pedals: Y, Z, Rx..Rz, sliders, or the Simulation page's accelerator/brake/clutch), the buttons
  // (Button page: paddles), each with its bit offset and size, and the output report for the force commands. Walked
  // depth first in descriptor order, adding up bit offsets per report ID.
  function parseLayout(device) {
    const inputs = new Map(), outputs = new Map();
    const walk = cols => {
      for (const c of cols) {
        for (const r of (c.inputReports || [])) { if (!inputs.has(r.reportId)) inputs.set(r.reportId, []); inputs.get(r.reportId).push(...r.items); }
        for (const r of (c.outputReports || [])) outputs.set(r.reportId, (outputs.get(r.reportId) || 0) + r.items.reduce((s, it) => s + it.reportSize * it.reportCount, 0));
        walk(c.children || []);
      }
    };
    walk(device.collections);
    const fields = new Map();   // reportId -> [{ page, id, offset, size, min, max }]
    let found = null;
    for (const [reportId, items] of inputs) {
      let bit = 0;
      const list = [];
      for (const it of items) {
        let usages = it.usages || [];
        if (it.isRange && !usages.length && it.usageMaximum >= it.usageMinimum) { usages = []; for (let u = it.usageMinimum; u <= it.usageMaximum; u++) usages.push(u); }
        for (let i = 0; i < it.reportCount; i++) {
          const u = usages.length ? usages[Math.min(i, usages.length - 1)] : null;
          if (!it.isConstant && u !== null)
            list.push({ page: u >>> 16, id: u & 0xFFFF, offset: bit + i * it.reportSize, size: it.reportSize, min: it.logicalMinimum, max: it.logicalMaximum });
        }
        bit += it.reportSize * it.reportCount;
      }
      fields.set(reportId, list);
      if (!found) { const x = list.find(f => f.page === 1 && f.id === 0x30); if (x) found = { reportId, ...x }; }
    }
    if (!found) return null;
    let outId = 0, outBytes = 7;
    if (outputs.size) { const [id, bits] = [...outputs.entries()][0]; outId = id; outBytes = Math.max(7, Math.ceil(bits / 8)); }
    const list = fields.get(found.reportId);
    const NAMES = { 0x30: 'X', 0x31: 'Y', 0x32: 'Z', 0x33: 'Rx', 0x34: 'Ry', 0x35: 'Rz', 0x36: 'Slider', 0x37: 'Dial', 0x38: 'Wheel' };
    const SIM = { 0xBA: 'Rudder', 0xBB: 'Throttle', 0xC4: 'Accelerator', 0xC5: 'Brake', 0xC6: 'Clutch', 0xC8: 'Steering' };
    const l = {
      reportId: found.reportId, xOffset: found.offset, xSize: found.size, xMax: found.max > 0 ? found.max : 2 ** found.size - 1, outId, outBytes,
      axes: list.filter(f => f.offset !== found.offset && f.size > 1 && ((f.page === 1 && NAMES[f.id]) || (f.page === 2 && SIM[f.id])))
        .map(f => ({ ...f, name: f.page === 1 ? NAMES[f.id] : SIM[f.id] })),
      buttons: list.filter(f => f.page === 9 && f.size === 1).map(f => ({ ...f, name: 'Button ' + f.id })),
      hat: list.find(f => f.page === 1 && f.id === 0x39 && f.size > 1) || null,   // (the d-pad: Generic Desktop's hat switch, 0..7 from up, clockwise; centred: outside that)
    };
    // PS4-mode wheels send a DS4-style report: the first X is the stick, the wheel is the 16-bit value at byte 42, and
    // the pedals aren't in the descriptor (put the wheel in PS3 mode for pedals and paddles)
    if (device.productId === 0xC260 || device.productId === 0xC267) Object.assign(l, { xOffset: 42 * 8, xSize: 16, xMax: 65535, ps4: true, hat: null });
    return l;
  }
  function readBits(bytes, offset, size) {
    let v = 0;
    for (let i = 0; i < size; i++) { const b = offset + i; if ((bytes[b >> 3] >> (b & 7)) & 1) v += 2 ** i; }
    return v;
  }
  // a field's value; signed when its logical minimum is below zero
  const field = f => { if (!report) return 0; const v = readBits(report, f.offset, f.size); return f.min < 0 && v >= 2 ** (f.size - 1) ? v - 2 ** f.size : v; };
  function describe(l) {
    const s = f => `${f.name} @bit ${f.offset} (${f.size} bits, ${f.min}..${f.max})`;
    console.log(`[wheel] report ${l.reportId}: steering X @bit ${l.xOffset} (${l.xSize} bits, 0..${l.xMax}); output report ${l.outId}, ${l.outBytes} bytes`);
    console.log('[wheel] axes: ' + (l.axes.map(s).join('; ') || 'none'));
    console.log('[wheel] buttons: ' + (l.buttons.map(f => f.id + '@' + f.offset).join(' ') || 'none') + '; d-pad: ' + (l.hat ? `hat @bit ${l.hat.offset} (${l.hat.size} bits, ${l.hat.min}..${l.hat.max})` : 'none'));
  }

  function onReport(e) {
    if (!lay || e.reportId !== lay.reportId) return;
    report = new Uint8Array(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength));
    const t = performance.now(), mid = lay.xMax / 2, p = (readBits(report, lay.xOffset, lay.xSize) - mid) / mid;
    if (lastPosT) { const dt = Math.max(1, t - lastPosT) / 1000; wheelVel += (((p - wheelPos) / dt) - wheelVel) * 0.35; }
    wheelPos = p; lastPosT = t;
    learnSample();
  }

  // ---- output: classic Logitech 7-byte commands; one in flight at a time (classic wheels drop back-to-back commands)
  let busy = false, lastLevel = -1, lastSent = 0;
  async function cmd(bytes) {
    if (!dev || !dev.opened) return;
    const buf = new Uint8Array(lay.outBytes); buf.set(bytes.slice(0, lay.outBytes));
    try { await dev.sendReport(lay.outId, buf); } catch (e) { console.warn('[wheel] send', e); }
  }
  async function force(f) {   // f: -1..1, positive toward X+ (right); levels above 0x80 push left
    const level = clamp(Math.round(0x80 - f * 127), 1, 255), now = performance.now();
    if (busy || (level === lastLevel && now - lastSent < 60)) return;
    busy = true; lastLevel = level; lastSent = now;
    await cmd(level === 0x80 ? [0x13, 0, 0, 0, 0, 0, 0] : [0x11, 0x00, level, 0x80, 0x80, 0x80, 0x00]);
    await sleep(3);
    busy = false;
  }
  let gain = +(load('stunts-wheel-gain') || 1), rotation = +(load('stunts-wheel-rotation') || 270);
  let direct = load('stunts-wheel-direct') === '1';
  let rumbleRough = load('stunts-wheel-rough') !== '0';   // the grass and dirt rumble (the Wheel menu)
  let springK = (v => v == null ? 2 : clamp(+v || 0, 0, 3))(load('stunts-wheel-spring'));   // the centring spring's strength (the Wheel menu)
  // ---- the centring spring, in a slot of its own (slot 3), played by the wheel itself: the classic spring, centred
  // (dead band 7F..80), the same both sides, "41 01 7F 80 KK 00 CLIP". Its strength s (the pull at full lock, in full
  // forces: (0.45 + 0.2 x speed) x the spring's own setting x the force setting x the soft lock's scaling) sets both: the
  // clip, 0..255 for s 0..1, the smooth part (the most it pulls), and the stiffness, s x 3.5 rounded up, 1..7 (how soon it
  // gets there). Sent only when its bytes change, 50 ms apart at most; stopped ("43") at 0, in the air, and when let go.
  const slotSent = { 3: '', 4: '' }, slotAt = { 3: 0, 4: 0 };
  async function slotSend(n, b, now) {   // (slots 3 and 4: a command only when its bytes change, 50 ms apart at most)
    const key = b.join(',');
    if (key === slotSent[n] || busy || now - slotAt[n] < 50 || !dev) return;
    busy = true; slotSent[n] = key; slotAt[n] = now;
    try { await cmd(b); await sleep(3); } finally { busy = false; }
  }
  const setCentre = (s, now) => slotSend(3, s > 0.004 ? [0x41, 0x01, 0x7F, 0x80, 0x11 * clamp(Math.ceil(s * 3.5), 1, 7), 0x00, clamp(Math.round(255 * Math.min(s, 1)), 1, 255)] : [0x43, 0, 0, 0, 0, 0, 0], now);
  const centreS = spd => (0.45 + 0.2 * spd) * springK * gain * steerK();
  // ---- the damper, in slot 4, the wheel's own (it measures the rim's speed itself, smooth and at once): the classic
  // damper, the same both sides, "81 02 K 00 K 00 00". Its strength c (the old damper's: (0.012 + 0.03 x speed), in
  // full forces per unit of rim speed, x its own setting x the force setting x the soft lock's scaling; less on ice, half
  // when crashed) as the stiffness, c x 75 rounded, 0..7 (1 parked, 3 at speed, by default). Stopped ("83") at 0 and in
  // the air.
  let damperK = (v => v == null ? 1 : clamp(+v || 0, 0, 3))(load('stunts-wheel-damper'));   // the damper's strength (the Wheel menu)
  const setDamper = (c, now) => { const K = clamp(Math.round(c * 75), 0, 7); return slotSend(4, K ? [0x81, 0x02, K, 0x00, K, 0x00, 0x00] : [0x83, 0, 0, 0, 0, 0, 0], now); };

  // ---- 1:1 steering (the Wheel menu): the car's front wheels follow the rim at once instead of turning at the game's limited
  // rate. The game only takes left/right keys, so: hold the key toward the wheel's angle and, a few hundred times a
  // second, write the angle less one step of the game's own steering rate into car_steeringAngle; the game's next tick
  // adds that step back and lands exactly on the rim's angle. (Small angles, under one step, go straight: the game
  // centres them.) Replays record keys only, so a race driven this way doesn't play back the same.
  const RATE20 = [8, 7, 6, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1];   // steerWhlRespTable_20fps by speed (16 mph steps)
  const i16 = new Int16Array(mem.buffer, mem.byteOffset, mem.byteLength >> 1);
  function writeSteer(v) {
    const a = D + ((PS + C_STEER) & 0xFFFF);
    if ((a & 1) === 0) Atomics.store(i16, a >> 1, v);
    else { mem[a] = v & 0xFF; mem[a + 1] = (v >> 8) & 0xFF; }
  }
  function steerDirect(tgt) {
    const fps = r16(S.framespersec) || 20;
    const rate = RATE20[(r16(PS + C_SPEED) >> 12) & 15] * (fps === 10 ? 2 : 1);
    const t = Math.round(clamp(tgt, -STEER_MAX, STEER_MAX));
    if (Math.abs(t) <= rate) { keys.set('ArrowRight', false); keys.set('ArrowLeft', false); writeSteer(0); return; }
    keys.set('ArrowRight', t > 0); keys.set('ArrowLeft', t < 0);
    writeSteer(t - Math.sign(t) * rate);
  }
  async function setRange() {
    if (!dev) return;
    if (!SET_RANGE.has(dev.productId)) return setSoftLock();
    while (busy) await sleep(2);
    busy = true; await cmd([0xF8, 0x81, rotation & 0xFF, rotation >> 8, 0, 0, 0]); await sleep(5); busy = false;
  }
  // ---- the soft lock, on the wheels that can't set their rotation: a spring in slot 2 that the wheel plays by itself,
  // free inside the rotation chosen (its dead band) and stiff past it, as games for these wheels did. The classic spring
  // every one of them takes: "21 01 D1 D2 K S CLIP", the dead band's two ends (0..255 across the wheel's travel), the
  // stiffness each side (a nibble each, the most the oldest wheels take: 7), no inversion, full clip; "23": slot 2
  // stopped. (The DFP first takes its own coarse range, F8 03: 900°, F8 02: 200°, which its position then spans.) The
  // rim still reports its whole travel: within the chosen rotation, it is scaled up to the game's full lock (steerK).
  const PHYS = { 0xC294: 180, 0xC295: 240, 0xCA03: 240, 0xC298: 900, 0xC293: 180, 0xC29C: 270 };   // physical lock to lock, degrees
  const soft = () => !!dev && !SET_RANGE.has(dev.productId) && !!PHYS[dev.productId];
  const softKey = () => 'stunts-wheel-softrot-' + dev.productId.toString(16);
  let softRot = 0;   // the soft lock's rotation (this model's; its physical rotation: no lock)
  const fullRot = () => dev.productId === 0xC298 ? (softRot > 200 ? 900 : 200) : PHYS[dev.productId];   // (what the position spans)
  const steerK = () => soft() && softRot < fullRot() ? fullRot() / softRot : 1;
  async function setSoftLock() {
    if (!soft()) return;
    const full = fullRot(), range = softRot;
    while (busy) await sleep(2);
    busy = true;
    try {
      if (dev.productId === 0xC298) { await cmd([0xF8, full === 900 ? 0x03 : 0x02, 0, 0, 0, 0, 0]); await sleep(5); }
      if (range >= full) await cmd([0x23, 0, 0, 0, 0, 0, 0]);   // (no limit: the spring stopped)
      else {
        const d1 = clamp(Math.round(127.5 * (1 - range / full)), 0, 127), d2 = 255 - d1;
        await cmd([0x21, 0x01, d1, d2, 0x77, 0x00, 0xFF]);
      }
      await sleep(5);
    } finally { busy = false; }
  }
  const setSoft = v => { softRot = clamp(v, 90, PHYS[dev.productId]); store(softKey(), softRot); setSoftLock(); };

  // ---- pedals and buttons: the descriptor says where every axis and button is; the setups only ask which one is the
  // throttle, the brake, the two paddles and the other buttons (they differ between models), kept per wheel model in
  // this browser
  let map = null, learn = null;
  const MAP_VERSION = 2;
  const mapKey = () => 'stunts-wheel-map-' + dev.productId.toString(16);
  const snapshot = list => new Map(list.map(f => [f.offset, field(f)]));
  function learnSample() {
    if (!learn || !report) return;
    if (learn.phase === 'axis') {
      for (const f of lay.axes) {
        if (learn.used.has(f.offset)) continue;
        const rest0 = learn.rest.get(f.offset), d = Math.abs(field(f) - rest0) / Math.max(1, f.max - f.min);
        if (d > (learn.best ? learn.best.dev : 0.15)) learn.best = { offset: f.offset, size: f.size, min: f.min, name: f.name, rest: rest0, full: field(f), dev: d };
      }
    } else if (learn.phase === 'button') {
      // a button held down (not one flickering by): changed from rest and still changed
      const c = learn.cand;
      if (c && field(c) !== c.restV) return;
      learn.cand = null;
      for (const f of lay.buttons) {
        if (learn.usedB.has(f.offset)) continue;   // (one taken already)
        const r = learn.rest.get(f.offset);
        if (field(f) !== r) { learn.cand = { offset: f.offset, size: 1, min: 0, name: f.name, restV: r, since: performance.now() }; break; }
      }
    }
  }
  // the setup prompts stay on screen, large, until each step is done (qol.js's messages are gone in under 2 s)
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);max-width:min(90vw,640px);padding:1.1em 1.5em;background:rgba(0,0,0,.88);color:#fff;font:600 clamp(18px,3vh,34px)/1.35 ui-monospace,Menlo,monospace;border-radius:8px;text-align:center;white-space:pre-line;pointer-events:none;z-index:20;display:none';
  document.body.appendChild(panel);
  const show = (title, text, raw) => {
    panel.innerHTML = ''; const h = document.createElement('div'); h.textContent = title; h.style.cssText = 'font-size:.6em;opacity:.7;margin-bottom:.4em';
    const b = document.createElement('div'); b.textContent = text; panel.append(h, b);
    if (raw) { const r = document.createElement('div'); r.textContent = raw; r.style.cssText = 'font-size:.45em;opacity:.75;margin-top:.6em;word-break:break-word'; panel.append(r); }
    panel.style.display = 'block';
  };
  const hide = () => { panel.style.display = 'none'; };
  // live readout under each step: the descriptor's axes and the buttons held
  const live = () => {
    if (!report) return 'No data from the wheel yet';
    const ax = lay.axes.map(f => `${f.name} ${field(f)}`).join('  ');
    const held = lay.buttons.filter(f => field(f) !== (learn && learn.base ? learn.base.get(f.offset) : 0)).map(f => f.id);
    return `${ax || 'no axes in the descriptor'}\nbuttons: ${held.length ? held.join(' ') : '-'}`;
  };
  // one step: waits for you, as long as `ms`; an axis is done when pressed and let go again, a button when held
  async function step(phase, title, text, ms) {
    learn.phase = phase; learn.best = null; learn.cand = null;
    learn.rest = snapshot(phase === 'axis' ? lay.axes : lay.buttons);
    const t0 = performance.now();
    let pressed = false;
    for (;;) {
      const left = Math.ceil((ms - (performance.now() - t0)) / 1000);
      if (left <= 0 || learn.cancel) break;
      show(title, `${text}\n(${left} s, or wait to skip; Esc cancels)`, live());
      const b = learn.best;
      if (phase === 'axis' && b && report) {
        const d = Math.abs(field(b) - b.rest) / Math.max(1, Math.abs(b.full - b.rest));
        if (b.dev >= 0.3) pressed = true;
        if (pressed && d < 0.3) break;   // let go again
      }
      if (phase === 'button' && learn.cand && performance.now() - learn.cand.since > 300) { learn.best = learn.cand; break; }
      await sleep(50);
    }
    const b = learn.best; learn.phase = 'wait';
    return learn.cancel || (phase === 'axis' && !pressed) ? null : b;
  }
  // the buttons after the paddles, each one skipped by waiting: [name in the map, what it does, how long it waits]
  const MORE = [['start', 'START / PAUSE (the race menu, Esc)', 8000], ['ok', 'CONFIRM (Enter in the menus)', 8000], ['back', 'BACK (Esc in the menus)', 8000],
    ['cam', 'CAMERA (C)', 6000], ['restart', 'RESTART the race (R)', 6000]];
  const PEDALS = ['gas', 'brake'], BUTTONS = ['up', 'down', ...MORE.map(b => b[0])];
  // two setups, each started from the Wheel menu and each saving only its own part of the map, the other kept as it
  // was: 'pedals' (the throttle and the brake) or 'buttons' (the gear paddles, then the buttons in MORE). The Wheel menu
  // stays open under the prompts (moved into its dialog: the top layer covers anything else), its input ignored but Esc,
  // which cancels the setup (see onKey); at the end, back to the menu on the item that started it
  let setupRun = 0;
  async function learnControls(part) {
    if (!dev || learn) return;
    keys.release();
    const run = ++setupRun;
    if (dlg.open) dlg.appendChild(panel);
    const done = async ms => { await sleep(ms); if (run !== setupRun) return; hide(); document.body.appendChild(panel); };
    if (lay.ps4) { show('Wheel setup', 'This wheel is in PS4 mode, where the pedals and buttons aren\'t described. Switch it to PS3 mode, then set it up again in the Wheel menu.'); await done(5000); return; }
    const pedalsPart = part === 'pedals', title = pedalsPart ? 'Pedal setup' : 'Button setup';
    learn = { phase: 'wait', used: new Set(), usedB: new Set() };
    show(title, 'Let go of the wheel, the pedals and the buttons', live());
    await sleep(1500);
    learn.base = snapshot(lay.buttons);
    const m = {};
    const N = pedalsPart ? 2 : 2 + MORE.length;
    let i = 0;
    const letGo = async t => { show(t, 'Let go of the button'); await sleep(700); };
    if (pedalsPart) {
      m.gas = await step('axis', `${title} ${++i}/${N}`, 'Press the THROTTLE all the way, then let go', 20000);
      if (m.gas) learn.used.add(m.gas.offset);
      m.brake = await step('axis', `${title} ${++i}/${N}`, 'Press the BRAKE all the way, then let go', 20000);
    } else {
      m.up = await step('button', `${title} ${++i}/${N}`, 'Press and HOLD the GEAR UP paddle', 10000);
      if (m.up) { learn.usedB.add(m.up.offset); await letGo(`${title} ${i}/${N}`); }
      m.down = await step('button', `${title} ${++i}/${N}`, 'Press and HOLD the GEAR DOWN paddle', 10000);
      if (m.down) { learn.usedB.add(m.down.offset); await letGo(`${title} ${i}/${N}`); }
      for (const [id, what, ms] of MORE) {
        m[id] = await step('button', `${title} ${++i}/${N}`, 'Press and HOLD the button for\n' + what, ms);
        if (m[id]) { learn.usedB.add(m[id].offset); await letGo(`${title} ${i}/${N}`); }
      }
    }
    const cancelled = learn.cancel;
    learn = null;
    car.paddleUp = car.paddleDown = true;   // (a paddle still held from setup doesn't shift: wait for it to be let go)
    for (const id of BTN) held[id] = true;   // (nor a button: each waits to be let go first)
    hatWas = hatDir(); hatRep = performance.now() + 400;   // (nor the d-pad, in the menu)
    if (dlg.open && !rows[menuIdx].hidden) rows[menuIdx].focus();
    if (cancelled) { console.log('[wheel] setup cancelled'); show(title, 'Cancelled, nothing saved.'); await done(1500); return; }
    const ids = pedalsPart ? PEDALS : BUTTONS, ok = ids.some(id => m[id]);
    if (ok) {
      const next = { v: MAP_VERSION };
      for (const id of pedalsPart ? BUTTONS : PEDALS) if (map && map[id]) next[id] = map[id];
      for (const id of ids) if (m[id]) next[id] = m[id];
      map = next; store(mapKey(), JSON.stringify(map));
    }
    const n = x => x ? x.name : 'none';
    console.log('[wheel] setup', part, JSON.stringify(m));
    show(title, !ok ? `No ${pedalsPart ? 'pedals' : 'buttons'} found, nothing saved. Set them up again in the Wheel menu (Options).`
      : (pedalsPart ? `Done. Throttle: ${n(m.gas)}, brake: ${n(m.brake)}.`
                    : `Done. Gear up: ${n(m.up)}, gear down: ${n(m.down)}, start: ${n(m.start)}, confirm: ${n(m.ok)}, back: ${n(m.back)}, camera: ${n(m.cam)}, restart: ${n(m.restart)}.`)
        + `\nThe Wheel menu (Options) sets them up again.`);
    await done(4000);
  }
  // A pedal's travel, 0..1, from rest toward the learnt full press (pedals may read high at rest and low pressed), with
  // a dead zone at each end: under 10% is let go, over 90% all the way, rescaled in between
  const travel = p => {
    if (!p || !report) return 0;
    const t = (field(p) - p.rest) * Math.sign(p.full - p.rest) / Math.max(1, Math.abs(p.full - p.rest));
    return clamp((t - 0.1) / 0.8, 0, 1);
  };
  // Analog pedals: the game has only keys for the throttle and the brake (on or off each tick, and replays are those
  // keys), so a pedal part way down holds its key on that share of the game's ticks: each new tick adds the travel to an
  // account, and the key is down on the ticks where it reaches 1 (half way: every other tick). All the way: every tick,
  // as before; let go: up at once. (A game clock standing still, as before the start, where it waits for the first input:
  // a tick every 80 ms all the same, or a pedal part way down would never start the race.)
  const pwm = { gas: { acc: 0, on: false }, brake: { acc: 0, on: false }, frame: -1, at: 0 };
  function pedals(now) {
    const tick = car.frame !== pwm.frame || now - pwm.at > 80;
    if (tick) { pwm.frame = car.frame; pwm.at = now; }
    for (const id of ['gas', 'brake']) {
      const t = travel(map[id]), s = pwm[id];
      if (t >= 1) { s.on = true; s.acc = 0; }
      else if (t <= 0) { s.on = false; s.acc = 0; }
      else if (tick) { s.acc += t; s.on = s.acc >= 1; if (s.on) s.acc -= 1; }
    }
    keys.set('ArrowUp', pwm.gas.on); keys.set('ArrowDown', pwm.brake.on);
  }
  const button = b => b && report ? field(b) !== b.restV : false;

  // ---- connecting
  async function open(d) {
    if (HIDPP[d.productId]) { say(`Wheel: the ${HIDPP[d.productId]} uses HID++, which this doesn't support yet`); return; }
    try { if (!d.opened) await d.open(); } catch (e) { say('Wheel: could not open it (' + e.message + ')'); return; }
    const l = parseLayout(d);
    if (!l) { say('Wheel: no wheel axis found on ' + d.productName); return; }
    if (dev && dev !== d) close();
    dev = d; lay = l; report = null; lastLevel = -1; slotSent[3] = slotSent[4] = ''; store('stunts-wheel-last', String(d.productId)); store('stunts-wheel-off', '0');
    if (soft()) softRot = clamp(+load(softKey()) || PHYS[d.productId], 90, PHYS[d.productId]);
    dev.addEventListener('inputreport', onReport);
    while (busy) await sleep(2);
    busy = true;
    await cmd([0xF5, 0, 0, 0, 0, 0, 0]);          // the wheel's own centring spring off: the force is all ours
    await sleep(5);
    busy = false;
    await setRange();
    window.stuntsWheel.active = true;
    const saved = load(mapKey());
    try { map = saved ? JSON.parse(saved) : null; } catch (_) { map = null; }
    if (map && map.v !== MAP_VERSION) map = null;   // (an older setup: set up again)
    describe(lay);
    // (no setup started from here: only from the Wheel menu)
    say(`Wheel: ${CLASSIC[dev.productId] || dev.productName} connected` + (map && (map.gas || map.brake) ? '' : '; pedals not set up yet (Options → Wheel)'));
  }
  function close() {
    keys.release();
    if (dev) { dev.removeEventListener('inputreport', onReport); }
    dev = null; lay = null; report = null; window.stuntsWheel.active = false; slotSent[3] = slotSent[4] = '';
    releaseWheelKeys(); renderMenu();
  }
  // "Disconnect FFB device": the forces stopped, the wheel let go and forgotten (the browser's permission for it given
  // back), and no reconnecting by itself at the next start until one is picked again
  async function disconnect() {
    const d = dev; if (!d) return;
    keys.release();
    while (busy) await sleep(2);
    busy = true;
    try { await cmd([0x13, 0, 0, 0, 0, 0, 0]); await cmd([0x23, 0, 0, 0, 0, 0, 0]); await cmd([0x43, 0, 0, 0, 0, 0, 0]); await cmd([0x83, 0, 0, 0, 0, 0, 0]); await cmd([0xF3, 0, 0, 0, 0, 0, 0]); } finally { busy = false; }   // (the force, the soft lock, the centring spring, the damper, all)
    close(); store('stunts-wheel-off', '1');
    try { if (d.forget) await d.forget(); else if (d.opened) await d.close(); } catch (_) {}
    renderMenu();
  }
  window.stuntsWheel = { active: false, get noRewind() { return !!dev && direct; } };   // (noRewind: for qol.js's Q)
  navigator.hid.addEventListener('disconnect', e => { if (e.device === dev) { close(); say('Wheel disconnected'); } });
  navigator.hid.getDevices().then(list => {   // (the wheel used last, if it's plugged in; else the first classic one)
    if (load('stunts-wheel-off') === '1') return;   // (let go from the Wheel menu: only picked again there)
    const ok = list.filter(d => d.vendorId === 0x046D && CLASSIC[d.productId] && parseLayout(d)), last = +load('stunts-wheel-last');
    const d = ok.find(d => d.productId === last) || ok[0]; if (d) open(d);
  });
  async function connect() {
    try {
      const list = await navigator.hid.requestDevice({ filters: [{ vendorId: 0x046D }] });
      if (!list.length) return;
      // (a wheel can show as several HID interfaces: take the one with the wheel axis)
      const pick = list.find(d => !HIDPP[d.productId] && parseLayout(d)) || list[0];
      if (pick === dev) { say(`Wheel: ${CLASSIC[dev.productId] || dev.productName}, force ${Math.round(gain * 100)}%, rotation ${rotation}\u00B0`); return; }
      if (dev) { await force(0); close(); }
      await open(pick);
    } catch (e) { say('Wheel: ' + e.message); }
  }
  const stopAll = () => { if (dev && dev.opened) { cmd([0x23, 0, 0, 0, 0, 0, 0]); cmd([0x43, 0, 0, 0, 0, 0, 0]); cmd([0x83, 0, 0, 0, 0, 0, 0]); cmd([0xF3, 0, 0, 0, 0, 0, 0]); cmd([0xF4, 0, 0, 0, 0, 0, 0]); } };
  addEventListener('pagehide', stopAll);

  // ---- page keys (before the game and qol.js see them)
  const typingNow = () => typeof typing === 'function' && typing();
  const swallow = new Set();
  function onKey(e, down) {
    if (!down && swallow.has(e.code)) { swallow.delete(e.code); e.stopImmediatePropagation(); e.preventDefault(); return; }
    if (dlg.open) {   // (the Wheel menu up: its keys, and none reach the game)
      e.stopImmediatePropagation(); e.preventDefault();
      if (!down) return;
      swallow.add(e.code);
      const c = e.code;
      if (learn) { if (c === 'Escape' && !e.repeat) learn.cancel = true; return; }   // (a setup running: Esc cancels it, nothing else)
      if (c === 'ArrowUp' || (c === 'Tab' && e.shiftKey)) menuDir('up');
      else if (c === 'ArrowDown' || c === 'Tab') menuDir('down');
      else if (c === 'ArrowLeft' || c === 'ArrowRight') { if (!e.repeat || menuItem().step) menuDir(c === 'ArrowLeft' ? 'left' : 'right'); }
      else if ((c === 'Enter' || c === 'NumpadEnter' || c === 'Space') && !e.repeat) menuAct();
      else if (c === 'Escape' && !e.repeat) closeMenu();
      return;
    }
    if (!down || typingNow() || e.ctrlKey || e.altKey || e.metaKey) return;
    let mine = true;
    if ((e.code === 'BracketLeft' || e.code === 'BracketRight') && dev) {
      const up = e.code === 'BracketRight';
      if (e.shiftKey && soft()) { setSoft(softRot + (up ? 30 : -30)); say(`Wheel rotation ${softRot}° (soft lock)`); }
      else if (e.shiftKey) { rotation = clamp(rotation + (up ? 30 : -30), 90, 900); store('stunts-wheel-rotation', rotation); setRange(); say(`Wheel rotation ${rotation}\u00B0` + (SET_RANGE.has(dev.productId) ? '' : ' (this wheel keeps its own)')); }
      else { gain = clamp(Math.round((gain + (up ? 0.1 : -0.1)) * 10) / 10, 0, 1.5); store('stunts-wheel-gain', gain); say(`Wheel force ${Math.round(gain * 100)}%`); }
    }
    else mine = false;
    if (mine) { swallow.add(e.code); e.stopImmediatePropagation(); e.preventDefault(); }
  }
  addEventListener('keydown', e => onKey(e, true), true);
  addEventListener('keyup', e => onKey(e, false), true);

  // ---- the car, read on each new game tick
  const car = { frame: -1, steer: 0, center: 0, speed: 0, load: 0, sliding: false, air: false, ice: 0, rough: 0, skid: false, crashed: false, susp: [0, 0, 0, 0] };
  const jolts = [];   // { t0, ms, amp, hz, land }: short shakes on events
  const jolt = (amp, ms, hz, land) => jolts.push({ t0: performance.now(), ms, amp, hz, land: !!land });
  function readCar() {
    const f = s16(r16(GAME_FRAME));
    if (f === car.frame) return;
    car.frame = f;
    const sound = r8(PS + C_SOUND), crash = s8(r8(PS + C_CRASH));
    car.steer = s16(r16(PS + C_STEER)) / STEER_MAX;
    car.speed = r16(PS + C_SPEED) / 256;                 // about mph
    const demand = s16(r16(PS + C_DEMAND)), grip = s16(r16(PS + C_GRIPSUM));
    car.load = grip > 0 ? clamp(demand / grip, 0, 1.5) : 0;
    car.sliding = r8(PS + C_SLIDING) !== 0 || s16(r16(PS + C_SLIDEYAW)) !== 0;
    car.air = r8(PS + C_SURFALL) === 0;
    let ice = 0, rough = 0;
    for (let i = 0; i < 4; i++) { const s = r8(PS + C_SURF + i); if (s === SURF_ICE) ice++; else if (s === SURF_GRASS) rough += 1; else if (s === SURF_DIRT) rough += 0.6; }
    car.ice = ice / 4; car.rough = rough / 4;
    car.skid = (sound & SND_SKID) !== 0;
    // suspension: a sudden change between the two sides kicks the rim (bumps, kerbs, landing on one side)
    const susp = [0, 1, 2, 3].map(i => s16(r16(PS + C_SUSP + i * 2)));
    const side = (susp[0] + susp[2]) - (susp[1] + susp[3]), prevSide = (car.susp[0] + car.susp[2]) - (car.susp[1] + car.susp[3]);
    if (Math.abs(side - prevSide) > 60 && !car.air) jolt(clamp(Math.abs(side - prevSide) / 400, 0.1, 0.5) * Math.sign(side - prevSide), 60, 0);
    car.susp = susp;
    if (sound & SND_WALL) jolt(0.7, 120, 18);
    if (sound & SND_LANDING) jolt(0.5, 90, 22, true);
    if (crash !== 0 && !car.crashed) jolt(1, 350, 14);
    car.crashed = crash !== 0;
    // roadside objects knocked down: the game keeps them in state's 24-entry lists (field_2FE .. field_3BE) and a count
    // (field_3F4); a change there, the race going on (not a restart), is a new one hit. The game goes on changing them
    // tick after tick while the object falls: one short jolt for the first change, none until they have been still a while
    let ob = 0; for (let a = S.state + OBJ_FROM; a <= S.state + OBJ_TO; a++) ob = (ob * 31 + r8(a)) >>> 0;
    if (car.objSig != null && ob !== car.objSig && f > car.objFrame) {
      if (!(f - car.objLast < 8)) jolt(0.5, 90, 22, true);   // (still for 0.4 s, 8 ticks: a new hit; the landing's jolt, kept as it is in the air: a hit can throw the car up)
      car.objLast = f;
    }
    car.objSig = ob; car.objFrame = f;
  }

  // ---- kerbs: red and white paint over the road. A wheel is on a kerb when the HD view finds a red material under it,
  // and stays on it over the white stripes that follow; white alone (a road's line, the start line) is not a kerb.
  // A material counts by its colour in the game's own table, so a recoloured kerb still works if it stays red and white;
  // or set the list yourself: localStorage['stunts-kerb-mats'] = '[n, n]' (the materials, view.wheelMat)
  const kerbOwn = (() => { try { const v = JSON.parse(load('stunts-kerb-mats') || 'null'); return Array.isArray(v) ? new Set(v) : null; } catch (e) { return null; } })();
  const matKind = new Map();   // material -> 0 other, 1 white, 2 red, 3 red and white in one (a two-colour pattern)
  function kind(m) {
    if (m < 0) return 0;
    if (kerbOwn) return kerbOwn.has(m) ? 3 : 0;
    if (matKind.has(m)) return matKind.get(m);
    let k = 0;
    try {
      const c = view.color(m), red = q => q[0] > 0.55 && q[1] < 0.5 && q[2] < 0.5 && q[0] > 1.6 * Math.max(q[1], q[2]), white = q => q[0] > 0.75 && q[1] > 0.75 && q[2] > 0.75;
      if (c.two) k = (red(c.two[0]) && white(c.two[1])) || (red(c.two[1]) && white(c.two[0])) ? 3 : 0;
      else k = red(c) ? 2 : white(c) ? 1 : 0;
    } catch (e) {}
    matKind.set(m, k); return k;
  }
  const kerbUntil = [0, 0, 0, 0];
  function kerbs(now) {   // 0..1: how much of the car is on a kerb (front wheels count double)
    const v = typeof view !== 'undefined' && view, mats = v && v.wheelMat, fresh = mats && now - v.wheelMatAt < 150;
    let on = 0;
    for (let i = 0; i < 4; i++) {
      const kd = fresh ? kind(mats[i]) : 0;
      if (kd >= 2) kerbUntil[i] = now + 250;                         // red: on a kerb
      else if (kd === 1 && kerbUntil[i] > now) kerbUntil[i] = now + 250;   // white right after red: still on it
      else if (kd === 0) kerbUntil[i] = 0;
      if (kerbUntil[i] > now) on += v.wheelFront && v.wheelFront[i] ? 2 : 1;
    }
    return Math.min(on / 3, 1);
  }

  // ---- the wheel's buttons and d-pad: through the page's own key handler (main.js key(), qol.js's keys first: R
  // restarts), as if pressed on the keyboard. Racing: Start and Back are Esc (the race menu), Camera C,
  // Restart R; the d-pad sends nothing there (the arrow keys are the steering's). In the menus: the d-pad is the arrow
  // keys, Confirm Enter, Back and Start Esc. With the Wheel menu up, they work that instead. (No rewind on the wheel: a
  // race wound back plays on from the recorded keys, not the steering 1:1 writes.)
  const BTN = ['start', 'ok', 'back', 'cam', 'restart'];
  const held = {};   // each button as last read: a press is its change to held
  const KEYCH = { Enter: 'Enter', Escape: 'Escape', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', KeyC: 'c', KeyR: 'r' };
  const pageKey = (code, down) => { if (typeof key === 'function') key({ code, key: KEYCH[code] || '', repeat: false, preventDefault() {} }, down); };
  const pageTap = async code => { pageKey(code, true); await sleep(70); pageKey(code, false); };
  const DIRKEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  // the d-pad's direction: 0..7 from up, clockwise; a diagonal counts as up or down (the menus are lists)
  function hatDir() {
    const h = lay && lay.hat; if (!h || !report) return null;
    const v = field(h) - h.min, n = h.max - h.min + 1;
    if (v < 0 || v >= n) return null;   // (let go: the null state, outside the logical range)
    return ['up', 'up', 'right', 'down', 'down', 'down', 'left', 'up'][Math.round(v * 8 / n) & 7];
  }
  let hatWas = null, hatRep = 0, hatKey = null;
  function releaseWheelKeys() { if (hatKey) { pageKey(hatKey, false); hatKey = null; } }
  function wheelInput(now, live) {
    const press = {};
    for (const id of BTN) { const on = !!(map && map[id]) && button(map[id]); press[id] = on && !held[id]; held[id] = on; }
    const dir = hatDir();
    if (dlg.open) {
      if (hatKey) { pageKey(hatKey, false); hatKey = null; }
      if (dir !== hatWas) { hatRep = now + 400; if (dir) menuDir(dir); }   // (held: again and again after a moment, as a key repeats)
      else if (dir && now >= hatRep && (dir === 'up' || dir === 'down' || menuItem().step)) { hatRep = now + 120; menuDir(dir); }
      if (press.ok) menuAct();
      else if (press.back || press.start) closeMenu();
    } else if (live) {
      if (hatKey) { pageKey(hatKey, false); hatKey = null; }
      if (press.start || press.back) pageTap('Escape');
      if (press.cam) pageTap('KeyC');
      if (press.restart) pageTap('KeyR');
    } else {
      const kc = dir ? DIRKEY[dir] : null;   // (held as long as the d-pad is: the game repeats it itself)
      if (kc !== hatKey) { if (hatKey) pageKey(hatKey, false); if (kc) pageKey(kc, true); hatKey = kc; }
      if (press.ok) pageTap('Enter');
      if (press.start || press.back) pageTap('Escape');
    }
    hatWas = dir;
  }

  // ---- the Wheel menu (wheelMenu): a button on the game's Options screen (worker.js says while run_option_menu runs:
  // window.stuntsOptions, main.js), in the game's button style as the track menu's Import / Export (qol.js), at the same
  // place; it opens a box of the same make with all the wheel's settings, worked with the mouse, the keys (arrows, Enter,
  // Esc) or the wheel itself (d-pad, Confirm, Back)
  const wcss = document.createElement('style');
  wcss.textContent = `
    #whlbtn { position: fixed; z-index: 5; display: none; padding: 0; border: 0; background: #aaa; cursor: pointer;
      box-shadow: inset var(--b) var(--b) 0 #fff, inset calc(-1 * var(--b)) calc(-1 * var(--b)) 0 #555; outline: var(--b) solid transparent; }
    #whlbtn:hover, #whlbtn:focus-visible { outline-color: #ff5; }
    #whlbtn canvas { display: block; width: 100%; height: 100%; image-rendering: pixelated; pointer-events: none; }
    #whlmenu { border: 0; padding: 0; background: transparent; max-width: calc(100vw - 24px); cursor: auto; overflow: visible; }
    #whlmenu::backdrop { background: rgba(0, 0, 0, .55); }
    #whlmenu .box { background: #aaa; padding: calc(var(--u) * 8) calc(var(--u) * 10) calc(var(--u) * 9); display: grid; gap: calc(var(--u) * 1.5);
      box-shadow: inset var(--b) var(--b) 0 #fff, inset calc(-1 * var(--b)) calc(-1 * var(--b)) 0 #555; }
    #whlmenu canvas { display: block; position: static; transform: none; image-rendering: pixelated; pointer-events: none; }   /* (the page centres every canvas absolutely: not these) */
    #whlmenu .title { margin: 0 auto; }
    #whlmenu .note { margin: 0 auto calc(var(--u) * 5); }
    #whlmenu .it { display: flex; align-items: center; gap: calc(var(--u) * 4); min-height: calc(var(--u) * 11); padding: 0 calc(var(--u) * 4); cursor: pointer; outline: var(--b) solid transparent; }
    #whlmenu .it:focus { outline-color: #ff5; }
    #whlmenu .it[hidden] { display: none; }
    #whlmenu .it .l { margin-right: auto; }
    #whlmenu button.b { flex: none; padding: calc(var(--u) * 1.5) calc(var(--u) * 3); border: 0; border-radius: 0; background: #aaa; cursor: pointer;
      box-shadow: inset var(--b) var(--b) 0 #fff, inset calc(-1 * var(--b)) calc(-1 * var(--b)) 0 #555; }
    #whlmenu button.b:active { box-shadow: inset var(--b) var(--b) 0 #555, inset calc(-1 * var(--b)) calc(-1 * var(--b)) 0 #fff; }
    #whlmenu .v { min-width: calc(var(--u) * 24); }`;
  document.head.appendChild(wcss);
  const setGain = v => { gain = clamp(Math.round(v * 10) / 10, 0, 1.5); store('stunts-wheel-gain', gain); };
  const setSpring = v => { springK = clamp(Math.round(v * 4) / 4, 0, 3); store('stunts-wheel-spring', springK); };
  const setDamperK = v => { damperK = clamp(Math.round(v * 4) / 4, 0, 3); store('stunts-wheel-damper', damperK); };
  const setRot = v => { rotation = clamp(v, 90, 900); store('stunts-wheel-rotation', rotation); setRange(); };
  const setDirect = v => { direct = v; store('stunts-wheel-direct', v ? '1' : '0'); };
  const setRough = v => { rumbleRough = v; store('stunts-wheel-rough', v ? '1' : '0'); };
  const onOff = v => v ? 'On' : 'Off';
  // (label, value shown, step: left/right or - and +, act: a click, Enter or Confirm; show: whether it's there now)
  const ITEMS = [
    { label: () => dev ? 'Disconnect FFB device' : 'Select a Logitech FFB device', value: () => dev ? CLASSIC[dev.productId] || dev.productName : '', act: () => dev ? disconnect() : connect() },
    { label: () => 'Force strength', value: () => Math.round(gain * 100) + '%', step: d => setGain(gain + d * 0.1) },
    { label: () => 'Centering spring', value: () => Math.round(springK * 100) + '%', step: d => setSpring(springK + d * 0.25) },
    { label: () => 'Damper', value: () => Math.round(damperK * 100) + '%', step: d => setDamperK(damperK + d * 0.25) },
    { label: () => soft() ? 'Rotation (soft lock)' : 'Rotation', value: () => (soft() ? softRot : rotation) + '°',
      step: d => soft() ? setSoft(softRot + d * 30) : setRot(rotation + d * 30), show: () => !!dev && (SET_RANGE.has(dev.productId) || soft()) },
    { label: () => '1:1 steering', value: () => onOff(direct), act: () => setDirect(!direct), turn: true },
    { label: () => 'Grass and dirt rumble', value: () => onOff(rumbleRough), act: () => setRough(!rumbleRough), turn: true },
    { label: () => 'Set up pedals', value: () => '', act: () => learnControls('pedals'), show: () => !!dev },
    { label: () => 'Set up buttons', value: () => '', act: () => learnControls('buttons'), show: () => !!dev },
    { label: () => 'Close', value: () => '', act: () => closeMenu() },
  ];
  const wbtn = document.createElement('button'); wbtn.id = 'whlbtn'; wbtn.type = 'button'; wbtn.title = 'The steering wheel\'s settings';
  const wbc = document.createElement('canvas'); wbtn.appendChild(wbc); document.body.appendChild(wbtn);
  const dlg = document.createElement('dialog'); dlg.id = 'whlmenu';
  dlg.innerHTML = '<div class="box"><canvas class="title" data-t="Wheel"></canvas><canvas class="note" data-t="1:1 steering produces wrong replay data"></canvas>' + ITEMS.map((it, i) => `<div class="it" tabindex="-1" data-i="${i}"><canvas class="l"></canvas>`
    + (it.step ? '<button class="b" type="button" data-d="-1" tabindex="-1"><canvas data-t="-"></canvas></button><canvas class="v"></canvas><button class="b" type="button" data-d="1" tabindex="-1"><canvas data-t="+"></canvas></button>' : '<canvas class="v"></canvas>') + '</div>').join('') + '</div>';
  document.body.appendChild(dlg);
  for (const el of [wbtn, dlg]) for (const ev of ['pointerdown', 'pointerup', 'pointermove', 'click']) el.addEventListener(ev, e => e.stopPropagation());   // (not the game's mouse)
  const rows = [...dlg.querySelectorAll('.it')];
  let gu = 2, menuIdx = 0;
  // (text in the game's font, black, drawn at the size of the game's own pixels: as qol.js's boxes)
  function paint(cv, t) {
    const font = typeof hudFont === 'function' && hudFont(); if (!font) return;
    if (t == null) t = cv.dataset.t || '';
    const key = t + '@' + gu; if (cv.dataset.p === key) return; cv.dataset.p = key;
    const dpr = devicePixelRatio || 1, u = gu * dpr * (cv.closest('button') || cv.classList.contains('note') ? 0.75 : cv.classList.contains('title') ? 1.2 : 1);
    const m = document.createElement('canvas').getContext('2d'), w = t ? hudText(m, font, t, 0, 8 * u, u, 'left', 0, 0, '0,0,0', false) : 0;
    cv.width = Math.max(1, Math.ceil(w)); cv.height = Math.ceil(9 * u);
    cv.style.width = cv.width / dpr + 'px'; cv.style.height = cv.height / dpr + 'px';
    if (t) hudText(cv.getContext('2d'), font, t, 0, 8 * u, u, 'left', 1, 0, '0,0,0', false);
  }
  function renderMenu() {
    if (!dlg.open) return;
    ITEMS.forEach((it, i) => {
      const r = rows[i]; r.hidden = !!it.show && !it.show();
      paint(r.querySelector('.l'), it.label()); paint(r.querySelector('.v'), it.value());
    });
    if (rows[menuIdx].hidden) menuDir('down');
  }
  const menuItem = () => ITEMS[menuIdx];
  function menuDir(dir) {
    if (dir === 'up' || dir === 'down') {
      const n = rows.length;
      for (let k = 1; k <= n; k++) { const j = (menuIdx + (dir === 'down' ? k : n - k)) % n; if (!rows[j].hidden) { menuIdx = j; break; } }
      rows[menuIdx].focus();
      return;
    }
    const it = menuItem();
    if (it.step) it.step(dir === 'right' ? 1 : -1); else if (it.turn) it.act();
    renderMenu();
  }
  function menuAct() { const it = menuItem(); if (it.act) Promise.resolve(it.act()).then(renderMenu, renderMenu); }
  function openMenu() {
    if (learn) return;
    gu = Math.max(1.5, Math.min(3, document.getElementById('screen').getBoundingClientRect().height / 200));
    dlg.style.setProperty('--u', gu + 'px'); dlg.style.setProperty('--b', Math.max(1, Math.round(gu)) + 'px');
    keys.release(); releaseWheelKeys();
    dlg.showModal();
    paint(dlg.querySelector('.title')); paint(dlg.querySelector('.note')); dlg.querySelectorAll('button canvas').forEach(c => paint(c));
    menuIdx = 0; renderMenu(); rows[menuIdx].focus();
  }
  function closeMenu() { if (learn) learn.cancel = true; if (dlg.open) dlg.close(); }   // (closed under a setup, as when leaving Options: the setup cancelled)
  wbtn.addEventListener('click', openMenu);
  rows.forEach((r, i) => {
    r.addEventListener('pointerenter', () => { if (!r.hidden && !learn) { menuIdx = i; r.focus(); } });
    r.addEventListener('click', e => {
      if (learn) return;   // (the menu stays still under a setup)
      menuIdx = i; r.focus();
      const b = e.target.closest('button.b');
      if (b) { ITEMS[i].step(+b.dataset.d); renderMenu(); } else menuAct();
    });
  });
  // (a click on the backdrop closes it; not a press that began inside and ended out there)
  let downOut = false; dlg.addEventListener('pointerdown', e => { downOut = e.target === dlg; });
  dlg.addEventListener('click', e => { if (e.target === dlg && downOut && !learn) closeMenu(); });
  dlg.addEventListener('cancel', e => { e.preventDefault(); if (learn) learn.cancel = true; else closeMenu(); });
  // the button: on the Options screen, at the right of the view, below the game's title (at the corner, where the track
  // menu's Import / Export is, it covered the title)
  let wdrawn = '';
  const wplace = () => {
    const on = !!window.stuntsOptions && !document.getElementById('setup');
    const d = on ? 'block' : 'none'; if (wbtn.style.display !== d) wbtn.style.display = d;
    if (!on) { if (dlg.open) closeMenu(); return; }
    const r = document.getElementById('screen').getBoundingClientRect(), u = r.height / 200;
    const hr = document.getElementById('gl') && document.getElementById('gl').getBoundingClientRect(), g = hr && hr.width ? hr : r, mg = g.height * 0.04;
    const w = Math.round(60 * u), h = Math.round(13 * u);
    wbtn.style.left = Math.round(g.right - mg - w) + 'px'; wbtn.style.top = Math.round(g.top + mg * 0.6 + 24 * u) + 'px';
    wbtn.style.width = w + 'px'; wbtn.style.height = h + 'px'; wbtn.style.setProperty('--b', Math.max(1, Math.round(u)) + 'px');
    const dpr = devicePixelRatio || 1, k = w + 'x' + h + '@' + dpr, font = typeof hudFont === 'function' && hudFont();
    if (wdrawn !== k && font) {
      wdrawn = k; wbc.width = Math.round(w * dpr); wbc.height = Math.round(h * dpr);
      const c = wbc.getContext('2d'), uu = u * dpr; c.clearRect(0, 0, wbc.width, wbc.height);
      hudText(c, font, 'Wheel', wbc.width / 2, wbc.height / 2 + 3 * uu, uu * 0.75, 'center', 1, 0, '0,0,0', false);
    }
  };
  const wloop = () => { wplace(); requestAnimationFrame(wloop); }; requestAnimationFrame(wloop);

  // ---- the force and the controls, a few hundred times a second
  let phase = 0, lastT = performance.now();
  function tick() {
    const now = performance.now(), dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
    if (!dev || !lay) return;
    if (learn) { force(0); return; }
    const live = racing();   // (not waiting for game_inputmode: the race only starts on the first input, which the wheel gives)
    wheelInput(now, live);
    let f;
    if (!live) {
      keys.release();
      f = 0; setCentre(centreS(0), now); setDamper(0, now);   // the centring spring in menus and before the start too
    } else {
      readCar();
      // steering: hold an arrow key until the car's steering angle reaches the wheel's
      const sk = steerK(), w = clamp(wheelPos * sk, -1, 1), tgt = w * STEER_MAX, ang = car.steer * STEER_MAX, full = Math.abs(w) >= 0.97;
      if (direct && !car.crashed) steerDirect(tgt);
      else {
        keys.set('ArrowRight', !car.crashed && w > 0.01 && (full || ang < tgt - 4));
        keys.set('ArrowLeft', !car.crashed && w < -0.01 && (full || ang > tgt + 4));
      }
      if (map) {
        if (map.gas || map.brake) pedals(now);
        const up = button(map.up), down = button(map.down);
        if (up && !car.paddleUp) tap('KeyA'); if (down && !car.paddleDown) tap('KeyZ');
        car.paddleUp = up; car.paddleDown = down;
      }
      // where the front wheels are, smoothed between the game's 20 ticks a second
      car.center += (car.steer - car.center) * (1 - Math.exp(-dt / 0.04));
      const spd = clamp(car.speed / 90, 0, 1);
      let grip = car.air ? 0.15 : car.crashed ? 0.2 : 1;
      grip *= 1 - 0.6 * car.ice;
      if (car.sliding) grip *= 0.35;                    // the wheel goes light when the tyres let go
      const follow = -(0.35 + 0.45 * spd) * (w - car.center) * (car.air ? 0.3 : 1);
      const align = -(0.08 + 0.55 * spd * Math.min(car.load, 1.2)) * w * grip;
      setDamper(car.air ? 0 : (0.012 + 0.03 * spd) * damperK * gain * sk * (1 - 0.5 * car.ice) * (car.crashed ? 0.5 : 1), now);   // (the damper: slot 4)
      setCentre(car.air ? 0 : centreS(spd), now);   // (a plain spring to the rim's centre, whatever the car does: slot 3)
      phase += dt;
      let tex = 0;
      if (!car.air && car.speed > 4) {
        const kb = kerbs(now);
        // (a kerb lies past the road's edge, where the physics sees grass: on one, its rattle instead of the grass's rumble)
        if (rumbleRough) tex += car.rough * (1 - kb) * 0.13 * Math.min(car.speed / 40, 1) * Math.sin(phase * 2 * Math.PI * (14 + car.speed / 6));
        if (car.skid) tex += 0.05 * Math.sin(phase * 2 * Math.PI * 30);
        // kerb: a square-wave rattle, faster with speed (the stripes passing under the tyres), harder than grass
        if (kb > 0) tex += kb * (0.1 + 0.1 * Math.min(car.speed / 60, 1)) * (Math.sin(phase * 2 * Math.PI * clamp(8 + car.speed * 0.3, 8, 32)) >= 0 ? 1 : -1);
      } else kerbs(now);
      f = car.air ? 0 : follow + align + tex;   // (in the air: no force at all, the rim free; only the landing's jolt, on touchdown)
    }
    const air = live && car.air;
    for (let i = jolts.length - 1; i >= 0; i--) {
      const j = jolts[i], t = now - j.t0;
      if (t > j.ms || air && !j.land) { jolts.splice(i, 1); continue; }
      const env = 1 - t / j.ms;
      f += j.amp * env * (j.hz ? Math.sign(Math.sin(2 * Math.PI * j.hz * t / 1000)) || 1 : 1);
    }
    force(clamp(f * gain, -1, 1));
  }
  setInterval(tick, 4);
  addEventListener('blur', () => { keys.release(); releaseWheelKeys(); if (dev) { force(0); slotAt[3] = slotAt[4] = 0; setCentre(0, performance.now()).then(() => setDamper(0, performance.now())); } });
})();
