// Worker side of the high-resolution view. A "3D frame" is either update_frame (the race) or, in menus such
// as the car select, any run of transformed_shape_op calls followed by get_a_poly_info. During a frame:
//  - transformed_shape_op runs as normal; afterwards its final rotation matrix (var_mat2) and
//    camera-space translation (var_vec) are read from its stack frame and recorded with the shape;
//  - skybox_op runs as normal; the sky and horizon it drew are copied into the background layer and the
//    3D window is then filled with KEY, which the page shows as see-through;
//  - get_a_poly_info does not rasterise (the page draws those polygons), it only resets the list.
// Everything drawn afterwards (explosions, cracks, clock, messages, dashboard) stays original pixels.
'use strict';
(function (root) {
  const KEY = 233;            // palette index no bitmap in the game uses
  const MAX = 1024, ENT = 32;   // shapes per frame, ints per shape (18..25: bitmask of the primitives the original drew,
                               // 26..28: world position, 29..31: rotvec)
  const HDR = 16;
  const ORD = 4096;            // paint order: count, then (shape index << 8 | primitive) per polygon
  const PTS = 21;              // per ordered polygon: vertex count + up to 10 screen points (the original's)
  const BUF = HDR + MAX * ENT + 1 + ORD + ORD * PTS;

  function install(pc, C, scene, bg, opts = {}) {
    const P = C.P, D = C.DSEG, S = C.SYM;
    // (OG mode, the page's H: the original draws its own pictures again, read at every use)
    if (opts.og) {   // (the page's keys H, G, F are not typed letters: while the game reads text, the page leaves them to it)
      const tI = new Int32Array(opts.og);
      for (const nm of ['enter_hiscore', 'do_savefile_dialog', 'do_fileselect_dialog']) { const f = P[nm]; if (f) P[nm] = function (r, m, PP, e) { Atomics.add(tI, 1, 1); try { return f(r, m, PP, e); } finally { Atomics.sub(tI, 1, 1); } }; }
    }
    if (opts.og) { const ogI = new Int32Array(opts.og), kept = !!opts.keepOriginal; Object.defineProperty(opts, 'keepOriginal', { get: () => kept || Atomics.load(ogI, 0) === 1 }); }
    const I = new Int32Array(scene), B = new Uint8Array(bg), Iw = new Int32Array(scene, 4 * (16 + 2 * BUF), 18);
    const [sseg, soff] = C.CSYM.sprite1;
    let box = null, pbox = [1e9, 1e9, -1e9, -1e9];   // the screen area the original marks as drawn this frame (rect_adjust_from_point)
    let inFrame = false, loose = false, buf = 1, n = 0, camSeen = false;
    function beginFrame() {
      inFrame = true; camSeen = false; buf = Atomics.load(I, 0) ^ 1; n = 0; box = [1e9, 1e9, -1e9, -1e9];
      I[16 + buf * BUF + 13] = 0; I[16 + buf * BUF + 14] = 0; I[16 + buf * BUF + 15] = 255;
    }
    function publish() {
      const base = 16 + buf * BUF;
      I[base] = n;
      for (const [k, name] of [[1, 'projectiondata5'], [2, 'projectiondata8'], [3, 'projectiondata9'], [4, 'projectiondata10']]) I[base + k] = s16(pc.rw(D, S[name]));
      I[base + 9] = pc.rw(D, S.select_rect_param) & 0xFF;
      Atomics.store(I, 0, buf);
      Atomics.add(I, 1, 1); lastPublish = performance.now();
      const kind = inRace ? 1 : 0; if (kind !== lastKind) { if (lastKind >= 0) session++; lastKind = kind; }   // (inside the race routine, or not)
      Atomics.store(I, 13, 0);
    }
    // move what is in the drawing target's rectangle into the background layer and make it see-through
    // (header slot 13: marking under way, until the frame is published; the page keeps its marks meanwhile)
    // the newest background seen at each pixel, and in which session (races, or the 3D in menus: a race's
    // backgrounds never show in the car select and the other way round)
    const latest = new Uint8Array(64000), seen = new Uint32Array(64000);
    let session = 1, lastPublish = 0, lastKind = -1, inRace = 0;
    const rg = P.run_game;
    // (each race builds the world afresh: the same track raced again after picking another car has its shapes loaded
    // elsewhere, and the world kept from the last race (keyed on the layout only) drew a black scene and giant polygons)
    if (rg) P.run_game = function (r, m, PP, e) { inRace++; worldHash = -1; try { return rg(r, m, PP, e); } finally { inRace--; } };
    function toBackground(L, R, T, Bt) {
      const base = 16 + buf * BUF;
      Atomics.store(I, 13, 1);
      const o = buf * 64000, ob = (buf ^ 1) * 64000;
      I[base + 5] = L; I[base + 6] = R; I[base + 7] = T; I[base + 8] = Bt;
      for (let y = Math.max(0, T); y < Math.min(200, Bt); y++) {
        const a = rowAddr(y);
        if (a < 0xA0000 || a >= 0xB0000) keyed.add(a + Math.max(0, L) + (Math.min(320, R) - Math.max(0, L)) * 0x100000);
        for (let x = Math.max(0, L); x < Math.min(320, R); x++) {
          const v = pc.mem[a + x], i = y * 320 + x;
          // (into both buffers: a pixel made see-through now may be left alone next frame, when the other buffer
          // is shown; a pixel already see-through gets the newest background known there)
          if (v !== KEY) { B[o + i] = B[ob + i] = latest[i] = v; seen[i] = session; }
          else if (seen[i] === session) B[o + i] = B[ob + i] = latest[i];
          else {   // (none yet on this screen: the nearest pixel along the row, or the column, that has one)
            const yy = (i / 320) | 0;
            for (let d = 1; d < 320; d++) {
              const l = x - d >= 0 && seen[i - d] === session ? i - d : x + d < 320 && seen[i + d] === session ? i + d
                : yy - d >= 0 && seen[i - d * 320] === session ? i - d * 320 : yy + d < 200 && seen[i + d * 320] === session ? i + d * 320 : -1;
              if (l >= 0) { B[o + i] = B[ob + i] = latest[i] = latest[l]; seen[i] = session; break; }
            }
          }
          B[128000 + i] = 1; pc.mem[a + x] = KEY;
        }
      }
    }
    const s16 = v => (v << 16) >> 16;
    // the rows of an off-screen window left see-through (the key colour where the original would have drawn): made black
    // again when the window is freed. Its memory is the game's again, and what it loads there next may read past its own
    // end into what was left: after the intro, the menu music's track scan ran on through a sea of the key colour, never
    // meeting the end it finds in the original's mostly black picture, and the game hung (a key pressed in the intro)
    const keyed = new Set();
    for (const name of ['sprite_free_wnd']) {
      const f = P[name];
      if (f) P[name] = function (r, m, PP, e) {
        for (const k of keyed) { const a = k % 0x100000, w = Math.floor(k / 0x100000); for (let x = 0; x < w; x++) if (pc.mem[a + x] === KEY) pc.mem[a + x] = 0; }
        keyed.clear();
        return f(r, m, PP, e);
      };
    }

    // OG mode in a race: which of the screen's pixels are the original's 3D view, for the page to draw the ghost car
    // on (bg + 256000: 1 there), not on the dashboard or anything else drawn over the view. Once the original has
    // painted the view, its pixels are copied aside; what still matches them when the frame goes to the screen is the
    // view. The game's own pixels are never touched: the cockpit's mask is ORed onto the view, and a view made
    // see-through for it (key colour 233) came out 233 | 29 = 253 where the original has 28 | 29 = 29
    // (mr-finster/stunts-hd#1: 2954, a line of wrong pixels along the dashboard's edge)
    let ogRect = null, ogKeyed = false, ogMarked = false;
    const ogKept = new Uint8Array(64000), ogMark = new Uint8Array(64000);
    function ogKey() {
      const [L, R, T, Bt] = ogRect;
      for (let y = Math.max(0, T); y < Math.min(200, Bt); y++) {
        const a = rowAddr(y);
        for (let x = Math.max(0, L); x < Math.min(320, R); x++) ogKept[y * 320 + x] = pc.mem[a + x];
      }
      ogKeyed = true;
    }
    // (at the frame's first copy to the screen; another copy in the same frame (the dashboard's needles) leaves the marks;
    // a frame drawn without the view kept (the modern look, menus, a paused race drawn again) clears them, see update_frame)
    function ogRestore() {
      if (!ogKeyed) return;
      const [L, R, T, Bt] = ogRect;
      ogMark.fill(0);
      for (let y = Math.max(0, T); y < Math.min(200, Bt); y++) {
        const a = rowAddr(y);
        for (let x = Math.max(0, L); x < Math.min(320, R); x++) if (pc.mem[a + x] === ogKept[y * 320 + x]) ogMark[y * 320 + x] = 1;
      }
      B.set(ogMark, 256000); ogKeyed = false; ogMarked = true;
    }

    // the frame the screen shows: when the game copies its back buffer to the screen, the frame last
    // published is what is there (header slot 15: that buffer + 1), and the page takes its background from it
    for (const name of ['sprite_blit_to_video', 'sprite_copy_2_to_1', 'sprite_copy_2_to_1_2', 'sprite_copy_2_to_1_clear']) {
      const f = P[name];
      if (f) P[name] = function (r, m, PP, e) { ogRestore(); const ret = f(r, m, PP, e); Atomics.store(I, 15, Atomics.load(I, 0) + 1); return ret; };
    }

    // row address of the sprite1 drawing target (the back buffer)
    function rowAddr(y) {
      const bmOff = pc.rw(sseg, soff), bmSeg = pc.rw(sseg, soff + 2), lo = pc.rw(sseg, soff + 10);
      return ((bmSeg << 4) + bmOff + pc.rw(sseg, (lo + y * 2) & 0xFFFF)) & 0xFFFFF;
    }

    const uf = P.update_frame;
    P.update_frame = function (r, m, PP, e) {
      // the see-through 3D window needs full-frame copies, not the dirty-rectangle mode init_main may pick
      pc.ww(D, S.slow_video_mgmt, 0); pc.ww(D, S.slow_video_mgmt_copy, 0);
      if (ogKeyed) ogRestore();   // (never left see-through into another frame)
      loose = false; beginFrame(); ogRect = null;
      if (opts.world) buildWorld();
      try { uf(r, m, PP, e); } finally { inFrame = false; }
      if (!ogKeyed && ogMarked) { B.fill(0, 256000, 320000); ogMarked = false; }
      publish();
    };

    // Which primitives does the original actually draw? transformed_shape_op ends every primitive at
    // loc_25801 with [bp-4] != 0 when it was drawn (after the direction masks, facing test, clipping, and
    // skipping decals whose base polygon was hidden). The translator puts a probe there.
    const VCOUNT = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 2, 6, 3];   // primidxcounttab
    const ends = new Map();   // shape -> Map(end offset of primitive -> index)
    let curShape = 0, curO = -1, primBase = 0, matSeen = false;
    function primEnds(ptr) {
      const key = ptr + ':' + pc.rw(D, ptr + 10) + ':' + pc.rw(D, ptr + 12);
      let e = ends.get(key);
      if (e) return e;
      e = new Map();
      const np = pc.rb(D, ptr + 6), npaint = pc.rb(D, ptr + 8), seg = pc.rw(D, ptr + 12);
      let off = pc.rw(D, ptr + 10);
      for (let i = 0; i < np; i++) { off = (off + 2 + npaint + (VCOUNT[pc.rb(seg, off)] || 0)) & 0xFFFF; e.set(off, i); }
      ends.set(key, e);
      return e;
    }
    // polygon index -> (shape, primitive), filled as transformed_shape_op inserts polygons into the sorted list
    const polyMap = new Int32Array(ORD).fill(-1);
    const ins = P.insert_newest_poly_in_poly_linked_list_40ED6;
    P.insert_newest_poly_in_poly_linked_list_40ED6 = function (r, m, PP, e) {
      if (inFrame && curO >= 0) {
        const idx = pc.rw(D, S.polyinfonumpolys), pi = primEnds(curShape).get(pc.rw(D, S.transshapeprimptr));
        if (idx < ORD && pi !== undefined) polyMap[idx] = (n << 8) | pi;
      }
      return ins(r, m, PP, e);
    };
    pc.probe = (r, label) => {
      if (curO < 0) return;
      if (label === 'loc_250A3') {
        // the shape's transform as used for its vertices (these locals are reused later in the call)
        for (let i = 0; i < 9; i++) I[curO + 2 + i] = s16(pc.rw(r.ss, (r.bp - 1066 + i * 2) & 0xFFFF));
        for (let i = 0; i < 3; i++) I[curO + 11 + i] = s16(pc.rw(r.ss, (r.bp - 20 + i * 2) & 0xFFFF));
        matSeen = true;
        return;
      }
      const i = primEnds(curShape).get(pc.rw(D, S.transshapeprimptr));
      if (i !== undefined && i < 256 && pc.rw(r.ss, (r.bp - 4) & 0xFFFF)) I[curO + 18 + (i >> 5)] |= 1 << (i & 31);
    };

    const ts = P.transformed_shape_op;
    P.transformed_shape_op = function (r, m, PP, e) {
      const sp = r.sp, bp = (sp - 2) & 0xFFFF;
      if (!inFrame && originalOnly) return ts(r, m, PP, e);
      if (!inFrame) { loose = true; beginFrame(); }   // a menu drawing 3D shapes (car select)
      if (!camSeen) {
        // camera rotation as the shapes see it (mat_temp); in the race also update_frame's cam_pos ([bp-88])
        camSeen = true;
        const base = 16 + buf * BUF;
        if (!loose) { for (let i = 0; i < 3; i++) I[base + 10 + i] = s16(pc.rw(r.ss, (r.bp - 88 + i * 2) & 0xFFFF)); I[base + 13] = 1; }
        I[base + 15] = pc.rb(D, S.cameramode);   // (the camera this frame is drawn with: the page plays a little behind, and a key may have changed it since)
        for (let i = 0; i < 9; i++) Iw[buf * 9 + i] = s16(pc.rw(D, S.mat_temp + i * 2));
      }
      const tsp = pc.rw(r.ss, (sp + 4) & 0xFFFF);
      if (inFrame && n < MAX) {
        curO = 16 + buf * BUF + HDR + n * ENT; curShape = pc.rw(D, (tsp + 6) & 0xFFFF); matSeen = false;
        for (let i = 18; i < 26; i++) I[curO + i] = 0;
      }
      // the truck the car starts in (shape 0x7FD6) is a black box round the camera at the start: left out of the original's own
      // drawing too (its header read as an empty shape for the call), so OG mode shows the road, not a black screen (the HD view
      // leaves it out already)
      const truck = pc.rw(D, (tsp + 6) & 0xFFFF) === 0x7FD6, hdr = (D << 4) + 0x7FD6, saved = truck ? pc.mem.slice(hdr, hdr + 14) : null;
      if (truck) pc.mem.fill(0, hdr, hdr + 14);
      try { ts(r, m, PP, e); } finally { curO = -1; if (truck) pc.mem.set(saved, hdr); }
      // the shape's dirty rectangle (polygons widen it inline, other primitives via rect_adjust_from_point)
      const rp = pc.rw(D, (tsp + 8) & 0xFFFF);
      if (inFrame && loose && box && rp) {
        const l = s16(pc.rw(D, rp)), rr = s16(pc.rw(D, rp + 2)), t = s16(pc.rw(D, rp + 4)), bb = s16(pc.rw(D, rp + 6));
        if (rr > l && bb > t) { box[0] = Math.min(box[0], l); box[1] = Math.min(box[1], t); box[2] = Math.max(box[2], rr); box[3] = Math.max(box[3], bb); }
      }
      if (!inFrame || n >= MAX || pc.rw(D, S.word_40ECE)) return;
      const o = 16 + buf * BUF + HDR + n * ENT;
      I[o] = pc.rw(D, (tsp + 6) & 0xFFFF);                       // shapeptr (SHAPE3D in dseg)
      I[o + 1] = pc.rb(D, (tsp + 19) & 0xFFFF);                  // paint job
      if (!matSeen) {   // returned before loc_250A3: take the locals as they are
        for (let i = 0; i < 9; i++) I[o + 2 + i] = s16(pc.rw(r.ss, (bp - 1066 + i * 2) & 0xFFFF));  // var_mat2
        for (let i = 0; i < 3; i++) I[o + 11 + i] = s16(pc.rw(r.ss, (bp - 20 + i * 2) & 0xFFFF));   // var_vec
      }
      I[o + 14] = pc.rb(D, (tsp + 18) & 0xFFFF);                 // ts_flags
      I[o + 15] = pc.rb(D, S.select_rect_param);                  // vertices halved when set
      // view-direction masks for the per-primitive cull tables: var_45C (cull1) and var_A (cull2)
      I[o + 16] = pc.rd(r.ss, (bp - 1116) & 0xFFFF) | 0;
      I[o + 17] = pc.rd(r.ss, (bp - 10) & 0xFFFF) | 0;
      const cb = 16 + buf * BUF;
      for (let i = 0; i < 3; i++) { I[o + 26 + i] = s16(pc.rw(D, (tsp + i * 2) & 0xFFFF)) + (loose ? 0 : I[cb + 10 + i]); I[o + 29 + i] = s16(pc.rw(D, (tsp + 10 + i * 2) & 0xFFFF)); }
      n++;
    };

    // The whole track as update_frame would place it if it drew every tile (it draws the 23 nearest):
    // the same tile walk, at full detail, written once per track into the world buffer as world-space
    // shape instances: shapeptr, low-detail shapeptr, paint (-1: alternating), x, y, z, rotation, layer.
    const W = opts.world ? new Int32Array(opts.world) : null;
    let worldHash = -1;
    function buildWorld() {
      const fp = a => [pc.rw(D, a + 2), pc.rw(D, a)];
      const [es, eo] = fp(S.td14_elem_map_main), [ts2, to] = fp(S.td15_terr_map_main);
      const rows = i => pc.rw(D, S.trackrows + i * 2), trows = i => pc.rw(D, S.terrainrows + i * 2);
      const elem = (e, s) => pc.rb(es, (eo + e + rows(s)) & 0xFFFF), terr = (e, s) => pc.rb(ts2, (to + e + trows(s)) & 0xFFFF);
      let h = 0;
      for (let s = 0; s < 30; s++) for (let e = 0; e < 30; e++) h = (h * 31 + elem(e, s) * 7 + terr(e, s)) | 0;
      if (h === worldHash) return;
      worldHash = h;
      const w16 = (a) => s16(pc.rw(D, a));
      const cx = e => w16(S.trackcenterpos2 + e * 2), cz = s => w16(S.trackcenterpos + s * 2);
      const obj = (base, i) => { const a = base + i * 14; return { rot: w16(a + 2), hi: pc.rw(D, a + 4), lo: pc.rw(D, a + 6), ovl: pc.rb(D, a + 8), surf: (pc.rb(D, a + 9) << 24) >> 24, mt: pc.rb(D, a + 11) }; };
      let k = 0;
      const add = (hi, lo, paint, x, y, z, rot, layer) => { if (!hi || k >= WMAX) return; const o = WHDR + k++ * WENT; W[o] = hi; W[o + 1] = lo || hi; W[o + 2] = paint; W[o + 3] = x; W[o + 4] = y; W[o + 5] = z; W[o + 6] = rot; W[o + 7] = layer; };
      const HILL = { 7: [4, 0xB6, 0xE, 0xBA, 0x18, 0xBE, 0x27, 0xC2, 0x3B, 0xC2, 0x62, 0xC2], 8: [5, 0xB7, 0xF, 0xBB, 0x19, 0xBF, 0x24, 0xC3, 0x38, 0xC3, 0x5F, 0xC3],
        9: [4, 0xB8, 0xE, 0xBC, 0x18, 0xC0, 0x26, 0xC4, 0x3A, 0xC4, 0x61, 0xC4], 10: [5, 0xB9, 0xF, 0xBD, 0x19, 0xC1, 0x25, 0xC5, 0x39, 0xC5, 0x60, 0xC5] };
      const subst = (t, el) => { const L = HILL[t]; for (let i = 0; i < L.length; i += 2) if (L[i] === el) return L[i + 1]; return 0; };
      const hillH = w16(S.hillHeightConsts + 2);
      const PADS = [[S.unk_3C0A2, 1], [S.unk_3C0A2 + 4, 2], [S.unk_3C0A2 + 12, 2], [S.unk_3C0A2 + 20, 4]];
      for (let s = 0; s < 30; s++) for (let e = 0; e < 30; e++) {
        // the fence around the track
        let di = -1;
        if (e === 0) di = s === 0 ? 7 : s === 29 ? 5 : 6;
        else if (e === 29) di = s === 0 ? 1 : s === 29 ? 3 : 2;
        else if (s === 0) di = 0; else if (s === 29) di = 4;
        if (di >= 0) { const f = obj(S.trkObjectList, pc.rb(D, S.fence_TrkObjCodes + di)); add(f.hi, f.lo, 0, cx(e), 0, cz(s), w16(S.word_3C0D6 + di * 2), 0); }
        let el = elem(e, s), t = terr(e, s);
        if (el >= 0xFD) continue;   // part of a multi-tile element, placed from its main tile
        if (el && t >= 7 && t < 11) { el = subst(t, el); t = 0; }
        let hh = 0;
        if (t !== 6) {
          if (el >= 0x69 && el <= 0x6C) {
            for (const [de, ds] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const t2 = terr(e + de, s + ds); if (t2) { const q = obj(S.sceneshapes2, t2); add(q.hi, q.lo, 0, cx(e + de), 0, cz(s + ds), q.rot, 0); } }
            t = 0;
          }
        } else { hh = hillH; if (el) t = 0; }
        if (t) { const q = obj(S.sceneshapes2, t); add(q.hi, q.lo, 0, cx(e), hh, cz(s), q.rot, 0); }
        if (!el) continue;
        const ob = obj(S.trkObjectList, el);
        const z = ob.mt & 1 ? w16(S.trackpos + s * 2) : cz(s), x = ob.mt & 2 ? w16(S.trackpos2 + (e + 1) * 2) : cx(e);
        if (hh) { const [tab, cnt] = PADS[ob.mt]; for (let i = 0; i < cnt; i++) add(S.game3dshapes + 0x3B2, 0, 0, x + w16(tab + i * 4), hh, z + w16(tab + i * 4 + 2), 0, 0); }
        if (ob.ovl) { const q = obj(S.trkObjectList, ob.ovl); add(q.hi, q.lo, q.surf, x, hh, z, q.rot, 1); }
        add(ob.hi, ob.lo, ob.surf, x, hh, z, ob.rot, 1);
      }
      W[1] = k; Atomics.add(W, 0, 1);
    }

    const rap = P.rect_adjust_from_point;
    P.rect_adjust_from_point = function (r, m, PP, e) {
      if (inFrame && box) { const pt = pc.rw(r.ss, (r.sp + 4) & 0xFFFF), x = s16(pc.rw(D, pt)), y = s16(pc.rw(D, pt + 2)); box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x + 1); box[3] = Math.max(box[3], y + 1); }
      return rap(r, m, PP, e);
    };

    const sky = P.skybox_op;
    P.skybox_op = function (r, m, PP, e) {
      const rect = pc.rw(r.ss, (r.sp + 6) & 0xFFFF);           // arg 2: RECTANGLE*
      sky(r, m, PP, e);
      if (inFrame && !loose) ogRect = [s16(pc.rw(D, rect)), s16(pc.rw(D, rect + 2)), s16(pc.rw(D, rect + 4)), s16(pc.rw(D, rect + 6))];
      if (!inFrame || loose || opts.keepOriginal) return;
      toBackground(s16(pc.rw(D, rect)), s16(pc.rw(D, rect + 2)), s16(pc.rw(D, rect + 4)), s16(pc.rw(D, rect + 6)));
    };

    // The track menu's overview. Modern view: instead of the original's picture, the whole track in 3D (the
    // page orbits it): the world is written, the window made see-through and a "preview" frame published.
    // The menu frees the track's shapes and the horizon right after, so the page is given a moment
    // (W[2] request, W[3] acknowledged) to build its meshes from them first. Otherwise: the original's
    // picture, drawn in several batches, left to the original renderer (and kept for OG mode, below).
    let originalOnly = 0;
    const dtp = P.draw_track_preview;
    P.draw_track_preview = function (r, m, PP, e) {
      pc.mouseHold = true;   // (the track menu coming up: a click that brought it here is not a click in it)
      if (!W) { originalOnly++; try { return dtp(r, m, PP, e); } finally { originalOnly--; } }
      // the original's picture as well, kept aside (bg + 192000) for OG mode, H switching either way while the menu
      // is up; the screen is left as it was (pixels already see-through get the original's from earlier batches)
      const rc = S.trackpreview_cliprect, L = Math.max(0, s16(pc.rw(D, rc))), R = Math.min(320, s16(pc.rw(D, rc + 2))), T = Math.max(0, s16(pc.rw(D, rc + 4))), Bt = Math.min(200, s16(pc.rw(D, rc + 6)));
      const was = [];
      for (let y = T; y < Bt; y++) { const a = rowAddr(y); was.push(pc.mem.slice(a + L, a + R)); for (let x = L; x < R; x++) if (pc.mem[a + x] === KEY) pc.mem[a + x] = B[192000 + y * 320 + x]; }
      originalOnly++; try { dtp(r, m, PP, e); } finally { originalOnly--; }
      for (let y = T; y < Bt; y++) { const a = rowAddr(y); for (let x = L; x < R; x++) B[192000 + y * 320 + x] = pc.mem[a + x]; pc.mem.set(was[y - T], a + L); }
      beginFrame(); inFrame = false;
      buildWorld();
      toBackground(L, R, T, Bt);
      I[16 + buf * BUF + 14] = 1;   // a preview frame
      publish();
      const req = W[2] + 1; Atomics.store(W, 2, req);
      // (up to 3 s: a big track takes the page a while on a slow phone, and its shapes freed while it still read them were
      // drawn as giant slabs and spikes, kept in its cache for the tracks after; the page answers as soon as it is done)
      for (let t = 0; t < 60 && Atomics.load(W, 3) !== req; t++) Atomics.wait(W, 3, Atomics.load(W, 3), 50);
    };

    // a crash's explosion: in the modern view the page draws its own (hires-view.js, explosions); the
    // original's 2D animation is left out (its caller pops the arguments)
    const soe = P.shape_op_explosion;
    if (opts.world) P.shape_op_explosion = function (r, m, PP, e) { if (opts.keepOriginal) return soe(r, m, PP, e); };

    // The race clock, speed and camera for the page's own display (opts.hud({ frame, fps, mph, gear, cam }), the page draws
    // them in the screen's corners): the game's clock (intro_draw_text with the clock's string at x 140) is
    // left out while driving without the dashboard; replays keep theirs.
    const idt = P.intro_draw_text;
    if (opts.hud) P.intro_draw_text = function (r, m, PP, e) {
      const sp = r.sp, str = pc.rw(r.ss, sp + 4), x = pc.rw(r.ss, sp + 6);
      if (str === S.resID_byte1 && x === 0x8C && !pc.rb(D, S.dashb_toggle) && !pc.rb(D, S.game_replay_mode)) {
        const st = S.state + 0x152;
        opts.hud({ frame: pc.rw(D, S.state + 320), fps: pc.rw(D, S.framespersec) || 20, mph: Math.round(pc.rw(D, st + 0x2C) / 256), gear: pc.rb(D, st + 0xBE), cam: pc.rb(D, S.cameramode) });
        return;
      }
      return idt(r, m, PP, e);
    };

    const gp = P.get_a_poly_info;
    P.get_a_poly_info = function (r, m, PP, e) {
      if (inFrame) {
        // the order get_a_poly_info would paint in: walk the sorted list from its head (entry 400)
        const o = 16 + buf * BUF + HDR + MAX * ENT, cnt = Math.min(pc.rw(D, S.polyinfonumpolys), ORD);
        let di = 400, k = 0;
        pbox = [1e9, 1e9, -1e9, -1e9];
        for (let i = 0; i < cnt; i++) {
          di = s16(pc.rw(D, (S.poly_linked_list_40ED6 + di * 2) & 0xFFFF));
          if (di < 0 || di >= ORD) break;
          if (polyMap[di] < 0) continue;
          // the original's projected, near-clipped screen points for this polygon (polyinfo + 6)
          const q = o + 1 + ORD + k * PTS, pi = S.polyinfoptrs + di * 4, ps = pc.rw(D, pi + 2), po = pc.rw(D, pi);
          const nv = Math.min(pc.rb(ps, (po + 3) & 0xFFFF), 10), ptype = pc.rb(ps, (po + 4) & 0xFFFF);
          I[q] = nv;
          if (ptype <= 1) for (let j = 0; j < nv; j++) {   // polygons and lines hold screen points (wheels/spheres do not)
            const x = s16(pc.rw(ps, (po + 6 + j * 4) & 0xFFFF)), y = s16(pc.rw(ps, (po + 8 + j * 4) & 0xFFFF));
            pbox[0] = Math.min(pbox[0], x); pbox[1] = Math.min(pbox[1], y); pbox[2] = Math.max(pbox[2], x + 1); pbox[3] = Math.max(pbox[3], y + 1);
          }
          for (let j = 0; j < nv; j++) { I[q + 1 + j * 2] = s16(pc.rw(ps, (po + 6 + j * 4) & 0xFFFF)); I[q + 2 + j * 2] = s16(pc.rw(ps, (po + 8 + j * 4) & 0xFFFF)); }
          I[o + 1 + k++] = polyMap[di];
        }
        I[o] = k;
        polyMap.fill(-1);
      }
      if (inFrame && loose && !opts.keepOriginal) {
        // menu scene (car select, track preview): only the area the polygons cover, plus a margin, becomes
        // see-through; what is there now (the stage) becomes the background layer. The rest of the window
        // (panels, buttons) is drawn once and never redrawn, so it must not be touched.
        const o = 16 + buf * BUF + HDR + MAX * ENT, k = I[o];
        // when the original keeps no rectangle for these shapes (it only does with draw flag 8), use the
        // polygons' screen points, with a margin for wheels
        const [x0, y0, x1, y1] = box[2] > box[0] ? box : [pbox[0] - 8, pbox[1] - 8, pbox[2] + 8, pbox[3] + 8];
        const L = s16(pc.rw(sseg, soff + 12)), R = s16(pc.rw(sseg, soff + 14)), T = s16(pc.rw(sseg, soff + 16)), Bt = s16(pc.rw(sseg, soff + 18));
        // exactly the rectangle the original keeps for these polygons (its own rect_adjust_from_point calls), so
        // the area is repainted by the original next frame; anything larger leaves see-through trails behind
        // plus the area of the car's shadow on the stage, as the page last reported it (what was there is
        // kept under every see-through pixel, so a larger area is harmless)
        let [a0, b0, a1, b1] = [x0, y0, x1, y1];
        if (I[12] && Atomics.load(I, 1) - I[12] < 8) { a0 = Math.min(a0, I[8]); b0 = Math.min(b0, I[9]); a1 = Math.max(a1, I[10]); b1 = Math.max(b1, I[11]); }
        if (k && x1 > x0) toBackground(Math.max(L, a0), Math.min(R, a1), Math.max(T, b0), Math.min(Bt, b1));
        else I[16 + buf * BUF + 5] = I[16 + buf * BUF + 6] = 0;
      }
      const wasLoose = inFrame && loose;
      if (!inFrame || opts.keepOriginal) { gp(r, m, PP, e); if (inFrame && opts.onRastered) opts.onRastered(rowAddr); if (inFrame && !wasLoose && inRace && opts.world && ogRect && !pc.inIrq) ogKey(); }   // (not the paused race's picture drawn again in the other look (worker.js): it goes to the screen another way)
      else { pc.call(r, PP, 'polyinfo_reset', 4); pc.ret(r, 4, 0); }
      if (wasLoose) { inFrame = false; loose = false; publish(); }
    };
  }

  const BYTES = 4 * (16 + 2 * BUF + 18);
  const WMAX = 8192, WHDR = 4, WENT = 8, WBYTES = 4 * (WHDR + WMAX * WENT);
  root.StuntsHires = { install, KEY, MAX, ENT, HDR, BUF, BYTES, ORD, PTS, WMAX, WHDR, WENT, WBYTES };
})(typeof window !== 'undefined' ? window : globalThis);
