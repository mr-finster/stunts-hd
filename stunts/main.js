// The page's side of the game, started by index.html once the game's code is made (boot.js): shows the screen, sends
// keys, draws the HD view. Uses window.stuntsBoot = { files (yours, or null for the developer copy), code }.
'use strict';
// (a new version of the site put up while the welcome screen was open: this file the new one, the page's others the old,
// and two versions' parts don't fit together. The page again instead, all of it new, straight into the game; once only)
if (self.stuntsBuild !== '__BUILD__') {
  let again = true;
  try { again = sessionStorage.getItem('stunts-restart') === '__BUILD__'; if (!again) { sessionStorage.setItem('stunts-restart', '__BUILD__'); sessionStorage.setItem('stunts-restart-go', '1'); } } catch (_) {}
  if (!again) { self.stuntsReloading = true; location.reload(); throw new Error('a new version of the page: loading it again'); }
}
// The original game runs in a worker (worker.js).
const canvas = document.getElementById('screen'), g = canvas.getContext('2d');
const memory = new SharedArrayBuffer(0x110000), palette = new SharedArrayBuffer(768), keys = new SharedArrayBuffer(4 * 1040);
const mem = new Uint8Array(memory), pal = new Uint8Array(palette), k = new Int32Array(keys);
const img = g.createImageData(320, 200), px = new Uint32Array(img.data.buffer), rgb = new Uint32Array(256);

// files the game saved (replays, tracks, high scores) live in localStorage
const saved = {};
for (let i = 0; i < localStorage.length; i++) {
  const key = localStorage.key(i);
  if (key.startsWith('stunts:')) saved[key.slice(7)] = Uint8Array.from(atob(localStorage.getItem(key)), c => c.charCodeAt(0));
}
// your last car, opponent and track (the worker sends them as they change), and a shared inbox for files
// dropped on the page (qol.js)
let prefs = null;
try { const p = localStorage.getItem('stunts-prefs'); if (p) prefs = Uint8Array.from(atob(p), c => c.charCodeAt(0)); } catch (_) {}
const inbox = new SharedArrayBuffer(32 + 256 * 1024);
// the mouse, for the game's mouse driver (int 33h in dos.js): [0] present, [1] x, [2] y (0..65535 across the
// 4:3 screen), [3] buttons
const mouse = new SharedArrayBuffer(40), mouseI = new Int32Array(mouse);   // ([4..9]: the game's mouse range and offset, from the worker)
Atomics.store(mouseI, 0, /[?&]nomouse/.test(location.search) ? 0 : 1);
function pointer(e) {
  if (pointer.fake) return;   // (a press the page is making on the game's behalf: see afterDelete in qol.js)
  const r = canvas.getBoundingClientRect();
  // only over the 4:3 picture, and not while driving: the game's pointer at the picture's edge would make those
  // rows narrow (see the clip in frame()), showing black boxes beside the picture
  const over = e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
  // (let go outside the picture: the drag and the game's button end all the same)
  if (!over && e.type === 'pointerup') { pointer.drag = pointer.downInMenu = false; Atomics.store(mouseI, 3, 0); if (typeof view !== 'undefined' && view && view.pointer) view.pointer = { ...view.pointer, b: 0, t: performance.now() }; return; }
  // (a replay playing is a race view too, but its panel is worked with the mouse: the pointer stays the game's there)
  const driving = typeof view !== 'undefined' && view && view.raceView && performance.now() - (view.lastFrame || 0) < 300
    && !mem[(StuntsCode.DSEG << 4) + StuntsCode.SYM.game_replay_mode];
  if (!over || driving) return;
  Atomics.store(mouseI, 1, Math.max(0, Math.min(65535, Math.round((e.clientX - r.left) / r.width * 65535))));
  Atomics.store(mouseI, 2, Math.max(0, Math.min(65535, Math.round((e.clientY - r.top) / r.height * 65535))));
  // (the track menu's 3D overview is turned by dragging: presses over it, between the title and the buttons, are not
  // the game's, which would open the track picker)
  // (only where the overview itself shows: the track picker or any dialog over it takes its clicks as before)
  const rx = (e.clientX - r.left) / r.width, ry = (e.clientY - r.top) / r.height;
  let onPreview = typeof view !== 'undefined' && view && view.previewView && ry > 0.1 && ry < 0.82 && overviewAt(rx, ry);
  // (a drag that began on the overview stays the overview's until let go, wherever it passes: not a press on a button)
  if (e.type === 'pointerdown') pointer.drag = !!onPreview; else if (!e.buttons) pointer.drag = false;
  if (pointer.drag && e.buttons) onPreview = true;
  // (and a press that began before the track menu came up, as the click on the main menu's Track sign: not a click in it)
  const inMenu = typeof view !== 'undefined' && view && view.previewView;
  if (e.type === 'pointerdown') pointer.downInMenu = inMenu; else if (!e.buttons) pointer.downInMenu = false;
  if (e.buttons != null) Atomics.store(mouseI, 3, onPreview || (inMenu && !pointer.downInMenu) ? 0 : (e.buttons & 1 ? 1 : 0) | (e.buttons & 2 ? 2 : 0));
  // (and for the track menu's 3D overview, turned by dragging: 0..1 across the picture, and the buttons held)
  if (typeof view !== 'undefined' && view) view.pointer = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, t: performance.now(), b: onPreview ? e.buttons || 0 : 0 };
}
addEventListener('pointermove', pointer); addEventListener('pointerdown', pointer); addEventListener('pointerup', pointer);
// is the track menu's 3D overview showing at this point (0..1 across the picture)? The game's own cursor is drawn at the
// pointer, its arrow down and to the right of the tip, so the pixel there is the cursor's: the ones just up and left of
// it tell (over the track picker or a dialog, those are the box's own)
function overviewAt(rx, ry) {
  const x = Math.min(319, Math.floor(rx * 320)), y = Math.min(199, Math.floor(ry * 200));
  for (const [dx, dy] of [[-2, -2], [-3, 0], [0, -3]]) {
    const px = x + dx, py = y + dy; if (px < 0 || py < 0) continue;
    const i = py * 320 + px; if (scr[i] === StuntsHires.KEY && mk[i]) return true;
  }
  return false;
}
// (the button still held from a click before the track menu came up: let go for the game at once)
setInterval(() => { if (typeof view !== 'undefined' && view && view.previewView && !pointer.downInMenu && Atomics.load(mouseI, 3)) Atomics.store(mouseI, 3, 0); }, 15);
// the wheel zooms the track menu's 3D overview (in: closer; clamped in renderPreview)
addEventListener('wheel', e => {
  const r = canvas.getBoundingClientRect();
  if (typeof view === 'undefined' || !view || view.pvT0 == null) return;
  if (document.querySelector('#trkio[open]')) return;   // (the import / export box: its own text boxes scroll)
  if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) return;
  const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  e.preventDefault();
  // over a dialog on the overview (the track picker): the wheel scrolls its list, a step per notch, as the arrow keys do
  const wx = (e.clientX - r.left) / r.width, wy = (e.clientY - r.top) / r.height;
  if (view.previewView && !overviewAt(wx, wy)) {   // (under the pointer: not the overview)
    if (wy < 0.1 || wy >= 0.82) return;   // (the title or the menu's buttons: the wheel does nothing there)
    wheelAcc += d; const step = 100;   // (a mouse wheel's notch: one line)
    while (Math.abs(wheelAcc) >= step) {
      const code = wheelAcc > 0 ? 'ArrowDown' : 'ArrowUp'; wheelAcc -= Math.sign(wheelAcc) * step;
      dispatchEvent(new KeyboardEvent('keydown', { code, key: code })); setTimeout(() => dispatchEvent(new KeyboardEvent('keyup', { code, key: code })), 40);
    }
    return;
  }
  wheelAcc = 0;
  view.pvZoomTo = Math.max(0.1, Math.min(1.25, (view.pvZoomTo || 1) * Math.exp(d * 0.0012)));   // (in close enough to look round the scenery)
}, { passive: false });
let wheelAcc = 0;
addEventListener('contextmenu', e => e.preventDefault());
const worker = new Worker('worker.js?v=__BUILD__');
worker.onmessage = e => {
  const m = e.data;
  if (m.type === 'prefs') { let s = ''; for (const b of m.data) s += String.fromCharCode(b); try { localStorage.setItem('stunts-prefs', btoa(s)); } catch (_) {} }
  if (m.type === 'save') { saved[m.name] = m.data; let s = ''; for (const b of m.data) s += String.fromCharCode(b); try { localStorage.setItem('stunts:' + m.name, btoa(s)); } catch (_) { if (window.qolSay) qolSay('Browser storage full: ' + m.name + ' not kept'); } }
  if (m.type === 'delete') { try { localStorage.removeItem('stunts:' + m.name); } catch (_) {} delete saved[m.name]; }
  if (m.type === 'error') { const el = document.getElementById('err'); el.hidden = false; el.textContent = m.message; }
  if (m.type === 'fatal') { try { sessionStorage.setItem('stunts-stopped', m.text); } catch (_) {} }   // (said on the welcome page after the reload)
  if (m.type === 'exit') { if (window.stuntsHost && stuntsHost.quit) stuntsHost.quit(); else location.reload(); }   // (the game's exit to DOS: in the app, the app closes; on the site, the game starts again)
  if (m.type === 'editor') document.getElementById('terrain').hidden = !m.on;
  if (m.type === 'files') window.stockNames = new Set(m.names);
  if (m.type === 'font') { hud.def = m.def; hud.led = m.led; }
  if (m.type === 'hud') { hud.d = m; hud.at = performance.now(); }
};
// High-resolution 3D: the worker records what the original renderer was asked to draw each frame
// (scene) and the sky it drew (bg); the page draws the polygons with WebGL between the two.
const HIRES = !/[?&]lowres/.test(location.search);
const scene = new SharedArrayBuffer(StuntsHires.BYTES), bg = new SharedArrayBuffer(5 * 64000), world = new SharedArrayBuffer(StuntsHires.WBYTES);
const MODERN = !/[?&]classic/.test(location.search);   // ?classic: the original's look (painter's order, flat colours, its view distance)
const bgU8 = new Uint8Array(bg), sceneI = new Int32Array(scene);
const bgCanvas = document.getElementById('bg'), bgG = bgCanvas.getContext('2d'), glCanvas = document.getElementById('gl');
// the dashboard in widescreen: its rows carried out to the window's sides, each the colour of the cockpit's own edge
const sidesCanvas = document.getElementById('sides'), sidesG = sidesCanvas.getContext('2d');
const bgImg = bgG.createImageData(320, 200), bgPx = new Uint32Array(bgImg.data.buffer);
// ?tod=dusk / ?tod=night: a look at the time of day (a mockup: a colour grade over the 3D view, headlights at night)
{ const tod = (/[?&]tod=(dusk|night)/.exec(location.search) || [])[1];
  if (tod) {
    document.getElementById('gl').style.filter = tod === 'dusk' ? 'saturate(1.2) brightness(0.95)' : 'brightness(0.55) saturate(0.8) contrast(1.15)';
    const t = document.getElementById('tod'); t.hidden = false;
    t.style.background = tod === 'dusk' ? 'linear-gradient(180deg, rgba(255,140,80,0.0) 0%, rgba(255,150,80,0.45) 45%, rgba(170,80,120,0.5) 100%)' : 'linear-gradient(180deg, rgba(10,20,70,0.55) 0%, rgba(20,40,110,0.35) 50%, rgba(0,0,20,0.35) 100%)';
    t.style.mixBlendMode = tod === 'dusk' ? 'soft-light' : 'multiply';
  } }
// a phone (a touch screen and no mouse): the 3D view drawn at up to twice its page pixels, not a phone's three times (over
// twice the pixels to draw, for little more to see), and its far shadows from a smaller map (?full: as on a computer)
const PHONE = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches && !/[?&]full\b/.test(location.search);
const view = HIRES ? new HiresView(glCanvas, mem, pal, scene, StuntsCode.DSEG, StuntsCode.SYM, MODERN ? { world, bg, phone: PHONE } : {}) : null;
const NOHUD = /[?&]nohud/.test(location.search);
const DASHM = ((/[?&]dash=(\w+)/.exec(location.search) || [])[1] || 'curve');   // (the widescreen dashboard: curve, the default; ?dash=flat the old flat colours)
// (?dash=curve: the dashboard carried out to the sides bending down: each column further out drawn lower, on a curve that
// takes it off the bottom of the screen; above it the 3D view. Its pixels: the car's plain column (DASH_COLS), as tex)
function drawCurve(dashRow, solidUp) {
  // (drawn at SS times the game's resolution: the curve's edge smooth, not a staircase of the game's pixels)
  const SS = 4, cw = Math.max(320, Math.round(320 * (view.wide || 1))), m = (cw - 320) >> 1, W = cw * SS, H = 200 * SS;
  if (sidesCanvas.width !== W) { sidesCanvas.width = W; sidesCanvas.height = H; sidesCanvas.img = sidesG.createImageData(W, H); sidesCanvas.px = new Uint32Array(sidesCanvas.img.data.buffer); }
  const sp = sidesCanvas.px; sp.fill(0);
  const D = StuntsCode.DSEG << 4, G = StuntsCode.SYM.gameconfig, code = String.fromCharCode(...mem.subarray(D + G, D + G + 4));
  const cols = DASH_COLS[code] || { l: 0, r: 318 }, K = StuntsHires.KEY;
  // (the dashboard: the block of rows at the bottom, bending down off the screen; the roof strip at the top, if the car has
  // one, bending up off it the opposite way: both on the same gentle curve, so the cockpit wraps round the view)
  let top = 200; while (top > 0 && dashRow[top - 1]) top--;
  let roof = 0; while (roof < top && dashRow[roof]) roof++;
  // (the two columns copied, remembered per car the first time they stand unchanged a second, outside a replay: whatever the
  // game draws over the dash meanwhile (the replay panel, the gear change's pop-up) is never carried out to the sides)
  const colOf = c => { const a = new Uint32Array(200); for (let y = 0; y < 200; y++) { const v = scr[y * 320 + c]; a[y] = v === K ? 0 : rgb[v]; } return a; };
  const now = { code, top, roof, l0: colOf(cols.l), l1: colOf(cols.l + 1), r0: colOf(cols.r), r1: colOf(cols.r - 1), e0: colOf(0), e1: colOf(1), f0: colOf(319), f1: colOf(318) };
  const D2 = (StuntsCode.DSEG << 4), replay = !!mem[D2 + StuntsCode.SYM.game_replay_mode];
  const same = (p, q) => p && p.code === q.code && p.top === q.top && p.roof === q.roof && ['l0', 'l1', 'r0', 'r1', 'e0', 'e1', 'f0', 'f1'].every(k => p[k].every((v, i) => v === q[k][i]));
  if (!replay) { drawCurve.run = same(drawCurve.last, now) ? (drawCurve.run || 0) + 1 : 0; drawCurve.last = now;
    const keep = drawCurve.keep || (drawCurve.keep = {});
    if (drawCurve.run >= 60 && !keep[code] && now.top < 190 && now.top > 60) keep[code] = now; }   // (only a real dash: the remembered setting turns it on before the game has drawn it, and "no dash" was learned)   // (the first steady view only, on the start line: never replaced, a pop-up held up as long can't creep in)
  const C = drawCurve.keep && drawCurve.keep[code] || now;
  top = C.top; roof = C.roof;
  const A = (200 - top) * 0.35;   // (the drop at the window's edge: about a third of the dash's height)
  let waterC = 0; if (solidUp) for (let y = top - 1; y >= 0; y--) if (solidUp[y]) { waterC = rgb[scr[y * 320]]; break; }
  const put = (X, Y, c) => { sp[Y * W + X] = c; sp[Y * W + W - 1 - X] = c; };
  if (solidUp) for (let y = 0; y < top; y++) if (solidUp[y]) { const c = rgb[scr[y * 320]]; for (let Y = y * SS; Y < (y + 1) * SS; Y++) for (let X = 0; X < (m + 3) * SS; X++) put(X, Y, c); }
  for (let X = 0; X < (m + 3) * SS; X++) {
    const x = X / SS, d = (m + 2 - x) / 220, sh = A * d * d * SS,   // (in the game's pixels from the picture's edge: the same curve at any width, a narrower window showing less of it)
    k = Math.floor(m + 2 - x) % 2, Lc = k ? C.l1 : C.l0, Rc = k ? C.r1 : C.r0, T0 = Math.round(top * SS + sh), R0 = Math.round(roof * SS - sh);
    if (waterC) for (let Y = top * SS; Y < T0; Y++) put(X, Y, waterC);   // (drowning: the water down to the curve, no gap above it)
    for (let Y = T0; Y < H; Y++) { const ys = Math.min(199, Math.floor((Y - sh) / SS)); sp[Y * W + X] = Lc[ys]; sp[Y * W + W - 1 - X] = Rc[ys]; }
    const Le = k ? C.e1 : C.e0, Re = k ? C.f1 : C.f0;   // (the roof strip from its own outer edge: the dash's column can fall on another part of it)
    for (let Y = 0; Y < R0; Y++) { const ys = Math.max(0, Math.floor((Y + sh) / SS)); sp[Y * W + X] = Le[ys]; sp[Y * W + W - 1 - X] = Re[ys]; }
  }
  sidesG.putImageData(sidesCanvas.img, 0, 0);
}
const DASH_COLS = { ANSX: { l: 5, r: 243 }, AUDI: { l: 33, r: 317 }, COUN: { l: 46, r: 314 }, FGTO: { l: 10, r: 301 }, JAGU: { l: 68, r: 294 },
  LANC: { l: 32, r: 269 }, LM02: { l: 7, r: 316 }, P962: { l: 1, r: 318 }, PC04: { l: 0, r: 244 }, PMIN: { l: 0, r: 310 }, VETT: { l: 42, r: 318 } };
// H: HD mode or OG mode, the original's own pictures (the worker reads the shared flag; kept for next time)
const ogFlag = new SharedArrayBuffer(32), ogI = new Int32Array(ogFlag);   // ([0] the look (OG), [1] > 0 while the game reads typed text: a high-score name, a save name;
// [4..7]: the Replay Menu's restart asked about on a touch screen, see worker.js and qol.js)
addEventListener('pointerdown', e => Atomics.store(ogI, 4, e.pointerType === 'touch' ? 1 : 0), true);
addEventListener('keydown', () => Atomics.store(ogI, 4, 0), true);
const typing = () => Atomics.load(ogI, 1) > 0;
let OG_MODE = false; try { OG_MODE = localStorage.getItem('stunts-og') === '1'; } catch (_) {}
const LIGHT = /[?&]light\b/.test(location.search);   // (the realistic light, L: shelved; only with ?light)
if (view && LIGHT) try { view.giOn = localStorage.getItem('stunts-light') === '1'; } catch (_) { view.giOn = false; }   // (classic unless L turned it on)
Atomics.store(ogI, 0, OG_MODE ? 1 : 0);   // (no race clock and speed: recording)
const DEBUG = /[?&]debug/.test(location.search);   // original renderer kept, shown half-transparent over the high-res one
if (DEBUG) canvas.style.opacity = 0.5;
// Sound: the original AdLib driver (Sound Blaster FM) unless ?pcspeaker or ?nosound
const SOUND = /[?&]nosound/.test(location.search) ? null : /[?&]pcspeaker/.test(location.search) ? 'pc' : 'ad';
const audio = SOUND === 'ad' ? new SharedArrayBuffer(512 + 8192 * 16) : null;
const args = SOUND === 'ad' ? ['/sad'] : SOUND ? [] : ['/ns'];
// the game's files (your copy, else the developer copy next to the page) and its code, from index.html
const startGame = gameFiles => (window.stockNames = new Set(Object.keys(gameFiles || {}).map(n => n.toUpperCase())), worker.postMessage(Object.assign(HIRES ? { memory, palette, keys, saved, scene, bg, world: MODERN ? world : null, keepOriginal: DEBUG } : { memory, palette, keys, saved }, { audio, args, prefs, inbox, mouse, gameFiles, code: stuntsBoot.code.url, og: ogFlag })));
startGame(stuntsBoot.files);
// browsers start audio only after a key press or click
let actx = null;
async function startAudio() {
  if (!audio || actx) { if (actx && actx.state !== 'running') actx.resume(); return; }
  actx = new AudioContext({ latencyHint: 'interactive' });
  await actx.audioWorklet.addModule('opl-worklet.js?v=__BUILD__');
  const node = new AudioWorkletNode(actx, 'stunts-opl', { numberOfInputs: 0, outputChannelCount: [2] });
  node.connect(actx.destination);
  node.port.postMessage({ sab: audio });
  if (window.qolAudio) qolAudio(node);   // (remembered volume, mute)
  // races: the worklet boosts the effects (opl-worklet.js FX)
  let wasRace = null; setInterval(() => { const r = !!(view && view.raceView && performance.now() - (view.lastFrame || 0) < 500); if (r !== wasRace) { wasRace = r; node.port.postMessage({ race: r }); } }, 200);
  const vol = /[?&]vol=([\d.]+)/.exec(location.search); if (vol) node.port.postMessage({ vol: +vol[1] });   // ?vol=0.1 .. 1
  // the worker stamps writes with epoch milliseconds; tell the synthesiser how they map to its clock
  const sync = () => { const ts = actx.getOutputTimestamp(); if (ts.performanceTime) node.port.postMessage({ offset: performance.timeOrigin + ts.performanceTime - ts.contextTime * 1000 }); };
  sync(); setInterval(sync, 1000);
}
addEventListener('pointerdown', startAudio);
startAudio();   // (at once, if the browser allows sound before a key press or click; otherwise the first one starts it)

// PC scan codes (set 1); 0x100 marks keys sent with the E0 prefix
const SCAN = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11, Minus: 12, Equal: 13, Backspace: 14,
  Tab: 15, KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25, BracketLeft: 26, BracketRight: 27, Enter: 28,
  ControlLeft: 29, KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40, Backquote: 41,
  ShiftLeft: 42, Backslash: 43, KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53, ShiftRight: 54,
  NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58, F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74, Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
  ArrowUp: 0x148, ArrowLeft: 0x14B, ArrowRight: 0x14D, ArrowDown: 0x150, Home: 0x147, End: 0x14F, PageUp: 0x149, PageDown: 0x151, Insert: 0x152, Delete: 0x153,
  NumpadEnter: 0x11C, ControlRight: 0x11D, AltRight: 0x138, NumpadDivide: 0x135,
};
function key(e, down) {
  if (document.getElementById('setup')) return;   // (the welcome screen: its keys are its own, none reach the game)
  if (document.querySelector('#trkio[open]')) return;   // (the track import / export box: typing there)
  if (down) startAudio();
  if (window.qolKey && qolKey(e, down)) return;   // the page's own keys (qol.js)
  if (!typing() && e.code === 'KeyG' && HIRES && view && view.ghostAvail && mem[(StuntsCode.DSEG << 4) + StuntsCode.SYM.game_replay_mode] === 0) {   // (G: the ghost car on or off, when there is one, not in a replay; no key of the game's in a race)
    e.preventDefault();
    if (down && !e.repeat) { view.ghostOn = !view.ghostOn; hud.drawn = null; try { localStorage.setItem('stunts-ghost-on', view.ghostOn ? '1' : '0'); } catch (_) {} }
    return;
  }
  if (!typing() && e.code === 'KeyL' && LIGHT && HIRES && view && !OG_MODE) {   // (L: the baked light on or off, in the HD look; no key of the game's in a race)
    e.preventDefault();
    if (down && !e.repeat) { view.giOn = !view.giOn; hud.drawn = null; try { localStorage.setItem('stunts-light', view.giOn ? '1' : '0'); } catch (_) {} }
    return;
  }
  if (!typing() && e.code === 'KeyH' && HIRES) {   // (H: no key of the game's)
    e.preventDefault();
    if (down && !e.repeat) { OG_MODE = !OG_MODE; Atomics.store(ogI, 0, OG_MODE ? 1 : 0); try { localStorage.setItem('stunts-og', OG_MODE ? '1' : '0'); } catch (_) {} hud.drawn = null; if (view && view.raceView && performance.now() - (view.lastFrame || 0) > 250) Atomics.add(ogI, 2, 1); }
    return;
  }
  const sc = SCAN[e.code];
  if (sc == null) return;
  e.preventDefault();
  if (down && e.repeat) return;   // the game does its own key repeat
  const ascii = e.key.length === 1 ? e.key.charCodeAt(0) & 0xFF : { Enter: 13, Escape: 27, Backspace: 8, Tab: 9 }[e.key] || 0;
  const wr = Atomics.load(k, 0);
  k[2 + wr] = (sc & 0xFFFF) | (down ? 1 << 16 : 0) | (ascii << 17);
  Atomics.store(k, 0, (wr + 1) & 1023);
}
addEventListener('keydown', e => key(e, true));
// the track editor's terrain pieces, without the secret key: the button sends the game Shift+F1
document.getElementById('terrain').addEventListener('click', async e => {
  e.stopPropagation();
  const k_ = (code, down) => key({ code, key: code === 'F1' ? 'F1' : 'Shift', repeat: false, preventDefault() {} }, down);
  k_('ShiftLeft', true); await new Promise(r => setTimeout(r, 60)); k_('F1', true); await new Promise(r => setTimeout(r, 90));
  k_('F1', false); await new Promise(r => setTimeout(r, 60)); k_('ShiftLeft', false);
});
addEventListener('keyup', e => key(e, false));

// 320x200 shown at 4:3; the 3D view (modern) as wide as the window, the original screen centred over it
const WIDE = MODERN && !/[?&]narrow/.test(location.search);
function fit() {
  const s = Math.min(innerWidth / 320, innerHeight / 240), gw = WIDE ? Math.max(320 * s, innerWidth) : 320 * s;   // (as wide as the window, 32:9 too)
  for (const c of [canvas, bgCanvas]) { c.style.width = 320 * s + 'px'; c.style.height = 240 * s + 'px'; }
  glCanvas.style.width = gw + 'px'; glCanvas.style.height = 240 * s + 'px';
  sidesCanvas.style.width = gw + 'px'; sidesCanvas.style.height = 240 * s + 'px';
  const hc = document.getElementById('hud'), dpr = devicePixelRatio || 1;
  hc.style.width = gw + 'px'; hc.style.height = 240 * s + 'px'; hc.width = Math.round(gw * dpr); hc.height = Math.round(240 * s * dpr); hud.drawn = null;
  if (view) view.resize(Math.round(gw), Math.round(240 * s), PHONE ? Math.min(2, dpr) : dpr, gw / (320 * s));
}
// The race display: time, speed and camera in the font and style of the game's race messages ("Fasten your
// Seatbelt!": FONTDEF.FNT, a solid black shadow a pixel down and right), crisp in the corners of the screen,
// the way modern racing games put them. The worker leaves the game's clock out and sends the numbers
// (hires-capture.js, opts.hud). A font: character offsets (words from 0x16); glyphs of 8 rows of bits, each
// with its width in a byte first, or all of the width in the header (word 8) and no such byte.
const hud = { def: null, led: null, d: null, at: 0, drawn: null };
function hudFont() { return hud.def; }   // (for qol.js, which has a hud of its own)
function hudText(c, f, str, x, y, u, align, alpha, gap = 0, rgb = '255,255,255', shadow = true) {
  const fixed = f[0x10] | f[0x11] << 8;
  const glyph = ch => { const o = f[0x16 + 2 * ch.charCodeAt(0)] | f[0x17 + 2 * ch.charCodeAt(0)] << 8; return o ? (fixed ? { w: fixed, at: o } : { w: f[o], at: o + 1 }) : null; };
  let w = 0; for (const ch of str) { const gl = glyph(ch); w += (gl ? gl.w : 4) + gap; }
  w -= fixed ? 1 + gap : 2;   // (the blank column at a glyph's right: trimmed off the end so the text aligns)
  const px = Math.round(align === 'right' ? x - w * u : align === 'center' ? x - w * u / 2 : x);
  // (the shadow: an extrusion, every step from the letter down and right filled, so the diagonals are drawn)
  const sd = Math.max(1, Math.round(u * 1.5)), layers = [];
  if (shadow) for (let k = sd; k >= 1; k--) layers.push([k, 'rgba(0,0,0,' + alpha + ')']);
  layers.push([0, 'rgba(' + rgb + ',' + alpha + ')']);
  for (const [dx, col] of layers) {
    c.fillStyle = col; let cx = px + dx;
    for (const ch of str) {
      const gl = glyph(ch); if (!gl) { cx += (4 + gap) * u; continue; }
      const nb = (gl.w + 7) >> 3;
      // (u need not be a whole number: each dot's edges are rounded to the screen's pixels, so the text scales smoothly and stays crisp)
      for (let r = 0; r < 8; r++) for (let b = 0; b < gl.w; b++) if (f[gl.at + r * nb + (b >> 3)] & (0x80 >> (b & 7))) {
        const x0 = Math.round(cx + b * u), y0 = Math.round(y - (8 - r) * u + dx);
        c.fillRect(x0, y0, Math.max(1, Math.round(cx + (b + 1) * u) - x0), Math.max(1, Math.round(y - (7 - r) * u + dx) - y0));
      }
      cx += (gl.w + gap) * u;
    }
  }
  return w * u;
}
function drawHud(t, race, shown) {
  // the numbers come from the game's memory every frame, so the display is up from the first frame of the race (the game
  // draws its clock only once the throttle is first pressed); not while 3D frames have stopped (a menu over the race), with
  // the dashboard, or in a replay (which keep the game's own)
  const D = StuntsCode.DSEG << 4, Sy = StuntsCode.SYM, hc = document.getElementById('hud');
  const live = !!(race && hud.def && view && t - (view.lastFrame || 0) < 300);
  if (live) hud.menuAt = 0;
  const on = live && !mem[D + Sy.dashb_toggle] && !mem[D + Sy.game_replay_mode];
  if (!live) {
    // outside a race: only the look's key, and only while the HD picture is on screen (car select, the track menu's
    // overview, a paused race), where pressing it changes what is seen; not on the flat menus
    if (!hud.def || !view || !shown || document.getElementById('setup')) { hc.hidden = true; hud.drawn = null; hud.menuAt = 0; return; }
    // (only once that screen has stood a moment: leaving a race for the main menu, the last 3D picture stays on screen a
    // few frames, and the settings line flashed up over it)
    if (!hud.menuAt) hud.menuAt = t;
    if (t - hud.menuAt < 60) { hc.hidden = true; hud.drawn = null; return; }   // (about a game frame: long enough for the last race picture to go)
    const mk = 'menu|' + OG_MODE + '|' + view.giOn + '|' + hc.width + '|' + hc.height;
    hc.hidden = false; if (hud.drawn === mk) return; hud.drawn = mk;
    const c = hc.getContext('2d'), H = hc.height, small = Math.max(1, Math.max(1, H / 340) * 0.75), m = Math.round(H * 0.04);
    c.clearRect(0, 0, hc.width, H);
    const w = hudText(c, hud.def, '(H) HD MODE', m, m + 8 * small, small, 'left', 0.75);
    hudText(c, hud.def, OG_MODE ? 'OFF' : 'ON', m + w + 12 * small, m + 8 * small, small, 'left', 1, 0, '255,247,33');
    if (LIGHT && !OG_MODE && view.giAvail !== false) { const w2 = hudText(c, hud.def, '(L) LIGHTING', m, m + 19 * small, small, 'left', 0.75); hudText(c, hud.def, view.giOn ? 'REALISTIC' : 'CLASSIC', m + w2 + 12 * small, m + 19 * small, small, 'left', 1, 0, '255,247,33'); }
    return;
  }
  const rw = a => mem[a] | mem[a + 1] << 8;
  const d = { frame: rw(D + Sy.state + 320), fps: rw(D + Sy.framespersec) || 20, mph: Math.round(rw(D + Sy.state + 0x152 + 0x2C) / 256), cam: mem[D + Sy.cameramode] };
  const secs = d.frame / d.fps, mm = Math.floor(secs / 60), ss = secs - mm * 60;
  hc.hidden = !on; if (!on) { hud.drawn = null; return; }
  const str = (a, n) => { let s = ''; for (let i = 0; i < n && mem[D + a + i]; i++) s += String.fromCharCode(mem[D + a + i]); return s; };
  const track = str(Sy.gameconfig + 13, 9).toUpperCase(), gear = mem[D + Sy.state + 0x152 + 0xBE];
  // the track's record from its high score file (7 records of 52 bytes, the time at +0x32 in frames; 0xFFFF: none), shown
  // as the game shows times, m:ss.ss. The file, not the game's table in memory: the game reads that only for the results
  // after a race, so in a race it still held another track's, or nothing yet
  let bestF = 0xFFFF; {
    const hf = saved[track + '.HIG'] || (window.stuntsBoot && stuntsBoot.files && stuntsBoot.files[track + '.HIG']);
    if (hf && hf.length >= 364) for (let i = 0; i < 7; i++) { const f = hf[i * 52 + 0x32] | hf[i * 52 + 0x33] << 8; if (f && f < bestF) bestF = f; }
  }
  const bs = bestF === 0xFFFF ? null : bestF / 20, best = bs == null ? '-:--.--' : Math.floor(bs / 60) + ':' + (bs % 60 < 10 ? '0' : '') + (bs % 60).toFixed(2);
  // the game's own "Wrong Way" (state+0x45D = 3, set whenever you drive against the track) is drawn by the game only in the
  // in-car view; in the others the page shows it, flashing
  const wrong = mem[D + Sy.state + 0x45D] === 3 && d.cam !== 0 && (t % 800) < 500;
  const rewound = window.qolRewind ? qolRewind.secs : 0;   // (seconds rewound with Q in this race, qol.js: the race marked)
  const time = mm + ':' + (ss < 10 ? '0' : '') + ss.toFixed(2), key = time + '|' + wrong + '|' + OG_MODE + '|' + view.giOn + '|' + d.mph + '|' + d.cam + '|' + hc.width + '|' + track + '|' + gear + '|' + best + '|' + (view.ghostAvail ? view.ghostOn : 'x') + '|' + rewound;
  if (hud.drawn === key) return; hud.drawn = key;
  // (u: one pixel of the font for the labels; the numbers larger. All in proportion to the picture's height, in
  // between whole pixels too: the text shrinks with a smaller window, down to the font's own size)
  const c = hc.getContext('2d'), H = hc.height, u = Math.max(1, H / 340), small = Math.max(1, u * 0.75);
  const tu = u * 1.5, su = u * 2.3, m = Math.round(H * 0.04), base = H - m, base2 = H - Math.round(m * 0.6);   // (base2: the ghost, gear and speed sit a little lower)
  c.clearRect(0, 0, hc.width, H);
  // top left: the camera, and the key that changes it (C: the next one)
  // (each: the key in brackets and the setting's name dim, its value white: (C) CAM CHASE, (H) HD MODE ON, (G) GHOST OFF)
  const CAMS = ['IN CAR', 'HIGH', 'CHASE', 'TV'];
  let ly = m + 8 * small;
  const setting = (label, value) => { const w = hudText(c, hud.def, label, m, ly, small, 'left', 0.75); hudText(c, hud.def, value, m + w + 12 * small, ly, small, 'left', 1, 0, '255,247,33'); ly += 11 * small; };
  if (CAMS[d.cam]) setting('(C) CAM', CAMS[d.cam]);
  setting('(H) HD MODE', OG_MODE ? 'OFF' : 'ON');
  if (LIGHT && !OG_MODE && view.giAvail !== false) setting('(L) LIGHTING', view.giOn ? 'REALISTIC' : 'CLASSIC');
  if (rewound) setting('(Q) REWOUND', rewound + ' S');
  // bottom left: the time, its label above, the track's best under it
  // (the ghost's key goes under the best time, when there is a ghost: a lap you finished on this very track)
  const showGhost = view.ghostAvail, gl = showGhost ? 11 * small : 0;
  const tb = base - gl - 8 * small - 4 * u;
  hudText(c, hud.def, time, m, tb, tu, 'left', 1);
  hudText(c, hud.def, 'RECORD ' + best, m, base - gl, small, 'left', 0.75);   // (the track's record: its high score table, whoever set it)
  if (showGhost) { const w = hudText(c, hud.def, '(G) GHOST', m, base2, small, 'left', 0.75); hudText(c, hud.def, view.ghostOn ? 'ON' : 'OFF', m + w + 12 * small, base2, small, 'left', 1, 0, '255,247,33'); }
  if (wrong) hudText(c, hud.def, 'WRONG WAY', hc.width / 2, H * 0.3, u * 2.4, 'center', 1);
  // top right: the track, as large as the settings on the left and level with their first line
  if (track) hudText(c, hud.def, track, hc.width - m, m + 8 * small, small, 'right', 1);
  // bottom right: the speed, large, its unit beside it, the gear under
  const hasGear = gear >= 1 && gear <= 6;
  if (hasGear) hudText(c, hud.def, 'GEAR ' + gear, hc.width - m, base2, small, 'right', 0.75);
  const sb = hasGear ? base2 - 8 * small - 4 * u : base2;
  const uw = hudText(c, hud.def, 'MPH', hc.width - m, sb - su + u, u, 'right', 0.75);
  hudText(c, hud.def, String(d.mph), hc.width - m - uw - 6 * u, sb, su, 'right', 1);
}
addEventListener('resize', fit); fit();

// the car select: the turntable round the car is opened up (the picture moved to the layer below the 3D view),
// so the 3D view's shadow under the car shows there, drawn at full resolution (S: the shadow's centre c and
// half-axes a, b in the 320x200 frame; only the turntable's dark grey top)
function openStage(S) {
  const [cx, cy] = S.c, [ax, ay] = S.a, [bx, by] = S.b, det = ax * by - ay * bx;
  if (Math.abs(det) < 1) return false;
  const ex = Math.abs(ax) + Math.abs(bx) + 2, ey = Math.abs(ay) + Math.abs(by) + 2;
  const x0 = Math.max(0, Math.floor(cx - ex)), x1 = Math.min(319, Math.ceil(cx + ex)), y0 = Math.max(0, Math.floor(cy - ey)), y1 = Math.min(199, Math.ceil(cy + ey));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * 320 + x, p = px[i]; if (!p) continue;
    const R = p & 255, G = (p >> 8) & 255, Bb = (p >> 16) & 255; if (Math.abs(R - G) > 10 || Math.abs(G - Bb) > 10 || R > 130) continue;
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, s = (dx * by - dy * bx) / det, u = (ax * dy - ay * dx) / det;
    if (s * s + u * u > 1.15) continue;
    bgPx[i] = p; px[i] = 0;
  }
  return true;
}
const scr = new Uint8Array(64000), mk = new Uint8Array(64000), ogView = new Uint8Array(64000);
// the game's own change of screen, dissolving one into the next in scattered dots: in HD mode, outside races, the
// last whole screen is held until the new one is done (it showed for a frame or two as a glitch: the old screen's
// pixels strewn over the new); OG mode keeps the dissolve
const rawNow = new Uint8Array(64000), rawPrev = new Uint8Array(64000);
let dissolveSince = 0;
function dissolving(a, b) {   // the pixels changed since the last look: many, and mostly lone ones
  let n = 0, lone = 0;
  for (let i = 321; i < 63679; i++) {
    if (a[i] === b[i]) continue;
    n++;
    if (a[i - 1] === b[i - 1] && a[i + 1] === b[i + 1] && a[i - 320] === b[i - 320] && a[i + 320] === b[i + 320]) lone++;
  }
  return n > 600 && lone > n * 0.3;
}
// The game draws its mouse pointer into the screen itself, and takes it off (mouse_draw_opaque, mouse_isdirty 0)
// while it draws under it, putting it back after (mouse_draw_transparent, 1). The screen is copied at the display's
// pace, so a copy in between had no pointer: it flickered in the menus and the editor (mr-finster/stunts-hd#9).
// While it is off, the copy gets it here as the game draws it (the mask ANDed, the picture ORed); only for a moment
// (a longer while is the game hiding it on purpose), and never while driving (a replay, yes).
// It is drawn where the game would read the mouse now, not where it last did: the game moves its pointer only when
// it next looks, which in the editor is a while, so it trailed the mouse in steps. While the game's own is on, it is
// taken off the copy first, with the screen under it as the game saved it to put back (mouseunkspriteptr).
let pointerOffSince = 0, pointerAt = null;   // (pointerAt: where a pointer is on the copy after pointerOver, or null)
const drivingNow = () => !!(view && view.raceView) && !mem[(StuntsCode.DSEG << 4) + StuntsCode.SYM.game_replay_mode];   // (a replay is a race view too, but with the pointer in use)
// where int 33h function 3 would put the pointer now, as mouse_get_state scales it, from the range and offset the
// worker publishes (mouseI[4..9]); null before the game has set the mouse up
function pointerLive() {
  const M = mouseI, x0 = M[4], x1 = M[5], y0 = M[6], y1 = M[7];
  if (!M[0] || x1 <= x0 || y1 <= y0) return null;
  const cl = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));
  const x = cl(x0 + M[1] / 65535 * (x1 - x0) + M[8] / 65536, x0, x1), y = cl(y0 + M[2] / 65535 * (y1 - y0) + M[9] / 65536, y0, y1);
  return [x >> (mem[(StuntsCode.DSEG << 4) + StuntsCode.SYM.mousehorscale] & 15), y];
}
function pointerOver(px, t) {
  const D = StuntsCode.DSEG << 4, S = StuntsCode.SYM;
  pointerAt = null;
  if (!mem[D + S.kbormouse] || drivingNow()) { pointerOffSince = 0; return; }
  const w16 = a => mem[a] | mem[a + 1] << 8, s16 = v => v << 16 >> 16;
  const far = a => ((w16(a + 2) << 4) + w16(a)) & 0xFFFFF;   // (a far pointer in memory, as an address)
  const shape = sp => far(far(D + S[sp]));   // (the sprite's bitmap: width, height, ..., x and y at 8 and 10, pixels from byte 16)
  const ok = b => { const w = w16(b), h = w16(b + 2); return w && h && w <= 64 && h <= 64; };
  const on = mem[D + S.mouse_isdirty], game = [s16(w16(D + S.mouse_xpos)), s16(w16(D + S.mouse_ypos))];
  if (on) pointerOffSince = 0;
  else { if (!pointerOffSince) pointerOffSince = t; if (t - pointerOffSince > 300) return; }
  const live = pointerLive() || game;
  if (on) {
    const u = shape('mouseunkspriteptr');
    if (!ok(u)) { pointerAt = game; return; }   // (taken off even where the mouse hasn't moved: mouse_xpos can be newer than the drawing)
    const w = w16(u), h = w16(u + 2), ux = s16(w16(u + 8)), uy = s16(w16(u + 10));
    for (let y = 0; y < h; y++) {
      const sy = uy + y; if (sy < 0 || sy >= 200) continue;
      for (let x = 0; x < w; x++) { const sx = ux + x; if (sx >= 0 && sx < 320) px[sy * 320 + sx] = mem[u + 16 + y * w + x]; }
    }
  }
  const mask = shape('mmouspriteptr'), pic = shape('smouspriteptr');
  if (!ok(mask) || !ok(pic)) return;
  for (const [b, or] of [[mask, false], [pic, true]]) {
    const w = w16(b), h = w16(b + 2);
    for (let y = 0; y < h; y++) {
      const sy = live[1] + y; if (sy < 0 || sy >= 200) continue;
      for (let x = 0; x < w; x++) {
        const sx = live[0] + x; if (sx < 0 || sx >= 320) continue;
        const v = mem[b + 16 + y * w + x], i = sy * 320 + sx;
        px[i] = or ? px[i] | v : px[i] & v;
      }
    }
  }
  pointerAt = live;
}
// where the pointer is on the copy (its mask's box), or null: kept see-through at the picture's left and right edges
// below, so a pointer there (in a replay, where it moves over the 3D view) doesn't make its rows narrow
function pointerBox() {
  if (!pointerAt) return null;
  const D = StuntsCode.DSEG << 4, S = StuntsCode.SYM;
  const w16 = a => mem[a] | mem[a + 1] << 8, far = a => ((w16(a + 2) << 4) + w16(a)) & 0xFFFFF;
  const b = far(far(D + S.mmouspriteptr)), w = w16(b), h = w16(b + 2);
  if (!w || !h || w > 64 || h > 64) return null;
  const [x, y] = pointerAt;
  return [x, y, x + w, y + h];
}
function frame(t) {   // t: the display frame's time (steadier than reading the clock mid-work)
  // one snapshot of the screen and the see-through marks for this whole frame: the game runs on meanwhile,
  // and two layers built from different moments leave holes where pixels turned see-through in between
  rawNow.set(mem.subarray(0xA0000, 0xA0000 + 64000));
  pointerOver(rawNow, t);
  const hold = !OG_MODE && !(view && view.raceView) && dissolving(rawNow, rawPrev);
  rawPrev.set(rawNow);
  if (hold && !dissolveSince) dissolveSince = t;
  if (!hold || t - dissolveSince > 500) { dissolveSince = 0; scr.set(rawNow); } mk.set(bgU8.subarray(128000, 192000)); ogView.set(bgU8.subarray(256000, 320000));
  for (let i = 0; i < 256; i++) rgb[i] = 0xFF000000 | ((pal[i * 3 + 2] * 255 / 63) << 16) | ((pal[i * 3 + 1] * 255 / 63) << 8) | (pal[i * 3] * 255 / 63);
  // the high-res layer shows while frames arrive, and for as long as see-through pixels remain on screen
  // (only pixels the worker made see-through count: bgU8[128000..] marks them; the game itself also uses
  // colour 233 in places such as the credits)
  // (marks are dropped where the screen changed only once 3D frames stopped: the worker marks the back
  // buffer a moment before the game copies it to the screen)
  let keyed = false, anyKey = false;
  // (the track menu's overview is a single frame, published before the menu reaches the screen: its marks
  // are kept while the menu is up, dialogs opening and closing over it included)
  // (the worker marking a frame, or a frame not yet taken: not idle; a mark left on for a second is ignored)
  if (!sceneI[13]) frame.busy = null; else if (frame.busy == null) frame.busy = t;
  const busy = frame.busy != null && t - frame.busy < 1000;
  const idle = view && !busy && sceneI[1] === view.seq && t - (view.lastFrame || 0) > 300 && !view.previewView;
  const edge = new Uint8Array(200);   // rows whose both ends are see-through (the 3D view may go past the frame there)
  const rowKey = new Uint16Array(200);   // see-through pixels per row (a row mostly see-through goes wide too: the crash's cracked glass touches the edges)
  let marked = 0, shown = 0;
  if (view) for (let i = 0; i < 64000; i++) {
    const m_ = mk[i];
    if (m_) marked++;
    if (scr[i] === StuntsHires.KEY) { anyKey = true; if (m_) { shown++; keyed = true; const x = i % 320, y = (i / 320) | 0; rowKey[y]++; if (x === 0 || x === 319) edge[y]++; } }
  }
  // (an edge pixel made see-through that the game's pointer now covers still counts as see-through: issue 9 / PR 6)
  const pb = view && pointerBox();
  if (pb) for (let y = Math.max(0, pb[1]); y < Math.min(200, pb[3]); y++) for (const x of [0, 319]) {
    const i = y * 320 + x;
    if (x >= pb[0] && x < pb[2] && mk[i] && scr[i] !== StuntsHires.KEY) edge[y]++;
  }
  // once 3D frames stop, marks are dropped where the screen changed, but only when the 3D view has mostly
  // gone (a menu or picture over it): a dialog or message over a paused view keeps its marks, so the view
  // shows again when it closes
  if (idle && shown < marked * 0.4) for (let i = 0; i < 64000; i++) if (scr[i] !== StuntsHires.KEY) { bgU8[128000 + i] = 0; mk[i] = 0; }
  if (view && view.previewView && (keyed ? (view.previewShown = true, false) : view.previewShown && !anyKey)) view.previewView = false;   // (left the menu)
  // the replay and pause panel: the black the game paints round it, below the 3D window, shows the 3D view instead (the
  // black reached from the screen's edges only, so the panel's own black, its clocks, stays), out to the wide edges too
  const hole = frame.hole || (frame.hole = new Uint8Array(64000)); hole.fill(0);
  if (view && view.raceView && !OG_MODE && keyed && !mem[(StuntsCode.DSEG << 4) + StuntsCode.SYM.dashb_toggle]) {
    let yk = -1; for (let y = 199; y >= 0; y--) if (rowKey[y] > 0) { yk = y; break; }
    if (yk >= 100 && yk < 196) {
      const blk = i => rgb[scr[i]] === rgb[0] && (rgb[0] & 0xFFFFFF) === 0, st = [];
      const push = i => { if (!hole[i] && blk(i)) { hole[i] = 1; st.push(i); } };
      for (let y = yk + 1; y < 200; y++) { push(y * 320); push(y * 320 + 319); }
      for (let x = 0; x < 320; x++) push(199 * 320 + x);
      while (st.length) { const i = st.pop(), x = i % 320, y = (i / 320) | 0;
        if (x > 0) push(i - 1); if (x < 319) push(i + 1); if (y > yk + 1) push(i - 320); if (y < 199) push(i + 320); }
      if (hole.some(Boolean)) for (let y = yk + 1; y < 200; y++) edge[y] = 2;   // (all of it wide: the panel itself is the game's picture, over the view)
    }
  }
  let live = false;
  if (view) { view.ogHide = OG_MODE && !keyed && !!view.raceView; view.ogMask = ogView; }
  try { live = view && view.render(t, keyed); }
  catch (e) { if (!frame.failed) { frame.failed = true; console.error(e); } live = false; }   // the original picture stays
  glCanvas.hidden = !live; bgCanvas.hidden = !live || !!view.raceView || !!view.previewView;
  // (OG mode: the HD layers made invisible, not hidden: hiding rebuilds the page's layers, a hitch on switching)
  // (the track menu's overview is a still picture: OG mode shows the original's, kept at bg + 192000; any other
  // still 3D picture made before the switch has no original pixels to show, and stays HD until drawn again)
  const ogStill = OG_MODE && keyed && !!view.previewView, og = OG_MODE && (!keyed || ogStill);
  // (OG mode in a race: the 3D view's canvas over the original picture, showing only your ghost (hires-view.js, ogGhostDraw);
  // not once frames stop (paused, a dialog up): the ghost would lie over the dialog)
  const ogGh = og && live && view.raceView && view.ogGhost && t - (view.lastFrame || 0) < 250;
  const ogo = og && !ogGh ? '0' : '', bgo = og ? '0' : ''; if (glCanvas.style.opacity !== ogo) glCanvas.style.opacity = ogo; if (bgCanvas.style.opacity !== bgo) bgCanvas.style.opacity = bgo;   // (races: the 3D view draws its own sky)
  const ogz = og ? '1' : ''; if (glCanvas.style.zIndex !== ogz) glCanvas.style.zIndex = ogz;
  // the race view goes past the 4:3 frame on the rows where the screen shows it edge to edge (not the
  // dashboard, D: the cockpit is only that wide); menus, dialogs, panels and the results keep to the frame,
  // from the moment they are on screen
  // (the dashboard on or off (D) kept from race to race: saved when it changes in a race, put back as each race starts)
  if (view) { const a = (StuntsCode.DSEG << 4) + StuntsCode.SYM.dashb_toggle, inRace = !!(live && view.raceView);
    if (inRace && !frame.wasRace) { try { const v = localStorage.getItem('stunts-dash'); if (v != null) mem[a] = +v; } catch (_) {} }
    else if (inRace && frame.dashWas != null && mem[a] !== frame.dashWas) { try { localStorage.setItem('stunts-dash', String(mem[a])); } catch (_) {} }
    frame.wasRace = inRace; frame.dashWas = inRace ? mem[a] : null; }
  if (WIDE && view) {
    const dash = live && keyed && view.raceView && !og && !!mem[(StuntsCode.DSEG << 4) + StuntsCode.SYM.dashb_toggle];   // (keyed: only while the 3D view shows this very frame: leaving for a menu, the sides went with the picture, not a few frames later)
    const race = live && (view.raceView || view.previewView), side = (1 - 1 / (view.wide || 1)) / 2 * 100;
    const pts = [];
    let wideRows = 0;
    // (?dash=open|tex|both|hood: widescreen dashboard mockups. open: the windscreen rows (any see-through) wide, the 3D view out
    // to the sides; tex: the dash body carried out in its own pattern, mirrored; hood: the 3D view across all of it)
    const DM = dash ? DASHM : '', dashRow = new Uint8Array(200);
    // (curve: a row above the dash (its height as remembered for this car) that the game paints one solid colour edge to
    // edge (drowning's blue): left closed, and carried out to the sides as it is; the dash's own rows never count)
    const solidUp = new Uint8Array(200);
    if (DM === 'curve') { const D0 = StuntsCode.DSEG << 4, G0 = StuntsCode.SYM.gameconfig, code0 = String.fromCharCode(...mem.subarray(D0 + G0, D0 + G0 + 4));
      const kt = drawCurve.keep && drawCurve.keep[code0] ? drawCurve.keep[code0].top : 0;
      for (let y = 0; y < kt; y++) { const o = y * 320, c = scr[o]; if (c === StuntsHires.KEY) continue; let ok = true;
        for (let x = 0; x < 6 && ok; x++) if (scr[o + x] !== c || scr[o + 314 + x] !== c) ok = false; solidUp[y] = ok ? 1 : 0; }
      // (water only when there's a lot of it: 15 rows or more of the one colour; a dash's own top line, solid edge to edge
      // just above it, filled the gap over the curve with brown)
      { const n = new Map(); for (let y = 0; y < kt; y++) if (solidUp[y]) { const c = scr[y * 320]; n.set(c, (n.get(c) || 0) + 1); }
        for (let y = 0; y < kt; y++) if (solidUp[y] && n.get(scr[y * 320]) < 15) solidUp[y] = 0; } }
    if (DM === 'curve') for (let y = 0; y < 200; y++) dashRow[y] = edge[y] !== 2 && rowKey[y] <= 12 ? 1 : 0;
    for (let y = 0; y < 200; y++) if (race && (edge[y] === 2 || DM === 'curve' && !solidUp[y] || rowKey[y] > 240 || DM === 'hood' || (DM === 'open' || DM === 'both') && rowKey[y] > 12)) { edge[y] = 2; wideRows++; }
    if (wideRows === 200) pts.push('none');
    else {
      // down the left side band by band, then up the right
      const xs = [];
      for (let y = 0; y < 200; y++) { const w = race && edge[y] === 2; if (!xs.length || xs[xs.length - 1].w !== w) xs.push({ y, w }); }
      const L = [], R = [];
      xs.forEach((b, k) => { const y0 = b.y / 2, y1 = (k + 1 < xs.length ? xs[k + 1].y : 200) / 2, x = b.w ? 0 : side; L.push(x.toFixed(3) + '% ' + y0 + '%', x.toFixed(3) + '% ' + y1 + '%'); R.unshift((100 - x).toFixed(3) + '% ' + y1 + '%', (100 - x).toFixed(3) + '% ' + y0 + '%'); });
      pts.push(...L, ...R);
    }
    const clip = pts[0] === 'none' ? '' : 'polygon(' + pts.join(', ') + ')';
    if (glCanvas.dataset.clip !== clip) { glCanvas.dataset.clip = clip; glCanvas.style.clipPath = clip; }
    // (the dashboard: the rows the 3D view doesn't reach across, carried out to the sides in the cockpit's own colours,
    // so it reads as one wide cockpit and not a 4:3 panel between black bars: each row one hard colour, the game's own
    // palette colour nearest its outer few columns, no fading or smoothing across the rows: pixels, not a blur)
    // (and, out of the dashboard, any race row the game paints one solid colour out to both its edges: under water, the
    // drowning picture's blue, which stood between black bars)
    const KEYC = StuntsHires.KEY, solidRow = y => { const o = y * 320, c = scr[o]; if (c === KEYC) return false;
      for (let x = 0; x < 6; x++) if (scr[o + x] !== c || scr[o + 314 + x] !== c) return false; return true; };
    let solidAny = false;
    if (!dash && !og && keyed && race && view.raceView) for (let y = 0; y < 200; y++) if (edge[y] !== 2 && solidRow(y)) { solidAny = true; break; }
    sidesCanvas.hidden = (!dash || DM === 'hood') && !solidAny;
    const curve = DM === 'curve';
    if (dash && DM !== 'hood' || solidAny) {
      if (curve) { drawCurve(dashRow, solidUp); } else {
      const cw = Math.max(320, Math.round(320 * (view.wide || 1))), m = (cw - 320) >> 1;
      if (sidesCanvas.width !== cw) { sidesCanvas.width = cw; sidesCanvas.height = 200; sidesCanvas.img = sidesG.createImageData(cw, 200); sidesCanvas.px = new Uint32Array(sidesCanvas.img.data.buffer); }
      const sp = sidesCanvas.px; sp.fill(0);
      const near = (r, g_, b_) => { let best = 0xFF000000, bd = 1e9; for (let i = 0; i < 256; i++) { const c = rgb[i], d = ((c & 255) - r) ** 2 + (((c >>> 8) & 255) - g_) ** 2 + (((c >>> 16) & 255) - b_) ** 2; if (d < bd) { bd = d; best = c; } } return best; };
      const row = (y, x0) => { let r = 0, g_ = 0, b_ = 0; for (let x = x0; x < x0 + 6; x++) { const c = scr[y * 320 + x] === StuntsHires.KEY && mk[y * 320 + x] ? 0 : rgb[scr[y * 320 + x]]; r += c & 255; g_ += (c >>> 8) & 255; b_ += (c >>> 16) & 255; } return near(r / 6, g_ / 6, b_ / 6); };
      // (the surface's colours: those making up a good share of the dash's own rows; for each side the column, within 72 of
      // its edge, with the most rows of those colours (nearest the edge on a tie): it runs between the gauges, not through them)
      // (each car's dashboard: a column near each edge, picked by hand, that runs through plain panel only (no gauges,
      // vents or switches); its pixels and its neighbour's (the grain) carried out to the sides. Unknown (add-on) cars:
      // the outermost columns)
      const carCode = String.fromCharCode(...mem.subarray((StuntsCode.DSEG << 4) + StuntsCode.SYM.gameconfig, (StuntsCode.DSEG << 4) + StuntsCode.SYM.gameconfig + 4));
      const dashCols = DASH_COLS[carCode] || { l: 0, r: 318 };
      for (let y = 0; y < 200; y++) {
        if (edge[y] === 2 || (!dash && !solidRow(y))) continue;
        const L = row(y, 0), R = row(y, 314), o = y * cw;
        if (DM === 'tex' || DM === 'both') {
          // (the dash's own surface carried out: a column near each edge that runs through surface only, its pixels and its
          // neighbour's (the grain) repeated outwards; chosen once a frame, below)
          const cl = dashCols.l, cr = dashCols.r, at = c => { const v = scr[y * 320 + c]; return v === StuntsHires.KEY ? 0 : rgb[v]; };
          for (let x = 0; x < m + 3; x++) { const k = (m + 2 - x) % 2;
            sp[o + x] = at(cl + k) || L; sp[o + cw - 1 - x] = at(cr - k) || R; }
        } else for (let x = 0; x < m + 3; x++) { sp[o + x] = L; sp[o + cw - 1 - x] = R; }   // (on a little under the picture: no gap where they meet)
      }
      sidesG.putImageData(sidesCanvas.img, 0, 0);
      }
    }
  }
  if (live) {
    // sky layer: the original skybox inside the 3D window, nothing elsewhere
    // (every see-through pixel shows what the original had there before it became see-through)
    const b = sceneI[15] ? sceneI[15] - 1 : sceneI[0];   // (the frame on screen, see hires-capture.js)
    for (let i = 0; i < 64000; i++) bgPx[i] = scr[i] === StuntsHires.KEY && mk[i] ? rgb[bgU8[b * 64000 + i]] : 0;
    bgG.putImageData(bgImg, 0, 0);
  }
  // the 3D window shows through the pixels the worker made see-through
  for (let i = 0; i < 64000; i++) { const c = scr[i]; px[i] = hole[i] && live && !og ? 0 : c === StuntsHires.KEY && mk[i] ? (ogStill ? rgb[bgU8[192000 + i]] : live && !og ? 0 : rgb[c]) : rgb[c]; }
  if (live && !og && view.stageShadow && !view.previewView && openStage(view.stageShadow)) bgG.putImageData(bgImg, 0, 0);
  g.putImageData(img, 0, 0);
  // (and only while the 3D view shows through in this very frame, or in OG mode: leaving car select or a race for the
  // high scores, the last 3D picture is kept a few frames more, and the settings line lingered over the next screen)
  { const now3d = live && (keyed || og); drawHud(t, now3d && view.raceView && !NOHUD, now3d); }
  if (frame.shot) { frame.shot = false; screenshot(); }
  requestAnimationFrame(frame);
}
// a screenshot (F10, qol.js): the page's layers as they show, at the display's own resolution, in one PNG; taken
// straight after the frame is drawn (the 3D view's picture is only there until the frame ends)
function screenshot() {
  const dpr = window.devicePixelRatio || 1, W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const c = out.getContext('2d'); c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  // (in the order they show: the 3D view's over the picture in OG mode, where it holds only the ghost)
  const layers = [...document.querySelectorAll('canvas#bg, canvas#gl, canvas#sides, canvas#screen, canvas#hud')].sort((a, b) => (+getComputedStyle(a).zIndex || 0) - (+getComputedStyle(b).zIndex || 0));
  for (const el of layers) {
    const st = getComputedStyle(el);
    if (el.hidden || st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0 || !el.width || !el.height) continue;
    const r = el.getBoundingClientRect(), x = r.left * dpr, y = r.top * dpr, w = r.width * dpr, h = r.height * dpr;
    c.save();
    // (the 3D view's clip, a polygon in % of its own box, as the page shows it)
    const m = /polygon\((.*)\)/.exec(st.clipPath || '');
    if (m) { c.beginPath(); m[1].split(',').forEach((pt, i) => { const [px, py] = pt.trim().split(/\s+/).map(parseFloat); const X = x + px / 100 * w, Y = y + py / 100 * h; i ? c.lineTo(X, Y) : c.moveTo(X, Y); }); c.closePath(); c.clip(); }
    c.imageSmoothingEnabled = st.imageRendering !== 'pixelated';
    try { c.drawImage(el, x, y, w, h); } catch (_) {}
    c.restore();
  }
  out.toBlob(b => {
    if (!b) return;
    const d = new Date(), z = n => String(n).padStart(2, '0');
    const a = document.createElement('a'); a.href = URL.createObjectURL(b);
    a.download = `stunts-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}.png`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    if (window.qolSay) qolSay('Screenshot saved (' + W + '\u00d7' + H + ')');
  }, 'image/png');
}
requestAnimationFrame(frame);
