// The PC the translated Stunts code runs on: DOS file and memory services, BIOS video and keyboard,
// VGA mode 13h, the PIT timer and the keyboard controller. Interrupts go through the real vector
// table, so the game's own handlers (timer_intr_callback, kb_int9_handler, kb_int16_handler) run.
'use strict';
(function (root) {
  const { Machine } = root.StuntsCPU;
  const RET = 0x0001, RETSEG = 0xC5C5;      // return-address marker pushed by calls
  const BIOS = 0xE000, STUB = 0xFF00;       // host interrupt stubs live at E000:FF00+n (not the code segment)
  // Conventional memory handed out by DOS 48h: as much as GAME.EXE gets on a PC (program
  // from 0A00h with 600 KB free; PSP, code, data and stack take 384Dh paragraphs, from its MZ header). Here only its data
  // segment is in memory (1000:0000-FFFF), so the heap could start at 2000h, but the amount matters: the
  // game's memory manager keeps freed files as a cache, and with ~140 KB more than on a PC the title music
  // survives a race in it and comes back with its drum instruments still pointing into a since-freed voice
  // file (no drums after a race). With a PC's memory the race evicts it, and the music is loaded and set up
  // afresh, as on the original.
  // (DOSBox's amount, about 634 KB free, program from 053Dh: what players run the game in today, and what add-on cars
  // are made for: the DAF Siluro's unpacked dashboard picture needs some 7 KB more than 600 KB free leaves, and the
  // game stopped with OUT OF MEMORY as the race loaded it. Still well short of the 140 KB that kept the music cached.)
  const HEAP0 = 0x053D + 0x384D, HEAP1 = 0xA000;

  class StuntsPC extends Machine {
    constructor(code, opts = {}) {
      super();
      this.C = code; this.P = code.P;
      this.files = opts.files;               // name (upper case) -> Uint8Array
      this.saved = opts.saved || {};         // files the game wrote
      this.now = opts.now || (() => performance.now());
      this.onExit = opts.onExit || (() => { throw new HostExit(0); });
      this.log = opts.log || (() => {});
      // a mouse (int 33h) when the page shares one: Int32 [0] present, [1] x and [2] y as 0..65535 across the
      // screen, [3] buttons (1 left, 2 right)
      this.mouseIn = opts.mouse ? new Int32Array(opts.mouse) : null;
      this.mouseR = { x0: 0, x1: 639, y0: 0, y1: 199, ox: 0, oy: 0 };
      if (opts.memory) this.mem = new Uint8Array(opts.memory);
      this.pal = opts.palette ? new Uint8Array(opts.palette) : new Uint8Array(768);
      this.codeNames = code.CODE;
      this.budget = 4000;
      this.blocks = [];                      // allocated [seg, paras]
      this.handles = [null, null, null, null, null];
      this.dta = [0, 0x80];
      this.pitDiv = 0x10000; this.pitLatch = null; this.nextTick = 0;
      this.keys = []; this.port60 = 0; this.inIrq = false;
      this.palIdx = 0; this.palRead = 0; this.palCnt = 0;
      this.frames = 0;
      this.ascii = new Uint8Array(128); this.shiftFlags = 0;
      this.onSave = opts.onSave || (() => {});
      this.onDelete = opts.onDelete || (() => {});   // (a file the game deletes: the page forgets its kept copy too)
      this.load();
    }

    load() {
      const m = this.mem, C = this.C;
      const b64 = s => typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(s, 'base64')) : Uint8Array.from(atob(s), c => c.charCodeAt(0));
      m.set(b64(C.DSEG_IMAGE), C.DSEG << 4);
      for (const [seg, data] of Object.entries(C.CSDATA)) m.set(b64(data), (+seg) << 4);
      for (let n = 0; n < 256; n++) { this.ww(0, n * 4, STUB + n); this.ww(0, n * 4 + 2, BIOS); }
      // a minimal PSP at 0x0F00 with an empty command line
      this.psp = 0x0F00;
      this.wb(this.psp, 0, 0xCD); this.wb(this.psp, 1, 0x20); this.ww(this.psp, 2, 0xA000);
      this.wb(this.psp, 0x80, 0); this.wb(this.psp, 0x81, 0x0D);
      const r = this.r;
      r.ds = r.ss = r.es = C.DSEG; r.cs = C.CODESEG;
    }

    // ---------------- control transfer
    addrName(off) {
      if (this.codeNames[off]) return [this.codeNames[off], 0];
      const g = this.C.GLAB[off];
      if (g) return g;
      return null;
    }
    call(r, P, name, width, entry) {
      const fn = P[name];
      if (!fn) throw new Error('call to missing proc ' + name);
      if (width === 4) this.push(r, RETSEG);
      this.push(r, RET);
      fn(r, this, P, entry);
    }
    ret(r, width, n) {
      const a = this.pop(r);
      if (a !== RET) throw new Error('stack imbalance: returned to ' + a.toString(16));
      if (width === 4) this.pop(r);
      r.sp = (r.sp + n) & 0xFFFF;
    }
    callptr(r, P, off, width) {
      const t = this.addrName(off);
      if (!t) throw new Error('indirect call to unknown address ' + off.toString(16));
      this.call(r, P, t[0], width, t[1]);
    }
    callfar(r, P, seg, off) {
      if (this.rb(seg, off) === 0xCD) {   // _int86 builds "int nn; retf" on the stack and calls it
        this.interrupt(r, this.rb(seg, (off + 1) & 0xFFFF)); return;
      }
      if (seg < 0xA000) {   // the loaded sound driver lives on the DOS heap
        const drv = this.rw(this.C.DSEG, this.C.SYM.audiodriverbinary + 2);
        if (!drv || seg !== drv) throw new Error('far call to ' + seg.toString(16) + ':' + off.toString(16) + ' (not code, not the sound driver)');
        this.push(r, RETSEG); this.push(r, RET); this.audioDriver(r, seg, off); this.ret(r, 4, 0); return; }
      // chaining to an original BIOS handler (pushf; call far): behave like its iret
      if (seg === BIOS && off >= STUB) { this.hostInt(r, off - STUB); this.pop(r); return; }
      const t = this.addrName(off);
      if (!t) throw new Error('far call to unknown address ' + seg.toString(16) + ':' + off.toString(16));
      this.call(r, P, t[0], 4, t[1]);
    }
    // jumps through pointers: to a return marker means "return to the caller"
    jmpfar(r, P, seg, off) {
      if (off === RET) return;
      if (seg === BIOS && off >= STUB) { this.hostInt(r, off - STUB); this.iretKeepFlags(r); return; }
      this.jmpaddr(r, P, off);
    }
    jmpaddr(r, P, off) {
      if (off === RET) return;
      const t = this.addrName(off);
      if (!t) throw new Error('indirect jump to unknown address ' + off.toString(16));
      P[t[0]](r, this, P, t[1]);
    }
    flagsWord(r) { return (r.cf ? 1 : 0) | (r.pf ? 4 : 0) | (r.zf ? 0x40 : 0) | (r.sf ? 0x80 : 0) | 0x200 | (r.df ? 0x400 : 0) | (r.of ? 0x800 : 0) | 2; }
    setFlags(r, t) { r.cf = t & 1; r.pf = !!(t & 4); r.zf = !!(t & 0x40); r.sf = !!(t & 0x80); r.df = (t >> 10) & 1; r.of = !!(t & 0x800); }
    iret(r) {
      const a = this.pop(r); this.pop(r); const f = this.pop(r);
      if (a !== RET) throw new Error('iret to ' + a.toString(16));
      this.setFlags(r, f);
    }
    iretKeepFlags(r) { this.pop(r); this.pop(r); this.pop(r); }

    // Software or hardware interrupt through the vector table
    interrupt(r, n) {
      const off = this.rw(0, n * 4), seg = this.rw(0, n * 4 + 2);
      if (seg === BIOS && off >= STUB) { this.hostInt(r, off - STUB); return; }
      const t = this.addrName(off);
      if (!t) throw new Error('interrupt ' + n.toString(16) + ' vector to unknown ' + seg.toString(16) + ':' + off.toString(16));
      this.push(r, this.flagsWord(r)); this.push(r, RETSEG); this.push(r, RET);
      this.P[t[0]](r, this, this.P, t[1]);
    }

    // Called on backward jumps: delivers timer and keyboard interrupts that are due
    poll(r) {
      this.budget = 4000;
      if (this.inIrq) return;
      const now = this.now();
      if (this.hook) this.hook(now, r);
      if (this.keys.length && !this.kbPending) {
        this.port60 = this.keys.shift(); this.kbPending = true;
        this.irq(r, 9);
      }
      const period = this.pitDiv * 1000 / 1193182;
      if (!this.nextTick) this.nextTick = now + period;
      let n = 0;
      while (now >= this.nextTick && n < 4) { this.tickTime = this.nextTick; this.nextTick += period; this.irq(r, 8); n++; }
      this.tickTime = 0;
      if (now - this.nextTick > 200) this.nextTick = now + period;   // don't try to catch up after a stall
    }
    irq(r, n) {
      const save = { ax: r.ax, bx: r.bx, cx: r.cx, dx: r.dx, si: r.si, di: r.di, bp: r.bp, sp: r.sp, ds: r.ds, es: r.es, f: this.flagsWord(r) };
      this.inIrq = true;
      try { this.interrupt(r, n); } finally { this.inIrq = false; }
      if (r.sp !== save.sp) throw new Error('irq ' + n + ' left the stack unbalanced');
      // handlers save their own registers; restore anyway in case a host stub touched them
      Object.assign(r, { ax: save.ax, bx: save.bx, cx: save.cx, dx: save.dx, si: save.si, di: save.di, bp: save.bp, ds: save.ds, es: save.es });
      this.setFlags(r, save.f);
    }

    io(r, text) {
      const m = /^(\w+)\s+(.*)$/.exec(text.trim()), op = m[1], arg = m[2].replace(/\s+/g, '');
      if (op === 'int') return this.interrupt(r, parseInt(arg, 16));
      if (op === 'in') {
        const port = arg.endsWith('dx') ? r.dx : parseInt(arg.split(',')[1], 16);
        r.ax = (r.ax & 0xFF00) | (this.inp(port) & 0xFF); return;
      }
      if (op === 'out') {
        const port = arg.startsWith('dx') ? r.dx : parseInt(arg.split(',')[0], 16);
        this.outp(port, r.ax & 0xFF); return;
      }
    }
    inp(port) {
      switch (port) {
        case 0x60: this.kbPending = false; return this.port60;
        case 0x61: return this.port61 || 0;
        case 0x21: return this.picMask || 0;
        case 0x3DA: { const t = this.now() % 14.3; return t < 1.2 ? 0x09 : 0x00; }   // 70 Hz vertical retrace
        case 0x3C9: { const v = this.pal[this.palRead * 3 + this.palCnt]; if (++this.palCnt === 3) { this.palCnt = 0; this.palRead = (this.palRead + 1) & 255; } return v; }
        case 0x201: return 0xFF;   // no joystick
      }
      return 0xFF;
    }
    outp(port, v) {
      switch (port) {
        case 0x40: if (this.pitLatch == null) this.pitLatch = v; else { this.pitDiv = (this.pitLatch | (v << 8)) || 0x10000; this.pitLatch = null; this.nextTick = 0; } return;
        case 0x43: this.pitLatch = null; return;
        case 0x61: this.port61 = v; return;
        case 0x21: this.picMask = v; return;
        case 0x3C8: this.palIdx = v; this.palCnt = 0; return;
        case 0x3C7: this.palRead = v; this.palCnt = 0; return;
        case 0x3C9: this.pal[this.palIdx * 3 + this.palCnt] = v & 63; if (++this.palCnt === 3) { this.palCnt = 0; this.palIdx = (this.palIdx + 1) & 255; } return;
      }
    }

    // ---------------- host BIOS and DOS
    hostInt(r, n) {
      const ah = r.ax >> 8, al = r.ax & 0xFF;
      switch (n) {
        case 0x08: return;
        case 0x09: {   // BIOS keyboard handler: port 60h into the BIOS key buffer and shift state
          const sc = this.port60; this.kbPending = false;
          if (sc === 0xE0) { this.e0 = true; return; }
          const code = sc & 0x7F, down = !(sc & 0x80), e0 = this.e0; this.e0 = false;
          const bit = { 0x2A: 2, 0x36: 1, 0x1D: 4, 0x38: 8 }[code];
          if (bit) { this.shiftFlags = down ? (this.shiftFlags | bit) : (this.shiftFlags & ~bit); return; }
          if (down) (this.biosKeys || (this.biosKeys = [])).push([code, e0 ? 0xE0 & 0 : (this.ascii[code] || 0)]);
          return;
        }
        case 0x10: return this.int10(r, ah, al);
        case 0x16: return this.int16(r, ah);
        case 0x1A: if (ah === 0) { const t = Math.floor(this.now() * 0.0182065); r.cx = (t >> 16) & 0xFFFF; r.dx = t & 0xFFFF; r.ax &= 0xFF00; } return;
        case 0x20: return this.onExit(0);
        case 0x21: return this.int21(r, ah, al);
        case 0x33: return this.int33(r);
        default: return;
      }
    }
    // the mouse driver: position in the range the game sets (0..639 across by default, as in mode 13h), set
    // positions kept as an offset from where the pointer really is
    int33(r) {
      const M = this.mouseIn, R = this.mouseR;
      if (!M || !M[0]) { if (r.ax === 0) r.ax = 0; return; }
      const px = () => R.x0 + M[1] / 65535 * (R.x1 - R.x0), py = () => R.y0 + M[2] / 65535 * (R.y1 - R.y0);
      const cl = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));
      switch (r.ax) {
        case 0x00: Object.assign(R, { x0: 0, x1: 639, y0: 0, y1: 199, ox: 0, oy: 0 }); r.ax = 0xFFFF; r.bx = 2; this.mousePublish(); return;
        // (mouseHold: a button still held from before a new menu came up is not pressed in it, until let go)
        // (a press that lands somewhere new, as a tap does: first the place with the button up, so the game moves its
        // highlight there; pressed only once it has seen it, or the end screen's Race tapped did the highlighted View Replay)
        case 0x03: {
          let b = M[3] & 3; if (this.mouseHold) { if (b) b = 0; else this.mouseHold = false; }
          r.cx = cl(px() + R.ox, R.x0, R.x1); r.dx = cl(py() + R.oy, R.y0, R.y1);
          if (b && !this.mouseB && (r.cx !== this.mouseX || r.dx !== this.mouseY)) b = 0;
          r.bx = this.mouseB = b; this.mouseX = r.cx; this.mouseY = r.dx; return;
        }
        case 0x04: R.ox = r.cx - px(); R.oy = r.dx - py(); this.mousePublish(); return;
        // (a new range keeps the position where it is, clamped: no movement the player did not make)
        case 0x07: { const cx = cl(px() + R.ox, R.x0, R.x1); R.x0 = Math.min(r.cx, r.dx); R.x1 = Math.max(r.cx, r.dx); R.ox = cl(cx, R.x0, R.x1) - px(); this.mousePublish(); return; }
        case 0x08: { const cy = cl(py() + R.oy, R.y0, R.y1); R.y0 = Math.min(r.cx, r.dx); R.y1 = Math.max(r.cx, r.dx); R.oy = cl(cy, R.y0, R.y1) - py(); this.mousePublish(); return; }
        default: return;   // (show / hide, speed: the page's own pointer)
      }
    }
    // (the range and offset, for the page: it draws the game's pointer where the game would read it now, [4..9])
    mousePublish() {
      const M = this.mouseIn, R = this.mouseR;
      if (M && M.length >= 10) { M[4] = R.x0; M[5] = R.x1; M[6] = R.y0; M[7] = R.y1; M[8] = Math.round(R.ox * 65536); M[9] = Math.round(R.oy * 65536); }
    }
    int10(r, ah, al) {
      if (ah === 0x00) { this.videoMode = al; if (al === 0x13) this.mem.fill(0, 0xA0000, 0xB0000); return; }
      if (ah === 0x0F) { r.ax = (r.ax & 0xFF) | (40 << 8); r.ax = (r.ax & 0xFF00) | (this.videoMode || 3); r.bx &= 0x00FF; return; }
      if (ah === 0x10 && al === 0x12) {        // set block of DAC registers from es:dx
        for (let i = 0; i < r.cx * 3; i++) this.pal[(r.bx * 3 + i) % 768] = this.rb(r.es, (r.dx + i) & 0xFFFF) & 63;
        return;
      }
      if (ah === 0x10 && al === 0x17) {
        for (let i = 0; i < r.cx * 3; i++) this.wb(r.es, (r.dx + i) & 0xFFFF, this.pal[(r.bx * 3 + i) % 768]);
        return;
      }
      if (ah === 0x10 && al === 0x10) { const i = r.bx * 3; this.pal[i] = (r.dx >> 8) & 63; this.pal[i + 1] = (r.cx >> 8) & 63; this.pal[i + 2] = r.cx & 63; return; }
    }
    int16(r, ah) {
      // BIOS keyboard buffer, fed by the host with [scancode, ascii]
      const q = this.biosKeys || (this.biosKeys = []);
      if (ah === 0x00 || ah === 0x10) {
        if (!q.length) { r.ax = 0; return; }
        const [sc, ch] = q.shift(); r.ax = (sc << 8) | ch; return;
      }
      if (ah === 0x01 || ah === 0x11) {
        if (!q.length) { r.zf = true; return; }
        r.zf = false; r.ax = (q[0][0] << 8) | q[0][1]; return;
      }
      if (ah === 0x02) { r.ax = (r.ax & 0xFF00) | (this.shiftFlags || 0); return; }
    }
    // DOS
    cstr(seg, off) { let s = ''; for (let i = 0; i < 128; i++) { const c = this.rb(seg, (off + i) & 0xFFFF); if (!c) break; s += String.fromCharCode(c); } return s; }
    fname(s) { return s.replace(/^.*[\\/:]/, '').toUpperCase(); }
    ok(r) { r.cf = 0; }
    err(r, code) { r.cf = 1; r.ax = code; }
    alloc(paras) {
      this.blocks.sort((a, b) => a[0] - b[0]);
      let seg = HEAP0;
      for (const [s, n] of this.blocks) { if (s - seg >= paras) break; seg = Math.max(seg, s + n); }
      if (seg + paras > HEAP1) return -1;
      this.blocks.push([seg, paras]);
      return seg;
    }
    largest() {
      this.blocks.sort((a, b) => a[0] - b[0]);
      let seg = HEAP0, best = 0;
      for (const [s, n] of this.blocks) { best = Math.max(best, s - seg); seg = Math.max(seg, s + n); }
      return Math.max(best, HEAP1 - seg);
    }
    int21(r, ah, al) {
      switch (ah) {
        case 0x02: case 0x06: case 0x09: return;
        case 0x0B: r.ax &= 0xFF00; return;
        case 0x0E: r.ax = (r.ax & 0xFF00) | 3; return;
        case 0x19: r.ax = (r.ax & 0xFF00) | 2; return;          // drive C:
        case 0x1A: this.dta = [r.ds, r.dx]; return;
        case 0x2F: r.es = this.dta[0]; r.bx = this.dta[1]; return;
        case 0x25: this.ww(0, al * 4, r.dx); this.ww(0, al * 4 + 2, r.ds); return;
        case 0x35: r.bx = this.rw(0, al * 4); r.es = this.rw(0, al * 4 + 2); return;
        case 0x2A: { const d = new Date(); r.cx = d.getFullYear(); r.dx = ((d.getMonth() + 1) << 8) | d.getDate(); r.ax = (r.ax & 0xFF00) | d.getDay(); return; }
        case 0x2C: { const d = new Date(); r.cx = (d.getHours() << 8) | d.getMinutes(); r.dx = (d.getSeconds() << 8) | Math.floor(d.getMilliseconds() / 10); return; }
        case 0x30: r.ax = 0x0005; r.bx = 0; r.cx = 0; return;     // DOS 5.0
        case 0x33: r.dx &= 0xFF00; return;
        case 0x3B: this.ok(r); return;
        case 0x47: this.wb(r.ds, r.si, 0); this.ok(r); return;
        case 0x62: case 0x51: r.bx = this.psp; return;
        case 0x48: {
          this.log('alloc ' + r.bx.toString(16));
          const s = this.alloc(r.bx);
          if (s < 0) { r.bx = this.largest(); return this.err(r, 8); }
          r.ax = s; return this.ok(r);
        }
        case 0x49: { const i = this.blocks.findIndex(b => b[0] === r.es); if (i >= 0) this.blocks.splice(i, 1); return this.ok(r); }
        case 0x4A: {
          this.log('setblock ' + r.es.toString(16) + ' ' + r.bx.toString(16));
          if (r.es === this.psp) return this.ok(r);
          const b = this.blocks.find(x => x[0] === r.es); if (!b) return this.err(r, 9);
          const old = b[1]; b[1] = 0;
          const fits = !this.blocks.some(x => x !== b && x[0] < r.es + r.bx && x[0] + x[1] > r.es) && r.es + r.bx <= HEAP1;
          if (fits) { b[1] = r.bx; return this.ok(r); }
          // largest size this block could grow to
          let lim = HEAP1; for (const x of this.blocks) if (x !== b && x[0] > r.es) lim = Math.min(lim, x[0]);
          b[1] = old; r.bx = lim - r.es; return this.err(r, 8);
        }
        case 0x4C: return this.onExit(al);
        case 0x3C: case 0x3D: {
          const name = this.fname(this.cstr(r.ds, r.dx));
          let data;
          if (ah === 0x3C) { data = new Uint8Array(0); this.saved[name] = data; }
          else { data = this.saved[name] || this.files[name] || (this.alias && this.alias[name] && (this.saved[this.alias[name]] || this.files[this.alias[name]])); if (!data) { this.log('open ' + name + ': not found'); return this.err(r, 2); } }
          const h = this.handles.length;
          this.handles.push({ name, data, pos: 0, write: ah === 0x3C || (al & 3) !== 0 });
          r.ax = h; this.log('open ' + name); return this.ok(r);
        }
        case 0x3E: { const f = this.handles[r.bx]; if (f && f.write) this.onSave(f.name, f.data); if (f) this.handles[r.bx] = null; return this.ok(r); }
        case 0x3F: {
          const f = this.handles[r.bx];
          if (!f) { if (r.bx < 5) { r.ax = 0; return this.ok(r); } return this.err(r, 6); }
          const n = Math.max(0, Math.min(r.cx, f.data.length - f.pos));
          for (let i = 0; i < n; i++) this.wb(r.ds, (r.dx + i) & 0xFFFF, f.data[f.pos + i]);
          f.pos += n; r.ax = n; this.log('read ' + f.name + ' ' + r.cx + ' -> ' + n + ' at ' + r.ds.toString(16) + ':' + r.dx.toString(16)); return this.ok(r);
        }
        case 0x40: {
          const f = this.handles[r.bx];
          if (!f) { r.ax = r.cx; if (r.bx === 1 || r.bx === 2) this.log('stdout: ' + Array.from({ length: r.cx }, (_, i) => String.fromCharCode(this.rb(r.ds, r.dx + i))).join('')); return this.ok(r); }
          const end = f.pos + r.cx;
          if (end > f.data.length) { const d = new Uint8Array(end); d.set(f.data); f.data = d; this.saved[f.name] = d; }
          for (let i = 0; i < r.cx; i++) f.data[f.pos + i] = this.rb(r.ds, (r.dx + i) & 0xFFFF);
          f.pos = end; r.ax = r.cx; return this.ok(r);
        }
        case 0x42: {
          const f = this.handles[r.bx]; if (!f) return this.err(r, 6);
          const off = ((r.cx << 16) | r.dx) | 0;
          f.pos = Math.max(0, (al === 0 ? 0 : al === 1 ? f.pos : f.data.length) + off);
          r.ax = f.pos & 0xFFFF; r.dx = (f.pos >>> 16) & 0xFFFF; this.log('seek ' + f.name + ' ' + al + ' ' + off + ' -> ' + f.pos); return this.ok(r);
        }
        case 0x44: if (al === 0) { r.dx = r.bx < 5 ? 0x80 | (r.bx === 0 ? 1 : r.bx === 1 ? 2 : 0) : 0; return this.ok(r); } return this.ok(r);
        case 0x41: { const n = this.fname(this.cstr(r.ds, r.dx)); this.log('delete ' + n); delete this.saved[n]; this.onDelete(n); return this.ok(r); }
        case 0x4E: {
          const pat = this.fname(this.cstr(r.ds, r.dx));
          const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
          // (a name that isn't DOS's 8.3, an add-on track's long one, goes to the game as DOS would show it, BERNIE~1.TRK, and
          // opens the file under its own name: written out whole, it ran past the game's 13-byte name and broke its stack)
          const al = this.alias || (this.alias = {}), short = n => {
            if (/^[A-Z0-9_$~!#%&'(){}^@`-]{1,8}(\.[A-Z0-9_$~!#%&'(){}^@`-]{0,3})?$/.test(n)) return n;
            for (const [k, v] of Object.entries(al)) if (v === n) return k;
            const dot = n.lastIndexOf('.'), clean = t => t.replace(/[^A-Z0-9_]/g, ''), base = clean(dot > 0 ? n.slice(0, dot) : n) || 'FILE', ext = clean(dot > 0 ? n.slice(dot + 1) : '').slice(0, 3);
            for (let i = 1; i < 1000; i++) { const t = String(i), k = base.slice(0, 7 - t.length) + '~' + t + (ext ? '.' + ext : ''); if (!(k in al) && !this.files[k] && !this.saved[k]) { al[k] = n; return k; } }
            return n.slice(0, 12);
          };
          const names = [...new Set([...Object.keys(this.files), ...Object.keys(this.saved)].map(short))].filter(n => re.test(n)).sort();
          // (at most 127 for a search with a wildcard: the track list counts its entries in a signed byte, 128 reads as -128 and
          // its stop at 128 never comes, so a pack of more tracks ran past the list and broke the game's stack: More Tracks)
          this.find = /\*/.test(pat) ? names.slice(0, 127) : names;
          return this.findNext(r);
        }
        case 0x4F: return this.findNext(r);
        case 0x56: { const a = this.fname(this.cstr(r.ds, r.dx)), b = this.fname(this.cstr(r.es, r.di)); this.saved[b] = this.saved[a] || this.files[a]; delete this.saved[a]; if (this.saved[b]) this.onSave(b, this.saved[b]); this.onDelete(a); return this.ok(r); }
        case 0x59: r.ax = 0; return;
        default:
          this.log('unhandled int 21h ah=' + ah.toString(16));
          return this.err(r, 1);
      }
    }
    findNext(r) {
      if (!this.find || !this.find.length) return this.err(r, 18);
      const n = this.find.shift(), real = this.alias && this.alias[n] || n, data = this.saved[real] || this.files[real];
      const [s, o] = this.dta;
      this.wb(s, o + 21, 0x20); this.ww(s, o + 22, 0); this.ww(s, o + 24, 0x2121);
      this.ww(s, o + 26, data.length & 0xFFFF); this.ww(s, o + 28, data.length >>> 16);
      for (let i = 0; i < 13; i++) this.wb(s, o + 30 + i, i < n.length ? n.charCodeAt(i) : 0);
      return this.ok(r);
    }

    // The loaded sound driver runs in a small 8086 interpreter (drv86.js); OPL writes go to onOpl with the
    // time they belong to (inside a timer tick: that tick's scheduled time, so the music keeps its rhythm
    // when ticks are delivered late). Without the interpreter: init succeeds, everything else is silent.
    audioDriver(r, seg, off) {
      if (typeof StuntsDrv86 !== 'undefined' && !this.drv) this.drv = new StuntsDrv86(this, {
        onWrite: (a, v) => this.onOpl && this.onOpl(a, v, this.inIrq && this.tickTime ? this.tickTime : this.now()),
        onSample: s => this.onSample && this.onSample(s, this.inIrq && this.tickTime ? this.tickTime : this.now()),
      });
      if (!this.drv || !this.drv.supports(seg)) {
        const base = this.rw(this.C.DSEG, this.C.SYM.audiodriverbinary);
        if (off === base) r.ax = (r.ax & 0xFF00) | 0x10; else r.ax &= 0xFF00;
        return;
      }
      this.drv.run(r, seg, off);
    }

    // ---------------- keyboard: PC scancodes in, the game's int 9 handler does the rest
    keyEvent(scan, down, ascii = 0) {
      const ext = scan > 0xFF;
      if (ext) this.keys.push(0xE0);
      this.keys.push((scan & 0x7F) | (down ? 0 : 0x80));
      if (down && !ext) this.ascii[scan & 0x7F] = ascii;
    }

    // ---------------- start-up: the C runtime's own init, then main(argc, argv)
    start(args = []) {
      const r = this.r, C = this.C;
      r.ss = r.ds = r.es = C.DSEG; r.sp = 0xFEF0; r.bp = 0;   // stack above the data, limit word_3EE24 = AE20h
      const sym = n => C.SYM[n];
      if (sym('crtsp1') != null) this.ww(C.DSEG, sym('crtsp1'), r.sp);
      if (sym('crtsp2') != null) this.ww(C.DSEG, sym('crtsp2'), r.sp);
      if (sym('word_3ED74') != null) this.ww(C.DSEG, sym('word_3ED74'), 0xFFFF);
      if (sym('crtpspseg') != null) this.ww(C.DSEG, sym('crtpspseg'), this.psp);
      this.mem.fill(0, (C.DSEG << 4) + 0x55CA, (C.DSEG << 4) + 0xAD20 - 64);
      // C runtime initialisers (loc_2CD28 in start)
      const L = C.LABELS.loc_2CD28;
      this.call(r, this.P, L[0], 4, L[1]);
      // argv strings at the top of the data segment
      const argv = ['STUNTS', ...args];
      let p = 0xFF00; const ptrs = [];
      for (const a of argv) { ptrs.push(p); for (const ch of a) this.wb(C.DSEG, p++, ch.charCodeAt(0)); this.wb(C.DSEG, p++, 0); }
      const av = p; ptrs.forEach((q, i) => this.ww(C.DSEG, av + i * 2, q)); this.ww(C.DSEG, av + ptrs.length * 2, 0);
      r.ds = r.es = C.DSEG; r.bp = 0;
      this.push(r, 0); this.push(r, av); this.push(r, argv.length);
      this.call(r, this.P, 'ported_stuntsmain_', 4);
      return r.ax;
    }
  }
  class HostExit extends Error { constructor(code) { super('exit ' + code); this.code = code; } }

  root.StuntsPC = StuntsPC; root.HostExit = HostExit;
})(typeof window !== 'undefined' ? window : globalThis);
