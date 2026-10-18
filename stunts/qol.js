// Comforts around the original game, all on the page (the game itself is untouched):
//   R              restart the race at once (the Replay Menu's "Re-Start Driving", no menus shown)
//   Q (hold)       rewind the race, a second at a time (the Replay Menu's wind back and "Continue Driving")
//   Alt+Enter, F   fullscreen (F: not while typing a name)
//   F9 / F7 / F8   mute, volume down / up (remembered)
//   F6             your files (saved replays and tracks): download them; drop .TRK / .RPL files on the page
//   gamepad        stick or d-pad steers (partly, by how far), RT/A accelerate, LT/B brake, RB/LB gear
//                  up/down, X camera, Y dashboard, Start menu, Back restart; in menus: d-pad, A, B
//   touch          on a phone or tablet: buttons over the race (steer, gas, brake, gears, camera, rewind, restart,
//                  menu, HD); menus and the replay are tapped
//   switching away pauses a race (and lets go of held keys); speed and gear show while racing without the
//   dashboard
// Uses the page's globals: mem, k, SCAN, view, StuntsCode, saved, inbox, startAudio.
'use strict';
(function () {
  const D = StuntsCode.DSEG << 4, S = StuntsCode.SYM, PS = S.state + 0x152;   // state.playerstate
  const r8 = o => mem[D + (o & 0xFFFF)], r16 = o => r8(o) | (r8(o + 1) << 8);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const store = (key, v) => { try { localStorage.setItem(key, v); return true; } catch (_) { return false; } };
  const load = key => { try { return localStorage.getItem(key); } catch (_) { return null; } };

  // ---- keys into the game, as the keyboard sends them
  const ASCII = { Enter: 13, Escape: 27, Backspace: 8, Space: 32 };
  const held = new Set();
  function send(code, down) {
    const sc = SCAN[code];
    if (sc == null) return;
    const ascii = /^Key[A-Z]$/.test(code) ? code.charCodeAt(3) + 32 : ASCII[code] || 0;
    const wr = Atomics.load(k, 0);
    k[2 + wr] = (sc & 0xFFFF) | (down ? 1 << 16 : 0) | ((down ? ascii : 0) << 17);
    Atomics.store(k, 0, (wr + 1) & 1023);
  }
  const tap = async (code, ms = 80) => { send(code, true); await sleep(ms); send(code, false); };
  const racing = () => view && view.raceView && performance.now() - (view.lastFrame || 0) < 400 && r8(S.game_replay_mode) === 0;

  // ---- messages on screen for a moment
  const osd = document.createElement('div');
  osd.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);padding:0.45em 0.9em;background:rgba(0,0,0,.78);color:#fff;font:600 clamp(14px, 2.2vh, 30px) ui-monospace,Menlo,monospace;border-radius:4px;pointer-events:none;opacity:0;transition:opacity .25s;z-index:10';
  document.body.appendChild(osd);
  let osdT = 0;
  const say = window.qolSay = t => { osd.textContent = t; osd.style.opacity = 1; clearTimeout(osdT); osdT = setTimeout(() => { osd.style.opacity = 0; }, 1600); };

  // ---- how it runs (the key left of 1: ^ or `): frames a second on the display, the slowest frame, the game's own frames
  // a second (20 in a race, as in 1990) and the 3D view's size; kept on or off from visit to visit
  const perf = document.createElement('div');
  perf.style.cssText = 'position:fixed;right:8px;top:8px;padding:.35em .6em;background:rgba(0,0,0,.65);color:#9f9;font:600 12px/1.45 ui-monospace,Menlo,monospace;border-radius:4px;pointer-events:none;white-space:pre;z-index:10;display:none';
  document.body.appendChild(perf);
  let perfOn = false;
  const perfShow = on => {
    perfOn = on; perf.style.display = on ? 'block' : 'none'; store('stunts-perf', on ? '1' : '0');
    if (!on) return;
    const I = typeof sceneI !== 'undefined' ? sceneI : null, gl = document.getElementById('gl');
    let n = 0, worst = 0, last = performance.now(), t0 = last, g0 = I ? Atomics.load(I, 1) : 0;
    const tick = now => {
      if (!perfOn) return;
      n++; worst = Math.max(worst, now - last); last = now;
      if (now - t0 >= 500) {
        const g = I ? Atomics.load(I, 1) : 0, dt = (now - t0) / 1000;
        perf.textContent = `${Math.round(n / dt)} fps  ${worst.toFixed(1)} ms max\n` + (I ? `game frames ${Math.round((g - g0) / dt)}/s` : '')
          + (gl && !gl.hidden && gl.width ? `  ${gl.width}\u00d7${gl.height}` : '');
        n = 0; worst = 0; t0 = now; g0 = g;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  try { if (localStorage.getItem('stunts-perf') === '1') perfShow(true); } catch (_) {}

  // ---- the game open in two tabs at once: both say so (each keeps its own copy of your files while it runs, so the
  // tab that saves last wins: a track, replay or high score saved in the other can be lost)
  try {
    const ch = new BroadcastChannel('stunts-recomp'); let warned = false;
    ch.onmessage = e => {
      if (e.data === 'hello') ch.postMessage('here');
      if ((e.data === 'hello' || e.data === 'here') && !warned) {
        warned = true; say('Stunts HD is open in another tab too: close one, or saves in one may overwrite the other');
        clearTimeout(osdT); osdT = setTimeout(() => { osd.style.opacity = 0; }, 7000);
      }
    };
    ch.postMessage('hello');
  } catch (_) {}

  // ---- your camera (C, F1-F4) kept from race to race and across visits: the game starts each race in the chase camera,
  // so for its first moment the one you last chose is put back; after that, the one you choose is remembered
  {
    let on = false, lastF = 0, applyUntil = 0;
    // (a camera key pressed in that moment: the player's choice wins at once, it is not put back)
    addEventListener('keydown', e => { if (/^(KeyC|F[1-4])$/.test(e.code)) applyUntil = 0; }, true);
    setInterval(() => {
      if (!racing()) { on = false; return; }
      const f = r16(S.state + 320), now = performance.now();
      if (!on || f < lastF - 5) { on = true; applyUntil = now + 1200; }   // (a new race, or one started again)
      lastF = f;
      const cur = r8(S.cameramode), want = parseInt(load('stunts-cam'), 10);
      if (now < applyUntil) { if (want >= 0 && want < 4 && cur !== want) mem[D + S.cameramode] = want; }
      else if (cur !== want && cur < 4) store('stunts-cam', String(cur));
    }, 50);
  }

  // ---- restart, at once: the worker is told (its results routine then answers "Re-Start Driving" unseen, see worker.js),
  // and Esc ends the race as the game's own Esc does (twice: the panel, then out of it)
  let restarting = false;
  async function restart() {
    if (restarting || !racing() || !IB) return;
    restarting = true; rw.secs = 0;
    try {
      queue.push({ name: 'RESTART', data: 'restart' }); pump();
      while (queue.length || sending || Atomics.load(IB, 0) !== Atomics.load(IB, 1)) await sleep(10);
      // (the first Esc pauses into the replay panel; the second leaves it for the results routine, as soon as the game is there)
      await tap('Escape', 40);
      for (let t = 0; t < 100 && r8(S.game_replay_mode) === 0; t++) await sleep(10);
      await sleep(30); await tap('Escape', 40); await sleep(300);
    } finally { restarting = false; }
  }

  // ---- rewind (Q, held): the race back a second a press, on while held; the worker winds it back the game's own way
  // (see worker.js). The seconds rewound show in the race display (main.js: "(Q) REWOUND") until the race is left or
  // started again
  const rw = window.qolRewind = { secs: 0 };
  let rwHeld = 0;
  const rewindOnce = () => {
    if (!racing() || !IB || !r16(S.state + 320)) return;   // (not on the line, before the clock runs: nothing to wind back)
    queue.push({ name: 'REWIND', data: 'rewind' }); pump();
    rw.secs++;
  };
  const rewindStop = () => { clearInterval(rwHeld); rwHeld = 0; };
  addEventListener('blur', rewindStop);
  setInterval(() => { if (!view || !view.raceView) rw.secs = 0; }, 500);

  // ---- sound: volume 0..1 (the synthesiser's 0..0.5), muted
  let vol = +(load('stunts-vol') || 0.45), muted = load('stunts-mute') === '1', opl = null;
  const applyVol = () => { if (opl) opl.port.postMessage({ vol: muted ? 0 : vol * 0.5 }); };
  window.qolAudio = node => { opl = node; if (!/[?&]vol=/.test(location.search)) applyVol(); };

  // ---- files: yours (localStorage 'stunts:NAME'), dropped ones added to the running game through the inbox
  const IB = inbox ? new Int32Array(inbox, 0, 4) : null, IU = inbox ? new Uint8Array(inbox) : null;
  const queue = [];
  let sending = false;
  async function pump() {
    if (sending || !IB) return;
    sending = true;
    while (queue.length) {
      const { name, data } = queue.shift();
      while (Atomics.load(IB, 0) !== Atomics.load(IB, 1)) await sleep(20);   // (the worker has taken the last one: one file at a time)
      IU.fill(0, 16, 32); for (let i = 0; i < name.length; i++) IU[16 + i] = name.charCodeAt(i);
      if (data === 'restart') IB[2] = -3; else if (data === 'rewind') IB[2] = -4; else if (data === 'pick') IB[2] = -2; else if (data) { IU.set(data, 32); IB[2] = data.length; } else IB[2] = -1;   // (-1: the file is deleted; -2: the track menu takes this track next)
      Atomics.add(IB, 0, 1);
    }
    sending = false;
  }
  function dosName(n) {
    const m = /^(.*?)(\.[^.]*)?$/.exec(n.toUpperCase()), ext = (m[2] || '').slice(0, 4);
    return m[1].replace(/[^A-Z0-9_\-]/g, '').slice(0, 8) + ext;
  }
  // a track file as the game's own are: 30 x 30 pieces, a scenery number 0-4, 30 x 30 terrain types 0-18, a 0 at the end
  const TRK = 1802, validTrk = d => d.length === TRK && d[900] <= 4 && d[TRK - 1] === 0 && !d.subarray(901, TRK - 1).some(t => t > 0x12);
  const exists = name => load('stunts:' + name) != null || !!(window.stockNames && stockNames.has(name));
  function forget(name) { try { localStorage.removeItem('stunts:' + name); } catch (_) {} delete saved[name]; queue.push({ name, data: null }); }
  // adds files to the game (and this browser): { added, bad, full, taken }. A name already in use is replaced only when
  // replace() agrees; a new track's name loses the high scores kept under it (another track's times)
  async function addFiles(list, replace = async names => { held.forEach(c => send(c, false)); held.clear(); return confirm('Replace ' + names.join(', ') + '?'); }, quiet = false) {
    const items = [], bad = [];
    for (const f of list) {
      if (!/\.(trk|rpl)$/i.test(f.name) || f.size > 200000) { bad.push(f.name); continue; }
      const name = dosName(f.name), data = new Uint8Array(await f.arrayBuffer());
      if (!/^[A-Z0-9_\-]{1,8}\.(TRK|RPL)$/.test(name) || (name.endsWith('.TRK') && !validTrk(data))) { bad.push(f.name); continue; }
      items.push({ name, data });
    }
    const taken = items.filter(i => exists(i.name)).map(i => i.name);
    const go = taken.length ? await replace(taken) : true;
    const added = [], full = [];
    for (const { name, data } of items) {
      if (!go && taken.includes(name)) continue;
      let s = ''; for (const b of data) s += String.fromCharCode(b);
      if (!store('stunts:' + name, btoa(s))) { full.push(name); continue; }
      saved[name] = data; queue.push({ name, data }); added.push(name);
      if (name.endsWith('.TRK')) {
        // (a stock track's name: its own table of times would show again, so an empty one stands in, as the editor
        // writes on saving a track: 7 records of 40 dots, 2 zeros, '../....', a zero, time 0xFFFF)
        const h = name.replace(/TRK$/, 'HIG');
        if (window.stockNames && stockNames.has(h)) {
          const rec = [...'.'.repeat(40)].map(c => c.charCodeAt(0)).concat([0, 0], [...'../....'].map(c => c.charCodeAt(0)), [0, 0xFF, 0xFF]);
          const e = new Uint8Array(364); for (let i = 0; i < 7; i++) e.set(rec, i * 52); let t = ''; for (const b of e) t += String.fromCharCode(b); store('stunts:' + h, btoa(t)); saved[h] = e; queue.push({ name: h, data: e }); }
        else if (load('stunts:' + h) != null || saved[h]) forget(h);
      }
    }
    pump();
    if (!quiet) say(full.length ? 'Browser storage full: ' + full.join(', ') + ' not added' : added.length ? 'Added ' + added.join(', ') + ': see the track and replay menus' : bad.length ? 'Only valid .TRK and .RPL files can be added' : 'Nothing added');
    if (panel.style.display !== 'none') listFiles();
    return { added, bad, full, taken: go ? [] : taken };
  }
  addEventListener('dragover', e => { e.preventDefault(); });
  addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:12px;top:12px;max-height:80vh;overflow:auto;min-width:240px;padding:10px 12px;background:rgba(10,10,14,.92);color:#eee;font:13px ui-monospace,Menlo,monospace;border:1px solid #444;border-radius:6px;z-index:11;display:none';
  document.body.appendChild(panel);

  function listFiles() {
    const names = [];
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key.startsWith('stunts:')) names.push(key.slice(7)); }
    names.sort();
    panel.innerHTML = '<div style="font-weight:700;margin-bottom:6px">Your files <span style="float:right;opacity:.6">F6</span></div>' +
      (names.length ? '' : '<div style="opacity:.7">None yet: save a replay in the game, or drop .TRK / .RPL files on the page.</div>');
    for (const n of names) {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;justify-content:space-between;gap:12px;padding:2px 0';
      const a = document.createElement('a'); a.textContent = 'download'; a.href = '#'; a.style.color = '#8cf';
      a.onclick = ev => {
        ev.preventDefault();
        const b = Uint8Array.from(atob(load('stunts:' + n) || ''), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([b])), l = document.createElement('a');
        l.href = url; l.download = n; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      };
      const links = document.createElement('span'); links.style.cssText = 'display:flex;gap:10px';
      links.append(a);
      row.append(Object.assign(document.createElement('span'), { textContent: n }), links);
      panel.appendChild(row);
    }
    panel.appendChild(Object.assign(document.createElement('div'), { textContent: 'Drop .TRK / .RPL files anywhere to add them.', style: 'margin-top:8px;opacity:.6' }));
  }

  // ---- page keys (before the game sees them)
  // (fullscreen on or off: in the desktop app its window, which the app may have made fullscreen already at the start, so
  // the page's own fullscreen inside it changed nothing you could see and the second press left the window fullscreen)
  const fullscreen = () => {
    if (window.stuntsHost && stuntsHost.fullscreen) { if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); stuntsHost.fullscreen(false); } else stuntsHost.fullscreen('toggle'); }
    else if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
  };
  const swallowed = new Set();
  window.qolKey = (e, down) => {
    if (!down && swallowed.has(e.code)) { swallowed.delete(e.code); if (e.code === 'KeyQ') rewindStop(); return true; }   // (Q let go: the rewind stops)
    let mine = false;
    if (e.code === 'KeyR' && !(typeof typing === 'function' && typing()) && racing()) { if (down && !e.repeat) restart(); mine = true; }
    else if (e.code === 'Enter' && e.altKey) { if (down) { fullscreen(); } mine = true; }
    else if (e.code === 'KeyF' && !(typeof typing === 'function' && typing()) && !e.altKey && !e.ctrlKey && !e.metaKey && !(e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) && !document.querySelector('#trkio[open]') && !document.getElementById('setup')) {   // (F: fullscreen anywhere in the game; not while a name or a code is being typed, in the game or in the page's boxes)
      if (down && !e.repeat) { fullscreen(); } mine = true;
    }
    else if (e.code === 'F9') { if (down) { muted = !muted; store('stunts-mute', muted ? '1' : '0'); applyVol(); say(muted ? 'Sound off' : 'Sound on'); } mine = true; }
    else if (e.code === 'F7' || e.code === 'F8') {
      if (down) { vol = Math.max(0, Math.min(1, Math.round((vol + (e.code === 'F8' ? 0.1 : -0.1)) * 10) / 10)); muted = false; store('stunts-vol', vol); store('stunts-mute', '0'); applyVol(); say('Volume ' + Math.round(vol * 100) + '%'); }
      mine = true;
    }
    else if (e.code === 'F10') { if (down && !e.repeat && typeof frame === 'function') frame.shot = true; mine = true; }   // (F10: a screenshot, main.js; F1-F4 are the game's own)
    else if (e.code === 'Backquote' && !(typeof typing === 'function' && typing())) { if (down && !e.repeat) perfShow(!perfOn); mine = true; }   // (the key left of 1: how it runs)
    else if (e.code === 'KeyQ' && !(typeof typing === 'function' && typing()) && (racing() || rwHeld)) {   // (Q: rewind, see above)
      if (down && !e.repeat) { rewindStop(); rewindOnce(); rwHeld = setInterval(rewindOnce, 300); } else if (!down) rewindStop();
      mine = true;
    }
    else if (e.code === 'F6') { if (down) { const open = panel.style.display === 'none'; panel.style.display = open ? 'block' : 'none'; if (open) listFiles(); } mine = true; }
    if (mine) { e.preventDefault(); if (down) swallowed.add(e.code); return true; }
    if (down) held.add(e.code); else held.delete(e.code);
    return false;
  };

  // ---- switching away: let go of every held key (their releases never arrive) and pause a race
  const away = () => {
    for (const c of held) send(c, false);
    held.clear(); pad.release();
    if (racing()) tap('KeyP');
  };
  addEventListener('blur', away);
  document.addEventListener('visibilitychange', () => { if (document.hidden) away(); });

  // ---- gamepad (standard mapping)
  const pad = {
    down: new Map(),   // code -> pressed by the pad
    set(code, on) { if (!!this.down.get(code) === on) return; this.down.set(code, on); send(code, on); if (on) startAudio(); },
    release() { for (const [c, on] of this.down) if (on) send(c, false); this.down.clear(); },
  };
  let padMode = null;
  const STEER_FULL = 200;   // the steering angle the stick's end stands for (it builds ~140 a second held)
  function pollPad(now) {
    const gp = navigator.getGamepads ? [...navigator.getGamepads()].find(g => g && g.connected) : null;
    if (!gp) { if (pad.down.size) pad.release(); return; }
    const b = i => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.3));
    const x = gp.axes[0] || 0, y = gp.axes[1] || 0;
    const mode = racing() ? 'race' : 'menu';
    if (mode !== padMode) { pad.release(); padMode = mode; }
    if (mode === 'race') {
      // steering by how far the stick is pushed: the game turns the wheel while a key is held and centres it
      // when let go, so the key is held until the car's steering angle (playerstate.car_steeringAngle) reaches
      // the stick's share of full lock, then let go, as a player feathers it
      const steer = b(14) ? -1 : b(15) ? 1 : Math.abs(x) < 0.15 ? 0 : x;
      const ang = (r16(PS + 0x20) << 16) >> 16, tgt = steer * STEER_FULL;
      const full = Math.abs(steer) >= 0.92;
      pad.set('ArrowRight', steer > 0 && (full || ang < tgt - 6));
      pad.set('ArrowLeft', steer < 0 && (full || ang > tgt + 6));
      pad.set('ArrowUp', b(7) || b(0)); pad.set('ArrowDown', b(6) || b(1));
      pad.set('Space', b(5)); pad.set('Enter', b(4));
      pad.set('KeyC', b(2)); pad.set('KeyD', b(3)); pad.set('Escape', b(9));
      if (b(8)) restart();
    } else {
      pad.set('ArrowLeft', b(14) || x < -0.6); pad.set('ArrowRight', b(15) || x > 0.6);
      pad.set('ArrowUp', b(12) || y < -0.6); pad.set('ArrowDown', b(13) || y > 0.6);
      pad.set('Enter', b(0) || b(9)); pad.set('Escape', b(1));
    }
  }
  addEventListener('gamepadconnected', e => say('Gamepad: ' + e.gamepad.id.replace(/\s*\(.*$/, '')));

  // ---- touch: on a phone or tablet, buttons over the race (steer, accelerate, brake, gears, camera, rewind, restart,
  // menu), each a key held while it's touched, as the keyboard's (through the page's key handler: Q rewinds, R restarts);
  // menus and the replay panel are worked by tapping, as with the mouse. Only once the screen has been touched: a
  // computer with a mouse never sees them
  const touch = (() => {
    const root = document.createElement('div'); root.id = 'touch';
    const css = document.createElement('style');
    css.textContent = `
      #touch { position: fixed; inset: 0; z-index: 9; pointer-events: none; display: none; touch-action: none; user-select: none; -webkit-user-select: none; }
      #touch.on { display: block; }
      #touch button { position: absolute; pointer-events: auto; touch-action: none; border: 2px solid rgba(255,255,255,.55); background: rgba(0,0,0,.28);
        color: #fff; font: 700 clamp(13px, 2.4vmin, 20px) ui-monospace, Menlo, monospace; border-radius: 50%; padding: 0; opacity: .7;
        -webkit-tap-highlight-color: transparent; display: grid; place-items: center; }
      #touch button.down { background: rgba(255,247,33,.45); opacity: 1; }
      #touch .big { width: clamp(64px, 17vmin, 104px); height: clamp(64px, 17vmin, 104px); font-size: clamp(22px, 5vmin, 34px); }
      #touch .small { width: clamp(40px, 10vmin, 60px); height: clamp(40px, 10vmin, 60px); border-radius: 12px; }
      #touch .tip { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); padding: .6em 1em; border-radius: 8px;
        background: rgba(0,0,0,.7); color: #fff; font: 600 15px system-ui, sans-serif; display: none; }
      #touch.portrait .tip { display: block; }
      #touch.auto .gear { display: none; }`;
    document.head.appendChild(css);
    // (where each sits: from the screen's edges, past a phone's notch and home bar)
    const E = 'max(12px, env(safe-area-inset-left))', R = 'max(12px, env(safe-area-inset-right))', B = 'max(14px, env(safe-area-inset-bottom))', T = 'max(10px, env(safe-area-inset-top))';
    const BIG = 'clamp(64px, 17vmin, 104px)', GAP = 'clamp(10px, 3vmin, 22px)', SM = 'clamp(46px, 12vmin, 70px)';
    // (the driving buttons above the time and the speed, which the game shows in the bottom corners; the small ones
    // under the track's name, top right, clear of the messages top left)
    const BB = `calc(${B} + clamp(34px, 10vmin, 52px))`, TT = `calc(${T} + clamp(18px, 5vmin, 26px))`;
    const BUTTONS = [
      // [label, key, class, css place]
      ['◀', 'ArrowLeft', 'big', `left:${E};bottom:${BB}`],
      ['▶', 'ArrowRight', 'big', `left:calc(${E} + ${BIG} + ${GAP});bottom:${BB}`],
      ['▲', 'ArrowUp', 'big', `right:${R};bottom:calc(${BB} + ${BIG} + ${GAP})`],
      ['▼', 'ArrowDown', 'big', `right:calc(${R} + ${BIG} + ${GAP});bottom:${BB}`],
      ['A', 'KeyA', 'small gear', `right:calc(${R} + (${BIG} - clamp(40px, 10vmin, 60px)) / 2);bottom:${BB}`],
      ['Z', 'KeyZ', 'small gear', `right:calc(${R} + ${BIG} + ${GAP} + (${BIG} - clamp(40px, 10vmin, 60px)) / 2);bottom:calc(${BB} + ${BIG} + ${GAP})`],
      ['C', 'KeyC', 'small', `right:${R};top:${TT}`],
      ['⟲', 'KeyQ', 'small', `right:calc(${R} + ${SM});top:${TT}`],
      ['R', 'KeyR', 'small', `right:calc(${R} + 2 * ${SM});top:${TT}`],
      ['☰', 'Escape', 'small', `right:calc(${R} + 3 * ${SM});top:${TT}`],
      ['HD', 'KeyH', 'small', `right:calc(${R} + 4 * ${SM});top:${TT}`],   // (the HD look or the original's, as H)
    ];
    const press = (code, down) => { if (typeof key === 'function') key({ code, key: code === 'Escape' ? 'Escape' : code.replace(/^Key/, '').toLowerCase(), repeat: false, preventDefault() {} }, down); };
    for (const [label, code, cls, place] of BUTTONS) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = cls; b.style.cssText = place;
      b.setAttribute('aria-label', code);
      let id = null;
      const up = e => { if (e.pointerId !== id) return; id = null; b.classList.remove('down'); press(code, false); };
      b.addEventListener('pointerdown', e => {
        e.preventDefault(); e.stopPropagation();   // (not the game's mouse: main.js listens on the window)
        if (id != null) return;
        id = e.pointerId; try { b.setPointerCapture(id); } catch (_) {}
        b.classList.add('down'); press(code, true);
      });
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, e => { e.stopPropagation(); up(e); });
      b.addEventListener('pointermove', e => e.stopPropagation());
      b.addEventListener('contextmenu', e => e.preventDefault());
      root.appendChild(b);
    }
    const tip = document.createElement('div'); tip.className = 'tip'; tip.textContent = '↻ Turn your phone sideways'; root.appendChild(tip);
    document.body.appendChild(root);
    let used = false;
    const use = e => {
      if (e.pointerType !== 'touch' || used) return;
      used = true;
      document.documentElement.style.touchAction = 'none';   // (no scrolling or zooming the game by accident)
    };
    addEventListener('pointerdown', use, true);
    // shown while racing (not in a replay, its panel is tapped); let go of everything when they go. Once shown they stay
    // through a stall of up to 2 s (a slow phone, a hiccup), so a held button isn't let go of in the middle of a race
    let shown = false;
    setInterval(() => {
      const age = view ? performance.now() - (view.lastFrame || 0) : 1e9;
      // (Q held: winding back runs as the Replay Menu does, the replay mode on for a moment; they stay, Q stays held)
      const race = view && view.raceView && (rwHeld || (r8(S.game_replay_mode) === 0 && (racing() || (shown && age < 2000))));
      const on = used && !!race && !document.getElementById('setup');
      root.classList.toggle('portrait', on && innerHeight > innerWidth * 1.1);
      root.classList.toggle('auto', !!r8(PS + 0xcc));   // (gears up and down only with the manual gearbox)
      if (on === shown) return;
      shown = on; root.classList.toggle('on', on);
      if (!on) for (const b of root.querySelectorAll('button.down')) { b.classList.remove('down'); press(b.getAttribute('aria-label'), false); }
    }, 150);
    return { root };
  })();

  // ---- speed and gear while racing without the dashboard
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;pointer-events:none;color:#fff;font:700 16px ui-monospace,Menlo,monospace;text-shadow:0 0 3px #000,1px 1px 0 #000,-1px -1px 0 #000;text-align:right;z-index:5;display:none';
  document.body.appendChild(hud);
  const screenCanvas = document.getElementById('screen');
  function drawHud() {
    const show = view && view.raceView && performance.now() - (view.lastFrame || 0) < 400 && !r8(S.dashb_toggle) && r8(S.game_replay_mode) === 0;   // (driving: not over a replay's panel)
    if (!show) { if (hud.style.display !== 'none') hud.style.display = 'none'; return; }
    const rc = screenCanvas.getBoundingClientRect(), h = rc.height;
    const mph = Math.round(r16(PS + 0x2c) / 256), gear = r8(PS + 0xbe), auto = r8(PS + 0xcc);
    hud.style.display = 'block';
    hud.style.right = (innerWidth - rc.right + h * 0.03) + 'px'; hud.style.bottom = (innerHeight - rc.bottom + h * 0.03) + 'px';
    hud.style.fontSize = Math.round(h * 0.055) + 'px';
    hud.innerHTML = mph + '<span style="font-size:.5em"> mph</span><br><span style="font-size:.55em">' + (auto ? 'A ' : '') + 'gear ' + gear + '</span>';
  }

  // (the speed is now drawn by the game in its clock's font: hires-capture.js; this page readout only with ?pagehud)
  const PAGE_HUD = /[?&]pagehud/.test(location.search);
  function tick(now) { try { pollPad(now); if (PAGE_HUD) drawHud(); } catch (e) { console.error(e); } requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
  // ---- the track menu: an Import / Export button in the game's own button style, under the track's name.
  // Export: the track on screen as a code (its .TRK file in base64) to copy, or the file itself. Import: a
  // code pasted in becomes one of your tracks (as a dropped file does), there in the track menu.
  {
    const css = document.createElement('style');
    css.textContent = `
      #trkbtn { position: fixed; z-index: 5; display: none; padding: 0; border: 0; background: #aaa; cursor: pointer;
        box-shadow: inset var(--b) var(--b) 0 #fff, inset calc(-1 * var(--b)) calc(-1 * var(--b)) 0 #555; outline: var(--b) solid transparent; }
      #trkbtn:hover, #trkbtn:focus-visible { outline-color: #ff5; }
      #trkbtn canvas { display: block; width: 100%; height: 100%; image-rendering: pixelated; pointer-events: none; }
      #trkio { border: 0; padding: 0; background: transparent; width: calc(var(--u) * 262); max-width: calc(100vw - 24px); cursor: auto; overflow: visible; }
      #trkio::backdrop { background: rgba(0, 0, 0, .55); }
      /* the game's own dialogs: a grey panel, light edges top and left, dark ones bottom and right, black text in its font */
      #trkio .box { position: relative; background: #aaa; padding: calc(var(--u) * 8) calc(var(--u) * 10) calc(var(--u) * 9);
        box-shadow: inset var(--b) var(--b) 0 #fff, inset calc(-1 * var(--b)) calc(-1 * var(--b)) 0 #555; }
      #trkio canvas.gt { display: block; position: static; transform: none; image-rendering: pixelated; pointer-events: none; }   /* (the page centres every canvas absolutely: not these) */
      #trkio .title { margin: 0 auto calc(var(--u) * 7); }
      #trkio .lbl { margin: calc(var(--u) * 6) 0 calc(var(--u) * 3); }
      #trkio textarea, #trkio input { display: block; width: 100%; box-sizing: border-box; margin: 0; background: #000; color: #fff; border: 0; border-radius: 0;
        padding: calc(var(--u) * 3) calc(var(--u) * 4); font: calc(var(--u) * 5.5)/1.35 ui-monospace, Menlo, monospace; resize: none;
        box-shadow: inset var(--b) var(--b) 0 #555, inset calc(-1 * var(--b)) calc(-1 * var(--b)) 0 #fff; }
      #trkio textarea { height: calc(var(--u) * 30); word-break: break-all; }
      #trkio textarea::placeholder, #trkio input::placeholder { color: #777; }
      #trkio textarea:focus, #trkio input:focus { outline: var(--b) solid #ff5; outline-offset: 0; }
      #trkio .row { display: flex; gap: calc(var(--u) * 4); margin-top: calc(var(--u) * 4); align-items: stretch; }
      #trkio .row input { flex: 1 1 0; width: auto; text-transform: uppercase; }
      #trkio button.b { flex: none; padding: calc(var(--u) * 2.5) calc(var(--u) * 4); border: 0; border-radius: 0; background: #aaa; cursor: pointer;
        box-shadow: inset var(--b) var(--b) 0 #fff, inset calc(-1 * var(--b)) calc(-1 * var(--b)) 0 #555; outline: var(--b) solid transparent; }
      #trkio button.b:hover, #trkio button.b:focus-visible { outline-color: #ff5; }
      #trkio button.b:active { box-shadow: inset var(--b) var(--b) 0 #555, inset calc(-1 * var(--b)) calc(-1 * var(--b)) 0 #fff; }
      #trkio .ask { display: none; position: absolute; inset: 0; place-items: center; background: rgba(0, 0, 0, .35); }
      #trkio .ask.on { display: grid; }
      #trkio .ask .box { padding: calc(var(--u) * 8) calc(var(--u) * 10); }
      #trkio .ask .row { justify-content: center; margin-top: calc(var(--u) * 6); }
      #trkio .msg { min-height: calc(var(--u) * 8); margin: 0 auto 0 0; flex: none; align-self: center; }   /* (its own size: drawn pixel for pixel, not stretched) */
      #trkio input[type=file] { display: none; }
      #trkio .row.end { margin-top: calc(var(--u) * 6); align-items: center; }`;
    document.head.appendChild(css);
    const btn = document.createElement('button'); btn.id = 'trkbtn'; btn.type = 'button'; btn.title = 'Import or export a track as a code';
    const bc = document.createElement('canvas'); btn.appendChild(bc); document.body.appendChild(btn);
    const dlg = document.createElement('dialog'); dlg.id = 'trkio';
    dlg.innerHTML = `<div class="box">
      <canvas class="gt title" data-t="Import / Export"></canvas>
      <canvas class="gt lbl" id="trklbl" data-t="Export"></canvas>
      <textarea id="trkout" readonly spellcheck="false"></textarea>
      <div class="row"><button class="b" id="trkcopy" type="button"><canvas class="gt" data-t="Copy code"></canvas></button><button class="b" id="trkdl" type="button"><canvas class="gt" data-t="Download .TRK"></canvas></button><button class="b" id="trkdel" type="button"><canvas class="gt" data-t="Delete track"></canvas></button></div>
      <canvas class="gt lbl" data-t="Import new track"></canvas>
      <textarea id="trkin" placeholder="Paste a track code" spellcheck="false"></textarea>
      <div class="row"><input id="trknm" maxlength="8" placeholder="NAME" spellcheck="false"><button class="b" id="trkadd" type="button"><canvas class="gt" data-t="Add track"></canvas></button><button class="b" id="trkup" type="button"><canvas class="gt" data-t="Upload .TRK"></canvas></button></div>
      <input type="file" id="trkfile" accept=".trk,.TRK" multiple hidden>
      <div class="row end"><canvas class="gt msg" id="trkmsg" data-t=""></canvas><button class="b" id="trkx" type="button"><canvas class="gt" data-t="Done"></canvas></button></div>
      <div class="ask" id="trkask"><div class="box"><canvas class="gt" id="trkaskt" data-t=""></canvas>
        <div class="row"><button class="b" id="trkyes" type="button"><canvas class="gt" data-t="Delete"></canvas></button><button class="b" id="trkno" type="button"><canvas class="gt" data-t="Cancel"></canvas></button></div></div></div></div>`;
    document.body.appendChild(dlg);
    // (none of the box's clicks or the button's reach the game's mouse)
    for (const el of [btn, dlg]) for (const ev of ['pointerdown', 'pointerup', 'pointermove', 'click']) el.addEventListener(ev, e => e.stopPropagation());
    const $ = id => dlg.querySelector('#' + id);
    // (text in the game's font, black, drawn at the size of the game's own pixels)
    let gu = 2;
    function paint(cv) {
      const font = typeof hudFont === 'function' && hudFont(), t = cv.dataset.t || '', dpr = devicePixelRatio || 1, u = gu * dpr * (cv.closest('button') ? 0.75 : 1);   // (buttons: a size smaller)
      if (!font) return;
      const m = document.createElement('canvas').getContext('2d'), w = t ? hudText(m, font, t, 0, 8 * u, u, 'left', 0, 0, '0,0,0', false) : 0;
      cv.width = Math.max(1, Math.ceil(w)); cv.height = Math.ceil(9 * u);
      cv.style.width = cv.width / dpr + 'px'; cv.style.height = cv.height / dpr + 'px';
      if (t) hudText(cv.getContext('2d'), font, t, 0, 8 * u, u, 'left', 1, 0, '0,0,0', false);
    }
    const msg = t => { $('trkmsg').dataset.t = t; paint($('trkmsg')); };
    const toB64 = d => { let s = ''; for (const b of d) s += String.fromCharCode(b); return btoa(s); };
    function current() {
      let n = ''; for (let i = 0; i < 8; i++) { const c = r8(S.gameconfig + 13 + i); if (!c) break; n += String.fromCharCode(c); }
      // (the track as the game holds it: its file read into one block, the pieces' map then the terrain's)
      const fp = s => (r16(S[s] + 2) << 4) + r16(S[s]), a = fp('td14_elem_map_main');
      const d = a > 0 && fp('td15_terr_map_main') - a === TRK / 2 && a + TRK <= mem.length ? mem.slice(a, a + TRK) : null;
      return { name: n.toUpperCase(), data: d };
    }
    // A track code: "ST1." and the file deflated, in URL-safe base64 (a track is mostly empty squares: some
    // 200 characters instead of 2,400). Plain base64 or hex of the file are read too.
    const pipe = async (d, s) => new Uint8Array(await new Response(new Blob([d]).stream().pipeThrough(s)).arrayBuffer());
    async function encode(d) {
      if (typeof CompressionStream === 'undefined') return toB64(d);
      return 'ST1.' + toB64(await pipe(d, new CompressionStream('deflate-raw'))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    async function decode(t) {
      t = t.replace(/\s+/g, '');
      if (/^ST1\./i.test(t)) {
        // (read no further than a track's size: a code made to inflate hugely stops there)
        try { let b = t.slice(4).replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
          const rd = new Blob([Uint8Array.from(atob(b), c => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(), parts = []; let n = 0;
          for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); n += value.length; if (n > TRK) { rd.cancel().catch(() => {}); return null; } }
          const out = new Uint8Array(n); let o = 0; for (const v of parts) { out.set(v, o); o += v.length; } return out; } catch (_) { return null; }
      }
      if (/^[0-9a-fA-F]+$/.test(t) && t.length === TRK * 2) return Uint8Array.from(t.match(/../g), h => parseInt(h, 16));
      try { return Uint8Array.from(atob(t), c => c.charCodeAt(0)); } catch (_) { return null; }
    }
    let cur = null;
    btn.addEventListener('click', () => {
      cur = current();
      gu = Math.max(1.5, Math.min(3, document.getElementById('screen').getBoundingClientRect().height / 200));
      dlg.style.setProperty('--u', gu + 'px'); dlg.style.setProperty('--b', Math.max(1, Math.round(gu)) + 'px');
      $('trklbl').dataset.t = cur.name ? 'Export ' + cur.name : 'Export';
      dlg.querySelectorAll('canvas.gt').forEach(paint);
      $('trkout').value = ''; if (cur.data) encode(cur.data).then(c => { $('trkout').value = c; });
      $('trkout').placeholder = cur.data ? '' : 'No track loaded to export.';
      $('trkin').value = ''; $('trknm').value = ''; msg(''); ask(false);
      held.forEach(c => send(c, false)); held.clear();
      dlg.showModal();
    });
    $('trkx').addEventListener('click', () => dlg.close());
    // (a click on the backdrop closes the box; not a text selection that began inside it and ended out there)
    let downOut = false; dlg.addEventListener('pointerdown', e => { downOut = e.target === dlg; });
    dlg.addEventListener('click', e => { if (e.target === dlg && downOut) dlg.close(); });
    $('trkcopy').addEventListener('click', async () => {
      if (!$('trkout').value) return msg('Nothing to copy');
      try { await navigator.clipboard.writeText($('trkout').value); msg('Code copied'); } catch (_) { $('trkout').select(); msg('Selected: Cmd+C or Ctrl+C'); }
    });
    $('trkdl').addEventListener('click', () => {
      if (!cur || !cur.data) return msg('Nothing to download');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([cur.data], { type: 'application/octet-stream' })); a.download = cur.name + '.TRK'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    // Delete track: only your own tracks (imported, dropped or saved in the game: kept in this browser), after asking
    // (the game-style question box: its text and its yes button's, answered yes (true) or no)
    const ask = on => $('trkask').classList.toggle('on', on);
    let answer = null;
    const question = (text, yes) => new Promise(res => {
      $('trkaskt').dataset.t = text; paint($('trkaskt'));
      const yc = $('trkyes').querySelector('canvas'); yc.dataset.t = yes; paint(yc);
      answer = res; ask(true); $('trkno').focus();
    });
    const answered = v => { ask(false); const a = answer; answer = null; if (a) a(v); };
    $('trkno').addEventListener('click', () => answered(false));
    $('trkyes').addEventListener('click', () => answered(true));
    dlg.addEventListener('close', () => answered(false));
    // after a delete or an import, the menu moves to a track (the new one; after a delete, the first in the game's list),
    // with no picker shown: the worker is told the name (its picker then answers with it, unseen), the box closes and
    // More Tracks is pressed (the game's own mouse, at the button); the game loads the track as if picked
    async function pickTrack(name) {
      if (!name) name = [...new Set([...(window.stockNames || []), ...Object.keys(saved)])].filter(n => n.endsWith('.TRK')).sort()[0];
      if (!name) return;
      queue.push({ name: name.replace(/\.TRK$/, ''), data: 'pick' }); pump();
      while (queue.length || sending || Atomics.load(IB, 0) !== Atomics.load(IB, 1)) await sleep(20);
      await sleep(150);
      // (only while the box is still up on the track menu: closed or left meanwhile, the player has moved on)
      if (!dlg.open || !(view && view.previewView)) return;
      dlg.close(); say(msgText());
      // (the pointer's own moves wait while this press is made: pointer.fake)
      pointer.fake = true;
      try {
        Atomics.store(mouseI, 1, Math.round(64 / 320 * 65535)); Atomics.store(mouseI, 2, Math.round(184 / 200 * 65535));
        await sleep(120); pointer.downInMenu = true; Atomics.store(mouseI, 3, 1);
        await sleep(150); Atomics.store(mouseI, 3, 0); pointer.downInMenu = false;
      } finally { pointer.fake = false; }
    }
    const msgText = () => $('trkmsg').dataset.t;
    const replaceAsk = names => question('Replace ' + names.map(n => n.replace(/\.TRK$/, '')).join(', ') + '?', 'Replace');
    $('trkdel').addEventListener('click', async () => {
      const f = cur && cur.name ? cur.name + '.TRK' : '';
      if (!f || load('stunts:' + f) == null) return msg('Only your own tracks can be deleted');
      if (!await question('Delete ' + cur.name + '?', 'Delete')) return;
      // (its high scores go with it; a stock track of the same name, hidden by yours, comes back)
      forget(f); const h = cur.name + '.HIG'; if (load('stunts:' + h) != null || saved[h]) forget(h);
      pump();
      if (panel.style.display !== 'none') listFiles();
      msg(window.stockNames && stockNames.has(f) ? 'Deleted: the original ' + cur.name + ' is back' : 'Deleted ' + cur.name);
      pickTrack(null);
    });
    // Upload .TRK: track files from the computer, checked as pasted codes are, added under their own names
    $('trkup').addEventListener('click', () => $('trkfile').click());
    $('trkfile').addEventListener('change', async () => {
      const list = [...$('trkfile').files]; $('trkfile').value = '';
      if (!list.length) return;
      const r = await addFiles(list, replaceAsk, true), nm = r.added.map(n => n.replace(/\.TRK$/, ''));
      msg(r.full.length ? 'Browser storage full' : nm.length ? 'Added ' + nm.join(', ') + (r.bad.length ? ' (' + r.bad.length + ' not a track)' : '') : r.bad.length ? 'Not a valid track' : 'Nothing added');
      const t = r.added.find(n => n.endsWith('.TRK')); if (t) pickTrack(t);   // (the new track on the menu at once)
    });
    $('trkadd').addEventListener('click', async () => {
      const d = await decode($('trkin').value);
      if (!d || d.length !== TRK) return msg('Not a track code');
      if (!validTrk(d)) return msg('Not a valid track');
      const n = $('trknm').value.toUpperCase().replace(/[^A-Z0-9_\-]/g, '').slice(0, 8);
      if (!n) return msg('Give it a name');
      const r = await addFiles([new File([d], n + '.TRK')], replaceAsk, true);
      msg(r.full.length ? 'Browser storage full' : r.added.length ? 'Added ' + n : 'Not added');
      if (r.added.length) pickTrack(n + '.TRK');   // (the new track on the menu at once)
    });
    // shown on the track menu (its 3D overview up)
    // (placed every frame, from the 3D view's own canvas: from the page's HUD, hidden for a moment as the menu came up,
    // it was first placed by the 4:3 picture and then jumped)
    let drawn = '';
    const place = () => {
      const on = !!(typeof view !== 'undefined' && view && view.previewView && !document.getElementById('setup'));
      btn.style.display = on ? 'block' : 'none';
      if (!on) return;
      const r = document.getElementById('screen').getBoundingClientRect(), u = r.height / 200;
      // (the top right corner of the whole view, as the page's "(H) HD MODE" is the top left: its margin, 4% of the height)
      const hr = document.getElementById('gl').getBoundingClientRect(), g = hr.width ? hr : r, mg = g.height * 0.04;
      const w = Math.round(88 * u), h = Math.round(13 * u);
      btn.style.left = Math.round(g.right - mg - w) + 'px'; btn.style.top = Math.round(g.top + mg * 0.6) + 'px';
      btn.style.width = w + 'px'; btn.style.height = h + 'px'; btn.style.setProperty('--b', Math.max(1, Math.round(u)) + 'px');
      const dpr = devicePixelRatio || 1, key = w + 'x' + h + '@' + dpr;
      const font = typeof hudFont === 'function' && hudFont();
      if (drawn !== key && font) {
        drawn = key; bc.width = Math.round(w * dpr); bc.height = Math.round(h * dpr);
        const c = bc.getContext('2d'), uu = u * dpr; c.clearRect(0, 0, bc.width, bc.height);
        hudText(c, font, 'Import/Export', bc.width / 2, bc.height / 2 + 3 * uu, uu * 0.75, 'center', 1, 0, '0,0,0', false);
      }
    };
    const loop = () => { place(); requestAnimationFrame(loop); }; requestAnimationFrame(loop);
  }
})();
