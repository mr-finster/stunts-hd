// Runs the translated original game. It never returns to the event loop, so everything it shares
// with the page goes through SharedArrayBuffers: memory (VGA at A0000), the palette, and key events.
'use strict';
importScripts('cpu.js?v=__BUILD__', 'drv86.js?v=__BUILD__', 'dos.js?v=__BUILD__', 'hires-capture.js?v=__BUILD__');   // (the site's version in each address: see index.html)

onmessage = async e => {
  const { memory, palette, keys, saved, scene, bg, world, keepOriginal, audio, args, prefs, inbox, mouse, gameFiles, code, og } = e.data;
  importScripts(code);   // the game's code, made by the page from your copy (boot.js)
  // your copy of the game (from the welcome screen), else the copy next to the page
  const files = gameFiles ? Object.assign({}, gameFiles) : {};
  // (which files: gen/files.json if there is one, else the server's directory listing of the Restunts copy, as tracks/ below)
  const list = gameFiles ? [] : await fetch('gen/files.json').then(r => r.ok ? r.json() : fetch('../vendor/restunts/stunts/')
    .then(r => r.text()).then(html => [...new Set([...html.matchAll(/href="([^"?/]+)"/g)].map(m => decodeURIComponent(m[1])))]));
  await Promise.all(list.map(async f => {
    const r = await fetch('../vendor/restunts/stunts/' + f);
    if (r.ok) files[f.toUpperCase()] = new Uint8Array(await r.arrayBuffer());
  }));
  // the developer copy's own tracks and replays: any file put in stunts/tracks/ (found through the server's directory
  // listing); with your own files (the zip), only the zip's tracks
  if (!gameFiles) try {
    const html = await (await fetch('tracks/')).text();
    const names = [...new Set([...html.matchAll(/href="([^"?/]+\.(?:trk|rpl))"/gi)].map(m => decodeURIComponent(m[1])))];
    await Promise.all(names.map(async n => { const r = await fetch('tracks/' + encodeURIComponent(n)); if (r.ok) files[n.toUpperCase()] = new Uint8Array(await r.arrayBuffer()); }));
  } catch (_) {}
  postMessage({ type: 'font', def: files['FONTDEF.FNT'], led: files['FONTLED.FNT'] });
  postMessage({ type: 'files', names: Object.keys(files) });   // (the game's own files: the page's import/export knows which names are taken)   // (the page's race display draws with the game's fonts)
  const k = new Int32Array(keys);
  const pc = new StuntsPC(StuntsCode, {
    files, saved, memory, palette, mouse,
    log: s => { if (/unhandled/.test(s) || /not found/.test(s) && /^(localhost|127\.)/.test(location.hostname)) console.log('[dos]', s); },   // (the files the game looks for and goes on without: only while developing)
    onExit: code => { postMessage({ type: 'exit', code }); throw new HostExit(code); },
    onSave: (name, data) => postMessage({ type: 'save', name, data: data.slice() }),
    onDelete: name => postMessage({ type: 'delete', name }),
  });
  // the game stopping itself (its fatal_error: out of memory, a file it can't do without): the page is told why
  // before the game exits, so the welcome page can say so (an add-on car too big for the game's memory did this)
  { const f = StuntsCode.P.fatal_error;
    if (f) StuntsCode.P.fatal_error = function (r, m, P, e) {
      try {
        const fmt = m.cstr(r.ds, m.rw(r.ss, r.sp + 4)); let n = 0;
        const text = fmt.replace(/%[sxd]/g, c => { const w = m.rw(r.ss, r.sp + 6 + 2 * n++); return c === '%s' ? m.cstr(r.ds, w) : c === '%x' ? w.toString(16) : String(w); }).replace(/\s+/g, ' ').trim();
        postMessage({ type: 'fatal', text });
      } catch (_) {}
      return f(r, m, P, e);
    }; }
  // key events from the page: ring of (scancode | down << 16 | ascii << 17)
  let lastDown = 0;
  pc.hook = () => {
    let rd = Atomics.load(k, 1);
    const wr = Atomics.load(k, 0);
    while (rd !== wr) {
      const v = k[2 + rd];
      if ((v >> 16) & 1) lastDown = v & 0xFFFF;
      pc.keyEvent(v & 0xFFFF, (v >> 16) & 1, (v >>> 17) & 0xFF);
      rd = (rd + 1) & 1023;
    }
    Atomics.store(k, 1, rd);
  };
  // AdLib: the OPL register writes go to the page's synthesiser (opl-worklet.js) through a shared ring
  if (audio) {
    const RING = 8192, I = new Int32Array(audio, 0, 2), R = new Uint8Array(audio, 8, 256), F = new Float64Array(audio, 512, RING * 2), T0 = performance.timeOrigin;
    pc.onOpl = (a, v, t) => { R[a] = v; const w = I[0], j = (w % RING) * 2; F[j] = T0 + t; F[j + 1] = (a << 8) | v; Atomics.store(I, 0, w + 1); };
  }
  // the chase camera (C) starts straight behind the car, a little lower than the original's default
  pc.ww(StuntsCode.DSEG, StuntsCode.SYM.custom_camera_azimuth_angle, 512);
  pc.ww(StuntsCode.DSEG, StuntsCode.SYM.custom_camera_elevation_angle, 56);
  if (scene) StuntsHires.install(pc, StuntsCode, scene, bg, { keepOriginal, og, world, hud: h => postMessage(Object.assign({ type: 'hud' }, h)) });   // (the clock's LED font has digits only)
  // the pause (P): any key resumes; Esc resumes and opens the race menu at once (else it takes a second Esc)
  const pau = StuntsCode.P.do_pau_restext;
  StuntsCode.P.do_pau_restext = function (r, m, P, e) {
    lastDown = 0;
    const ret = pau(r, m, P, e);
    if (lastDown === 1) { pc.keyEvent(1, 1, 27); pc.keyEvent(1, 0, 0); }
    return ret;
  };
  // Your last car, paint, gearbox, opponent and track (gameconfig's first 22 bytes, kept by the page): put
  // back over the game's defaults at start-up (the track named there is the one it loads next), if their
  // files are there. The page is told whenever they may have changed (after the car, opponent and track
  // menus, and as a race starts).
  const CFG = SY_ => SY_.gameconfig, GC = 22;
  const sdc = StuntsCode.P.set_default_car;
  StuntsCode.P.set_default_car = function (r, m, P, e) {
    const ret = sdc(r, m, P, e);
    if (prefs && prefs.length === GC) {
      const str = (o, n) => { let t = ''; for (let i = 0; i < n && prefs[o + i]; i++) t += String.fromCharCode(prefs[o + i]); return t; };
      const has = n => !!(files[n] || pc.saved[n]);
      const car = str(0, 4), opp = prefs[6] ? str(7, 4) : null, trk = str(13, 8);
      if (has('CAR' + car + '.RES') && (!opp || has('CAR' + opp + '.RES')) && /^[A-Z0-9_\-]+$/i.test(trk) && has(trk.toUpperCase() + '.TRK'))
        for (let i = 0; i < GC; i++) pc.wb(StuntsCode.DSEG, CFG(StuntsCode.SYM) + i, prefs[i]);
    }
    return ret;
  };
  // the track editor (load_tracks_menu_shapes is, in fact, the whole editor): the page shows its terrain button
  { const ed = StuntsCode.P.load_tracks_menu_shapes;
    StuntsCode.P.load_tracks_menu_shapes = function (r, m, P, e) { postMessage({ type: 'editor', on: true }); try { return ed(r, m, P, e); } finally { postMessage({ type: 'editor', on: false }); } }; }
  const tellPrefs = () => { const a = new Uint8Array(GC); for (let i = 0; i < GC; i++) a[i] = pc.rb(StuntsCode.DSEG, CFG(StuntsCode.SYM) + i); postMessage({ type: 'prefs', data: a }); };
  for (const name of ['run_car_menu', 'run_opponent_menu', 'run_tracks_menu', 'draw_track_preview']) {   // (the preview: a track was chosen)
    const f = StuntsCode.P[name];
    StuntsCode.P[name] = function (r, m, P, e) { const ret = f(r, m, P, e); tellPrefs(); return ret; };
  }
  // files dropped on the page arrive through a shared inbox (the worker never returns to its event loop):
  // Int32 [0] the page's count, [1] the worker's, [2] the data's length (-1: delete the file; -2: the track the track menu
  // takes next, see below; -3: restart, -4: rewind); the name (16 bytes) at 16, data at 32
  let pick = null, restartAt = 0, rewindAsk = 0;
  if (inbox) {
    const IB = new Int32Array(inbox, 0, 4), IU = new Uint8Array(inbox), hook0 = pc.hook;
    pc.hook = now => {
      hook0(now);
      const want = Atomics.load(IB, 0);
      if (want !== Atomics.load(IB, 1)) {
        let name = ''; for (let i = 16; i < 32 && IU[i]; i++) name += String.fromCharCode(IU[i]);
        if (IB[2] === -3) restartAt = Date.now();
        else if (IB[2] === -4) rewindAsk++;   // (Q: a second back, see below)
        else if (IB[2] === -2) pick = { name: name.toUpperCase(), t: Date.now() };
        else if (IB[2] < 0) delete pc.saved[name.toUpperCase()]; else pc.saved[name.toUpperCase()] = IU.slice(32, 32 + IB[2]);
        Atomics.store(IB, 1, want); Atomics.notify(IB, 1);
      }
    };
  }
  // A paused race (Esc) draws no more 3D frames, so switching HD and OG there would show nothing new: the page
  // asks (og[2] counts the requests) and the picture is drawn once more, in the new look, from the game's state.
  if (og) {
    const oI = new Int32Array(og), hook1 = pc.hook || (() => {}); let done = Atomics.load(oI, 2);
    const mem8 = new Uint8Array(memory), bg8 = bg ? new Uint8Array(bg) : null;
    let panelTop = 0;
    pc.hook = (now, r) => {
      hook1(now, r);
      const rq = Atomics.load(oI, 2);
      if (rq === done || !r || inUF || !inRun) { if (rq !== done && !inRun) done = rq; return; }   // (only inside the race routine, never inside a frame being drawn: between them, the game waiting; elsewhere the request is dropped)
      done = rq;
      const save = { ax: r.ax, bx: r.bx, cx: r.cx, dx: r.dx, si: r.si, di: r.di, bp: r.bp, sp: r.sp, ds: r.ds, es: r.es, f: pc.flagsWord(r) };
      pc.inIrq = true;
      // (the picture is drawn over the whole screen: the replay panel at the bottom, black at its edges, is put back)
      const S0 = mem8.slice(0xA0000, 0xA0000 + 64000), M0 = bg8 ? bg8.slice(128000, 192000) : null;
      // (its top: the rows at the bottom with no see-through (colour 233) pixels; in the original look nothing is marked, so the last one seen, else the replay panel's 151)
      let top = 200;
      { const keyed = y => { let c = 0; for (let x = 0; x < 320; x++) if (S0[y * 320 + x] === 233) c++; return c > 8; }; if (keyed(60)) { while (top > 100 && !keyed(top - 1)) top--; panelTop = top; } }
      top = panelTop || 151;
      try { if (lastUF) { r.ds = StuntsCode.DSEG; pc.push(r, lastUF[1]); pc.push(r, lastUF[0]); pc.call(r, StuntsCode.P, 'update_frame', 4, 0); } } finally { pc.inIrq = false; }
      if (top < 200) { mem8.set(S0.subarray(top * 320), 0xA0000 + top * 320); if (bg8) bg8.set(M0.subarray(top * 320), 128000 + top * 320); }
      Object.assign(r, save); pc.setFlags(r, save.f);
    };
  }
  // Re-Start Driving in the Replay Menu sits next to Continue Driving, and picked by mistake it throws the race away: the
  // page asks first (og[5] asked, og[6] answered, og[7] the answer) and the game waits; not wanted, the game's own menu
  // shows again
  if (og && StuntsCode.P.show_dialog) {
    const oI = new Int32Array(og), sd = StuntsCode.P.show_dialog;
    const isReplayMenu = (r, sp) => {   // (the "men" text: its third and fourth arguments, the text's far address)
      const off = pc.rw(r.ss, (sp + 8) & 0xFFFF), seg = pc.rw(r.ss, (sp + 10) & 0xFFFF);
      let t = ''; for (let i = 0; i < 160; i++) t += String.fromCharCode(pc.rb(seg, (off + i) & 0xFFFF));
      return t.includes('Re-Start Driving');
    };
    StuntsCode.P.show_dialog = function (r, m, P, e) {
      const sp = r.sp, menu = isReplayMenu(r, sp);
      // (its eight arguments as given: it writes the menu's centred place over the two that ask for it, -1, and shown
      // again from those it came out shifted)
      const args = []; for (let i = 0; i < 8; i++) args.push(pc.rw(r.ss, (sp + 4 + i * 2) & 0xFFFF));
      for (;;) {
        const ret = sd(r, m, P, e);
        if (!menu || (r.ax & 0xFFFF) !== 2) return ret;   // (2: Re-Start Driving; its caller counts from 1)
        const ask = Atomics.add(oI, 5, 1) + 1;
        while (Atomics.load(oI, 6) !== ask) Atomics.wait(oI, 6, Atomics.load(oI, 6), 250);
        if (Atomics.load(oI, 7)) return ret;
        r.sp = sp;   // (shown again, from the same call: its arguments and return address are still on the stack)
        for (let i = 0; i < 8; i++) pc.ww(r.ss, (sp + 4 + i * 2) & 0xFFFF, args[i]);
      }
    };
  }
  // Music after a race: the title song's header names its instruments (4 letters each), and setting it up
  // writes over each name a pointer into the voice file. When the song is still in the game's file cache
  // (enough memory: it was not evicted during the race) but the voice file was loaded again elsewhere, the
  // second setup finds no names, only pointers into freed memory: no drums. The names are put back first.
  // Music after a race: setting up a song points the drums (BASD, SNAR, TOMM, RIDE, CRSH, CHHT, OHHT) into its
  // voice file. Back at the menu the title song comes from the game's file cache, already set up, so the game
  // skips that step and the drums still point into the race's voice file, since freed: no drums. The drums
  // the title's own voice file gave them are put back.
  { const P = StuntsCode.P, init = P.init_audio_resources, amsi = P.audio_map_song_instruments, D = StuntsCode.DSEG, S = StuntsCode.SYM;
    const DR = ['basdres', 'snarres', 'tommres', 'rideres', 'crshres', 'chhtres', 'ohhtres'];
    if (init && amsi && DR.every(n => S[n] != null)) {
      const kept = new Map(); let mapped = false;
      const vceKey = r => { const a = ((pc.rw(r.ss, (r.sp + 10) & 0xFFFF) << 4) + pc.rw(r.ss, (r.sp + 8) & 0xFFFF)) & 0xFFFFF; return a + ':' + Array.from(pc.mem.slice(a, a + 16)).join(','); };
      P.audio_map_song_instruments = function (r, m, PP, e) { const ret = amsi(r, m, PP, e); mapped = true; return ret; };
      P.init_audio_resources = function (r, m, PP, e) {
        const key = vceKey(r); mapped = false;
        const ret = init(r, m, PP, e);
        if (mapped) kept.set(key, DR.map(n => [pc.rw(D, S[n]), pc.rw(D, S[n] + 2)]));
        else { const k = kept.get(key); if (k) DR.forEach((n, i) => { pc.ww(D, S[n], k[i][0]); pc.ww(D, S[n] + 2, k[i][1]); }); }
        return ret;
      };
    }
  }
  // No attract mode: the game starts its demo ("Professional Driver") after a few minutes without input, which
  // cut into whatever was going on (a track being built, the page's own boxes open). Its idle count is held at 0.
  { const hook2 = pc.hook || (() => {}), D2 = StuntsCode.DSEG, IC = StuntsCode.SYM.idle_counter;
    if (IC != null) pc.hook = (now, r) => { hook2(now, r); pc.ww(D2, IC, 0); }; }
  // count rendered 3D frames for the page (k[1030])
  const uf = StuntsCode.P.update_frame;
  // A race starts with the game driving the car out of the start truck (game_replay_mode 1, byte_4393C
  // non-zero), which any key but the race shortcuts skips: Space is pressed for the player as soon as the intro is running (its game
  // frames advancing: keys pressed while the race loads are dropped), so the car is on the line at once.
  const D = StuntsCode.DSEG, SY = StuntsCode.SYM;
  let rewinding = false;
  function rewind(r, m, P, seconds) {
    const GS = StuntsCode.STRUCTS.GAMESTATE.fields, GI = StuntsCode.STRUCTS.GAMEINFO.fields, fr = SY.state + GS.game_frame;
    const now = pc.rw(D, fr), fps = pc.rw(D, SY.framespersec) || 20, to = Math.max(0, now - seconds * fps);
    rewinding = true; const irq = pc.inIrq; pc.inIrq = true;   // (the timer held off while it winds back: in the replay its tick would end the race)
    try {
      pc.wb(D, SY.game_replay_mode, 2);   // (the recorded keys, as a replay plays)
      pc.push(r, to); pc.call(r, P, 'restore_gamestate', 4); r.sp = (r.sp + 2) & 0xFFFF;
      while (pc.rw(D, fr) < to) pc.call(r, P, 'update_gamestate', 4);
    } finally { rewinding = false; pc.inIrq = irq; }
    // "Continue Driving" (loc_244A7, less what is the menu's own: the camera and the dashboard stay as they were)
    pc.ww(D, SY.elapsed_time2, to); pc.ww(D, SY.gameconfig + GI.game_recordedframes, to);
    pc.wb(D, SY.game_replay_mode, 0); pc.wb(D, SY.state + GS.game_3F6autoLoadEvalFlag, 0); pc.ww(D, SY.state + GS.game_frame_in_sec, 0); pc.wb(D, SY.byte_449E6, 0);
    pc.wb(D, SY.byte_449DA, 0); pc.wb(D, SY.is_in_replay, 0);   // (the race no longer over, nor a replay: as the menu leaves them)
    pc.wb(D, SY.byte_43966, 3);   // (and marked continued, as that menu marks a race taken up again from a rewound replay
    // (loc_24453): the results say so, and its time goes in no high score table (byte_43966 & 6))
    return to;
  }
  let intro = null;
  let lastUF = null, inUF = 0, inRun = 0;
  // The original's bump bug: after touching the other car, a car's extra wheel angle (car_36MwhlAngle) dies away by
  // 15/16 a frame, rounded down: from a positive value it reaches 0, from -15 it stays (-225 >> 4 = -15), and the car
  // pulls left for good. Here, after the original's own update, a value stuck in -15..-1 shrinks as a positive one does.
  // Not in a replay: a replay is the race driven again from its keys, and one recorded in DOS hit the bug there
  // (mr-finster/stunts-hd#1: 0051 left the road and drowned)
  // Off for now (2026-10-15): it changed the physics replays recorded in DOS were made with; kept to turn back on
  const BUMPFIX = false;
  { const ug = StuntsCode.P.update_grip; if (BUMPFIX && ug) StuntsCode.P.update_grip = function (r, m, P, e) {
    const cs = pc.rw(r.ss, (r.sp + 4) & 0xFFFF), ret = ug(r, m, P, e), Dg = StuntsCode.DSEG;
    let w = pc.rw(Dg, cs + 54); if (w > 32767) w -= 65536;
    if (w < 0 && w > -16 && pc.rw(Dg, cs + 62) === 0 && !pc.rb(Dg, StuntsCode.SYM.is_in_replay)) pc.ww(Dg, cs + 54, (-((-w * 15) >> 4)) & 0xFFFF);
    return ret;
  }; }
  // a track the page has just added (or the one to show after a delete): the track menu's More Tracks is pressed for it
  // (qol.js) and the picker answers at once with its name, unseen, as if chosen there; the game then loads it as ever.
  // Only a track's picker, and only for a few seconds after the page asked
  // R on the page: Esc pauses the race into its replay, Esc again asks for the Replay Menu, and the menu answers
  // "Re-Start Driving" (2) at once, unseen: the game starts the race again as from the menu
  { const sd = StuntsCode.P.show_dialog; if (sd) StuntsCode.P.show_dialog = function (r, m, P, e) {
    if (restartAt && Date.now() - restartAt < 3000 && pc.mem[(StuntsCode.DSEG << 4) + StuntsCode.SYM.game_replay_mode] !== 0) { restartAt = 0; m.ret(r, 4, 0); r.ax = 2; return; }
    return sd(r, m, P, e);
  }; }
  { const fsd = StuntsCode.P.do_fileselect_dialog; if (fsd) StuntsCode.P.do_fileselect_dialog = function (r, m, P, e) {
    const buf = pc.rw(r.ss, (r.sp + 6) & 0xFFFF), ext = pc.rw(r.ss, (r.sp + 8) & 0xFFFF), D = StuntsCode.DSEG;
    let x = ''; for (let i = 0; i < 4; i++) x += String.fromCharCode(pc.mem[(D << 4) + ext + i] | 0x20);
    if (pick && Date.now() - pick.t < 3000 && x === '.trk' && /^[A-Z0-9_\-]{1,8}$/.test(pick.name)) {
      for (let i = 0; i < 9; i++) pc.wb(D, buf + i, i < pick.name.length ? pick.name.charCodeAt(i) : 0);
      pick = null; m.ret(r, 4, 0); r.ax = 1; return;
    }
    return fsd(r, m, P, e);
  }; }
  // Q on the page: the race back a second a press, the way the game's own Replay Menu does it: rewound in the replay
  // (the state kept nearest before, then the recorded keys driven again to the frame, as restore_gamestate and
  // update_gamestate do when a replay is wound back), then "Continue Driving" from there, as that menu does
  // (loc_244A7: the recording ends there, the replay off). The original's own code throughout: the state after is
  // the one the race had then. Only while driving, inside the race routine
  { const ug = StuntsCode.P.update_gamestate; if (ug && StuntsCode.P.restore_gamestate) StuntsCode.P.update_gamestate = function (r, m, P, e) {
    if (rewindAsk && !pc.rw(D, SY.state + StuntsCode.STRUCTS.GAMESTATE.fields.game_frame)) rewindAsk = 0;   // (on the line, before the clock runs: nothing to wind back)
    if (!rewindAsk || !inRun || rewinding || pc.rb(D, SY.game_replay_mode) !== 0) return ug(r, m, P, e);
    const back = rewindAsk; rewindAsk = 0;
    rewind(r, m, P, back);
    m.ret(r, 4, 0);   // (this frame's update not made: the race carries on from the frame rewound to)
  }; }
  { const rg = StuntsCode.P.run_game; if (rg) StuntsCode.P.run_game = function (r, m, P, e) { inRun++; try { return rg(r, m, P, e); } finally { inRun--; } }; }   // (inside the race routine: the only place a picture may be drawn again)
  StuntsCode.P.update_frame = function (r, m, P, e) {
    Atomics.add(k, 1030, 1);
    lastUF = [pc.rw(r.ss, (r.sp + 4) & 0xFFFF), pc.rw(r.ss, (r.sp + 6) & 0xFFFF)];   // (its two arguments, for a picture drawn again: see below)
    const inIntro = pc.rb(D, SY.game_replay_mode) === 1 && pc.rb(D, SY.byte_4393C) !== 0, gf = pc.rw(D, SY.state + 320);
    if (!inIntro) intro = null;
    else if (!intro) intro = { gf, sent: false };
    else if (!intro.sent && ((gf - intro.gf) & 0xFFFF) >= 2) { intro.sent = true; tellPrefs(); pc.keyEvent(0x39, 1, 0x20); pc.keyEvent(0x39, 0, 0); }
    inUF++; try { return uf(r, m, P, e); } finally { inUF--; }
  };
  postMessage({ type: 'running' });
  try { pc.start(args || []); postMessage({ type: 'exit', code: pc.r.ax }); }
  catch (err) {
    if (!(err instanceof HostExit)) { console.error(err); postMessage({ type: 'error', message: String(err && err.stack || err) }); }
  }
};
