// Your copy of the game: the welcome screen, reading a stunts.zip (or the files themselves) in the browser,
// keeping the files in this browser (IndexedDB), and handing them to the game. Nothing leaves the computer.
//   StuntsSetup.load()          -> the stored files ({ NAME: Uint8Array }) or null
//   StuntsSetup.show(onReady, note, check, ready)   the welcome screen; onReady(files) when Start game is pressed, once a
//                                     good set is in (ready: one kept from last time, in from the start) (check(files):
//                               a promise, rejected with a message for the player when the set cannot run)
'use strict';
(function (root) {
  // files the game cannot start without; the rest are listed if missing but do not stop it
  // (all of Stunts 1.1's own files but the other sound cards' drivers (MT-32, PC speaker, Tandy) and the sample replay)
  const NEED = ['AD15.DRV', 'ADENG1.VCE', 'ADSKIDMS.VCE', 'ALPINE.PVS', 'CARANSX.RES', 'CARAUDI.RES', 'CARCOUN.RES', 'CARFGTO.RES', 'CARJAGU.RES', 'CARLANC.RES', 'CARLM02.RES', 'CARP962.RES', 'CARPC04.RES', 'CARPMIN.RES', 'CARVETT.RES', 'CITY.PVS', 'COUNTRY.PVS', 'CRED.RES', 'DEFAULT.TRK', 'DESERT.PVS', 'FONTDEF.FNT', 'FONTLED.FNT', 'FONTN.FNT', 'GAME.PRE', 'GAME1.P3S', 'GAME2.P3S', 'GEENG.SFX', 'MAIN.RES', 'MISC.PRE', 'OPP1.PRE', 'OPP1LOSE.PVS', 'OPP1WIN.PVS', 'OPP2.PRE', 'OPP2LOSE.PVS', 'OPP2WIN.PVS', 'OPP3.PRE', 'OPP3LOSE.PVS', 'OPP3WIN.PVS', 'OPP4.PRE', 'OPP4LOSE.PVS', 'OPP4WIN.PVS', 'OPP5.PRE', 'OPP5LOSE.PVS', 'OPP5WIN.PVS', 'OPP6.PRE', 'OPP6LOSE.PVS', 'OPP6WIN.PVS', 'SDCRED.PES', 'SDCSEL.PVS', 'SDGAME.PVS', 'SDGAME2.PVS', 'SDMAIN.PVS', 'SDMSEL.PVS', 'SDOSEL.PVS', 'SDTEDIT.PES', 'SDTITL.PVS', 'SKIDOVER.KMS', 'SKIDSLCT.KMS', 'SKIDTITL.KMS', 'SKIDVICT.KMS', 'STANSX.P3S', 'STAUDI.P3S', 'STCOUN.P3S', 'STDAANSX.PVS', 'STDAAUDI.PVS', 'STDACOUN.PVS', 'STDAFGTO.PVS', 'STDAJAGU.PVS', 'STDALANC.PVS', 'STDALM02.PVS', 'STDAP962.PVS', 'STDAPC04.PVS', 'STDAPMIN.PVS', 'STDAVETT.PVS', 'STDBANSX.PVS', 'STDBAUDI.PVS', 'STDBCOUN.PVS', 'STDBFGTO.PVS', 'STDBJAGU.PVS', 'STDBLANC.PVS', 'STDBLM02.PVS', 'STDBP962.PVS', 'STDBPC04.PVS', 'STDBPMIN.PVS', 'STDBVETT.PVS', 'STFGTO.P3S', 'STJAGU.P3S', 'STLANC.P3S', 'STLM02.P3S', 'STP962.P3S', 'STPC04.P3S', 'STPMIN.P3S', 'STVETT.P3S', 'TEDIT.PRE', 'TITLE.P3S', 'TROPICAL.PVS'];
  // and the program: GAME.EXE, or the parts the game's installer builds it from (the MCGA build)
  const PROGRAM = ['EGA.CMN', 'MCGA.HDR', 'MCGA.DIF', 'MCGA.COD'];
  const COD_11 = 48899;   // (Stunts 1.1's MCGA.COD, dated 13 March 1991)
  // the other releases, told apart by the size of their MCGA.COD (the Stunts wiki's downloads): named, when they're picked
  const OTHER = { 42978: 'Stunts 1.0 (October 1990)', 70850: '4D Sports Driving (December 1990)', 48719: '4D Sports Driving (February 1991)' };
  const missing = files => NEED.filter(n => !files[n]).concat(files['GAME.EXE'] || PROGRAM.every(n => files[n]) ? [] : PROGRAM.filter(n => !files[n]));
  const KEEP = /\.(RES|P3S|3SH|PVS|VSH|XVS|PES|ESH|PRE|FNT|TRK|RPL|DRV|VCE|SFX|KMS|PLB|TD|HIG)$|^GAME\.EXE$|^EGA\.CMN$|^MCGA\.(HDR|DIF|COD)$/;   // (what the game reads, and its program; the rest is left out. 3SH, VSH, XVS, ESH: the unpacked forms the game also takes, as added cars often come: without them it asked for the disk again and again)

  // ---- stored files (IndexedDB: survives reloads, stays on this computer) ----
  const db = () => new Promise((res, rej) => { const r = indexedDB.open('stunts-recomp', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function load() {
    try { const d = await db(); return await new Promise(res => { const r = d.transaction('files').objectStore('files').get('game'); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }); }
    catch (_) { return null; }
  }
  async function store(files) { const d = await db(); await new Promise((res, rej) => { const t = d.transaction('files', 'readwrite'); t.objectStore('files').put(files, 'game'); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  async function forget() { const d = await db(); await new Promise(res => { const t = d.transaction('files', 'readwrite'); t.objectStore('files').delete('game'); t.oncomplete = res; t.onerror = res; }); }

  // ---- a zip, read in the browser (stored and deflated entries; the browser's own decompressor) ----
  async function unzip(buf) {
    const u = new Uint8Array(buf), v = new DataView(buf), out = {};
    let e = u.length - 22;
    while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('This does not look like a zip file.');
    let p = v.getUint32(e + 16, true);
    const n = v.getUint16(e + 10, true);
    for (let i = 0; i < n; i++) {
      if (v.getUint32(p, true) !== 0x02014b50) break;
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + xl + cl;
      if (name.endsWith('/') || /(^|\/)__MACOSX\//.test(name) || /(^|\/)\._/.test(name)) continue;
      const start = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true), data = u.subarray(start, start + csize);
      let bytes;
      if (method === 0) bytes = data.slice();
      else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else continue;
      out[name] = bytes;
    }
    return out;
  }
  // any folder layout: file names only, upper case (DOS); zips inside the zip are opened too
  async function collect(list) {
    const files = {}; collect.names = [];
    const add = async (name, bytes) => {
      const base = name.split(/[\\/]/).pop().toUpperCase(); collect.names.push(name.toUpperCase());
      if (base.endsWith('.ZIP')) {   // (a zip inside that can't be read is passed over: the rest may be the whole game)
        let z = null; try { z = await unzip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)); } catch (_) {}
        if (z) for (const [k, b] of Object.entries(z)) await add(k, b);
        return;
      }
      if (KEEP.test(base) && base.length <= 12) files[base] = bytes;
    };
    for (const f of list) await add(f.name, new Uint8Array(await f.arrayBuffer()));
    return files;
  }

  // ---- the welcome screen: the trailer on a widescreen TV, the title, your copy in, and the details behind links
  // (laid out like the VF1 recomp's page). Colours from the game's menu: its hazard stripes and road signs. ----
  const SIGN = {   // the main menu's four road signs, as small icons
    car: '<svg class="sg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5" fill="#1d3fd8"/></svg>',
    track: '<svg class="sg" viewBox="0 0 20 20"><path d="M1.6 3h16.8L10 18z" fill="#f59a1c"/></svg>',
    opp: '<svg class="sg" viewBox="0 0 20 20"><path d="M6.5 1.5h7l5 5v7l-5 5h-7l-5-5v-7z" fill="#d81818"/></svg>',
    opt: '<svg class="sg" viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16" fill="#2f8f3a"/></svg>',
    sup: '<svg class="sg" viewBox="0 0 20 20"><path d="M10 1l9 9-9 9-9-9z" fill="#e8c21a"/></svg>',
    src: '<svg class="sg" viewBox="0 0 20 20"><rect x="1.5" y="1.5" width="17" height="17" fill="#2b2b2b"/><path d="M8 6.5 4.5 10 8 13.5M12 6.5l3.5 3.5-3.5 3.5" fill="none" stroke="#fff" stroke-width="1.8"/></svg>',   // (a dark sign with code brackets: the source on GitHub)
    play: '<svg class="sg" viewBox="0 0 20 20"><rect x="1.5" y="1.5" width="17" height="17" fill="#1d3fd8"/><path d="M7.5 5.5l6.5 4.5-6.5 4.5z" fill="#fff"/></svg>',   // (an information sign: the trailer)
    log: '<svg class="sg" viewBox="0 0 20 20"><rect x="2" y="3" width="16" height="14" fill="#ececec"/><path d="M5 7.5h10M5 12.5h7" stroke="#333" stroke-width="2"/></svg>',   // (a notice board: the changelog)
    quit: '<svg class="sg" viewBox="0 0 20 20"><path d="M10 2.5v7" stroke="#e04040" stroke-width="2.6" stroke-linecap="round"/><path d="M5.6 5.4a6.4 6.4 0 1 0 8.8 0" fill="none" stroke="#e04040" stroke-width="2.6" stroke-linecap="round"/></svg>',   // (a power sign: the app's Quit)
    all: '<svg class="sg" viewBox="0 0 20 20"><rect x="2" y="2" width="7" height="7" fill="#1d3fd8"/><rect x="11" y="2" width="7" height="7" fill="#f59a1c"/><rect x="2" y="11" width="7" height="7" fill="#2f8f3a"/><rect x="11" y="11" width="7" height="7" fill="#d81818"/></svg>'
  };
  // the More ports menu at the top right: this port and the others. The others' icons are inline: this page is
  // cross-origin isolated, so it can't show images from another site.
  const PORTS = [
    { name: 'Stunts HD', about: '1990 DOS racer, in your browser', icon: 'media/favicon.png' },
    { name: 'Virtua Fighter', about: '1993 arcade fighter, for Windows, Mac and Steam Deck', url: 'https://vf1-recomp.pages.dev/',
      icon: 'data:image/webp;base64,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' },
    { name: 'Virtua Fighter 2', about: '1994 arcade fighter, for Windows, Mac and Steam Deck', url: 'https://vf2-recomp.pages.dev/',
      icon: 'data:image/webp;base64,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' }
  ];
  const portRow = p => p.url
    ? `<li><a href="${p.url}"><img src="${p.icon}" alt="" width="40" height="40"><span><b>${p.name}</b>${p.about}</span></a></li>`
    : `<li><div class="prow"><img src="${p.icon}" alt="" width="40" height="40"><span><b>${p.name}</b>${p.about}</span></div></li>`;
  // a skyline behind the TV, drawn for this page in the menu's low-poly style: far peaks with snow, near hills
  const FAR = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="160" viewBox="0 0 1200 160"><path d="M0 160 L0 48 106 29 128 88 148 72 173 25 178 90 206 33 222 46 338 92 469 25 693 91 778 92 838 68 886 24 918 46 1069 23 1127 89 1200 48 L1200 160Z" fill="#16224a"/><path d="M106 29 L76 34 L109 33 L112 46Z" fill="#2c3d72"/><path d="M173 25 L166 38 L174 36 L174 43Z" fill="#2c3d72"/><path d="M206 33 L198 49 L208 46 L210 37Z" fill="#2c3d72"/><path d="M469 25 L432 44 L500 40 L532 43Z" fill="#2c3d72"/><path d="M886 24 L873 36 L890 34 L895 30Z" fill="#2c3d72"/><path d="M1069 23 L1027 29 L1077 28 L1085 41Z" fill="#2c3d72"/></svg>';
  const NEAR = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="160" viewBox="0 0 1200 160"><path d="M0 160 L0 115 241 107 271 121 325 126 400 106 414 122 623 105 661 123 888 110 1137 119 1200 115 L1200 160Z" fill="#0d1631"/></svg>';
  const svg = t => `url("data:image/svg+xml,${encodeURIComponent(t)}")`;
  const CSS = `
  #setup { --ground: #070a16; --line: #2a3150; --ink: #f1efe8; --muted: #a9adc2; --dim: #747a96; --yel: #fff721; --yel2: #fffa6b;
    --px: system-ui, -apple-system, "Segoe UI", sans-serif;
    position: fixed; inset: 0; z-index: 10; overflow: auto; overflow-x: hidden; cursor: auto; color: var(--ink); background: var(--ground);
    font: 17px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; color-scheme: dark; }
  #setup *, #setup *::before { box-sizing: border-box; }
  #setup .sky { position: fixed; inset: 0; pointer-events: none;
    background: radial-gradient(ellipse 80% 55% at 50% 34%, rgba(60,140,252,.17), transparent 70%), linear-gradient(#0a1230, var(--ground) 60%); }
  #setup main { position: relative; min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 24px 16px; }
  @keyframes su-rise { from { opacity: 0; transform: translateY(22px); } to { opacity: 1; transform: none; } }
  @keyframes su-fade { from { opacity: 0; } to { opacity: 1; } }

  /* the trailer playing, its corners rounded; hills drift past behind it */
  #setup .tv { position: relative; margin: clamp(18px, 4.5vh, 48px) 0; width: min(1000px, 100%, max(300px, (100vh - 540px) * 1.78, 30vw)); animation: su-rise .9s cubic-bezier(.2,.7,.3,1) .2s backwards; }
  #setup .tv { isolation: isolate; }
  #setup .hills { position: absolute; z-index: -1; left: 50%; top: 40%; width: 100vw; height: 160px; transform: translateX(-50%); pointer-events: none; opacity: .6;
    -webkit-mask-image: linear-gradient(90deg, transparent, #000 25%, #000 75%, transparent); mask-image: linear-gradient(90deg, transparent, #000 25%, #000 75%, transparent); }
  #setup .hills i { position: absolute; inset: 0; background-repeat: repeat-x; background-position: 0 100%; animation: su-pan 100s linear infinite; }
  #setup .hills .far { background-image: ${svg(FAR)}; opacity: .9; }
  #setup .hills .near { background-image: ${svg(NEAR)}; animation-duration: 50s; }
  #setup .hills::after { content: ""; position: absolute; left: 0; right: 0; top: 100%; height: 240px; background: linear-gradient(#0d1631, transparent); }
  @keyframes su-pan { to { background-position: -1200px 100%; } }
  #setup .set { position: relative; }
  #setup .scr { position: relative; aspect-ratio: 16 / 9; overflow: hidden; background: #000; border-radius: 14px; }
  #setup .scr video, #setup .scr img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  #setup #su-tvbtn { position: absolute; inset: 0; z-index: 2; border: 0; padding: 0; background: transparent; cursor: pointer; }
  #setup .idle { position: absolute; inset: 0; display: grid; place-items: center; font: 800 clamp(16px, 3vw, 28px) var(--px); color: var(--yel);
    background: #000; }
  #setup .drophint { position: absolute; inset: 0; display: none; place-items: center; z-index: 2; background: rgba(0,0,0,.78);
    border: clamp(8px, 1.6vw, 14px) solid; border-image: repeating-linear-gradient(-45deg, var(--yel) 0 14px, #111 14px 28px) 14;
    font: 700 clamp(15px, 2.6vw, 22px)/1.5 var(--px); color: #fff; }
  #setup.over .drophint { display: grid; }

  #setup h1 { position: relative; margin: 0; line-height: 0; animation: su-rise .7s cubic-bezier(.2,.7,.3,1) .1s backwards; }
  #setup h1 img { display: block; width: clamp(240px, 42vw, 460px); height: auto; filter: drop-shadow(3px 4px 0 rgba(0,0,0,.55)); }
  /* a little HD tucked under the logo's U, in the game's letters and the logo's yellow, as on the trailer's end frame
     (logo.webp is 1000x244: the notch under the U's right side, against the N's leg, at x 475, y 184; sized and placed
     by the logo's own width) */
  #setup h1 .hd { position: absolute; left: 47.5%; top: 75.4%; font: 900 italic calc(clamp(240px, 42vw, 460px) * .05)/1 var(--px);
    color: #f2f714; text-shadow: 3px 4px 0 rgba(0,0,0,.55); white-space: nowrap; }
  #setup .aka { margin: 8px 0 0; font-size: .74rem; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); animation: su-fade 1s ease .2s backwards; }
  #setup .ver { margin: 10px 0 0; font-size: .86rem; font-weight: 600; color: var(--ink); animation: su-fade 1s ease .3s backwards; }
  /* (in front of the hills behind the trailer: on a short screen, a phone's, they reached down past it, over the buttons) */
  #setup .cta { position: relative; z-index: 1; margin-top: 0; display: flex; gap: .7rem; justify-content: center; flex-wrap: wrap; animation: su-rise .7s cubic-bezier(.2,.7,.3,1) .5s backwards; }
  #setup .btn { display: inline-flex; align-items: center; gap: .6rem; cursor: pointer; border: 0; border-radius: 999px; padding: .8rem 1.5rem;
    font: 700 1.02rem system-ui, sans-serif; color: #111; background: var(--yel); text-decoration: none; transition: background .18s, box-shadow .18s; }
  #setup .btn .ico { width: 1.1em; height: 1.1em; flex: none; margin-left: -.2rem; }
  #setup .btn:hover { background: var(--yel2); }
  #setup .btn:focus-visible, #setup .lnk:focus-visible { outline: 2px solid var(--yel); outline-offset: 3px; }
  #setup .cta { flex-direction: column; align-items: center; }
  #setup .cta [hidden] { display: none; }
  /* the desktop app's downloads: beside the browser button, its platforms in a panel (GitHub's latest release) */
  /* two ways to play, side by side: here in the browser, or the app; each says which it is underneath */
  #setup .cta .row { display: flex; gap: 1rem; justify-content: center; align-items: flex-start; flex-wrap: wrap; }
  #setup .cta .way { display: flex; flex-direction: column; align-items: center; gap: .45rem; }
  #setup .cta .cap { font-size: .8rem; color: var(--muted); }
  #setup .cta .or { align-self: flex-start; line-height: 3.1rem; font-size: .86rem; color: var(--dim); }
  @media (max-width: 520px) { #setup .cta .row { flex-direction: column; align-items: center; gap: .5rem; } #setup .cta .or { line-height: 1.4; align-self: center; } }
  #setup .btn.alt { color: var(--ink); background: transparent; box-shadow: inset 0 0 0 2px var(--line); }
  #setup .btn.alt:hover, #setup .info.open .btn.alt { background: rgba(255,255,255,.06); box-shadow: inset 0 0 0 2px var(--yel); }
  #setup .cta .info .pop.dl { width: 290px; }
  #setup .pop.dl ul { padding: .9rem 0 0; }
  #setup .pop.dl li { padding: 0; }
  #setup .pop.dl li::before { display: none; }
  #setup .pop.dl li a { display: flex; align-items: center; gap: .6rem; padding: .45rem 0; color: var(--ink); text-decoration: none; border-bottom: 1px solid rgba(255,255,255,.06); }
  #setup .pop.dl li a:hover { color: var(--yel); }
  #setup .pop.dl li a small { margin-left: auto; color: var(--dim); }
  #setup .pop p a { color: var(--ink); text-underline-offset: 3px; text-decoration-color: var(--yel); }
  #setup .pop p a:hover { color: var(--yel); }
  #setup .pop.dl p a { color: var(--muted); }
  #setup .pop.dl li a .ico { width: 16px; height: 16px; flex: none; color: var(--yel); }
  #setup .cta .again { cursor: pointer; font-size: .82rem; color: var(--dim); text-decoration: underline; text-underline-offset: 3px; }
  #setup .cta .again:hover { color: var(--ink); }
  #setup .status { margin-top: .9rem; max-width: 36em; font-size: .92rem; color: var(--muted); }
  #setup .status:empty { display: none; }
  #setup .status .ok { color: #7fe39a; } #setup .status .bad { color: #ff8a7a; }
  #setup .status .btn { margin-top: .9rem; }

  #setup .more { position: relative; z-index: 3; margin-top: 1.5rem; display: flex; justify-content: center; flex-wrap: wrap; gap: .15rem 1rem;
    animation: su-rise .7s cubic-bezier(.2,.7,.3,1) .6s backwards; }
  #setup .info { position: relative; }
  #setup .info.open, #setup .info:hover { z-index: 5; }   /* (its panel over the links after it in the row: on a phone they showed through it) */
  #setup .info::before { content: ""; position: absolute; left: 0; right: 0; bottom: 100%; height: 12px; }
  #setup .lnk { display: inline-flex; align-items: center; gap: .45rem; padding: .3rem .35rem; border: 0; background: transparent; cursor: pointer;
    font: 600 .9rem system-ui, sans-serif; color: var(--muted); text-decoration: underline; text-decoration-color: var(--line);
    text-underline-offset: 4px; text-decoration-thickness: 1.5px; transition: color .18s, text-decoration-color .18s; }
  #setup .lnk .sg { width: 1.05em; height: 1.05em; flex: none; }
  #setup .lnk:hover, #setup .info.open .lnk { color: #fff; text-decoration-color: var(--yel); }
  /* Watch: the trailer with sound, from YouTube, over the page */
  #su-vid { position: fixed; inset: 0; z-index: 2147483000; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 16px;
    background: rgba(2,3,12,.88); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); cursor: pointer; }
  #su-vid .yt { position: relative; width: min(1700px, 100%, calc((100vh - 150px) * 16 / 9)); aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden;
    background: #000; box-shadow: 0 30px 80px rgba(0,0,0,.7); cursor: auto; }
  #su-vid iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  #su-vid .x { position: absolute; top: 14px; right: 16px; width: 36px; height: 36px; border-radius: 50%; border: 0; cursor: pointer;
    background: rgba(255,255,255,.1); color: #fff; font: 600 1.2rem/36px system-ui, sans-serif; }
  #su-vid .x:hover { background: rgba(255,255,255,.2); }
  #su-vid .ytlink { margin-top: 14px; font: 14px system-ui, sans-serif; color: rgba(255,255,255,.6); text-decoration: none; cursor: pointer; }
  #su-vid .ytlink:hover { color: #fff; }
  #setup .pop { position: absolute; bottom: calc(100% + 10px); left: 50%; width: min(380px, calc(100vw - 32px)); max-height: min(72vh, 560px);
    overflow-y: auto; overscroll-behavior: contain; padding: 0 0 1rem; text-align: left; background: #0e1226; border-radius: 4px;
    box-shadow: 0 24px 60px rgba(0,0,0,.7), inset 0 0 0 1px rgba(255,255,255,.08);
    opacity: 0; visibility: hidden; transform: translateX(-50%) translateY(6px); transition: opacity .18s, transform .18s, visibility .18s; }
  #setup .pop.wide { width: min(440px, calc(100vw - 32px)); }
  #setup .info.open .pop { opacity: 1; visibility: visible; transform: translateX(-50%); }
  @media (hover: hover) { #setup .info:hover .pop { opacity: 1; visibility: visible; transform: translateX(-50%); } }
  /* headings as the trailer's captions: white game-style letters in a black box, a yellow line under */
  #setup .pop h2 { margin: 0 0 .8rem; padding: .85rem 1.1rem .75rem; background: #000; font: 800 1.02rem/1.4 var(--px); color: #fff; }
  #setup .pop h3 { margin: 1rem 1.1rem .35rem; font: 800 .7rem var(--px); color: var(--yel); text-transform: uppercase; letter-spacing: .08em; }
  #setup .pop p, #setup .pop ul, #setup .pop ol, #setup .pop .keys { margin: 0 1.1rem; font-size: .86rem; line-height: 1.5; color: var(--muted); }
  #setup .pop p + p { margin-top: .5rem; }
  #setup .pop ul + p { margin-top: .9rem; }
  /* the desktop app's own front page: the logo and two steps, nothing else (no trailer, other ports, support or source
     links: About has those); Keys and About in a small line under them */
  #setup.app .aka, #setup.app .ver, #setup.app .tv, #setup.app .ports, #setup.app .cta, #setup.app .more .info:not(.keep), #setup.app .status:empty { display: none; }
  #setup.app main { padding-top: 9vh; }
  #setup.app h1 { margin-bottom: 34px; }
  #setup .steps { display: none; list-style: none; margin: 0 auto; padding: 0; max-width: 460px; text-align: left; }
  #setup.app .steps { display: block; }
  #setup .steps li { display: flex; align-items: center; gap: 16px; padding: 16px 0; border-top: 1px solid rgba(255,255,255,.08); }
  #setup .steps li:first-child { border-top: 0; }
  #setup .steps .n { flex: none; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font: 700 1rem/1 inherit; color: #070a16; background: var(--yel); }
  #setup .steps li.off .n { background: var(--dim); }
  #setup .steps li.done .n { background: #3ecf6a; font-size: 1.15rem; }   /* (your game is in: a tick for its number) */
  #setup .steps .pick { display: flex; flex-direction: column; gap: 8px; margin-left: auto; }
  #setup .steps .pick .btn { justify-content: center; }
  #setup .steps .t { flex: 1; min-width: 0; }
  #setup .steps .t b { display: block; color: var(--ink); font-size: 1rem; }
  #setup .steps .t small { display: block; margin-top: 3px; color: var(--muted); font-size: .8rem; line-height: 1.4; }
  #setup .steps .btn { flex: none; }
  #setup .steps li.off .btn { opacity: .35; pointer-events: none; }
  #setup .steps label { display: inline-flex; align-items: center; gap: .4rem; margin: 8px 14px 0 0; color: var(--muted); font-size: .8rem; cursor: pointer; }
  #setup .steps input[type=checkbox] { accent-color: var(--yel); width: 14px; height: 14px; }
  #setup.app .more { margin-top: 28px; }
  /* the changelog's older versions: a line each that opens */
  #setup .pop details { margin: .55rem 1.1rem 0; padding-top: .5rem; border-top: 1px solid rgba(255,255,255,.08); }
  #setup .pop details summary { cursor: pointer; list-style: none; font-size: .86rem; font-weight: 700; color: var(--ink); }
  #setup .pop details summary::-webkit-details-marker { display: none; }
  #setup .pop details summary::after { content: "+"; float: right; color: var(--muted); }
  #setup .pop details[open] summary::after { content: "−"; }
  #setup .pop details.closing summary::after { content: "+"; }
  #setup .pop details ul { margin: 0; padding-top: .4rem; overflow: hidden; }   /* (the next version's heading in the changelog, apart from the list above it) */
  #setup .pop b { color: var(--ink); }
  #setup .pop ul, #setup .pop ol { list-style: none; padding: 0; }
  #setup .pop li { position: relative; padding-left: 1rem; margin-top: .45rem; }
  #setup .pop li:first-child { margin-top: 0; }
  #setup .pop ul li::before { content: ""; position: absolute; left: 0; top: .55em; width: 6px; height: 6px; background: var(--yel); }
  #setup .pop ol { counter-reset: n; }
  #setup .pop ol li { padding-left: 1.4rem; counter-increment: n; }
  #setup .pop ol li::before { content: counter(n); position: absolute; left: 0; top: 0; font: 800 .8rem/calc(.86rem * 1.5) var(--px); color: var(--yel); }
  #setup .pop code { font: 500 .78rem ui-monospace, Menlo, monospace; color: var(--ink); background: #05070f; border-radius: 3px; padding: .05rem .35rem; }
  #setup .keys { display: grid; grid-template-columns: max-content 1fr; gap: .4rem .9rem; align-items: baseline; }
  #setup kbd { font: 700 .72rem ui-monospace, Menlo, monospace; background: #e9e4d6; color: #111; border-radius: 3px; padding: .05rem .4rem;
    box-shadow: 0 2px 0 #8c877a; white-space: nowrap; }
  #setup .note { max-width: 42em; margin-top: 1.4rem; font-size: .72rem; line-height: 1.55; color: var(--dim); text-wrap: pretty; animation: su-fade 1s ease 1s backwards; }
  #setup .note a { color: var(--muted); }
  #setup input[type=file] { display: none; }
  @media (max-width: 520px) { #setup { font-size: 16px; } #setup .lnk { font-size: .84rem; padding-inline: .15rem; } }

  /* More ports: a pill at the top right whose panel drops down, like the links' panels below */
  #setup .ports { position: absolute; top: 14px; right: 16px; z-index: 4; text-align: left; animation: su-fade 1s ease .4s backwards; }
  #setup .ports .lnk { padding: .4rem .75rem .4rem .6rem; border-radius: 999px; text-decoration: none; background: rgba(14,18,38,.65);
    box-shadow: inset 0 0 0 1px var(--line); }
  #setup .ports .lnk:hover, #setup .ports .info.open .lnk { box-shadow: inset 0 0 0 1px var(--yel); }
  #setup .ports .chev { width: .7em; height: .7em; flex: none; transition: transform .18s; }
  #setup .ports .info.open .chev { transform: rotate(180deg); }
  #setup .ports .info::before { bottom: auto; top: 100%; }
  #setup .ports .pop { top: calc(100% + 10px); bottom: auto; left: auto; right: 0; width: min(340px, calc(100vw - 32px)); padding: .45rem 0; transform: translateY(-6px); }
  #setup .ports .info.open .pop { transform: none; }
  @media (hover: hover) { #setup .ports .info:hover .pop { transform: none; } #setup .ports .info:hover .chev { transform: rotate(180deg); } }
  /* a phone: the links' panels as on the VF1 page, across the screen 16px in from each side and centred top to bottom
     (above its link, a panel off to one side ran off the screen's edge); the More ports menu still drops from its corner */
  @media (max-width: 640px) {
    #setup .more .pop, #setup .more .pop.wide { position: fixed; left: 16px; right: 16px; width: auto; top: 50%; bottom: auto; max-height: 80vh; transform: translateY(calc(-50% + 6px)); }
    #setup .more .info.open .pop { transform: translateY(-50%); }
    /* (with a mouse too, only a click opens one: a panel opened by hovering covered the links, and took the click) */
    #setup .more .info:not(.open):hover .pop { opacity: 0; visibility: hidden; }
  }
  #setup .pop .plist { margin: 0; }
  #setup .pop .plist li { padding: 0; margin: 0; }
  #setup .pop .plist li::before { display: none; }
  #setup .plist a, #setup .plist .prow { display: flex; align-items: center; gap: .8rem; padding: .55rem 1.1rem; color: var(--muted);
    text-decoration: none; font-size: .84rem; line-height: 1.35; }
  #setup .plist a:hover, #setup .plist a:focus-visible { background: rgba(255,255,255,.06); outline: none; }
  #setup .plist img { width: 40px; height: 40px; flex: none; border-radius: 9px; }
  #setup .plist b { display: block; font-size: .95rem; }
  @media (max-width: 520px) { #setup main { padding-top: 64px; } }
`;
  const HTML = `
  <div class="sky"></div>
  <main>
    <nav class="ports" aria-label="More ports"><span class="info"><button class="lnk" aria-expanded="false">${SIGN.all}More ports<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="pop">
        <ul class="plist">${PORTS.map(portRow).join('')}</ul>
      </div></span></nav>
    <h1><img src="logo.webp" alt="STUNTS HD" width="1000" height="245"><span class="hd" aria-hidden="true">HD</span></h1>
    <p class="aka">Also known as 4D Sports Driving</p>
    <p class="ver">The 1990 original, recompiled in <b style="color: var(--yel)">HD widescreen</b>: play in your browser or on desktop</p>
    <div class="tv">
      <div class="hills"><i class="far"></i><i class="near"></i></div>
      <div class="set">
        <div class="scr" id="su-scr">
          <div class="idle">STUNTS HD</div>
          <video id="su-tv" poster="media/poster.jpg" muted loop playsinline autoplay preload="auto"></video><button id="su-tvbtn" aria-label="Watch the trailer with sound"></button>
          <div class="drophint">DROP YOUR<br>STUNTS.ZIP</div>
        </div>
      </div>
    </div>
    <div class="cta">
      <div class="row">
      <div class="way">
      <label class="btn" for="su-file"><svg class="ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5v13l10.5-6.5z" fill="currentColor"/></svg>Play in your browser</label>
      <button class="btn" id="su-start" hidden><svg class="ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5v13l10.5-6.5z" fill="currentColor"/></svg>Start game</button>
        <small class="cap">Pick your Stunts zip: it stays on your computer</small>
      <label class="again" for="su-file" hidden>or use a different copy</label>
      </div>
      <span class="or">or</span>
      <div class="way">
      <span class="info"><button class="btn alt" aria-expanded="false"><svg class="ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M3 13v3.5h14V13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Download for desktop</button>
        <div class="pop dl"><h2>Desktop app</h2><ul><li><a href="https://github.com/mr-finster/stunts-hd/releases/latest/download/Stunts-HD-mac-universal.zip"><svg class="ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M3 13v3.5h14V13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>macOS <small>Apple Silicon and Intel</small></a></li><li><a href="https://github.com/mr-finster/stunts-hd/releases/latest/download/Stunts-HD-win-x64.zip"><svg class="ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M3 13v3.5h14V13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Windows <small>x64</small></a></li><li><a href="https://github.com/mr-finster/stunts-hd/releases/latest/download/Stunts-HD-win-arm64.zip"><svg class="ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M3 13v3.5h14V13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Windows <small>ARM</small></a></li><li><a href="https://github.com/mr-finster/stunts-hd/releases/latest/download/Stunts-HD-linux-x86_64.AppImage"><svg class="ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M3 13v3.5h14V13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Linux <small>x64 AppImage</small></a></li><li><a href="https://github.com/mr-finster/stunts-hd/releases/latest/download/Stunts-HD-linux-arm64.AppImage"><svg class="ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M3 13v3.5h14V13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Linux <small>ARM AppImage</small></a></li></ul><p style="margin-top:.7rem"><small>Needs your own Stunts 1.1, as here. <a href="https://github.com/mr-finster/stunts-hd/releases/latest" target="_blank" rel="noopener">Release notes</a></small></p></div></span>
        <small class="cap">App for macOS, Windows and Linux</small>
      </div>
      </div>
      <button class="btn" id="su-open" hidden><svg class="ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5v10h15v-8H9.5l-2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>Open your Stunts folder</button>
    </div>
    <input type="file" id="su-file" accept=".zip,application/zip,application/x-zip-compressed,application/x-zip,application/octet-stream" multiple>
    <div class="status" id="su-status"></div>
    <ol class="steps" id="su-steps">
      <li><span class="n">1</span><span class="t"><b>Open your Stunts folder or zip</b><small>Your copy of Stunts 1.1. It's read here, never uploaded.</small></span><span class="pick"></span></li>
      <li class="off"><span class="n">2</span><span class="t"><b>Play</b><small id="su-mine">Once your game is in.</small>
        <label><input type="checkbox" id="su-full">Fullscreen</label><label><input type="checkbox" id="su-skip">Skip this screen next time</label></span></li>
    </ol>

    <nav class="more" aria-label="More about it">
      <span class="info"><a class="lnk" id="su-watch" href="https://youtu.be/WifwNFpG96o" target="_blank" rel="noopener">${SIGN.play}Watch</a></span>
      <span class="info"><button class="lnk" aria-expanded="false">${SIGN.car}Features</button>
        <div class="pop">
          <h2>What's new</h2>
          <ul>
            <li><b>The game's own code,</b> recompiled from your copy in this browser: the same physics, cars and opponents.</li>
            <li><b>HD 3D in widescreen,</b> smooth at any refresh rate.</li>
            <li><b>OG mode:</b> press <kbd>H</kbd> for the 1990 look, at any time.</li>
            <li><b>Locked chase cam,</b> now the default.</li>
            <li><b>Cars in HD 3D,</b> crumpling when they crash, and 3D explosions.</li>
            <li><b>Unlimited draw distance,</b> car shadows, tyre marks, water reflections and ripples.</li>
            <li><b>Ghost car:</b> race your best lap, kept for every track.</li>
            <li><b>Share tracks:</b> Import/Export in the track menu, as a short code or a <code>.TRK</code> file.</li>
            <li><b>3D track preview:</b> drag to turn it, scroll to zoom.</li>
            <li><b>Instant restart</b> with <kbd>R</kbd>, and your camera kept from race to race.</li>
            <li><b>A cleaner HUD</b> with the track's record, and the original AdLib music and sound.</li>
            <li><b>Your own tracks:</b> drop <code>.TRK</code> files on the game at any time.</li>
            <li><b>Your own cars:</b> add-on cars in your zip show up in the car select.</li>
            <li><b>Keyboard or gamepad.</b></li>
          </ul>
          <h3>ORIGINAL GAME FIXES</h3>
          <ul>
            <li><b>Tunnel roofs</b> show from outside too; the original drew them only from inside.</li>
            <li><b>No demo</b> starting by itself while you sit in the menus.</li>
          </ul>
        </div></span>
      <span class="info"><button class="lnk" aria-expanded="false">${SIGN.track}How to play</button>
        <div class="pop">
          <h2>You need</h2>
          <ol>
            <li>Find your Stunts folder: the one with <code>STUNTS.EXE</code>, <code>GAME1.P3S</code>, <code>MAIN.RES</code> and friends (Stunts 1.1).</li>
            <li><b>Which copy?</b> Stunts 1.1: its <code>MCGA.COD</code> is ${COD_11.toLocaleString('en')} bytes, dated 13 March 1991. 4D Sports Driving (the European release) and other versions don't run yet.</li>
            <li><b>New to Stunts?</b> You need your own copy of Stunts 1.1. To learn more about the game and its community, visit <a href="https://zak.stunts.hu/" target="_blank" rel="noopener">ZakStunts</a> or the <a href="https://wiki.stunts.hu/" target="_blank" rel="noopener">Stunts Wiki</a>.</li>
            <li>Already have it as a zip? Use that as it is. If not, zip the whole folder. Any layout works: files in subfolders, or loose at the top.</li>
            <li><b>Your tracks too:</b> any <code>.TRK</code> tracks (and <code>.RPL</code> replays) in the zip show up in the game's track menu.</li>
          </ol>
          <h3>STAYS ON YOUR COMPUTER</h3>
          <p>Your files are read here and kept in this browser for next time, never sent anywhere. Tracks you build and replays you save are kept here too.</p>
        </div></span>
      <span class="info"><button class="lnk" aria-expanded="false">${SIGN.opt}Keys</button>
        <div class="pop wide">
          <h2>Keys</h2>
          <div class="keys">
            <span><kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd></span><span>Accelerate, brake, steer</span>
            <span><kbd>A</kbd> <kbd>Z</kbd></span><span>Gear up, down (manual gearbox)</span>
            <span><kbd>C</kbd></span><span>Change camera: in car, high, chase, TV</span>
            <span><kbd>H</kbd></span><span>HD mode or OG mode</span>
            <span><kbd>G</kbd></span><span>Ghost car on and off (once you have a best lap)</span>
            <span><kbd>D</kbd></span><span>Dashboard on and off</span>
            <span><kbd>R</kbd></span><span>Restart the race</span>
            <span><kbd>Q</kbd> (hold)</span><span>Rewind the race</span>
            <span><kbd>Esc</kbd></span><span>Race menu: replays, restart, quit</span>
            <span><kbd>F</kbd></span><span>Fullscreen</span>
            <span><kbd>F10</kbd></span><span>Screenshot (PNG at your display's resolution)</span>
            <span><kbd>^</kbd> / <kbd>&#96;</kbd></span><span>How it runs: frames a second, slowest frame (the key left of 1)</span>
          </div>
          <p style="margin-top:.7rem">Gamepad: stick or d-pad to steer, triggers to drive.</p>
        </div></span>
      <span class="info"><button class="lnk" aria-expanded="false">${SIGN.opp}Known issues</button>
        <div class="pop">
          <h2>Known issues</h2>
          <ul>
            <li><b>Only Stunts 1.1</b> runs: other versions are turned away for now.</li>
          </ul>
        </div></span>
      <span class="info"><button class="lnk" aria-expanded="false">${SIGN.log}Changelog</button>
        <div class="pop">
          <h2>Changelog</h2>
          <p><b>v1.5.14</b> &middot; Oct 18 2026</p>
          <ul>
            <li>Rewind: hold Q to take the race back a second at a time. A rewound race counts as "continued", as in the original: its time goes in no high score table.</li>
            <li>F10 saves a screenshot at your display's resolution; the key left of 1 shows how smoothly it runs (thanks, brummilab!).</li>
            <li>On a phone, the hills no longer cover the Play button; other versions of the game are named when picked (thanks, brummilab!).</li>
          </ul>
          <details><summary>v1.5.13 &middot; Oct 18 2026</summary><ul>
            <li>Track editor: the mouse pointer keeps up with the mouse, instead of trailing it in small steps (thanks, brummilab!).</li>
          </ul></details>
          <details><summary>v1.5.12 &middot; Oct 17 2026</summary><ul>
            <li>Replays: the mouse works while the replay plays, so its buttons no longer need a pause first (thanks, brummilab!).</li>
            <li>Desktop app: F and Alt+Enter switch the window in and out of fullscreen (thanks, brummilab!).</li>
          </ul></details>
          <details><summary>v1.5.11 &middot; Oct 17 2026</summary><ul>
            <li>The mouse pointer no longer flickers in the menus and the track editor (thanks, brummilab!).</li>
          </ul></details>
          <details><summary>v1.5.10 &middot; Oct 15 2026</summary><ul>
            <li>Checked against all 6,907 replays in Chocolate Stunts' test pack: every one plays back exactly as in DOS.</li>
            <li>OG mode: the in-car dashboard's edge is drawn exactly as the original draws it, without a stray line of pixels.</li>
          </ul></details>
          <details><summary>v1.5.9 &middot; Oct 15 2026</summary><ul>
            <li>Replays recorded in DOS play back as recorded again: one stopped with "divide by zero", and the bump-bug fix sent others off course, so it's off for now.</li>
          </ul></details>
          <details><summary>v1.5.8 &middot; Oct 14 2026</summary><ul>
            <li>Widescreen in-car view: the dashboard wraps round the sides on a smooth, gentle curve, without its gauges copied out, and goes with the picture when you leave a race.</li>
            <li>Dashboard on or off (<kbd>D</kbd>) is remembered from race to race.</li>
            <li>Drowning fills the whole screen again, and no more seeing through the Acura's side intake.</li>
          </ul></details>
          <details><summary>v1.5.6 &middot; Oct 13 2026</summary><ul>
            <li>OG mode: the picture's black side bars are back where they belong.</li>
          </ul></details>
          <details><summary>v1.5.5 &middot; Oct 13 2026</summary><ul>
            <li>In-car view: no tyre marks in front of the camera, and drowning fills the whole screen.</li>
          </ul></details>
          <details><summary>v1.5.4 &middot; Oct 13 2026</summary><ul>
            <li>Clouds no longer multiply after restarts and camera changes, or drift in the in-car view.</li>
            <li>In-car view: banked corners and the road under the car no longer drop out of view.</li>
          </ul></details>
          <details><summary>v1.5.3 &middot; Oct 12 2026</summary><ul>
            <li>Racing the same track again after picking another car no longer shows a black scene with giant polygons.</li>
            <li>Car windows flush with the body, with nothing of the car's inside showing round them.</li>
            <li>Add-on cars (ZakStunts pack): grilles and rear panels as the original drew them.</li>
            <li>Tyre marks one even shade.</li>
          </ul></details>
          <details><summary>v1.5.2 &middot; Oct 11 2026</summary><ul>
            <li>More Tracks no longer crashes with a big track pack (over 127 tracks), and long track names from packs open.</li>
            <li>Tyre marks only from the wheels on the grass, and no longer showing through things.</li>
            <li>Paused or in a replay, the 3D view fills the screen round the panel.</li>
            <li>Car windows look like glass, sized to their frames; no flash of the settings line leaving a race; no stutter the first time things appear.</li>
          </ul></details>
          <details><summary>v1.5.1 &middot; Oct 11 2026</summary><ul>
            <li>Desktop app: pick your game as a folder or a zip (on Windows and Linux the one dialog only showed folders).</li>
            <li>A tick once your game is in; fullscreen and skip-this-screen on to start with.</li>
            <li>A Quit button, and quitting the game to DOS closes the app (it started the game again).</li>
          </ul></details>
          <details><summary>v1.5 &middot; Oct 11 2026</summary><ul>
            <li>Download for desktop: a button beside Play in your browser, for macOS, Windows and Linux.</li>
            <li>The desktop app has its own simple front page: open your Stunts folder, then play. It can go fullscreen and skip that page next time.</li>
          </ul></details>
          <details><summary>v1.4.1 &middot; Oct 11 2026</summary><ul>
            <li>Desktop app: one Mac download that runs at full speed on Apple Silicon and Intel (the Intel-only one crawled on Apple Silicon Macs).</li>
            <li>The app has its own icon on every system.</li>
          </ul></details>
          <details><summary>v1.4 &middot; Oct 11 2026</summary><ul>
            <li>A desktop app for macOS, Windows and Linux, on GitHub: open your Stunts folder or zip and play, no browser needed.</li>
          </ul></details>
          <details><summary>v1.3 &middot; Oct 11 2026</summary><ul>
            <li>Big add-on cars (like the DAF Siluro) no longer stop the game when the race loads: it now has as much memory as in DOSBox.</li>
            <li>If the game ever does stop, the welcome page says why.</li>
          </ul></details>
          <details><summary>v1.2 &middot; Oct 11 2026</summary><ul>
            <li>Pressing a key during the intro no longer freezes the game on a black screen.</li>
            <li>Extra cars in your copy work: no more endless "Please check disk" when you pick one.</li>
          </ul></details>
          <details><summary>v1.1 &middot; Oct 10 2026</summary><ul>
            <li>Hills are shaded by the sun, roads up them too, and the cracks between hill pieces are gone.</li>
            <li>No more sky showing through gaps under roofs (the barn and friends).</li>
            <li>Widescreen goes as wide as your screen, even 32:9.</li>
            <li>Smoother shadows: loops, bridges and ramps, and trees on traffic islands now cast them.</li>
            <li>The flickery dissolve between menu screens is gone in HD mode.</li>
            <li>An update going live no longer breaks a game you're starting.</li>
            <li>The source is on GitHub.</li>
          </ul></details>
          <details><summary>v1.0 &middot; Oct 9 2026</summary><ul>
            <li>First release.</li>
          </ul></details>
        </div></span>
      <span class="info"><a class="lnk" href="https://github.com/mr-finster/stunts-hd" target="_blank" rel="noopener">${SIGN.src}GitHub</a></span>
      <span class="info"><a class="lnk" id="su-support" href="https://buymeacoffee.com/mrfinster" target="_blank" rel="noopener">${SIGN.sup}Support me</a></span>
    </nav>

    <p class="note">A fan-made recompilation of Stunts (Distinctive Software, 1990): the game's own code is translated ${root.stuntsHost ? 'on your computer' : 'in your browser'} from the copy you bring, and the PC around it is rebuilt. No game files are included: you need your own copy. Stunts © 1990 Distinctive Software / Broderbund. Not affiliated with or endorsed by them. Made with the help of AI coding tools.</p>
  </main>
`;

  function show(onReady, note, check, ready) {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const el = document.createElement('div'); el.id = 'setup'; el.innerHTML = HTML; document.body.appendChild(el);
    const status = el.querySelector('#su-status'), input = el.querySelector('#su-file'), tv = el.querySelector('#su-tv');
    tv.onerror = () => tv.remove();   // (no trailer next to the page: the title shows)
    // the trailer fetched whole and played from memory: the host answers no byte ranges, and without them the
    // player can't skip back or forward
    let tvUrl = '';
    if (!root.stuntsHost) fetch('media/trailer.mp4').then(r => r.ok ? r.blob() : Promise.reject())
      .then(b => { if (!tv.isConnected) return; tv.src = tvUrl = URL.createObjectURL(b); tv.play().catch(() => {}); }).catch(() => tv.remove());
    const say = h => { status.innerHTML = h; try { status.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {} };   // (the answer in view: on a short window it fell below the fold)
    if (note) say(note);
    // the game stopped itself last time (see worker.js): why, instead of just the welcome page again
    { let why = null; try { why = sessionStorage.getItem('stunts-stopped'); sessionStorage.removeItem('stunts-stopped'); } catch (_) {}
      if (why) say(`<span class="bad">The game stopped: ${why.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])}.</span> An add-on car or track in your copy may be too big for it: try another.`); }
    let latest = 0;
    // a good set in (from a zip just now, or kept from last time): the big button starts the game; the welcome screen
    // stays up till then (its links, Support me), and a small link loads a different copy
    const start = el.querySelector('#su-start'), up = el.querySelector('.cta label.btn'), again = el.querySelector('.cta .again');
    // (in the desktop app: the system's own dialog for your Stunts folder or zip, in place of the browser button)
    const open = el.querySelector('#su-open'), host = root.stuntsHost;
    const pickBy = kind => async () => { const list = await host.pickGame(kind); if (list) take(list.map(f => new File([f.data], f.name))); };
    if (host) { open.hidden = false; up.hidden = true; open.onclick = pickBy('folder'); again.onclick = e => { e.preventDefault(); open.onclick(); }; }
    // the desktop app's own front page (see the CSS): your game in a line, its two options (kept in this app's storage:
    // index.html reads them at the next start), About with the links the page leaves out, and its own wording
    if (host) {
      el.classList.add('app');
      tv.pause(); tv.removeAttribute('src');
      const li = el.querySelectorAll('#su-steps li');
      // (step 1: a folder or a zip, a button each: Windows' and Linux's dialogs pick one kind or the other)
      const zip = open.cloneNode(true); zip.id = 'su-zip'; zip.classList.add('alt'); zip.onclick = pickBy('zip');
      zip.innerHTML = zip.innerHTML.replace(/<path[^>]*>/, '<path d="M5 2.5h7l3.5 3.5v11.5H5zM9 4.5h2M9 7h2M9 9.5h2M8.5 12h3v3h-3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>');
      li[0].querySelector('.pick').append(open, zip); li[1].appendChild(start); start.hidden = false;
      open.lastChild.textContent = 'Folder'; zip.lastChild.textContent = 'Zip';
      for (const i of el.querySelectorAll('.more .info')) if (/Keys/.test(i.firstElementChild.textContent)) i.classList.add('keep');
      for (const k of ['full', 'skip']) {
        const box = el.querySelector('#su-' + k);
        box.checked = true; try { box.checked = localStorage.getItem('stunts-app-' + k) !== '0'; } catch (_) {}   // (both on unless turned off)
        box.onchange = () => { try { localStorage.setItem('stunts-app-' + k, box.checked ? '1' : '0'); } catch (_) {} };
      }
      el.querySelector('#su-skip').parentElement.title = 'Ctrl+Shift+H (the Welcome Screen item in the Game menu) brings this screen back';
      const ab = document.createElement('span'); ab.className = 'info keep';
      ab.innerHTML = `<button class="lnk" aria-expanded="false">${SIGN.log}About</button><div class="pop"><h2>About</h2>`
        + '<p><b>Stunts HD <span id="su-version"></span></b>: Stunts / 4D Sports Driving (1990), recompiled and redrawn in HD. Your own copy of the game is needed: none of it is included.</p>'
        + '<p>Open source (MIT): <a href="https://github.com/mr-finster/stunts-hd" target="_blank" rel="noopener">github.com/mr-finster/stunts-hd</a><br>Play in the browser: <a href="https://stunts-recomp.pages.dev/" target="_blank" rel="noopener">stunts-recomp.pages.dev</a><br>Like it? <a href="https://buymeacoffee.com/mrfinster" target="_blank" rel="noopener">Buy me a coffee</a></p>'
        + '<p>Built on the Restunts project\'s reverse engineering. three.js (MIT). Made with the help of AI coding tools.</p></div>';
      el.querySelector('nav.more').appendChild(ab);
      const qt = document.createElement('span'); qt.className = 'info keep'; qt.innerHTML = `<button class="lnk">${SIGN.quit}Quit</button>`;
      qt.firstChild.onclick = () => host.quit(); el.querySelector('nav.more').appendChild(qt);
      host.version().then(v => { const e = el.querySelector('#su-version'); if (e) e.textContent = v; }).catch(() => {});
    }
    // (your copy in a line: its tracks, and the cars it adds to the game's eleven)
    const STOCK = new Set(['ANSX', 'AUDI', 'COUN', 'FGTO', 'JAGU', 'LANC', 'LM02', 'P962', 'PC04', 'PMIN', 'VETT']);
    const mine = files => {
      const n = Object.keys(files), tracks = n.filter(k => k.endsWith('.TRK')).length, cars = n.filter(k => /^CAR(.{4})\.RES$/.test(k) && !STOCK.has(k.slice(3, 7))).length;
      return `Your game: Stunts 1.1 &middot; ${tracks} track${tracks === 1 ? '' : 's'}${cars ? ` &middot; ${cars} add-on car${cars === 1 ? '' : 's'}` : ''}`;
    };
    const armed = files => {
      up.hidden = true; open.hidden = true; start.hidden = false; again.hidden = false;
      el.classList.add('armed'); el.querySelector('#su-mine').innerHTML = mine(files);
      if (host) { start.innerHTML = start.innerHTML.replace('Start game', 'Play'); open.hidden = false; again.hidden = true; const li = el.querySelectorAll('#su-steps li'); li[1].classList.remove('off'); li[0].classList.add('done'); li[0].querySelector('.n').textContent = '\u2713'; }
      start.onclick = () => { if (host) { let f = true; try { f = localStorage.getItem('stunts-app-full') !== '0'; } catch (_) {} if (f) host.fullscreen(true); } if (closeWatch) closeWatch(); tv.pause(); if (tvUrl) URL.revokeObjectURL(tvUrl); el.remove(); st.remove(); onReady(files); };
    };
    if (ready) armed(ready);
    // (a hint at which copy it was, when the program is not the one this page knows: 4D Sports Driving, the game's
    // European release, has a different program; the size of MCGA.COD tells the versions apart)
    const which = files => {
      const cod = files['MCGA.COD'], size = cod ? cod.length : 0, n = collect.names || [];
      if (OTHER[size]) return `<br><small>This is <b>${OTHER[size]}</b>: only Stunts 1.1 runs here for now.</small>`;
      const eu = n.some(k => k.endsWith('.D4D') || /4D[ _-]?SPORTS/.test(k));
      // (the size only when it tells: the same size as 1.1's means a changed copy, and a GAME.EXE alone has none)
      const sz = size && size !== COD_11 ? `: its <code>MCGA.COD</code> is ${COD_11.toLocaleString('en')} bytes, yours is ${size.toLocaleString('en')}` : size ? ': this one looks like it but has been changed' : '';
      return `<br><small>${eu ? 'This looks like <b>4D Sports Driving</b>, the European release: its program is different and does not run here yet. ' : ''}`
        + `You need an original <b>Stunts 1.1</b>${sz}.</small>`;
    };
    async function take(list) {
      if (!list || !list.length) return;
      const me = ++latest;
      say('Reading…');
      let files;
      try { files = await collect([...list]); } catch (err) { if (me === latest) say(`<span class="bad">${/Offset|bounds/.test(err.message) ? 'This zip could not be read (it may be a zip64 or damaged file): try making it again.' : err.message || err}</span>`); return; }
      if (me !== latest) return;   // (a newer pick or drop since)
      const names = Object.keys(files), miss = missing(files);
      const tracks = names.filter(n => n.endsWith('.TRK')).length, replays = names.filter(n => n.endsWith('.RPL')).length;
      // (another release named first: Stunts 1.0 has other file names, and the list of what's missing told nothing)
      if (files['MCGA.COD'] && OTHER[files['MCGA.COD'].length]) { say(`<span class="bad">This copy is another version of the game.</span>${which(files)}`); return; }
      if (miss.length) {
        say(`<span class="bad">That doesn't look like the whole game: missing ${miss.slice(0, 6).join(', ')}${miss.length > 6 ? ` and ${miss.length - 6} more` : ''}.</span> Zip the full Stunts 1.1 folder and try again.</span>${collect.names && collect.names.some(k => k.endsWith('.D4D') || /4D[ _-]?SPORTS/.test(k)) ? which(files) : ''}`);
        return;
      }
      if (check) {
        say('Building the game from your copy…');
        try { await check(files); } catch (err) { if (me === latest) say(`<span class="bad">${err.message || err}</span>${which(files)}`); return; }
        if (me !== latest) return;
      }
      try { await store(files); } catch (_) {}
      say(`<span class="ok">✓ Found the game: ${names.length} files, ${tracks} track${tracks === 1 ? '' : 's'}${replays ? `, ${replays} replay${replays === 1 ? '' : 's'}` : ''}.</span>`);
      armed(files); start.focus();
      if (host) say('');   // (the app says it in its own line: your game, under the button)
    }
    input.onchange = async () => { await take(input.files); input.value = ''; };
    // a drop anywhere on the page (the TV says where)
    let depth = 0;
    el.addEventListener('dragenter', e => { e.preventDefault(); if (depth++ === 0) el.classList.add('over'); });
    el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('over'); } });
    el.addEventListener('dragover', e => e.preventDefault());
    el.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); depth = 0; el.classList.remove('over'); take(e.dataTransfer.files); });
    // the links' panels: open on hover (where there is one) or a click, one at a time
    const infos = [...el.querySelectorAll('.info')];
    const shut = keep => infos.forEach(i => { if (i !== keep) { i.classList.remove('open'); i.firstElementChild.setAttribute('aria-expanded', 'false'); } });
    for (const i of infos) i.firstElementChild.onclick = e => {
      e.stopPropagation(); const o = !i.classList.contains('open'); shut(i);
      i.classList.toggle('open', o); i.firstElementChild.setAttribute('aria-expanded', String(o));
    };
    el.addEventListener('click', e => { if (!e.target.closest('.pop')) shut(); });
    el.addEventListener('keydown', e => { if (e.key === 'Escape') shut(); });
    // Watch: the trailer with sound, from YouTube, over the page, the TV paused meanwhile (a credentialless iframe, as Support
    // me's below; where there's none, the link itself opens YouTube in a tab of its own)
    let closeWatch = null;
    el.querySelector('#su-watch').addEventListener('click', e => {
      shut();   // (a link, not a panel: not left highlighted)
      if (!('credentialless' in HTMLIFrameElement.prototype)) return;
      e.preventDefault();
      if (document.getElementById('su-vid')) return;
      const back = document.createElement('div'); back.id = 'su-vid';
      back.innerHTML = '<div class="yt"></div><a class="ytlink" href="https://youtu.be/WifwNFpG96o" target="_blank" rel="noopener">Watch on YouTube &#8599;</a><button class="x" aria-label="Close">&times;</button>';
      const f = document.createElement('iframe');
      f.credentialless = true;                                // (before its src)
      f.title = 'Stunts HD trailer'; f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; f.allowFullscreen = true;
      f.src = 'https://www.youtube-nocookie.com/embed/WifwNFpG96o?autoplay=1&rel=0&playsinline=1';
      back.firstChild.append(f);
      const playing = !tv.paused; tv.pause();
      const close = closeWatch = () => { closeWatch = null; back.remove(); removeEventListener('keydown', esc); if (playing && tv.isConnected) tv.play().catch(() => {}); };
      const esc = ev => { if (ev.key === 'Escape') close(); };
      back.addEventListener('click', ev => { if (ev.target === back || ev.target.closest('.x')) close(); });
      addEventListener('keydown', esc);
      document.body.append(back);
    });
    el.querySelector('#su-tvbtn').addEventListener('click', e => { e.stopPropagation(); el.querySelector('#su-watch').click(); });
    // Support me: Buy Me a Coffee's support panel, as on the VF1 page. This page is cross-origin isolated (the
    // game's memory is shared with its worker), so BMC's own widget can't embed its page here, but a credentialless iframe
    // can (Chrome, Edge). Where there's none (Safari, Firefox) the panel opens in a small window of its own.
    const BMC = 'https://www.buymeacoffee.com/widget/page/mrfinster?description=' + encodeURIComponent('Support me on Buy me a coffee!') +
      '&color=' + encodeURIComponent('#BD5FFF');
    // the changelog's older versions open and close with a quick slide (as on the VF1 page)
    el.querySelectorAll('.pop details').forEach(d => {
      const body = d.querySelector('ul');
      let anim = null;
      d.querySelector('summary').addEventListener('click', e => {
        e.preventDefault();
        const opening = !d.open || d.classList.contains('closing'), from = d.open ? body.getBoundingClientRect().height : 0;
        if (anim) anim.cancel();
        d.open = true; d.classList.toggle('closing', !opening);
        anim = body.animate({ height: [from + 'px', (opening ? body.scrollHeight : 0) + 'px'], opacity: [from ? 1 : 0, opening ? 1 : 0] }, { duration: 240, easing: 'cubic-bezier(.2,.7,.2,1)' });
        anim.onfinish = () => { anim = null; if (!opening) { d.open = false; d.classList.remove('closing'); } };
      });
    });
    const sup = el.querySelector('#su-support');
    sup.addEventListener('click', e => {
      e.preventDefault();
      if (!('credentialless' in HTMLIFrameElement.prototype)) {
        const w = 420, h = Math.min(760, screen.availHeight - 60);
        window.open(BMC, 'bmc', `popup,width=${w},height=${h},left=${(screen.availLeft || 0) + screen.availWidth - w - 24},top=${(screen.availTop || 0) + 24}`);
        return;
      }
      if (document.getElementById('su-bmc')) return;
      const wide = matchMedia('(min-width: 480px)').matches;   // BMC's widget: a panel at the right, or the whole phone screen
      const back = document.createElement('div');
      back.id = 'su-bmc';
      back.style.cssText = 'position:fixed;inset:0;z-index:2147483000;cursor:pointer';
      const f = document.createElement('iframe');
      f.credentialless = true;                                // before its src: without it the page is blocked here
      f.title = 'Buy Me a Coffee';
      f.allow = 'payment *';
      f.style.cssText = 'position:fixed;border:0;background:#fff;cursor:auto;' + (wide
        ? `right:18px;bottom:90px;width:420px;max-width:100vw;height:${innerHeight - 120}px;border-radius:10px;box-shadow:-6px 0 30px rgba(13,12,34,.1)`
        : 'inset:0;width:100%;height:100%');
      f.src = BMC;
      back.append(f);
      const close = () => { back.remove(); removeEventListener('keydown', esc); };
      const esc = ev => { if (ev.key === 'Escape') close(); };
      back.addEventListener('click', ev => { if (ev.target === back) close(); });
      if (!wide) {
        const x = document.createElement('button');
        x.setAttribute('aria-label', 'Close');
        x.innerHTML = '<svg width="16" height="16" viewBox="0 0 28 28"><path d="M2.45 27.65L.35 25.55 11.9 14 .35 2.45 2.45.35 14 11.9 25.55.35 27.65 2.45 16.1 14 27.65 25.55 25.55 27.65 14 16.1z" fill="#666"/></svg>';
        x.style.cssText = 'position:fixed;top:16px;right:16px;width:40px;height:40px;border:0;border-radius:100px;background:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer';
        x.onclick = close;
        back.append(x);
      }
      document.body.append(back);
      addEventListener('keydown', esc);
    });
  }
  root.StuntsSetup = { load, store, forget, show, collect, complete: files => !missing(files).length };
})(self);
