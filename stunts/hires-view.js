// Page side of the high-resolution view. Each game frame the worker reports which polygons the original
// renderer decided to draw (shape + primitive), in the order it would paint them, plus each shape's
// camera-space transform and the projection constants. Here they are painted in that same order, with
// no depth buffer, exactly like the original, only at display resolution and with motion interpolated
// between game frames.
'use strict';
(function (root) {
  const T = root.THREE, H = root.StuntsHires;
  const VCOUNT = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 2, 6, 3];   // primidxcounttab   // vertices per primitive type (11 sphere, 12 wheel)
  const MAXV = 300000;

  class HiresView {
    constructor(canvas, mem, pal, scene, D, S, opts = {}) {
      this.mem = mem; this.pal = pal; this.I = new Int32Array(scene); this.D = D; this.S = S;
      this.modern = !!opts.world;
      this.r = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, logarithmicDepthBuffer: this.modern });
      if (this.modern) { this.initModern(opts); return; }
      this.r.setClearColor(0x000000, 0);
      this.scene = new T.Scene();
      this.cam = new T.Camera();
      this.cache = new Map();
      this.pos = new Float32Array(MAXV * 3); this.col = new Float32Array(MAXV * 3);
      this.geo = new T.BufferGeometry();
      this.geo.setAttribute('position', new T.BufferAttribute(this.pos, 3).setUsage(T.DynamicDrawUsage));
      this.geo.setAttribute('color', new T.BufferAttribute(this.col, 3).setUsage(T.DynamicDrawUsage));
      const mat = new T.MeshBasicMaterial({ vertexColors: true, side: T.DoubleSide, depthTest: false, depthWrite: false });
      this.mesh = new T.Mesh(this.geo, mat);
      this.mesh.frustumCulled = false;
      this.scene.add(this.mesh);
      this.seq = -1; this.lastFrame = 0;
    }
    // ---------------------------------------------------------------------------------------------
    // Modern view: a depth buffer instead of the painter's order, lighting with sun shadows, fog, and
    // the whole track at any distance. Near the camera the shapes the original placed this frame are
    // drawn (animated vertices and paint jobs stay right); everywhere else the same shapes, placed by
    // the worker's whole-track walk, come from the static track meshes.
    initModern(opts) {
      const r = this.r; this.phone = !!opts.phone;
      r.setClearColor(0x000000, 0);
      r.outputEncoding = T.sRGBEncoding;
      r.shadowMap.enabled = true; r.shadowMap.type = T.PCFSoftShadowMap;   // (filtered, then re-sharpened in getShadow: straight hard edges, no stair steps, no blur)
      this.W = new Int32Array(opts.world); this.bgU8 = new Uint8Array(opts.bg); this.worldVer = -1;
      this.cache = new Map(); this.geoCache = new Map();
      this.scene = new T.Scene();
      this.cam = new T.Camera(); this.cam.matrixAutoUpdate = false; this.cam.far = FAR; this.cam.near = NEAR;
      this.scene.fog = new T.Fog(0xffffff, 9000, 90000);
      this.hemi = new T.HemisphereLight(0xdfeeff, 0x6a6048, 0.4); this.scene.add(this.hemi);
      const sun = this.sun = new T.DirectionalLight(0xfff2dc, 0.68);   // level ground: about its original colour; walls darker
      sun.castShadow = true; sun.shadow.mapSize.setScalar(opts.phone ? 4096 : 8192);   // (texels of under half a unit round the camera: crisp edges; a phone's half that, the near map keeps close ones crisp)
      sun.shadow.camera.layers.enable(3);   // (the track's shadows cast by its pieces' low-detail shapes, on layer 3 only: see buildWorld)
      sun.shadow.bias = -0.00012; sun.shadow.normalBias = +((root.location && /[?&]nb=([\d.]+)/.exec(root.location.search)) || [0, 1.2])[1];   // (small: shadows touch what casts them)
      const sc = sun.shadow.camera; sc.left = -2600; sc.right = 2600; sc.top = 2600; sc.bottom = -2600; sc.near = 10; sc.far = 16000;
      this.scene.add(sun, sun.target);
      // (no tone mapping: the original palette colours stay as they are)
      // sky environment for reflections: a gradient dome, prefiltered for rough and glossy surfaces
      const env = new T.Scene(), dome = new T.SphereGeometry(100, 32, 16), dc = [];
      const top = new T.Color(0.24, 0.5, 0.88).convertSRGBToLinear(), hor = new T.Color(0.78, 0.88, 0.97).convertSRGBToLinear(), gnd = new T.Color(0.09, 0.12, 0.06);
      for (let i = 0; i < dome.attributes.position.count; i++) { const y = dome.attributes.position.getY(i) / 100, c = y > 0 ? hor.clone().lerp(top, 1 - Math.exp(-y * 4.5)) : hor.clone().lerp(gnd, Math.min(1, -y * 4)); dc.push(c.r, c.g, c.b); }
      dome.setAttribute('color', new T.Float32BufferAttribute(dc, 3));
      env.add(new T.Mesh(dome, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide })));
      const sunDisc = new T.Mesh(new T.SphereGeometry(6, 16, 8), new T.MeshBasicMaterial({ color: new T.Color(12, 11, 9) }));
      sunDisc.position.set(-45, 78, 43); env.add(sunDisc);
      const pm = new T.PMREMGenerator(r), envMap = pm.fromScene(env, 0.02).texture; pm.dispose();
      this.mat = modernMaterial({ envMap, envMapIntensity: 0.05, roughness: 0.95 }, 0.16, 0.08);
      // the original's stippled (see-through) faces: flat colour, as see-through as the share of their dots,
      // blended after everything solid (no dot or dither pattern)
      this.matT = modernMaterial({ envMap, envMapIntensity: 0.05, roughness: 0.95, transparent: true, depthWrite: true }, 0.16, 0.08);
      // (and first, the same faces into depth only: then only the nearest layer of them is coloured, so a loop or a
      // ramp's deck reads the same from every angle; blended in turn, two layers or one, as their order flipped with
      // the camera, it switched between dark and see-through while driving towards it)
      this.matTD = modernMaterial({ envMap, envMapIntensity: 0.05, roughness: 0.95, transparent: true, colorWrite: false, depthWrite: true }, 0.16, 0.08);
      this.matPair = [this.mat, this.matT, this.matTD];
      this.matT.depthWrite = false;
      // car paint: glossy, reflecting the sky and catching the sun
      this.carMat = modernMaterial({ flatShading: false, envMap, envMapIntensity: 0.6, roughness: 0.42, metalness: 0.08, clearcoat: 0.9, clearcoatRoughness: 0.07 }, 0, 0, true);
      this.bgMat = modernMaterial({ depthTest: false, depthWrite: false, fog: false });
      this.dyn = new DynBuf(this.matPair); this.dyn.mesh.castShadow = this.dyn.mesh.receiveShadow = true;
      this.carShadow = ((root.location && /[?&]carsh=(\w+)/.exec(root.location.search)) || [])[1] || (OG ? 'crisp' : 'map');   // the cars' shadows in a race: 'crisp' (their own maps, see carSunsAt) or 'map' (the sun's, as the scenery's; ?realistic shades by the lights' own shadows)
      this.bgDyn = new DynBuf(this.bgMat); this.bgDyn.mesh.renderOrder = -10;
      // clouds: soft, slightly see-through, lit mostly by the sky
      // (depth-tested at their real distance: transparent objects are drawn after all opaque ones)
      this.cloudMat = modernMaterial({ depthWrite: false, fog: false, transparent: !OG, opacity: OG ? 1 : 0.72, emissive: 0x9aa4b0, roughness: 1 });
      this.cloudDyn = new DynBuf(this.cloudMat); this.cloudDyn.mesh.renderOrder = -9;
      this.scene.add(this.cloudDyn.mesh);
      this.dynFlat = new DynBuf(this.matPair); this.dynFlat.mesh.receiveShadow = true;
      this.dynCar = new DynBuf(this.carMat); this.dynCar.mesh.receiveShadow = true; this.dynCar.solid = true; this.dynCar.smooth = true;   // (stipple reads as glass on a car)
      this.scene.add(this.dynCar.mesh);
      // what the original drew is shown (its facing tests hide the inside of buildings the camera is in);
      // whole shapes cast the shadows
      this.dyn.mesh.castShadow = false;
      this.dynShadow = new DynBuf(new T.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: T.DoubleSide })); this.dynShadow.mesh.castShadow = true; this.dynShadow.noSee = 'upright';   // (see-through faces standing up cast no shadow: a fence's or grate's shadow is its solid frame; lying flat facing up, a bridge's deck, they do)
      this.scene.add(this.dyn.mesh, this.bgDyn.mesh, this.dynFlat.mesh, this.dynShadow.mesh);
      // the cars' shadows in a race, crisp: each car its own small shadow map from the sun, many times finer than the sun's
      // (whose texels, over its reach, rounded a car's shadow and stepped its edges as it moved); the cars cast only into
      // these (drawn into them on their own, see carSunsAt), and the cars' own lights add no light
      if (this.carShadow === 'crisp') {
        this.dynCarSh = new DynBuf(new T.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: T.DoubleSide }), 20000); this.dynCarSh.mesh.castShadow = true; this.dynCarSh.noSee = true; this.dynCarSh.mesh.layers.set(5);
        this.scene.add(this.dynCarSh.mesh);
        this.carSuns = [0, 1].map(i => {
          const l = new T.DirectionalLight(0xffffff, 0); l.castShadow = true; l.shadow.mapSize.set(CAR_SH_N, CAR_SH_N); l.shadow.autoUpdate = false; l.shadow.radius = 3 + i; l.layers.enable(5);
          const c = l.shadow.camera; c.left = c.bottom = -CAR_SH_R; c.right = c.top = CAR_SH_R; c.updateProjectionMatrix();
          this.scene.add(l, l.target); return l;
        });
        this.carShCam = new T.Camera(); this.carShCam.layers.set(5);
        // the near map: the scenery's shadows close to the camera as crisp as the cars', from a light of its own (no light
        // of its own either), the sun's map handing over further off (nearSunAt)
        const l = this.nearSun = new T.DirectionalLight(0xffffff, 0); l.castShadow = true; l.shadow.mapSize.set(NEAR_SH_N, NEAR_SH_N); l.shadow.autoUpdate = false; l.shadow.radius = 2;   // (radius: the map's tag in getShadow)
        const c = l.shadow.camera; c.left = c.bottom = -NEAR_SH_R; c.right = c.top = NEAR_SH_R; c.updateProjectionMatrix();
        this.scene.add(l, l.target);
      }
      // the ground beyond the track and between hills (flat land is not a shape in the original)
      const g = new T.CircleGeometry(0.5, 128).rotateX(-Math.PI / 2), n = g.attributes.position.count;   // (a disc: it ends where the horizon stands, all round)
      g.setAttribute('rank', new T.BufferAttribute(new Float32Array(n).fill(-60 * RANKS), 1));   // (behind everything on it: see RANKS)
      g.setAttribute('pat', new T.BufferAttribute(new Float32Array(n).fill(65535), 1));
      this.groundMat = modernMaterial({ vertexColors: false }, 0.14, 0.1);
      g.setAttribute('color', new T.BufferAttribute(new Float32Array(n * 3).fill(1), 3));   // white: "the ground" for the grass map
      this.ground = new T.Mesh(g, this.groundMat); this.ground.receiveShadow = true; this.ground.frustumCulled = false;
      this.ground.scale.set(FAR, 1, FAR); this.scene.add(this.ground);
      // car select: the stage is a picture, so a shadow-only disc at the car's wheels catches its shadow
      this.stage = new T.Mesh(new T.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new T.ShadowMaterial({ opacity: 0.42, side: T.DoubleSide }));
      // (the shadow as in a race: the same shade all over, its edges made hard as getShadow's; fading out only at the disc's rim)
      this.stage.material.onBeforeCompile = sh => {
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vDisc;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvDisc = position.xz;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vDisc;')
          .replace('#include <shadowmap_pars_fragment>', () => T.ShaderChunk.shadowmap_pars_fragment.replace(
            'float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {',
            s => s.replace('getShadow', 'getShadowRaw').replace(' {', ';') + `
float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) { return smoothstep( 0.42, 0.58, getShadowRaw( shadowMap, shadowMapSize, shadowBias, shadowRadius, shadowCoord ) ); }
` + s.replace('getShadow', 'getShadowRaw')))
          .replace('gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );', `gl_FragColor = vec4( color, ${OG_SHADOW.toFixed(3)} * ( 1.0 - smoothstep( 0.82, 1.0, length( vDisc ) ) ) * ( 1.0 - getShadowMask() ) );`);
      };
      this.stage.receiveShadow = true; this.stage.frustumCulled = false; this.stage.matrixAutoUpdate = false;
      this.scene.add(this.stage);
      this.statics = new T.Group(); this.scene.add(this.statics);
      this.hidden = [];
      // the original sky picture, drawn here (not by the page) so it can follow the eased camera every frame
      // and be cut just above its own horizon, where this view's ground takes over
      this.skyData = new Uint8Array(320 * 200 * 4);
      this.skyTex = new T.DataTexture(this.skyData, 320, 200, T.RGBAFormat);
      this.skyTex.magFilter = T.LinearFilter; this.skyTex.minFilter = T.LinearFilter;   // (sRGB values, shown as they are)
      this.skyScene = new T.Scene(); this.skyCam = new T.OrthographicCamera(-1, 1, 1, -1, -1, 1);
      // (the outline of hills and buildings against the sky: the filtered mask, sharpened into a smooth edge
      // instead of the picture's pixel steps)
      this.skyQuad = new T.Mesh(new T.PlaneGeometry(2, 2), new T.ShaderMaterial({
        transparent: true, depthTest: false, depthWrite: false, uniforms: { map: { value: this.skyTex }, haze: { value: new T.Color() } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform sampler2D map; uniform vec3 haze; varying vec2 vUv; void main() { vec4 t = texture2D(map, vUv); float w = fwidth(t.a) * 0.7 + 0.02; gl_FragColor = vec4(mix(t.rgb, haze, 0.32), smoothstep(0.5 - w, 0.5 + w, t.a)); }',   // (distant: in the haze)
      }));
      this.skyScene.add(this.skyQuad);
      // the horizon as the original draws it: the scenery's sprites side by side (1024 columns a turn), one
      // sprite pixel per game pixel, crisp, scrolled to where the game has them and on across a wider view
      // (o: panorama column at game x 0; bottom: game row under the sprites; k: canvas width / 4:3 frame)
      this.stripMat = new T.ShaderMaterial({
        transparent: true, depthTest: false, depthWrite: false,
        uniforms: { map: { value: null }, o: { value: 0 }, bottom: { value: 0 }, NH: { value: 1 }, k: { value: 1 }, below: { value: new T.Vector4(0, 0, 0, 0) }, haze: { value: new T.Vector4(0, 0, 0, 0) } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `uniform sampler2D map; uniform float o; uniform float bottom; uniform float NH; uniform float k; uniform vec4 below; uniform vec4 haze; varying vec2 vUv;
void main() {
  if (${GAPVIZ ? 1 : 0} > 0) discard;
  float gx = (vUv.x * 2.0 - 1.0) * k * 160.0 + 160.0, gy = (1.0 - vUv.y) * 200.0;
  float pr = NH - (bottom - gy);
  if (pr >= NH && below.a > 0.5) { gl_FragColor = vec4(below.rgb, 1.0); return; }   // (the original look: the ground colour below, as it paints it; no seam where the land ends)
  if (pr < 0.0 || pr >= NH) discard;
  vec4 t = texture2D(map, vec2((o + gx) / 1024.0, (NH - pr) / NH));
  if (t.a < 0.5) discard;
  gl_FragColor = vec4(mix(t.rgb, haze.rgb, haze.a), 1.0);   // (the distance's fade, sRGB)
}`,
      });
      this.strip = new T.Mesh(new T.PlaneGeometry(2, 2), this.stripMat); this.strip.frustumCulled = false;
      // (the original look) the sky as the original paints it: its colour on each row, from the game's own
      // picture, across the whole view, following the horizon (bottom: game row under the horizon sprites)
      this.bandData = new Uint8Array(256 * 4); this.bandTex = new T.DataTexture(this.bandData, 256, 1, T.RGBAFormat);
      this.bandMat = new T.ShaderMaterial({
        depthTest: false, depthWrite: false,
        uniforms: { map: { value: this.bandTex }, yb: { value: 0 }, tt: { value: 0 }, bottom: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `uniform sampler2D map; uniform float yb; uniform float tt; uniform float bottom; varying vec2 vUv;
void main() {
  float py = clamp(floor((1.0 - vUv.y) * 200.0 - bottom) + yb + 1.0, tt, yb);
  gl_FragColor = vec4(texture2D(map, vec2((py + 0.5) / 256.0, 0.5)).rgb, 1.0);
}`,
      });
      this.band = new T.Mesh(new T.PlaneGeometry(2, 2), this.bandMat); this.band.frustumCulled = false;
      this.bandScene = new T.Scene(); this.bandScene.add(this.band);
      this.stripScene = new T.Scene(); this.stripScene.add(this.strip);
      // behind it, a sky dome: the picture's plain sky colour is see-through, and the dome shades it from a
      // pale horizon to a deeper zenith with a glow around the sun (tinted from the track's sky colour)
      this.domeMat = new T.ShaderMaterial({
        depthTest: false, depthWrite: false, side: T.DoubleSide,   // (both: the water's mirror image turns it inside out)
        uniforms: { zenith: { value: new T.Color() }, horizon: { value: new T.Color() }, mid: { value: new T.Color() }, useMid: { value: 0 }, sunDir: { value: new T.Vector3(0, 1, 0) }, glow: { value: OG ? 0 : 1 } },
        vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform vec3 zenith; uniform vec3 horizon; uniform vec3 mid; uniform float useMid; uniform vec3 sunDir; uniform float glow; varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir); float h = max(d.y, 0.0);
  vec3 c = useMid > 0.5 ? (h < 0.18 ? mix(horizon, mid, smoothstep(0.0, 0.18, h)) : mix(mid, zenith, smoothstep(0.18, 0.9, h))) : mix(horizon, zenith, 1.0 - exp(-h * 4.5));   // (the original look: pale at the horizon, the game's sky colour, deep overhead)
  float s = max(dot(d, sunDir), 0.0);
  c += glow * vec3(1.0, 0.92, 0.78) * (pow(s, 6.0) * 0.18 + pow(s, 120.0) * 0.6 + pow(s, 3000.0) * 6.0);
  gl_FragColor = vec4(c, 1.0);
  if (${GAPVIZ ? 1 : 0} > 0) gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
  #include <encodings_fragment>
}`,
      });
      this.dome = new T.Mesh(new T.SphereGeometry(200000, 48, 24), this.domeMat); this.dome.frustumCulled = false;
      this.domeScene = new T.Scene(); this.domeScene.add(this.dome);
      this.hd = new Map();   // scenery -> high-resolution horizon (horizons/<name>_hd.png), if there is one
      for (let i = 0; i < SCENERY.length; i++) this.horizonHD(i);   // (loaded ahead of the first race)
      // layer 1: what the grass map sees (land and track, no cars or sky)
      // (only the ground, the land shapes and flat track pieces: grass grows on under bridges and buildings)
      for (const m of [this.ground, this.dynFlat.mesh]) m.layers.enable(1);
      this.grass = root.StuntsGrass && /[?&]grass/.test(root.location.search) ? [
        new root.StuntsGrass(r, this.scene, { R: 900, CELL: 32, PER: 56, FADE: 0.6 }),                                       // dense, near
        new root.StuntsGrass(r, this.scene, { R: 5200, CELL: 150, PER: 36, SIZE: 2.4, R0: 700, FADE: 0.35, MAPN: 1024, every: 24 }),   // to the horizon
      ] : null;
      this.aoPass = !OG && root.StuntsAO && !/[?&]noao/.test(root.location.search) ? new root.StuntsAO(r) : null;
      this.seq = -1; this.lastFrame = 0;
      this.prewarm();
    }

    // Every shader compiled up front, while the game loads, and again once a track's shapes are in: compiled at
    // first use instead, each new kind of thing on screen (a menu's car, a track) stalled a frame, a long one on
    // slower GPUs (the Steam Deck), and a palette fade caught in the stall showed a frame of wrong colours
    prewarm() {
      const t0 = performance.now();
      for (const [sc, cam] of [[this.scene, this.cam], [this.domeScene, this.cam], [this.skyScene, this.skyCam], [this.bandScene, this.skyCam], [this.stripScene, this.skyCam]])
        if (sc && cam) try { this.r.compile(sc, cam); } catch (_) {}
      this.prewarmMs = (this.prewarmMs || 0) + Math.round(performance.now() - t0);
    }

    // static track meshes, one instanced mesh per (shape, paint job)
    buildWorld() {
      const W = this.W, H_ = H, n = W[1];
      for (const m of this.statics.children) m.dispose && m.dispose();
      this.statics.clear();
      if (!this.loStatics) { this.loStatics = new T.Group(); this.scene.add(this.loStatics); }
      for (const m of this.loStatics.children) m.dispose && m.dispose();
      this.loStatics.clear();
      this.wkey = new Map(); this.terrain = new Set(); this.water = null; this.roofs = []; this.roofStrips = null; this.skyKeep = null; this.domeEased = false;
      const groups = new Map();
      for (let i = 0; i < n; i++) {
        const o = H_.WHDR + i * H_.WENT, hi = W[o], paint = W[o + 2], layer = W[o + 7] ? LAYER : 0;
        if (!layer) this.terrain.add(hi);
        const k = hi + ':' + paint + ':' + layer;
        if (!groups.has(k)) groups.set(k, { hi, paint, layer, list: [] });
        groups.get(k).list.push(o);
      }
      const M = new T.Matrix4(), R = new T.Matrix4();
      // the track's extent (for the track menu's overview)
      const box = this.worldBox = { x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9, y1: 0 };
      for (let pass = 0; pass < 2 && box.x0 > box.x1; pass++) for (let i = 0; i < n; i++) {
        const o = H_.WHDR + i * H_.WENT, x = W[o + 3], z = -W[o + 5];
        if (!pass && !W[o + 7]) continue;   // the track pieces (else everything)
        box.x0 = Math.min(box.x0, x); box.x1 = Math.max(box.x1, x); box.z0 = Math.min(box.z0, z); box.z1 = Math.max(box.z1, z); box.y1 = Math.max(box.y1, W[o + 4]); }
      if (!n) this.worldBox = null;
      { const m = this.mapBox = { x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9 };
        for (let i = 0; i < n; i++) { const o = H_.WHDR + i * H_.WENT, x = W[o + 3], z = -W[o + 5]; m.x0 = Math.min(m.x0, x - 512); m.x1 = Math.max(m.x1, x + 512); m.z0 = Math.min(m.z0, z - 512); m.z1 = Math.max(m.z1, z + 512); } }
      // pieces overlap their neighbours a little (below), but not at a crest: where a road climbs to a tile's edge and the
      // next piece goes on at that height (a slope up a hill into a hilltop ramp, a ramp's top into an elevated deck), the
      // one overhanging floated over the other's last bit of climb, and the inside of the hill showed under its lip as a
      // hairline of sky. Each piece's edges: their height at the tile's boundary, and whether its surface climbs to it.
      const edges = new Map(), noLap = new Map(), gc = new Map(), v3 = new T.Vector3(), Rm = new T.Matrix4();
      const geoOf = (hi, paint, layer) => { const k = hi + ':' + paint + ':' + layer; if (!gc.has(k)) gc.set(k, this.shapeGeo(hi, Math.max(0, paint), layer)); return gc.get(k); };
      for (let i = 0; i < n; i++) {
        const o = H_.WHDR + i * H_.WENT, g = geoOf(W[o], W[o + 2], W[o + 7] ? LAYER : 0);
        if (!g || g.userData.flat || !W[o + 7]) continue;   // (track pieces only: the scenery, the map's edge fences, keeps its overlap)
        const pos = g.getAttribute('position'), cx = W[o + 3], cz = -W[o + 5], y0 = W[o + 4];
        Rm.makeRotationY(-W[o + 6] * Math.PI * 2 / 1024);
        const vs = [];
        for (let k = 0; k < pos.count; k++) { v3.fromBufferAttribute(pos, k).applyMatrix4(Rm); vs.push([v3.x + cx, v3.y + y0, v3.z + cz]); }
        const mine = new Map();
        for (const [x, y, z] of vs) for (const [ax, a, b] of [[0, x, z], [2, z, x]]) {
          const B = Math.round(a / 1024) * 1024; if (Math.abs(a - B) > 6 || y < 20) continue;
          const key = ax + ':' + B + ':' + Math.floor(b / 1024), e = mine.get(key) || { i, side: Math.sign(B - (ax ? cz : cx)), h: 0, inc: false, ax, B, lat: Math.floor(b / 1024) };
          e.h = Math.max(e.h, y); mine.set(key, e);
        }
        for (const e of mine.values()) {
          // (climbing to it: an upward-facing face of it, tilted along the way across the edge, touching the edge at its top;
          // not a deck's flat top, its underside or its pillars)
          e.inc = false;
          for (let k = 0; k + 2 < vs.length && !e.inc; k += 3) {
            const [a, b, c] = [vs[k], vs[k + 1], vs[k + 2]];
            const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
            let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
            if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
            if (ny < 0.5 || Math.abs(e.ax ? nz : nx) < 0.03 || Math.abs(e.ax ? nz : nx) < Math.abs(e.ax ? nx : nz)) continue;   // (tilted along the way, not across it: a banked corner's road leans sideways, and its ends meet the next piece as any road does)
            e.inc = [a, b, c].some(([x, y, z]) => Math.abs((e.ax ? z : x) - e.B) < 6 && y > e.h - 20 && Math.floor((e.ax ? x : z) / 1024) === e.lat);
          }
          const key = e.ax + ':' + e.B + ':' + e.lat; if (!edges.has(key)) edges.set(key, []); edges.get(key).push(e);
        }
      }
      for (const list of edges.values()) for (const a of list) for (const b of list)
        if (a.i !== b.i && a.side === -b.side && Math.abs(a.h - b.h) < 15 && (a.inc || b.inc)) {
          const L = noLap.get(a.i) || []; if (!L.some(q => q.ax === a.ax && q.B === a.B)) L.push({ ax: a.ax, B: a.B, h: a.h, lat: a.lat }); noLap.set(a.i, L);
        }
      this.noLap = noLap;   // (for checking)
      for (const gr of groups.values()) {
        const geo = this.shapeGeo(gr.hi, Math.max(0, gr.paint), gr.layer);
        if (!geo) continue;
        const isec = new T.InstancedBufferAttribute(new Float32Array(gr.list.length), 1).setUsage(T.DynamicDrawUsage);
        const im = new T.InstancedMesh(withSec(geo, isec), this.matPair, gr.list.length);
        gr.isec = isec; gr.inst = gr.list.map(o => [W[o + 3], W[o + 4], -W[o + 5], -W[o + 6] * Math.PI * 2 / 1024]);
        gr.unk = geo.boundingBox || (geo.computeBoundingBox(), geo.boundingBox);
        gr.unk = Math.max(-gr.unk.min.x, gr.unk.max.x, -gr.unk.min.z, gr.unk.max.z) > 0x280 ? 0x800 : 0x400;
        im.castShadow = !geo.userData.flat; im.receiveShadow = true; im.frustumCulled = false; im.customDepthMaterial = depthNoSee();
        im.userData = gr; if (!gr.layer || geo.userData.flat) im.layers.enable(1);
        // (its shadow is its own, from the shape drawn: the game's low-detail shapes for the distance, cast instead to save
        // triangles, left out whole parts (a windmill's sails and most of its body, a barn's roof, ramps entirely))
        const bb = geo.boundingBox, slope = (this.isTerrain(gr.hi) || this.isHillRoad(gr.hi)) && bb.max.y - bb.min.y > 1;
        gr.list.forEach((o, j) => {
          M.makeTranslation(W[o + 3], W[o + 4], -W[o + 5]).multiply(R.makeRotationY(-W[o + 6] * Math.PI * 2 / 1024));
          // pieces overlap their neighbours a little: no cracks between tiles, as where a ramp meets the flat road
          // (the same colour meeting, so the overlap itself does not show)
          // (track pieces too: road meets road at their edges, and a hairline of grass showed between them)
          const nl = noLap.get((o - H_.WHDR) / H_.WENT);
          if (slope) {}   // (a hill's slopes (and a road up one): their edges meet their neighbours' exactly; grown, a slope's edge stands off the next one's, sky showing between)
          else if (!nl) { const dk = geo.userData.deck; M.multiply(new T.Matrix4().makeScale(dk ? dk[0] : 1.006, 1, geo.userData.roofed || dk && dk[1] === 1 ? 1 : 1.006)); }   // (a tunnel's see-through roof not along its length: two layers of it at each joint showed as a dark, flickering outline)
          else {   // (a crest on one side or both: that edge kept exactly on the boundary, the overlap all on the other side)
            const c = [W[o + 3], -W[o + 5]], sc = [1.006, 1.006], sh = [0, 0];
            for (const ax of [0, 1]) { const bs = nl.filter(q => (q.ax ? 1 : 0) === ax); if (bs.length > 1) sc[ax] = 1; else if (bs.length) sh[ax] = -(bs[0].B - c[ax]) * 0.006; }
            M.makeTranslation(c[0] + sh[0], W[o + 4], c[1] + sh[1]).multiply(new T.Matrix4().makeScale(sc[0], 1, sc[1])).multiply(R.makeRotationY(-W[o + 6] * Math.PI * 2 / 1024));
          }
          im.setMatrixAt(j, M);
          if (geo.userData.roofBox) this.roofs.push({ m: M.clone(), b: geo.userData.roofBox });
          const ent = { im, j, m: M.clone(), x: W[o + 3], y: W[o + 4], z: W[o + 5] };
          for (const [p, v] of [[W[o], ent], [W[o + 1], { lo: true, x: ent.x, y: ent.y, z: ent.z }]]) {
            if (!this.wkey.has(p)) this.wkey.set(p, []);
            if (v.lo && W[o + 1] === W[o]) continue;
            this.wkey.get(p).push(v);
          }
        });
        im.instanceMatrix.needsUpdate = true;
        this.statics.add(im);
      }
      this.hidden = []; this.giDirty = true; this.warmWorld = true;
    }

    // Baked light (L), at the first frame it is wanted after a track is built: the track lit by the whole sky, seen from
    // 64 directions spread over it (more of them high up, as the sky's light comes more from there). From each, the
    // track's depth (orthographic, its whole extent); then every cell of the volume over the track counts the
    // directions it can see the sky in (nothing nearer the sky at its place in that view), as a share, summed in a
    // half-float target. The view straight down also gives the ground's colour under each cell, fading with height.
    // Needs float colour targets (WebGL2 with EXT_color_buffer_float): without them, no baked light.
    bakeGI() {
      const r = this.r, gl = r.getContext(), t0 = performance.now();
      this.giDirty = false;
      if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) { this.giAvail = false; return; }
      const mb = this.mapBox; if (!mb || mb.x0 > mb.x1) return;
      let ytop = 0; for (const im of this.statics.children) { const g = im.geometry; if (!g.boundingBox) g.computeBoundingBox();
        for (const e of im.userData.inst || []) ytop = Math.max(ytop, e[1] + g.boundingBox.max.y); }
      const lo = new T.Vector3(mb.x0, -64, mb.z0), size = new T.Vector3(mb.x1 - mb.x0, Math.min(ytop, 6000) + 400, mb.z1 - mb.z0);
      const NX = Math.min(480, Math.ceil(size.x / 64)), NZ = Math.min(480, Math.ceil(size.z / 64)), NY = 40, TX = 8, TY = 5;
      const N = 64, DM = 1024;
      if (!this.giRT || this.giRT.width !== NX * TX || this.giRT.height !== NZ * TY) {
        if (this.giRT) this.giRT.dispose();
        this.giRT = new T.WebGLRenderTarget(NX * TX, NZ * TY, { type: T.HalfFloatType, format: T.RGBAFormat, minFilter: T.LinearFilter, magFilter: T.LinearFilter, depthBuffer: false, stencilBuffer: false });
      }
      if (!this.giDM) {
        this.giDM = new T.WebGLRenderTarget(DM, DM, { minFilter: T.NearestFilter, magFilter: T.NearestFilter });
        this.giDM.depthTexture = new T.DepthTexture(DM, DM); this.giDM.depthTexture.type = T.UnsignedIntType;
        this.giOver = new T.MeshBasicMaterial({ vertexColors: true, side: T.DoubleSide, fog: false });
        this.giAcc = new T.ShaderMaterial({
          uniforms: { tD: { value: null }, tC: { value: null }, vp: { value: new T.Matrix4() }, lo: { value: new T.Vector3() }, size: { value: new T.Vector3() },
            res: { value: new T.Vector3() }, tiles: { value: new T.Vector2(TX, TY) }, w: { value: 0 }, down: { value: 0 }, ground: { value: new T.Color() }, depthSpan: { value: 1 } },
          vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
          fragmentShader: `uniform sampler2D tD; uniform sampler2D tC; uniform mat4 vp; uniform vec3 lo; uniform vec3 size; uniform vec3 res; uniform vec2 tiles;
uniform float w; uniform float down; uniform vec3 ground; uniform float depthSpan;
void main() {
  vec2 px = gl_FragCoord.xy, tile = floor(px / res.xz), xz = px - tile * res.xz;
  float layer = tile.y * tiles.x + tile.x;
  vec3 p = lo + vec3(xz.x, layer + 0.5, xz.y) / vec3(res.x, res.y, res.z) * size;
  vec4 c = vp * vec4(p, 1.0); vec3 n = c.xyz / c.w * 0.5 + 0.5;
  float vis = 0.0;
  // (four taps a texel apart: a softer edge where a cell sits at a shadow's border in this direction)
  for (int i = 0; i < 4; i++) { vec2 o = (vec2(float(i - (i / 2) * 2), float(i / 2)) - 0.5) / ${DM}.0;
    vis += n.z <= texture2D(tD, n.xy + o).r + 0.0004 ? 0.25 : 0.0; }
  vec3 rgb = vec3(0.0);
  if (down > 0.5) { float d = texture2D(tD, n.xy).r; vec3 a = d >= 0.99999 ? ground : texture2D(tC, n.xy).rgb;
    float h = max(0.0, (n.z - min(d, 1.0)) * -depthSpan); h = d >= 0.99999 ? p.y : h;
    rgb = a * exp(-h / 260.0); }
  gl_FragColor = vec4(rgb, vis * w);
}`,
          depthTest: false, depthWrite: false, blending: T.CustomBlending, blendEquation: T.AddEquation, blendSrc: T.OneFactor, blendDst: T.OneFactor,
          blendEquationAlpha: T.AddEquation, blendSrcAlpha: T.OneFactor, blendDstAlpha: T.OneFactor });
        this.giQuad = new T.Mesh(new T.PlaneGeometry(2, 2), this.giAcc); this.giQuad.frustumCulled = false;
        this.giQS = new T.Scene(); this.giQS.add(this.giQuad); this.giQC = new T.Camera();
      }
      const U = this.giAcc.uniforms;
      U.lo.value.copy(lo); U.size.value.copy(size); U.res.value.set(NX, NY, NZ); U.tD.value = this.giDM.depthTexture; U.tC.value = this.giDM.texture;
      U.ground.value.copy(this.groundMat.color);
      // (the scene with only the track in it: everything else hidden for the bake, put back after)
      const vis = this.scene.children.map(c => c.visible), prevT = r.getRenderTarget(), sm = r.shadowMap.autoUpdate, ac = r.autoClear, cc = r.getClearColor(new T.Color()), ca = r.getClearAlpha();
      for (const c of this.scene.children) c.visible = c === this.statics;
      // (and not the clouds: scenery shapes too, up in the sky, they darkened everything under them)
      const clouds = this.statics.children.filter(im => im.visible && im.userData.hi != null && this.isCloud({ ptr: im.userData.hi, paint: Math.max(0, im.userData.paint) }));
      for (const im of clouds) im.visible = false;
      const fog = this.scene.fog; this.scene.fog = null; this.scene.overrideMaterial = this.giOver; r.shadowMap.autoUpdate = false;
      const ctr = lo.clone().addScaledVector(size, 0.5), R = size.length() * 0.5 + 200;
      const cam = new T.OrthographicCamera(-R, R, R, -R, 1, R * 2 + 400);
      r.setRenderTarget(this.giRT); r.setClearColor(0x000000, 0); r.clear(true, false, false);
      for (let i = 0; i < N; i++) {
        // (directions: cosine-weighted over the sky, a Fibonacci spiral; the first straight up)
        const u = (i + 0.5) / N, rad = Math.sqrt(u) * (i ? 1 : 0), phi = i * 2.39996323, y = Math.sqrt(1 - rad * rad);
        const d = new T.Vector3(Math.cos(phi) * rad, y, Math.sin(phi) * rad);
        cam.position.copy(ctr).addScaledVector(d, R + 200); cam.up.set(0, 0, 1); if (Math.abs(d.y) < 0.99) cam.up.set(0, 1, 0);
        cam.lookAt(ctr); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
        r.setRenderTarget(this.giDM); r.setClearColor(0x000000, 0); r.autoClear = true; r.render(this.scene, cam);
        U.vp.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); U.w.value = 1 / N; U.down.value = i ? 0 : 1; U.depthSpan.value = cam.far - cam.near;
        r.setRenderTarget(this.giRT); r.autoClear = false; r.render(this.giQS, this.giQC);
      }
      for (const im of clouds) im.visible = true;
      this.scene.overrideMaterial = null; this.scene.fog = fog; this.scene.children.forEach((c, k) => { c.visible = vis[k]; });
      r.shadowMap.autoUpdate = sm; r.autoClear = ac; r.setClearColor(cc, ca); r.setRenderTarget(prevT);
      GI_U.tGI.value = this.giRT.texture; GI_U.giMin.value.copy(lo); GI_U.giSize.value.copy(size); GI_U.giRes.value.set(NX, NY, NZ); GI_U.giTiles.value.set(TX, TY);
      this.giAvail = true; this.giMs = Math.round(performance.now() - t0);
    }
    giFrame() {
      if (this.warmWorld) { this.warmWorld = false; this.prewarm(); }   // (the track's own shapes' shaders, before its first frame)
      if (root.location && /[?&]gidebug=(\d)/.test(root.location.search)) GI_U.giDbg.value = +/[?&]gidebug=(\d)/.exec(root.location.search)[1];
      if (this.giOn && this.giDirty && this.statics.children.length) this.bakeGI();
      GI_U.giOn.value = this.giOn && this.giAvail && !this.giDirty ? 1 : 0;
    }

    // The original draws some one-sided faces from both sides, depending on the direction it looks at a piece
    // from (transformed_shape_op: when the piece is not round the camera, the view direction in the piece's
    // own axes picks one of 32 sectors; a face whose cull2 mask has that sector skips the facing test). Per
    // static instance here: its sector + 1 (0: round the camera, the facing test for all).
    viewSectors() {
      // (the camera's matrices are set by hand each frame: read, never recomputed from its position)
      const cam = this.cam, V = new T.Vector3(), VM = cam.matrixWorldInverse, e = cam.matrixWorld.elements;
      const F = new T.Vector3(-e[8], -e[9], -e[10]).normalize(), cp = this.camPos;
      for (const im of this.statics.children) {
        const gr = im.userData; if (!gr.isec || NOSEC) continue;
        const a = gr.isec.array;
        gr.inst.forEach(([x, y, z, r], j) => {
          V.set(x, y, z).applyMatrix4(VM);
          let s = 0;
          if (Math.abs(V.x) >= 2 * gr.unk || Math.abs(V.z) >= 2 * gr.unk) {
            // view direction in the piece's axes (the game's: z not mirrored)
            const c = Math.cos(r), sn = Math.sin(r), vx = c * F.x - sn * F.z, vy = F.y, vz = -(sn * F.x + c * F.z);
            if (vy <= 0 || y - cp.y >= 0) s = 1 + viewSector(vx, vy, vz);
          }
          a[j] = s;
        });
        gr.isec.needsUpdate = true;
      }
    }

    // the car select's picture as a texture (the screen, the original picture under the car's see-through
    // pixels), refreshed now and then: what the paint reflects there
    carPicture(car) {
      // (once per car shown, a little after it appears: the picture is still)
      const now = performance.now();
      let ph = 0; for (let i = 0; i < 768; i += 7) ph = (ph * 31 + this.pal[i]) | 0;   // (the palette: a fade in or out)
      const key = car + ':' + ph;
      if (key !== this.carPicCar) { this.carPicCar = key; this.carPicT = now; this.carPicDone = false; }
      if (this.carPicDone || now - this.carPicT < 300) { CARPIC.on.value = this.carPicTex ? 1 : 0; return; }
      this.carPicDone = true;
      // (averaged over 10x10 blocks: broad areas of colour, smooth in the paint, not the wall's speckle)
      const BW = 32, BH = 20;
      if (!this.carPicData) { this.carPicData = new Uint8Array(BW * BH * 4); this.carPicTex = new T.DataTexture(this.carPicData, BW, BH, T.RGBAFormat); this.carPicTex.flipY = false; this.carPicTex.magFilter = this.carPicTex.minFilter = T.LinearFilter; this.carPicTex.wrapS = T.RepeatWrapping; }
      const m = this.mem, p = this.pal, d = this.carPicData, KEY = root.StuntsHires ? root.StuntsHires.KEY : 233;
      d.fill(0); const acc = new Float32Array(BW * BH * 3);
      for (let i = 0; i < 64000; i++) {
        let v = m[0xA0000 + i]; if (v === KEY) v = this.bgU8[i];
        const b = (((i / 320) | 0) / 10 | 0) * BW + ((i % 320) / 10 | 0);
        acc[b * 3] += p[v * 3]; acc[b * 3 + 1] += p[v * 3 + 1]; acc[b * 3 + 2] += p[v * 3 + 2];
      }
      for (let b = 0; b < BW * BH; b++) { for (let k = 0; k < 3; k++) d[b * 4 + k] = acc[b * 3 + k] / 100 * 255 / 63; d[b * 4 + 3] = 255; }
      this.carPicTex.needsUpdate = true; CARPIC.tex.value = this.carPicTex; CARPIC.on.value = 1;
    }

    solidInvisible() {
      if (!this._solidInv) { const a = this.S.trkObjectList + 167 * 14; this._solidInv = new Set([this.rw(a + 4), this.rw(a + 6)]); }
      return this._solidInv;
    }

    // a sky shape made only of light greys is a cloud
    isCloud(o) {
      const sh = this.shape(o.ptr, o.paint);
      if (sh.cloud === undefined) sh.cloud = sh.prims.length > 0 && sh.prims.every(p => Math.max(...p.c) - Math.min(...p.c) < 0.1 && p.c[0] > 0.4);
      return sh.cloud;
    }

    // Windmill sails. The original draws them as a disc of 16 thin wedges round the hub, four of them solid (the
    // blades) and the rest not drawn, the solid ones moving on by one wedge every four game frames (four "paint
    // jobs" of the shape): a turn in steps of 22.5 degrees five times a second. Here the blades are the same solid
    // wedges turned smoothly by the fraction of a step the picture's time is through.
    sailInfo(hi) {
      const sh0 = this.shape(hi, 0), k0 = sh0.key;
      this.sails = this.sails || new Map();
      if (this.sails.has(k0)) return this.sails.get(k0);
      let info = null;
      try {
        const S = [0, 1, 2, 3].map(k => this.shape(hi, k)), n = S[0].prims.length;
        if (S.every(x => x.prims.length === n)) {
          const diff = [];
          for (let i = 0; i < n; i++) {
            const p = S[0].prims[i]; let d = false;
            for (let k = 1; k < 4 && !d; k++) {
              const q = S[k].prims[i];
              if (p.pat !== q.pat || p.tri.length !== q.tri.length) { d = true; break; }
              for (let t = 0; t < p.tri.length; t++) if (Math.abs(p.tri[t] - q.tri[t]) > 0.01) { d = true; break; }
            }
            if (d) diff.push(i);
          }
          if (diff.length >= 8 && diff.every(i => S[0].prims[i].tri.length === 9)) {
            const cnt = new Map();
            for (const i of diff) { const t = S[0].prims[i].tri; for (let k = 0; k < 9; k += 3) { const key = t[k] + ',' + t[k + 1] + ',' + t[k + 2]; cnt.set(key, (cnt.get(key) || 0) + 1); } }
            let hub = null, best = 0; for (const [k, c] of cnt) if (c > best) { best = c; hub = k.split(',').map(Number); }
            const flat = diff.every(i => { const t = S[0].prims[i].tri; return Math.abs(t[2] - hub[2]) < 0.01 && Math.abs(t[5] - hub[2]) < 0.01 && Math.abs(t[8] - hub[2]) < 0.01; });
            if (best === diff.length && flat) {
              const ang = (k) => diff.filter(i => S[k].prims[i].pat !== 0).map(i => { const t = S[k].prims[i].tri; return Math.atan2((t[1] + t[4] + t[7]) / 3 - hub[1], (t[0] + t[3] + t[6]) / 3 - hub[0]); });
              const A0 = ang(0), A1 = ang(1), wrap = d => { d = (d + Math.PI / 4) % (Math.PI / 2); if (d < 0) d += Math.PI / 2; return d - Math.PI / 4; };
              let delta = 1e9; for (const a1 of A1) for (const a0 of A0) { const d = wrap(a1 - a0); if (Math.abs(d) < Math.abs(delta)) delta = d; }
              const e4 = Array.from({ length: 16 }, (_, i) => this.mem[(this.D << 4) + this.S.byte_3C0C6 + i]);
              if (A0.length && A0.length === A1.length && Math.abs(delta) > 0.2 && Math.abs(delta) < 0.6 && e4.every((v, i) => v === i >> 2))
                info = { base: sh0, diff: new Set(diff), hub, delta: Math.sign(delta) * Math.PI / 8, geos: new Map() };   // (a wedge of 16 exactly: as measured it was a little off, and the sails jumped back a few degrees once a quarter turn)
            }
          }
        }
      } catch (_) {}
      this.sails.set(k0, info);
      return info;
    }
    sailShape(si, q) {   // the shape with its blades turned q / 192 of a cycle (a cycle: four steps, a quarter turn)
      let sh = si.geos.get(q);
      if (sh) return sh;
      const al = q / 48 * si.delta, c = Math.cos(al), sn = Math.sin(al), [hx, hy] = si.hub;
      const prims = [];
      si.base.prims.forEach((p, i) => {
        if (!si.diff.has(i)) { prims.push(p); return; }
        if (p.pat === 0) return;
        const t = Float32Array.from(p.tri);
        for (let k = 0; k < t.length; k += 3) { const x = t[k] - hx, y = t[k + 1] - hy; t[k] = hx + x * c - y * sn; t[k + 1] = hy + x * sn + y * c; }
        prims.push(Object.assign({}, p, { tri: t }));
      });
      sh = Object.assign({}, si.base, { prims, key: si.base.key + ':sail' + q });
      si.geos.set(q, sh);
      return sh;
    }

    // a shape (all primitives) as mirrored-z geometry with colour, decal rank and stipple attributes
    shapeGeo(ptr, paint, layer = 0, over = null) {
      const sh = over || this.shape(ptr, paint), key = sh.key + ':' + layer;
      if (this.geoCache.has(key)) return this.geoCache.get(key);
      let nv = 0;
      for (const p of sh.prims) if (p.pat !== 0) nv += p.tri.length / 3;
      if (!nv) { this.geoCache.set(key, null); return null; }
      const nocast = new Float32Array(nv), pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3), rank = new Float32Array(nv), pat = new Float32Array(nv), lo = new Float32Array(nv * 3), one = new Float32Array(nv), spin = new Float32Array(nv), c2 = new Float32Array(nv * 2), f0 = new Float32Array(nv * 3), fn = new Float32Array(nv * 3);
      let v = 0, nSolid = 0;
      const order = sh.prims.filter(p => !seeThrough(p.pat)).concat(sh.prims.filter(p => seeThrough(p.pat)));
      for (const p of order) {
        if (p.pat === 0) continue;
        if (!seeThrough(p.pat)) nSolid += p.tri.length / 3;
        const c = lin(p.c), t = p.tri;
        for (let i = 0; i < t.length; i += 3, v++) {
          pos[v * 3] = t[i]; pos[v * 3 + 1] = t[i + 1]; pos[v * 3 + 2] = -t[i + 2];
          col[v * 3] = c[0]; col[v * 3 + 1] = c[1]; col[v * 3 + 2] = c[2]; rank[v] = (p.rank + layer) * RANKS + p.idx; pat[v] = p.pat;
          if (p.lofs) { lo[v * 3] = p.lofs[i]; lo[v * 3 + 1] = p.lofs[i + 1]; lo[v * 3 + 2] = -p.lofs[i + 2]; }
          one[v] = p.one; spin[v] = p.slope ? -1 : p.glass ? 0.25 : 0; c2[v * 2] = p.cull2 & 0xFFFF; c2[v * 2 + 1] = p.cull2 >>> 16; nocast[v] = p.canopy ? 1 : p.ribbon || seeThrough(p.pat) && p.plane && p.plane.n[1] > 0.85 ? 2 : 0;   // (2: see-through, casts all the same: decided here, from the face's own plane, as the moving pieces' shadows decide it (DynBuf.fill); the normals three.js makes point the other way)
          if (p.f3 && p.one) { f0.set(p.f3[0], v * 3); fn.set(p.f3[1], v * 3); }
        }
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('color', new T.BufferAttribute(col, 3));
      g.setAttribute('rank', new T.BufferAttribute(rank, 1)); g.setAttribute('pat', new T.BufferAttribute(pat, 1)); g.setAttribute('lofs', new T.BufferAttribute(lo, 3)); g.setAttribute('c2', new T.BufferAttribute(c2, 2)); g.setAttribute('f0', new T.BufferAttribute(f0, 3)); g.setAttribute('fn', new T.BufferAttribute(fn, 3));
      g.setAttribute('nocast', new T.BufferAttribute(nocast, 1)); g.setAttribute('spin', new T.BufferAttribute(spin, 1));
      g.addGroup(0, nSolid, 0); g.addGroup(nSolid, nv - nSolid, 2); g.addGroup(nSolid, nv - nSolid, 1);
      g.computeVertexNormals();   // face normals (non-indexed); three.js's shadow lookup needs a normal
      g.userData.flat = sh.flat; g.userData.key = sh.key; g.userData.roofed = sh.prims.some(p => p.roof);
      { // (a see-through deck, a bridge's: along its length, no overlap with the next piece (two layers of it at the joint
        // flickered as a dark line across the road), as a tunnel's roof; x0, z0 the deck faces' extent across and along)
        let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
        for (const p of sh.prims) if (seeThrough(p.pat) && !p.ribbon && p.plane && p.plane.n[1] > 0.85) for (let k = 0; k < p.tri.length; k += 3) { x0 = Math.min(x0, p.tri[k]); x1 = Math.max(x1, p.tri[k]); z0 = Math.min(z0, p.tri[k + 2]); z1 = Math.max(z1, p.tri[k + 2]); }
        if (x1 > x0) g.userData.deck = [x1 - x0 > 900 ? 1 : 1.006, z1 - z0 > 900 ? 1 : 1.006];
      }
      if (g.userData.roofed) {   // (the roof's extent, in the geometry's own (mirrored) space: x0, z0, x1, z1, its lowest y)
        const b = [1e9, 1e9, -1e9, -1e9, 1e9];
        for (const p of sh.prims) if (p.roof) for (let k = 0; k < p.tri.length; k += 3) { b[0] = Math.min(b[0], p.tri[k]); b[2] = Math.max(b[2], p.tri[k]); b[1] = Math.min(b[1], -p.tri[k + 2]); b[3] = Math.max(b[3], -p.tri[k + 2]); b[4] = Math.min(b[4], p.tri[k + 1]); }
        g.userData.roofBox = b;
      }
      if (this.geoCache.size > 2000) this.geoCache.clear();
      this.geoCache.set(key, g);
      return g;
    }

    // per captured shape: three.js-space 3x4 transform (rotation part already mirrored)
    placeModern(f) {
      const R = f.R.elements, race = !!f.cam;   // f.R: camera rotation (column-major storage of a row matrix)
      // Rc[i][j]
      const Rc = (i, j) => R[j * 4 + i];
      for (const o of f.objs) {
        const C = o.C, Wm = new Array(12);
        // stunts world: p = Rc^T (C v + t) + cam ; in the menus the camera space is the world
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) Wm[i * 4 + j] = race ? Rc(0, i) * C[j] + Rc(1, i) * C[4 + j] + Rc(2, i) * C[8 + j] : C[i * 4 + j];
          Wm[i * 4 + 3] = race ? Rc(0, i) * C[3] + Rc(1, i) * C[7] + Rc(2, i) * C[11] + f.cam[i] : C[i * 4 + 3];
        }
        // mirror z: S W S
        Wm[2] = -Wm[2]; Wm[6] = -Wm[6]; Wm[8] = -Wm[8]; Wm[9] = -Wm[9]; Wm[11] = -Wm[11];
        o.Wm = Wm;
      }
    }

    // a horizon panorama on a cylinder fixed in the world round the camera, its bottom edge on the horizon,
    // ang radians high; mode: how the sky is see-through (0 the image's alpha, 1 a key colour, 2 fading out
    // towards the top, 3 the alpha of a pixel picture, smoothed into a clean outline); hazed like the distance
    horizonMesh(tex, ang, mode, key, hazeAmt, foot = 0.85) {
      const R = 150000, h = R * Math.tan(ang);
      const mat = new T.ShaderMaterial({
        transparent: true, depthTest: false, depthWrite: false, side: T.DoubleSide,
        uniforms: { map: { value: tex }, haze: { value: new T.Color() }, key: { value: new T.Vector3(...key) }, mode: { value: mode }, hazeAmt: { value: hazeAmt }, foot: { value: foot }, uvT: { value: new T.Vector2(tex.repeat.x, tex.offset.x) } },
        // (the texture's repeat and offset round the circle: a ShaderMaterial does not apply them itself)
        vertexShader: 'uniform vec2 uvT; varying vec2 vUv; void main() { vUv = vec2(uv.x * uvT.x + uvT.y, uv.y); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform sampler2D map; uniform vec3 haze; uniform vec3 key; uniform float mode; uniform float hazeAmt; uniform float foot; varying vec2 vUv;
void main() {
  if (${GAPVIZ ? 1 : 0} > 0) discard;
  vec4 t = texture2D(map, vUv);
  float w = fwidth(t.a) * 0.7 + 0.02;
  float a = mode < 0.5 ? t.a : mode < 1.5 ? smoothstep(0.08, 0.2, distance(t.rgb, key)) : mode < 2.5 ? 1.0 - smoothstep(0.45, 0.92, vUv.y) : smoothstep(0.5 - w, 0.5 + w, t.a);
  gl_FragColor = vec4(mix(t.rgb, haze, hazeAmt + (foot - hazeAmt) * (1.0 - smoothstep(0.0, 0.2, vUv.y))), a);   // hazier at its foot (as the land there)
}`,
      });
      const geo = new T.CylinderGeometry(R, R, h, 256, 1, true).translate(0, h / 2, 0);
      const m = new T.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = 1;
      this.domeScene.add(m);
      return m;
    }

    // The original horizon, from the four sprites load_skybox located (skyboxes: far pointers to SHAPE2Ds)
    // laid side by side as skybox_op_helper2 does (x 0, 320, 512, 832: 1024 columns, a full turn, bottom
    // edges on the horizon), the sky see-through. Rebuilt when the scenery changes.
    horizonNative() {
      const S = this.S, m = this.mem, sp = [];
      for (let k = 0; k < 4; k++) {
        const off = this.rw(S.skyboxes + k * 4), seg = this.rw(S.skyboxes + k * 4 + 2), a = ((seg << 4) + off) & 0xFFFFF;
        sp.push({ a, w: m[a] | (m[a + 1] << 8), h: m[a + 2] | (m[a + 3] << 8) });
      }
      const key = sp.map(q => q.a + ':' + q.w + 'x' + q.h).join(' ');
      if (key === this.natKey) return this.natMesh;
      // (the game rewriting its skybox pointers, caught half-way: the skyline there is stays; else it would
      // flash away for a frame and be built again)
      if (this.natMesh && (sp.some(q => !q.a || !q.w || q.h > 64) || sp.reduce((t, q) => t + q.w, 0) !== 1024)) return this.natMesh;
      this.natKey = key;
      if (this.natMesh) { this.domeScene.remove(this.natMesh); this.natMesh.geometry.dispose(); this.natMesh.material.uniforms.map.value.dispose(); this.natMesh = null; }
      if (sp.some(q => !q.a || !q.w || q.h > 64) || sp.reduce((t, q) => t + q.w, 0) !== 1024) { this.natIdx = null; return null; }
      const H = Math.max(...sp.map(q => q.h)), idx = new Int16Array(1024 * H).fill(-1);
      let x0 = 0;
      for (const q of sp) { for (let y = 0; y < q.h; y++) for (let x = 0; x < q.w; x++) idx[(H - q.h + y) * 1024 + x0 + x] = m[q.a + 16 + y * q.w + x]; x0 += q.w; }
      // sky: from the top of each column down, the picture's top-row colours and other bright sky blues
      const pal = this.pal, sky = new Uint8Array(256);
      const cnt = new Uint16Array(256);   // (the commonest colour at the tops of the sprites: their own sky)
      for (let x = 0; x < 1024; x++) for (let y = 0; y < H; y++) if (idx[y * 1024 + x] >= 0) { cnt[idx[y * 1024 + x]]++; break; }
      let top = 0; for (let i = 1; i < 256; i++) if (cnt[i] > cnt[top]) top = i;
      sky[top] = 1; sky[this.rw(S.skybox_sky_color) & 255] = 1;
      for (let i = 0; i < 256; i++) { const r = pal[i * 3] / 63, g = pal[i * 3 + 1] / 63, b = pal[i * 3 + 2] / 63; if (b >= g * 0.95 && b > r + 0.12 && (r + g + b) / 3 > 0.45) sky[i] = 1; }
      const d = new Uint8Array(1024 * H * 4), skyM = this.natSky = new Uint8Array(1024 * H);
      for (let x = 0; x < 1024; x++) {
        let y = 0;
        while (y < H && (idx[y * 1024 + x] < 0 || sky[idx[y * 1024 + x]])) y++;
        for (let yy = 0; yy < H; yy++) {
          const c = idx[Math.max(yy, Math.min(y, H - 1)) * 1024 + x], o = ((H - 1 - yy) * 1024 + x) * 4;   // (sky pixels take the colour below: no dark fringe)
          if (c >= 0) { d[o] = pal[c * 3] * 255 / 63; d[o + 1] = pal[c * 3 + 1] * 255 / 63; d[o + 2] = pal[c * 3 + 2] * 255 / 63; }
          d[o + 3] = yy >= y ? 255 : 0; skyM[yy * 1024 + x] = yy < y ? 1 : 0;
        }
      }
      this.natIdx = idx; this.natH = H;
      if (this.stripTex) this.stripTex.dispose();
      // the strip's texture: the sprites as they are (sky see-through), one texel per sprite pixel, drawn
      // sharp; ?smoothsky enlarges them 8 times with Scale2x first (smooth diagonals, the same colours)
      let val = new Int16Array(1024 * H), w = 1024, h = H;
      for (let i = 0; i < val.length; i++) val[i] = skyM[i] ? -1 : idx[i];
      const passes = !/[?&]smoothsky/.test(root.location.search) ? 0 : this.r.capabilities.maxTextureSize >= 8192 ? 3 : 2;
      for (let p = 0; p < passes; p++) { val = scale2x(val, w, h); w *= 2; h *= 2; }
      const big = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const c = val[y * w + x], o = ((h - 1 - y) * w + x) * 4;
        if (c >= 0) { big[o] = pal[c * 3] * 255 / 63; big[o + 1] = pal[c * 3 + 1] * 255 / 63; big[o + 2] = pal[c * 3 + 2] * 255 / 63; big[o + 3] = 255; }
      }
      this.stripTex = new T.DataTexture(big, w, h, T.RGBAFormat); this.stripTex.wrapS = T.RepeatWrapping; this.stripTex.needsUpdate = true;   // (nearest: crisp)
      const tex = new T.DataTexture(d, 1024, H, T.RGBAFormat);
      tex.wrapS = T.RepeatWrapping; tex.magFilter = T.LinearFilter; tex.minFilter = T.LinearFilter; tex.offset.x = HD_OFFSET; tex.needsUpdate = true;
      // on the cylinder: the pixels enlarged 4 times (sharp), then filtered with mipmaps: no crawling or
      // shimmer as the view turns; the panorama goes round SKY_WRAPS times (its pixels about 0.7 times the
      // original's size on screen, rows ROW_ASPECT times as tall as columns, as the original's 4:3 pixels)
      const U = 4, W4 = 1024 * U, H4 = H * U, d4 = new Uint8Array(W4 * H4 * 4);
      for (let y = 0; y < H4; y++) { const sy = (y / U) | 0; for (let x = 0; x < W4; x++) { const so = (sy * 1024 + ((x / U) | 0)) * 4, o = (y * W4 + x) * 4; d4[o] = d[so]; d4[o + 1] = d[so + 1]; d4[o + 2] = d[so + 2]; d4[o + 3] = d[so + 3]; } }
      const t4 = new T.DataTexture(d4, W4, H4, T.RGBAFormat);
      t4.wrapS = T.RepeatWrapping; t4.magFilter = T.LinearFilter; t4.minFilter = T.LinearMipmapLinearFilter; t4.generateMipmaps = true;
      t4.anisotropy = this.r.capabilities.getMaxAnisotropy(); t4.repeat.x = SKY_WRAPS * SKY_NARROW; t4.offset.x = HD_OFFSET;   // (narrower than its rows' proportion: SKY_NARROW) t4.needsUpdate = true;
      tex.dispose();
      this.natMesh = this.horizonMesh(t4, H / (1024 * SKY_WRAPS) * 2 * Math.PI * ROW_ASPECT, 3, [0, 0, 0], 0.32);
      return this.natMesh;
    }

    // A high-resolution 360° horizon for a scenery, if horizons/<name>_hd.(webp|jpg|png) exists (see
    // horizons/README.md): a cylinder fixed in the world around the camera, its bottom edge on the horizon.
    // An image with the original's proportions wraps once with the original's row/column angles; a taller
    // one (a reimagined panorama) keeps square pixels and repeats round the circle as often as keeps it about
    // HD_SCALE times the original's height. A plain sky (the colour of its top row, covering much of the image) is see-through; a
    // photographic sky fades into the sky dome towards the top.
    horizonHD(scen) {
      const name = SCENERY[scen];
      if (!name || !HD_SKY) return null;   // (off unless ?hdsky: the panoramas are made from the game's files, so never on the site)
      if (this.hd.has(name)) return this.hd.get(name);
      this.hd.set(name, null);
      const img = new Image(), exts = ['webp', 'jpg', 'png'];
      img.onerror = () => { if (exts.length) img.src = 'horizons/' + name + '_hd.' + exts.shift(); };
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const all = g.getImageData(0, 0, img.width, img.height).data, n = all.length / 4;
        const key = [0, 0, 0]; for (let i = 0; i < img.width; i++) for (let k = 0; k < 3; k++) key[k] += all[i * 4 + k] / 255 / img.width;
        let alpha = false, near = 0;
        for (let i = 0; i < n; i += 7) {
          if (all[i * 4 + 3] < 250) alpha = true;
          if (Math.hypot(all[i * 4] / 255 - key[0], all[i * 4 + 1] / 255 - key[1], all[i * 4 + 2] / 255 - key[2]) < 0.12) near++;
        }
        const keyed = near / (n / 7) > 0.15;
        const tex = new T.CanvasTexture(c); tex.wrapS = T.RepeatWrapping; tex.anisotropy = this.r.capabilities.getMaxAnisotropy();
        const ratio = img.height / img.width, R = 150000;
        let ang, reps = 1;
        if (ratio < 0.06) {
          // the original's proportions: rows ROW_ASPECT times the angle of columns (the race projection's 230
          // vs 155 pixels per radian); the _x8 files already carry 1.2 of that (4:3 display pixels)
          const baked = ratio > NATIVE_H[scen] / 1024 * 1.1;
          ang = ratio * 2 * Math.PI * (baked ? ROW_ASPECT / 1.2 : ROW_ASPECT);
          tex.offset.x = HD_OFFSET;
        } else {
          reps = Math.max(1, Math.round(ratio * 2 * Math.PI / (Math.max(NATIVE_H[scen], 30) / 155 * HD_SCALE)));
          ang = ratio * 2 * Math.PI / reps;
        }
        tex.repeat.x = reps;
        this.hd.set(name, this.horizonMesh(tex, ang, alpha ? 0 : keyed ? 1 : 2, key, ratio < 0.06 ? 0.32 : 0.14));
      };
      img.src = 'horizons/' + name + '_hd.' + exts.shift();
      return null;
    }

    // Clouds. The game places each one at a fixed depth (15000) and height in front of its camera, levelled
    // (its pitch undone), turned to face along the camera's heading, and sideways at 15000 * sin(h - yaw),
    // h being the cloud's own fixed heading: so h = yaw + asin(x / depth), exactly, from any game camera
    // (chase, TV, helicopter, in-car). Each cloud seen is remembered at that heading, height and depth and
    // drawn there round the viewer every frame, facing it: fixed in the world, no drift, no size or twist
    // changes, and none popping in at the edges of a wider or trailing view.
    cloudSky(seen, cur) {
      const reg = this.cloudReg || (this.cloudReg = []);
      const now = performance.now();
      const dAng = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
      // (the camera's whole turn undone, its roll and pitch as well as its heading: the in-car camera leans and pitches
      // with the car, and undoing its pitch alone put clouds at wrong heights and headings as the car rolled on a bank or
      // went over a jump: they drifted on their own, and some were taken for new clouds and drawn again beside themselves)
      // (R's rows are the camera's axes in the world: camera space C = R w, so w = R^T C; then turned to its heading)
      const e = cur.R.elements, row = r => [e[r], e[r + 4], e[r + 8]], R0 = row(0), R1 = row(1), R2 = row(2);
      const yaw = Math.atan2(R2[0], R2[2]), cy = Math.cos(yaw), sy = Math.sin(yaw);
      const level = (X, Y, Z) => { const wx = X * R0[0] + Y * R1[0] + Z * R2[0], wy = X * R0[1] + Y * R1[1] + Z * R2[1], wz = X * R0[2] + Y * R1[2] + Z * R2[2];
        return [wx * cy - wz * sy, wy, wx * sy + wz * cy]; };
      const unlevel = (hx, hy, hz) => { const wx = hx * cy + hz * sy, wz = -hx * sy + hz * cy;
        return [R0[0] * wx + R0[1] * hy + R0[2] * wz, R1[0] * wx + R1[1] * hy + R1[2] * wz, R2[0] * wx + R2[1] * hy + R2[2] * wz]; };
      for (const o of seen) {
        const [X, Yl, Zl] = level(o.C[3], o.C[7], o.C[11]);   // camera space, levelled: sideways, up, ahead
        if (Zl < 1000) continue;
        const az = Math.PI - (yaw + Math.asin(Math.max(-1, Math.min(1, X / Zl))));   // three.js heading (stunts z mirrored)
        let c = null, bd = 0.05;
        for (const r of reg) if (r.ptr === o.ptr) { const d = Math.abs(dAng(az, r.az)); if (d < bd) { bd = d; c = r; } }
        if (!c) reg.push(c = { ptr: o.ptr, paint: o.paint, az, d: Zl, y: Yl, at: now });
        else { c.az += dAng(az, c.az) * 0.2; c.d += (Zl - c.d) * 0.2; c.y += (Yl - c.y) * 0.2; c.paint = o.paint; c.at = now; }   // (integer noise only)
      }
      // (one remembered where the game would draw it now, well inside its view, and not drawn there for half a second:
      // a stray copy, or the clouds moved: dropped. A cloud a camera saw slightly off its remembered heading (a camera
      // change, the in-car view leaning on a banked road) was added again beside the first, and they built up)
      // (how far to the side and how high the game draws clouds: learnt from the ones it draws; 'well inside' is within
      // 80% of the furthest to the side, and level with one drawn this frame, as all of a track's clouds are equally high)
      const vy = [];
      for (const o of seen) { const X = o.C[3], Y = o.C[7], Z = o.C[11]; if (Z > 1000) { this.cloudX = Math.max(this.cloudX || 0, Math.abs(X / Z)); vy.push(Y / Z); } }
      if (vy.length && this.cloudX > 0.2) for (let i = reg.length - 1; i >= 0; i--) {
        const c = reg[i], a = Math.PI - c.az - yaw;   // (the game's sideways angle for it: X = depth * sin a, at its depth)
        if (Math.cos(a) < 0.5 || now - c.at < 500) continue;
        const [X, Y, Z] = unlevel(c.d * Math.sin(a), c.y, c.d * Math.cos(a));   // (where in the camera's view it would be)
        if (Z > 1000 && Math.abs(X / Z) < 0.8 * this.cloudX && vy.some(v => Math.abs(v - Y / Z) < 0.05)) reg.splice(i, 1);
      }
      const p = this.camPos;
      return reg.map(c => {
        const s = Math.sin(c.az), k = Math.cos(c.az);   // facing the viewer: rotY(az + pi)
        return { ptr: c.ptr, paint: c.paint, flags: 3, fixed: true, mask: [~0, ~0, ~0, ~0, ~0, ~0, ~0, ~0],
          Wm: [-k, 0, -s, p.x + s * c.d, 0, 1, 0, p.y + c.y, s, 0, -k, p.z + k * c.d] };
      });
    }

    // The game places a car only while it is in its own (4:3) view: the opponent beside or behind the player
    // would vanish in a wider or trailing view. When there is an opponent (gameconfig.game_opponenttype) and
    // the frame has none near where its state says it is (state.opponentstate: car_posWorld1 / 64, yaw in
    // car_rotate), it is added at that place, upright, in its paint (gameconfig.game_opponentmaterial).
    addOpponent(f) {
      if (!f.cam) return;
      const m = this.mem, D = this.D << 4, cfg = this.S.gameconfig;
      if (!m[D + cfg + 6]) return;
      const hi = this.rw(this.S.trkObjectList + 3 * 14 + 4), lo = this.rw(this.S.trkObjectList + 3 * 14 + 6);
      if (!hi) return;
      const st = this.S.state + 0x222, rl = o => { const a = D + ((st + o) & 0xFFFF); return m[a] | (m[a + 1] << 8) | (m[a + 2] << 16) | (m[a + 3] << 24); };
      const x = rl(0) / 64, y = rl(4) / 64, z = -rl(8) / 64;
      for (const o of f.objs) if ((o.ptr === hi || o.ptr === lo) && Math.hypot(o.Wm[3] - x, o.Wm[11] - z) < 300) return;
      const yaw = this.s16(this.rw(st + 24)) * 2 * Math.PI / 1024, c = Math.cos(yaw), s = Math.sin(yaw);
      f.objs.push({ ptr: hi, paint: m[D + cfg + 11], flags: 0, mask: new Int32Array(8).fill(-1), wp: [x, y, -z], pos: new T.Vector3(), Wm: [c, 0, s, x, 0, 1, 0, y, -s, 0, c, z] });
    }

    // The game keeps a car's origin CAR_Y above the road and its wheels reach a little below the origin: cars
    // are lowered along their own up axis until the wheels touch (else they float over their shadows).
    // Done once per game frame, as it arrives, so the camera and the drawing see the same place.
    sinkCars(f) {
      if (!f.cam) return;
      const ptrs = new Set();
      for (const i of [2, 3]) for (const k of [4, 6]) ptrs.add(this.rw(this.S.trkObjectList + i * 14 + k));
      for (const o of f.objs) {
        if (!ptrs.has(o.ptr)) continue;
        const sh = this.shape(o.ptr, o.paint);
        if (sh.wheelMin == null) { sh.wheelMin = 0; let w = Infinity; for (const p of sh.prims) if (p.wheel) for (let i = 1; i < p.tri.length; i += 3) w = Math.min(w, p.tri[i]); if (w < Infinity) sh.wheelMin = w; }
        const k = CAR_Y + sh.wheelMin, W = o.Wm;
        if (k > 0 && k < 20) { W[3] -= W[1] * k; W[7] -= W[5] * k; W[11] -= W[9] * k; }
      }
    }

    // The game draws cars from camera-space integers and an integer camera: their places jitter by a unit or
    // two from frame to frame (and up and down by one). The car states hold them in 1/64 units
    // (state.playerstate / opponentstate .car_posWorld1): use those. Done as the frame arrives.
    preciseCars(f) {
      if (!f.cam) return;
      const m = this.mem, D = this.D << 4;
      const rl = a => { a = D + (a & 0xFFFF); return m[a] | (m[a + 1] << 8) | (m[a + 2] << 16) | (m[a + 3] << 24); };
      for (const [idx, st] of [[2, this.S.state + 338], [3, this.S.state + 546]]) {
        const ptrs = [4, 6].map(k => this.rw(this.S.trkObjectList + idx * 14 + k));
        const x = rl(st) / 64, y = rl(st + 4) / 64, z = -rl(st + 8) / 64;
        let best = null, bd = 6 * 6;   // (only when it is clearly this frame's car)
        for (const o of f.objs) if (ptrs.includes(o.ptr)) { const d = (o.Wm[3] - x) ** 2 + (o.Wm[7] - y) ** 2 + (o.Wm[11] - z) ** 2; if (d < bd) { bd = d; best = o; } }
        if (best) { best.Wm[3] = x; best.Wm[7] = y; best.Wm[11] = z; }
      }
    }

    // TV and helicopter cameras (modes 3 and 1) aim at the followed car with integer angles: they turn in
    // steps of 1/1024 of a turn. Aim at the eased car instead, keeping the game's framing (the car's
    // direction in the game's camera space, smoothed) and the game's camera position. Changes q in place.
    aimCam(cur, ease, q, cp) {
      const mode = cur.mode != null ? cur.mode : this.mem[(this.D << 4) + this.S.cameramode];
      if (mode !== 1 && mode !== 3) { this.aim = null; return; }
      const idx = this.mem[(this.D << 4) + this.S.followOpponentFlag] ? 3 : 2;
      const ptrs = [4, 6].map(f => this.rw(this.S.trkObjectList + idx * 14 + f));
      let o = null, bd = Infinity;
      for (const c of cur.objs) if (ptrs.includes(c.ptr)) { const d = (c.Wm[3] - cp.x) ** 2 + (c.Wm[7] - cp.y) ** 2 + (c.Wm[11] - cp.z) ** 2; if (d < bd) { bd = d; o = c; } }
      if (!o) { this.aim = null; return; }
      const M = ease(o), car = new T.Vector3(M[3], M[7], M[11]);
      // the game's framing this game frame: the car's direction in its camera space
      const gq = quat(cur.R), gc = new T.Vector3(cur.cam[0], cur.cam[1], -cur.cam[2]);
      const dGame = new T.Vector3(o.Wm[3], o.Wm[7], o.Wm[11]).sub(gc).applyQuaternion(gq).normalize();
      let A = this.aim;
      // the framing eases towards the game's on every display frame (not in a step each game frame: that was
      // the TV camera's jerk, every third frame at 60 Hz)
      if (!A || A.mode !== mode || A.cam.distanceToSquared(gc) > 300 * 300) A = this.aim = { mode, cam: gc.clone(), d: dGame.clone(), t: dGame.clone(), f: cur };   // (a cut: no glide)
      else { if (A.f !== cur) { A.f = cur; A.cam.copy(gc); A.t.copy(dGame); } A.d.lerp(A.t, 1 - Math.exp(-(this.camDt || 0.016) / 0.35)).normalize(); }
      // the world direction to the eased car, turned so that it lands at A.d, no roll
      const w = car.sub(cp).normalize();
      const yaw = Math.atan2(-w.x, -w.z), pitch = Math.asin(Math.max(-1, Math.min(1, w.y)));
      const yawC = Math.atan2(A.d.x, -A.d.z), pitchC = Math.asin(Math.max(-1, Math.min(1, A.d.y)));
      q.setFromEuler(new T.Euler(pitch - pitchC, yaw + yawC, 0, 'YXZ')).invert();
    }

    // The chase camera (camera mode 2) as in a modern racer: the game's camera swings around the followed
    // car's vertical axis, trailing the angle the game puts it at, so the car is seen to turn and slide.
    // Distance, height, pitch and the car's place on screen stay the game's. Changes q and cp in place.
    // The in-car camera kept clear of the track: eased between the game's places it could pass a little under a banked
    // road or into a wall beside it, and faces aren't drawn from behind: the road vanished and the ground below showed
    // through. Rays from just above it, down its own up axis and down the world's, and from beside it to either side,
    // find the nearest surfaces; it is moved out along their normals to at least CLEAR from each.
    camClear(q, cp) {
      const CLEAR = 5, ray = this.clearRay || (this.clearRay = new T.Raycaster()), inv = q.clone().invert();
      const targets = this.statics.children.filter(c => c.visible).concat(this.dyn.mesh, this.dynFlat.mesh, this.ground);
      const up = new T.Vector3(0, 1, 0).applyQuaternion(inv), right = new T.Vector3(1, 0, 0).applyQuaternion(inv).setY(0).normalize();
      const nM = new T.Matrix3(), im = new T.Matrix4();
      for (const d of [up.clone().negate(), new T.Vector3(0, -1, 0), right, right.clone().negate()]) {
        // (from only a little behind: far enough to catch a surface the camera has slipped a few units past, not so far
        // that a tunnel's roof or the far side of a wall is taken for it)
        const back = 15;
        ray.set(cp.clone().addScaledVector(d, -back), d); ray.near = 0; ray.far = back + CLEAR;
        const hit = ray.intersectObjects(targets, false).find(h => h.face);
        if (!hit) continue;
        const n = hit.face.normal.clone();
        if (hit.instanceId != null) { hit.object.getMatrixAt(hit.instanceId, im); n.applyMatrix3(nM.getNormalMatrix(im)); } else n.applyMatrix3(nM.getNormalMatrix(hit.object.matrixWorld));
        n.normalize(); if (n.dot(d) > 0) n.negate();   // (facing back along the ray: towards where the camera should be)
        const dist = cp.clone().sub(hit.point).dot(n);
        if (dist < CLEAR) cp.addScaledVector(n, CLEAR - dist);
      }
    }
    followCam(now, cur, ease, q, cp) {
      const dt = Math.min(0.1, Math.max(0, (now - (this.followT || now)) / 1000)); this.followT = now; this.camDt = dt;   // (aimCam eases with it too)
      // a new race, or a restart (the game's frame counter goes back): the camera and the wheels start where the game
      // puts them, not easing from where the last race left them
      const gfr = this.rw(this.S.state + GAME_FRAME);
      this.raceReset = gfr + 20 < (this.followGf || 0); this.followGf = gfr;
      if (this.raceReset) { this.follow = null; this.aim = null; }
      if ((cur.mode != null ? cur.mode : this.mem[(this.D << 4) + this.S.cameramode]) !== 2) { this.follow = null; return; }
      // the followed car (player, or the opponent with F): its shapes from the track object list, the one
      // nearest the camera, eased like the car that is drawn
      const idx = this.mem[(this.D << 4) + this.S.followOpponentFlag] ? 3 : 2;
      const ptrs = [4, 6].map(f => this.rw(this.S.trkObjectList + idx * 14 + f));
      const near = (objs, p) => { let best = null, bd = Infinity; for (const o of objs) if (ptrs.includes(o.ptr)) { const d = (o.Wm[3] - p.x) ** 2 + (o.Wm[7] - p.y) ** 2 + (o.Wm[11] - p.z) ** 2; if (d < bd) { bd = d; best = o; } } return best; };
      const o = near(cur.objs, cp);
      if (!o) { this.follow = null; return; }
      const p = new T.Vector3(o.Wm[3], o.Wm[7], o.Wm[11]);
      { const M = ease(o); p.set(M[3], M[7], M[11]); }   // (eased exactly as the car is drawn: no wobble between them)
      const yaw0 = Math.atan2(cp.x - p.x, cp.z - p.z), dist = Math.hypot(cp.x - p.x, cp.z - p.z);
      let F = this.follow;
      // a new start, a reset after a crash, a replay jump: no swing
      let cut = false;
      if (!F || F.p.distanceToSquared(p) > 500 * 500) { F = this.follow = { yaw: yaw0, p: p.clone() }; cut = true; }
      else {
        const d = Math.atan2(Math.sin(yaw0 - F.yaw), Math.cos(yaw0 - F.yaw));
        if (Math.abs(d) > 2.4) { F.yaw = yaw0; cut = true; }   // the game turned its camera round (looking back, a cut)
        else {
          F.yaw += d * (1 - Math.exp(-dt / FOLLOW_LAG));
          const e = Math.atan2(Math.sin(F.yaw - yaw0), Math.cos(F.yaw - yaw0));   // never further off the game's angle than MAX_SWING
          if (Math.abs(e) > MAX_SWING) F.yaw = yaw0 + Math.sign(e) * MAX_SWING;
        }
      }
      F.p.copy(p);
      // the game's camera moves in whole steps (integer angles and distances): its distance, height and
      // pitch are damped a little (CAM_DAMP seconds) so they glide
      const k = cut ? 1 : 1 - Math.exp(-dt / CAM_DAMP);
      F.dist = cut || F.dist == null ? dist : F.dist + (dist - F.dist) * k;
      F.h = cut || F.h == null ? cp.y - p.y : F.h + (cp.y - p.y - F.h) * k;
      const dy = Math.atan2(Math.sin(F.yaw - yaw0), Math.cos(F.yaw - yaw0));
      // rotate the camera rigidly about the vertical axis through the car
      cp.set(p.x + Math.sin(F.yaw) * F.dist, p.y + F.h, p.z + Math.cos(F.yaw) * F.dist);
      const turn = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), dy);
      const w = turn.multiply(q.clone().invert());   // the camera's orientation in the world
      F.q = cut || !F.q ? w.clone() : F.q.slerp(w, k).normalize();
      q.copy(F.q).invert();
    }

    renderModern(now, keep) {
      const I = this.I, seq = I[1], Wd = this.W;
      (this.shapeMemo || (this.shapeMemo = new Map())).clear();   // (shapes looked up once a frame: see shape)
      // the track menu asks for its overview to be built now (its shapes and horizon are freed right after)
      if (Atomics.load(Wd, 2) !== Atomics.load(Wd, 3)) {
        this.worldVer = Wd[0]; this.buildWorld();   // (always: the shapes in memory are this track's now)
        try { this.horizonNative(); } catch (_) {}
        this.pvGround = this.groundColor();
        { const c = this.rw(this.S.skybox_sky_color) & 255, p = this.pal; this.pvSky = new T.Color(p[c * 3] / 63, p[c * 3 + 1] / 63, p[c * 3 + 2] / 63).convertSRGBToLinear(); }
        Atomics.store(Wd, 3, Atomics.load(Wd, 2)); Atomics.notify(Wd, 3);
      }
      if (this.W[0] !== this.worldVer) { this.worldVer = this.W[0]; this.buildWorld(); }
      // Game frames arrive about 20 times a second, unevenly. Each gets a steady timestamp (one smoothed
      // period after the last, pulled gently towards when it arrived) and the view plays a little behind,
      // always between the two frames around its clock: motion never jumps when a frame comes early or late.
      if (seq !== this.seq) {
        this.seq = seq; this.lastFrame = now; this.previewShown = false;
        const f = this.snapshot(now), h = this.hist || (this.hist = []), last = h[h.length - 1];
        this.placeModern(f); this.preciseCars(f); this.addOpponent(f); this.sinkCars(f);
        // (the game's horizon now and then not matched for a frame: the last match stands (its colour bands are the
        // track's scenery's, the same all race); without it, the frame's sky fell back to the plain sky colour: the
        // horizon's haze and gradient flashed off)
        if (f.cam) { f.sky = this.matchSky(); if (f.sky) this.skyKeep = f.sky; else if (this.skyKeep) f.sky = this.skyKeep; }
        // Timestamps from the game's own frame counter (state.game_frame), the game's period apart
        // (1000 / framespersec, corrected slowly by how fast frames really come): a frame drawn again without
        // the game moving on (before the start: ~200 a second) replaces the last, a frame missed counts double.
        // How late frames arrive against these timestamps is tracked near its upper envelope (see the clock).
        const gf = this.rw(this.S.state + GAME_FRAME), Pn = 1000 / (this.rw(this.S.framespersec) || 20);
        const steps = last && last.gf != null ? (gf - last.gf) & 0xFFFF : -1;
        f.gf = gf;
        if (f.cam) f.st = [this.carFromState(2), this.carFromState(3)], f.me = f.st[0];   // (read with the frame's clock: the cars' places when not drawn, for the ghost and the tyre marks)
        if (f.cam && !f.sky && steps === 0 && this.skyKeep) f.sky = this.skyKeep;   // (a picture drawn again in a paused race, in the other look: the game does not draw its sky again, the last one stands)
        if (f.cam && last && last.cam && now - last.arr < 400 && steps >= 0 && steps <= 8) {
          if (steps === 0) { f.t = last.t; f.arr = last.arr; h[h.length - 1] = f; }
          else {
            const G = this.gaps; G.push((now - last.arr) / steps); if (G.length > 15) G.shift();
            const med = G.slice().sort((x, y) => x - y)[G.length >> 1];
            this.period += (Math.min(Pn * 1.5, Math.max(Pn * 0.8, med)) - this.period) * 0.05;
            f.t = last.t + steps * this.period;
            const lat = now - f.t;
            if (Math.abs(lat - this.late) > 3 * this.period) this.late = lat;   // (a stall or a burst: at once)
            else this.late += (lat - this.late) * (lat > this.late ? 0.3 : 0.02);
            f.arr = now; h.push(f); if (h.length > 6) h.shift();
          }
        } else if (!f.cam && last && !last.cam && now - last.arr < 400) {
          // (menus, the car select: no game frame counter; as before)
          const gap = Math.min(150, Math.max(16, now - last.arr));
          this.period = this.period ? this.period + (gap - this.period) * 0.08 : gap;
          const expect = last.t + this.period;
          f.t = expect + Math.max(-0.5, Math.min(0.5, (now - expect) / this.period)) * this.period * 0.25;
          f.arr = now; h.push(f); if (h.length > 6) h.shift();
        } else { h.length = 0; this.playT = null; this.late = 0; this.clockOff = null; this.gaps = []; this.period = Pn; f.arr = now; h.push(f); }
      }
      const hist = this.hist;
      if (!hist || !hist.length || (now - this.lastFrame > 400 && !keep)) return false;
      // the playback clock: runs with the display, PLAY_DELAY periods behind the frames' timestamps (shifted by
      // how late they come); the shift changes by at most CLOCK_SLEW of the elapsed time (a far-off one, after
      // a stall or at the start, at once); never backwards, except to resynchronise
      const P_ = this.period || 50, L_ = this.late || 0;
      if (this.clockOff == null || Math.abs(L_ - this.clockOff) > 2 * P_) this.clockOff = L_;
      else { const st = CLOCK_SLEW * Math.max(0, now - (this.clockNow || now)); this.clockOff += Math.max(-st, Math.min(st, L_ - this.clockOff)); }
      this.clockNow = now;
      let rt = now - P_ * PLAY_DELAY - this.clockOff;
      if (this.playT != null && rt < this.playT && this.playT - rt < 2 * P_) rt = this.playT;
      this.playT = rt;
      let j = hist.length - 1;
      while (!this.ogHide && j > 0 && hist[j - 1].t > rt) j--;   // (OG mode: the newest frame, the one the original's picture shows, for the ghost on it)
      if (j === 0 && hist.length > 1) j = 1;
      const cur = this.cur = hist[j], prev = this.prev = j > 0 ? hist[j - 1] : null, race = this.raceView = !!cur.cam;
      this.previewView = cur.preview;
      if (cur.preview) return this.renderPreview(now);
      this.pvT0 = null; this.stage.visible = true; if (this.pvFrame) this.pvFrame.visible = false;
      // (OG mode: nothing eased, the original's own frame, for the ghost laid on its picture: ogGhostDraw)
      const a = this.easeA = prev && !this.ogHide ? Math.max(0, Math.min(1, (rt - prev.t) / Math.max(1, cur.t - prev.t))) : 1;
      // ease moving shapes from the same shape in the previous frame (nearest in the world)
      const byPtr = new Map();
      if (prev && a < 1) for (const o of prev.objs) { if (!byPtr.has(o.ptr)) byPtr.set(o.ptr, []); byPtr.get(o.ptr).push(o); }
      const ease = o => {
        if (o.fixed) return o.Wm;
        const list = byPtr.get(o.ptr);
        if (!list) return o.Wm;
        let best = null, bd = 250 * 250;
        for (const po of list) { const d = (po.Wm[3] - o.Wm[3]) ** 2 + (po.Wm[7] - o.Wm[7]) ** 2 + (po.Wm[11] - o.Wm[11]) ** 2; if (d < bd) { bd = d; best = po; } }
        return best ? o.Wm.map((v, i) => best.Wm[i] + (v - best.Wm[i]) * a) : o.Wm;
      };
      const [p5, p8, p9, p10] = cur.p;
      const k = this.ogHide ? 1 : this.wide || 1;   // widescreen: the 4:3 frame is the middle 1/k of the canvas (OG mode: the 4:3 frame alone)
      this.cam.projectionMatrix.set(
        p9 / 160 / k, 0, -(p5 / 160 - 1) / k, 0,
        0, p10 / 100, -(1 - p8 / 100), 0,
        0, 0, (FAR + NEAR) / (NEAR - FAR), 2 * FAR * NEAR / (NEAR - FAR),
        0, 0, -1, 0);
      this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert();

      LINE_PX.value = 0.3;
      // camera: view = (S Rc S) T(-S cam), eased between game frames
      const view = new T.Matrix4();
      if (race) {
        const q = quat(cur.R), cp = new T.Vector3(cur.cam[0], cur.cam[1], -cur.cam[2]);
        // (a cut: the TV camera moving to its next post, a camera key: no gliding between the two places)
        const cut = prev && (Math.hypot(prev.cam[0] - cur.cam[0], prev.cam[1] - cur.cam[1], prev.cam[2] - cur.cam[2]) > 900 || quat(prev.R).angleTo(q) > 0.6
          || (prev.mode != null && cur.mode != null && prev.mode !== cur.mode));   // (another camera, C: from in car to high is near enough to glide, and the glide passed right by the car, drawn huge)
        if (prev && a < 1 && !cut) {
          q.copy(quat(prev.R).slerp(q, a));
          // (a curve through the game's camera positions, not a straight line between two: over a crest the
          // straight line runs under the road, and the in-car view looked out from beneath it)
          const H = this.hist, P0 = H[j - 2] && H[j - 2].cam ? H[j - 2] : prev, P3 = { cam: [0, 1, 2].map(k => 2 * cur.cam[k] - prev.cam[k]) };   // (the next point extrapolated: the curve's end never changes while it is run)
          const cr = k => { const p0 = P0.cam[k], p1 = prev.cam[k], p2 = cur.cam[k], p3 = P3.cam[k], t = a, t2 = t * t, t3 = t2 * t;
            return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3); };
          const jump = Math.hypot(P0.cam[0] - prev.cam[0], P0.cam[1] - prev.cam[1], P0.cam[2] - prev.cam[2]) > 900 || quat(P0.R).angleTo(quat(prev.R)) > 0.6 || (P0.mode != null && prev.mode != null && P0.mode !== prev.mode);   // (a cut just before: no curve through it)
          if (jump) cp.lerpVectors(new T.Vector3(prev.cam[0], prev.cam[1], -prev.cam[2]), cp, a);
          else cp.set(cr(0), cr(1), -cr(2));
        }
        // debugging: view.debugCam = { x, y, z, yaw, pitch } (stunts world, angles in degrees) looks from there instead
        const dc = this.debugCam;
        if (!dc && !this.ogHide) { this.followCam(now, cur, ease, q, cp); this.aimCam(cur, ease, q, cp);
          if ((cur.mode != null ? cur.mode : this.mem[(this.D << 4) + this.S.cameramode]) === 0) this.camClear(q, cp); }
        if (dc) { cp.set(dc.x, dc.y, -dc.z); q.setFromEuler(new T.Euler(-dc.pitch * Math.PI / 180, -dc.yaw * Math.PI / 180, 0, 'YXZ')).invert(); }
        view.makeRotationFromQuaternion(q).multiply(new T.Matrix4().makeTranslation(-cp.x, -cp.y, -cp.z));
        this.camPos = cp;
      } else this.camPos = new T.Vector3();
      this.cam.matrixWorldInverse.copy(view); this.cam.matrixWorld.copy(view).invert();
      const camWorld = this.cam.matrixWorld;

      // static meshes follow the shapes' current vertices (animated in place, e.g. windmill sails) and the
      // alternating paint jobs, so decorations move at any distance
      if (race) {
        const E4 = this.mem[(this.D << 4) + this.S.byte_3C0C6 + (this.rw(this.S.state + GAME_FRAME) & 15)];
        for (const im of this.statics.children) {
          const gr = im.userData, paint = gr.paint < 0 ? E4 : gr.paint;
          if (gr.paint < 0) {   // (windmill sails: turned smoothly, see sailInfo)
            const si = this.sailInfo(gr.hi);
            if (si) {
              const gT = prev && prev.gf != null && ((cur.gf - prev.gf) & 0xFFFF) <= 8 ? prev.gf + ((cur.gf - prev.gf) & 0xFFFF) * a : cur.gf, q = Math.floor(((gT % 16) + 16) % 16 * 12 + 0.5) % 192;   // (12 turns a game frame: an even 4 a display frame at 60 Hz, the game's 20)
              if (gr.sailQ !== q || !im.geometry.userData.key || im.geometry.userData.key.indexOf(':sail') < 0) {
                // (each of the 192 turns made once and kept: a new geometry a frame would pile up on the GPU)
                const sg = gr.sailGeos || (gr.sailGeos = []);
                if (!sg[q]) { const g = this.shapeGeo(gr.hi, 0, gr.layer, this.sailShape(si, q)); if (g) sg[q] = withSec(g, gr.isec); }
                if (sg[q]) { im.geometry = sg[q]; gr.sailQ = q; }
              }
              continue;
            }
          }
          const key = this.shape(gr.hi, paint).key, was = im.geometry.userData.key;
          if (key === was) continue;
          // (only the vertices and the paint (the alternating ones: windmill sails) may have changed: anything else
          // means the memory now holds something else, as when a race ends and the game loads other shapes there)
          if (!was || key.split(':').slice(0, 4).join(':') !== was.split(':').slice(0, 4).join(':')) continue;
          const g = this.shapeGeo(gr.hi, paint, gr.layer);
          if (g) im.geometry = withSec(g, gr.isec);
        }
        this.viewSectors();
      }

      // static meshes: hide the instances the original drew this frame (they come from the capture)
      for (const h of this.hidden) { h.im.setMatrixAt(h.j, h.m); h.im.instanceMatrix.needsUpdate = true; }
      this.hidden = [];
      this.statics.visible = race; if (this.loStatics) this.loStatics.visible = race;
      // (out of a race (the car select): only the car and its turntable's shadow; the world's other layers, filled from
      // a frame where the game was between pictures, showed the track's land through the car's window for a frame)
      for (const m of [this.dyn.mesh, this.dynFlat.mesh, this.bgDyn.mesh, this.cloudDyn.mesh]) if (m) m.visible = race;
      const zero = new T.Matrix4().makeScale(0, 0, 0);
      const draw = [], back = [], flat = [], cars = [], clouds = [];
      const carPtrs = new Set();
      // (front wheels: which shapes are which car, and their steering eased)
      { this.carIdx = new Map(); this.steerS = this.steerS || [0, 0, 0, 0]; this.steerRaw = this.steerRaw || [0, 0, 0, 0];
        const dts = Math.min(0.1, Math.max(0, (now - (this.steerT || now)) / 1000)); this.steerT = now;
        for (const ci of [2, 3]) {
          for (const f of [4, 6]) this.carIdx.set(this.rw(this.S.trkObjectList + ci * 14 + f), ci);
          const raw = this.s16(this.rw(this.S.state + 0x152 + (ci - 2) * 0xD0 + 0x20)); this.steerRaw[ci] = raw;
          const target = (raw >> 1) * 2 * Math.PI / 1024;
          if (!race || this.raceReset) this.steerS[ci] = target;   // (outside races, and at a new start: no easing carried over from the last one)
          else this.steerS[ci] += (target - this.steerS[ci]) * (1 - Math.exp(-dts / 0.06));
        } }
      if (race) for (const i of [2, 3]) for (const f of [4, 6]) carPtrs.add(this.rw(this.S.trkObjectList + i * 14 + f));
      for (const o of cur.objs) {
        if ((o.flags & 3) === 3) { (this.isCloud(o) ? clouds : back).push(o); continue; }
        if (race && TRUCK.includes(o.ptr)) continue;   // the truck the car starts in: left out   // horizon decoration (sky shapes)
        if (race && this.wkey) {
          // the static instance of this shape at (nearly) the same place: the captured one replaces it
          let hit = null, bd = 64;
          for (const c of this.wkey.get(o.ptr) || []) { const d = (c.x - o.wp[0]) ** 2 + (c.y - o.wp[1]) ** 2 + (c.z - o.wp[2]) ** 2; if (d < bd) { bd = d; hit = c; } }
          if (hit && hit.lo) continue;
          if (hit && (this.isTerrain(o.ptr) || this.isHillRoad(o.ptr))) continue;   // (the land, hills and slopes, and roads up them: always the static one; the captured one's points, worked out here, meet its static neighbours' a hair off, and the sky showed between)
          if (hit && hit.im.userData.sailQ != null) continue;   // (a windmill: its static instance turns its sails smoothly, the original's own drawing would step them)
          if (hit) {
            hit.im.setMatrixAt(hit.j, zero); hit.im.instanceMatrix.needsUpdate = true; this.hidden.push(hit);
            // its exact placement (the game's camera-space numbers are 16-bit: they jitter against neighbours)
            const e = hit.m.elements;
            o.Wm = [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]];
            o.fixed = true; o.hit = hit;
          }
        }
        o.layer = race && this.terrain && !this.terrain.has(o.ptr) ? LAYER : 0;
        (!race || carPtrs.has(o.ptr) ? cars : this.shape(o.ptr, o.paint).flat ? flat : draw).push(o);
      }
      // ease moving shapes from the same shape in the previous frame (nearest in the world)
      // the camera inside a shape (the truck at the start): show only the faces the original drew, so the
      // walls around the camera stay hidden as in the original; otherwise every face, depth-tested (the
      // original drops polygons that cross its near limit, e.g. the road right under the chase camera)
      // (the in-car camera: never. It sits within a few dozen units of the road, so on a banked corner (not level) the
      // road the game dropped at its near limit went too, the tile under the car with it, and the ground below showed
      // through; every face is drawn instead, and camClear keeps the camera above the road)
      const cw = this.camPos, inCar = race && (cur.mode != null ? cur.mode : this.mem[(this.D << 4) + this.S.cameramode]) === 0;
      for (const o of draw.concat(flat)) {
        const W = o.Wm, bb = this.shape(o.ptr, o.paint).bb, dx = cw.x - W[3], dy = cw.y - W[7], dz = cw.z - W[11];
        // local (mirrored) = R^T d; shape space z is mirrored back
        const lx = W[0] * dx + W[4] * dy + W[8] * dz, ly = W[1] * dx + W[5] * dy + W[9] * dz, lz = -(W[2] * dx + W[6] * dy + W[10] * dz);
        o.inside = race && !inCar && lx > bb[0] - 4 && lx < bb[3] + 4 && ly > bb[1] - 4 && ly < bb[4] + 4 && lz > bb[2] - 4 && lz < bb[5] + 4;
        o.camL = [lx, ly, lz];
      }
      // a captured piece the camera isn't inside: its static instance after all (needed only for the faces the original
      // drops round its camera). Drawn from the game's frame, a piece misses the static one's culling by view sector, and
      // showed faces it hides: a bridge deck's piece changed shade, a far ramp popped, as each was captured or let go
      for (const list of [draw, flat]) for (let i = list.length; i--;) {
        const o = list[i];
        if (!o.fixed || o.inside || !o.hit) continue;
        o.hit.im.setMatrixAt(o.hit.j, o.hit.m); o.hit.im.instanceMatrix.needsUpdate = true; list.splice(i, 1);
      }
      // wheels roll with the distance each car travels (sign: along or against its nose)
      this.roll = this.roll || new Map();
      for (const o of cars) {
        const M = ease(o), r = this.roll.get(o.ptr) || { d: 0, p: null };
        const p = new T.Vector3(M[3], M[7], M[11]);
        if (r.p) { const dv = p.clone().sub(r.p); if (dv.length() < 400) r.d += dv.length() * Math.sign(dv.x * M[2] + dv.y * M[6] + dv.z * M[10] || 1); }
        r.p = p; this.roll.set(o.ptr, r); o.roll = r.d;
      }
      this.dyn.fill(this, draw, ease, true);
      // (a crashed car crumples: see crumple(); its crash as the explosions keep it)
      for (const o of cars) { const c = this.boomFx && this.boomFx.cars && this.boomFx.cars[this.carIdx && this.carIdx.get(o.ptr)]; const cr = c && race ? { k: Math.min(1, (now - c.t0) / 250), seed: c.seed, dx: c.dx, dz: c.dz } : this.debugCrumple;
        if (!cr) { o.crumple = null; continue; }
        const sh = this.shape(o.ptr, o.paint);
        if (sh.ext == null) { sh.ext = 1; for (const p of sh.prims) if (!p.wheel) for (let k = 0; k < p.tri.length; k += 3) sh.ext = Math.max(sh.ext, Math.abs(p.tri[k]), Math.abs(p.tri[k + 2])); sh.top = 0; for (const p of sh.prims) for (let k = 1; k < p.tri.length; k += 3) sh.top = Math.max(sh.top, p.tri[k]); }
        o.crumple = Object.assign({ ext: sh.ext, top: sh.top }, cr); }   // (debugCrumple: { k, seed, dx, dz } on every car, e.g. the car select)
      this.dynCar.fill(this, cars, ease, true);
      this.dynShadow.fill(this, race && this.dynCarSh ? draw : draw.concat(cars), ease, false);   // (crisp car shadows: the cars kept out of the sun's map)
      if (this.dynCarSh) this.dynCarSh.fill(this, race ? cars : [], ease, false);
      this.dynFlat.fill(this, flat, ease, true);
      this.bgDyn.fill(this, back, ease, true);
      this.cloudDyn.fill(this, race ? this.cloudSky(clouds, cur) : clouds, ease, true);

      // ground, fog and sky from the original's sky picture (as drawn for the game frame's camera)
      const b = I[0], base = 16 + b * H.BUF;
      let L = I[base + 5], R = I[base + 6], Tt = I[base + 7], B = I[base + 8];
      // (a picture drawn again in a paused race, in the other look, marks no area as drawn: the last one stands)
      if (R > L) { this.lastBox = [L, R, Tt, B]; this.lastBox.gf = cur.gf; } else if (race && this.lastBox && cur.gf === this.lastBox.gf) [L, R, Tt, B] = this.lastBox;
      // (a race frame that marks no sky drawn, as the game sometimes leaves it: the last frame's sky, haze and horizon
      // stand, as they are; dropping them for that frame flashed the sky flat and the haze off)
      const keepSky = race && !(R > L) && this.skyShown;
      this.ground.visible = race; this.ground.scale.set(2 * HZ_R, 1, 2 * HZ_R);
      if (!race) this.cloudReg = null;
      if (keepSky) { this.dome.position.copy(this.camPos); this.ground.position.set(this.camPos.x, 0, this.camPos.z); }
      else {
        this.skyQuad.visible = false; this.dome.visible = false;
        for (const m of [...this.hd.values(), this.natMesh]) if (m) m.visible = false;
        this.bandOn = false; this.setDepth(null);
      }
      this.skyShown = race && (R > L || keepSky);
      if (race && R > L) {
        const frameView = new T.Matrix4().makeRotationFromQuaternion(new T.Quaternion().setFromRotationMatrix(mirror(cur.R)))
          .multiply(new T.Matrix4().makeTranslation(-cur.cam[0], -cur.cam[1], cur.cam[2]));
        const fwd = new T.Vector3(0, 0, -1).applyMatrix4(new T.Matrix4().extractRotation(frameView).invert()); fwd.y = 0; fwd.normalize();
        const far = new T.Vector3(cur.cam[0], 0, -cur.cam[2]).addScaledVector(fwd, 1e7);
        const nF = far.clone().applyMatrix4(frameView).applyMatrix4(this.cam.projectionMatrix);
        const nN = far.clone().applyMatrix4(view).applyMatrix4(this.cam.projectionMatrix);
        const hy = Math.round((1 - nF.y) * 100), cut = hy - 1;
        const px = y => { y = Math.max(Tt, Math.min(B - 1, y)); const c = this.bgU8[b * 64000 + y * 320 + ((L + R) >> 1)]; return new T.Color(this.pal[c * 3] / 63, this.pal[c * 3 + 1] / 63, this.pal[c * 3 + 2] / 63).convertSRGBToLinear(); };
        // the sky picture down to just above its horizon, shifted to the eased camera
        const d = this.skyData, pal = this.pal;
        d.fill(0);
        // the plain sky: in each column, from the top down, the colours of the picture's top row and other
        // bright sky blues (the lighter bands near the horizon), up to the first hill, building or tree
        const skyIs = new Uint8Array(256), top = b * 64000 + Math.max(0, Tt) * 320, cnt = new Uint16Array(256);
        for (let x = Math.max(0, L); x < Math.min(320, R); x++) { skyIs[this.bgU8[top + x]] = 1; cnt[this.bgU8[top + x]]++; }
        let sky = 0; for (let i = 1; i < 256; i++) if (cnt[i] > cnt[sky]) sky = i;
        for (let i = 0; i < 256; i++) { const r_ = pal[i * 3] / 63, g_ = pal[i * 3 + 1] / 63, b_ = pal[i * 3 + 2] / 63; if (b_ >= g_ * 0.95 && b_ > r_ + 0.12 && (r_ + g_ + b_) / 3 > 0.45) skyIs[i] = 1; }
        const y1 = Math.min(200, B, cut);
        for (let x = Math.max(0, L); x < Math.min(320, R); x++) {
          let open = true;
          for (let y = Math.max(0, Tt); y < y1; y++) {
            const c = this.bgU8[b * 64000 + y * 320 + x], o = (199 - y) * 320 * 4 + x * 4;
            if (open && skyIs[c]) continue;
            if (open) for (let yy = Math.max(0, Tt); yy < y; yy++) { const q = (199 - yy) * 320 * 4 + x * 4; d[q] = pal[c * 3] * 255 / 63; d[q + 1] = pal[c * 3 + 1] * 255 / 63; d[q + 2] = pal[c * 3 + 2] * 255 / 63; }   // (no dark fringe when filtered)
            open = false;
            d[o] = pal[c * 3] * 255 / 63; d[o + 1] = pal[c * 3 + 1] * 255 / 63; d[o + 2] = pal[c * 3 + 2] * 255 / 63; d[o + 3] = 255;
          }
        }
        // the bottom row continued a little (the ground covers it): no filtered seam at the horizon
        for (let y = y1; y < Math.min(200, y1 + 3) && y1 > 0; y++) d.copyWithin((199 - y) * 1280, (199 - (y1 - 1)) * 1280, (200 - (y1 - 1)) * 1280);
        // a clear day's sky: deep blue overhead, pale near the horizon (warmer when the track's sky is)
        const sc0 = new T.Color(pal[sky * 3] / 63, pal[sky * 3 + 1] / 63, pal[sky * 3 + 2] / 63), warm = Math.max(0, sc0.r - sc0.b);
        this.domeMat.uniforms.zenith.value.setRGB(0.24 + warm * 0.3, 0.5, 0.88).convertSRGBToLinear();
        this.domeMat.uniforms.horizon.value.setRGB(0.78 + warm * 0.2, 0.88, 0.97).convertSRGBToLinear();
        this.dome.position.copy(this.camPos); this.dome.visible = true;
        this.skyTex.needsUpdate = true;
        this.skyQuad.position.set(nN.x - nF.x, nN.y - nF.y, 0); this.skyQuad.visible = true;
        for (const m of [...this.hd.values(), this.natMesh]) if (m) m.visible = false;
        if (this.natMesh) this.natMesh.visible = false;
        const hdImg = !this.noHD && this.horizonHD(this.forceScenery != null ? this.forceScenery : this.mem[(this.D << 4) + this.S.byte_46167] & 7);   // (forceScenery: for testing)
        this.stripOn = false;
        if (USE_STRIP && !hdImg && cur.sky && this.stripTex) {
          // the original's horizon, where the game drew it, moved with the eased camera at the original's rate
          // (1024 columns a turn), its foot on the far edge of the land
          const dx = (nN.x - nF.x) * 160 * k * (1024 / (2 * Math.PI)) / p9;
          this.horizonStrip(cur.sky.o - dx, fwd);
          this.skyCal = { o: cur.sky.o, a: Math.atan2(fwd.x, fwd.z) };   // (for checking the overview's mapping)
          this.skyQuad.visible = false;
        }
        const hd = this.stripOn ? null : hdImg || this.horizonNative();
        if (hd) {
          hd.visible = true; this.skyQuad.visible = false;
          // standing on the land at HZ_R, where the land has faded nearly into the haze (no strip of bare
          // haze between them when the camera is up high); the panorama runs the other way round from
          // three.js headings
          const s = HZ_R / 150000;
          hd.position.set(this.camPos.x, 0, this.camPos.z); hd.scale.set(-s, s, s);
        }
        // ground and fog colours, eased (no flashing when the sampled rows change)
        const g = hy > Tt && hy < B - 2 ? px(B - 1) : null, f = px(Math.max(Tt + 1, hy - 3));
        if (!this.fogC) { this.fogC = f.clone(); this.groundC = (g || f).clone(); }
        this.fogC.lerp(f, 0.08); if (g) this.groundC.lerp(g, 0.08);
        // aerial haze: distant land and buildings fade to the sky's horizon colour, the backdrop picture too
        // (three.js mixes fog in after the sRGB conversion: its colour is given in sRGB)
        this.scene.fog.color.copy(this.domeMat.uniforms.horizon.value).multiplyScalar(0.92).convertLinearToSRGB();
        this.skyQuad.material.uniforms.haze.value.copy(this.scene.fog.color);
        for (const m of [...this.hd.values(), this.natMesh]) if (m) m.material.uniforms.haze.value.copy(this.skyQuad.material.uniforms.haze.value);
        if (this.natMesh) { const u = this.natMesh.material.uniforms; u.hazeAmt.value = 0.32; u.foot.value = 0.85; }   // (as made; the overview and the original look change them)
        this.groundMat.color.copy(this.groundC); this.hemi.groundColor.copy(this.groundC);
        this.ground.position.set(this.camPos.x, 0, this.camPos.z);
        this.scene.fog.near = 4000; this.scene.fog.far = 60000;
        if (OG) {
          // the original look: no haze, the game's ground colour, its sky colours (bands) and horizon
          this.scene.fog.near = 1e9; this.scene.fog.far = 2e9;
          const gc = this.groundColor(); this.groundMat.color.copy(gc); this.hemi.groundColor.copy(gc);
          { const g = gc.clone().convertLinearToSRGB(); this.stripMat.uniforms.below.value.set(g.r, g.g, g.b, this.stripOn ? 1 : 0); }
          // the sky: the game's own colours, its plain sky overhead and its lowest band at the horizon, on the dome
          // (fixed in the world: it tilts with the view); depth fades towards that band, subtly
          { const sb = cur.sky && cur.sky.bands && cur.sky.bands[cur.sky.yb] >= 0 ? cur.sky.bands[cur.sky.yb] : sky;
            const hc = new T.Color(pal[sb * 3] / 63, pal[sb * 3 + 1] / 63, pal[sb * 3 + 2] / 63);
            // (overhead: the sky colour deepened towards blue, for a gradient)
            // (eased, as the fog is: a frame whose colours come out otherwise does not flash the sky)
            const du = this.domeMat.uniforms, ez = this.domeEased ? 0.15 : 1; this.domeEased = true;
            du.horizon.value.lerp(hc.clone().lerp(new T.Color(1, 1, 1), 0.5).convertSRGBToLinear(), ez);
            du.mid.value.lerp(sc0.clone().convertSRGBToLinear(), ez);
            du.zenith.value.lerp(sc0.clone().lerp(new T.Color(0.05, 0.22, 0.75), 0.85).convertSRGBToLinear(), ez); du.useMid.value = 1;   // (a strong gradient: deep blue overhead)
            this.setDepth(hc, 4000, 30000, DEPTH_AMT);   // (the farthest scenery, as hazy as the horizon behind it)
            if (hd && hd === this.natMesh) { const u = hd.material.uniforms; u.haze.value.copy(hc); u.hazeAmt.value = DEPTH_AMT; u.foot.value = DEPTH_AMT; } }
          const sk = cur.sky;
          if (this.stripOn && sk && sk.bands) {
            if (this.bandFor !== sk) {
              this.bandFor = sk;
              for (let y = 0; y < 200; y++) { const v = sk.bands[y]; if (v < 0) continue; this.bandData.set([pal[v * 3] * 255 / 63, pal[v * 3 + 1] * 255 / 63, pal[v * 3 + 2] * 255 / 63, 255], y * 4); }
              this.bandTex.needsUpdate = true;
            }
            const u = this.bandMat.uniforms; u.yb.value = sk.yb; u.tt.value = sk.tt; u.bottom.value = this.stripMat.uniforms.bottom.value;
            this.bandOn = true;
          }
        }
      } else if (!keepSky) { this.scene.fog.near = 1e9; this.scene.fog.far = 2e9; }

      // car select: the turntable is a picture, so a shadow-only disc under the car's wheels (turning with it)
      // catches the car's shadow; the sun is then mostly above the turntable
      this.stageUp = null;
      if (!race && cars.length) {
        const o = cars[0], M = ease(o), sh = this.shape(o.ptr, o.paint), bb = sh.bb;
        const Rr = 0.62 * Math.max(bb[3] - bb[0], bb[5] - bb[2]);
        const m = new T.Matrix4().set(M[0], M[1], M[2], M[3], M[4], M[5], M[6], M[7], M[8], M[9], M[10], M[11], 0, 0, 0, 1);
        this.stage.matrix.copy(m).multiply(new T.Matrix4().makeTranslation(0, bb[1] + 0.5, 0)).multiply(new T.Matrix4().makeScale(Rr, 1, Rr));
        this.stage.matrixWorldNeedsUpdate = true;
        this.stage.visible = true;
        this.stageUp = new T.Vector3(M[1], M[5], M[9]).normalize(); this.stageR = Rr * 1.6;
        this.carPicture(o.ptr);
      } else { this.stage.visible = false; CARPIC.on.value = 0; this.carPicCar = null; }

      // sun: from the upper left behind the camera's usual view, shadows around what is in front of it
      const fwd = new T.Vector3(0, 0, -1).applyMatrix4(new T.Matrix4().extractRotation(camWorld));
      let focus;
      if (race) focus = this.camPos.clone().addScaledVector(fwd.setY(0).normalize(), 4500);   // (the shadows reach further ahead: they came into view, fading in, closer than the scenery)
      else { focus = new T.Vector3(); for (const o of cars) focus.add(new T.Vector3(o.Wm[3], o.Wm[7], o.Wm[11])); focus.divideScalar(Math.max(1, cars.length)); }
      // (car select: mostly overhead the turntable, a little from the left and the front)
      // (the baked light's mode: the sun lower, about 30 degrees up (?sunel=), its shadows near three times as long)
      const low = race && this.giOn && this.giAvail !== false, el = +((/[?&]sunel=([\d.]+)/.exec(root.location.search) || [])[1] || 30);
      const sunDir = low ? new T.Vector3(-0.36, 0.538 * Math.tan(el * Math.PI / 180), 0.4).normalize() : race || !this.stageUp ? new T.Vector3(-0.36, 0.84, 0.4).normalize()
        : this.stageUp.clone().multiplyScalar(0.9).add(new T.Vector3(-0.38, 0, 0.22)).normalize();
      const ext = race ? 7000 : Math.ceil((this.stageR || 900) * 1.1), sc = this.sun.shadow.camera;
      // (a race: faded out by 7000 from the camera, inside the map's own edge fade everywhere in view, even along the picture's
      // sides; far enough off that a shadow coming into reach doesn't catch the eye)
      if (race) SH_FADE.value.set(5000, 7000); else SH_FADE.value.set(1e9, 2e9);
      this.sun.shadow.bias = -0.00012 * 4000 / ext;   // (the same offset on the ground whatever the map's reach)
      // keep the shadow map's texels fixed on the ground while the camera moves (no shimmering edges)
      // (the shadow camera's own axes: DirectionalLightShadow looks at the target with up = sun.up, and Matrix4.lookAt
      // takes x = up × z, y = z × x, z = towards the light)
      // (a phone: in steps of 32 texels, so the map need not be drawn again each time the camera moves, see below)
      const tx = 2 * ext / this.sun.shadow.mapSize.x * (race && this.phone ? 32 : 1), ax = new T.Vector3().crossVectors(this.sun.up, sunDir).normalize(), ay = new T.Vector3().crossVectors(sunDir, ax);
      SUN_DIR.value.copy(sunDir);
      const fx = Math.round(focus.dot(ax) / tx) * tx, fy = Math.round(focus.dot(ay) / tx) * tx, fz = focus.dot(sunDir);
      focus = ax.multiplyScalar(fx).add(ay.multiplyScalar(fy)).addScaledVector(sunDir, fz);
      this.sun.target.position.copy(focus); this.sun.position.copy(focus).addScaledVector(sunDir, 3 * ext);
      if (sc.right !== ext) { sc.left = sc.bottom = -ext; sc.right = sc.top = ext; sc.near = ext * 1.2; sc.far = ext * 4.8; sc.updateProjectionMatrix(); }
      SH_RANGE.value = sc.far - sc.near;
      GI_U.giSoft.value = low ? 1 : 0; GI_U.giTexW.value = 2 * ext / this.sun.shadow.mapSize.x;
      this.sun.target.updateMatrixWorld(); this.sun.updateMatrixWorld();
      // (a phone in a race: the far map drawn again when it has moved, or every third frame for what moves in it (a windmill's
      // sails); the cars and the shadows close by have maps of their own, drawn every frame. Its matrix is set as it is drawn,
      // so a map kept from an earlier frame still falls where it did)
      const sh = this.sun.shadow; sh.autoUpdate = !(race && this.phone);
      if (!sh.autoUpdate) { const k = focus.x + ',' + focus.y + ',' + focus.z + ',' + ext; if (k !== this.sunKey || ++this.sunN >= 3) { sh.needsUpdate = true; this.sunKey = k; this.sunN = 0; } }
      if (this.carSuns && !this.ogHide) { this.carSunsAt(race, cars, ease, sunDir); this.nearSunAt(race, fwd, sunDir); }
      this.explosions(now, race, camWorld);
      this.tyreMarks(race, cars, ease);
      this.contactShadows(race, cars, ease);
      this.ghostLap(race, cars, cur, prev, a);
      if (this.grass) for (const g of this.grass) g.update(this, this.camPos, this.groundMat.color, this.sun, this.hemi, this.scene.fog, now, race);
      this.r.autoClear = false; this.r.clear();
      this.ogGhost = null;
      if (this.ogHide) { this.ogGhostDraw(); return true; }   // (OG mode in a race: the 3D layers are invisible, so nothing is drawn: no shadows, reflections or passes; the ghost alone, for the page)
      // (the water's reflection, the whole scene drawn again: every other frame, the last one standing between)
      if (race && !/[?&]norefl/.test(root.location.search) && this.waterInView()) { if ((this.reflN = (this.reflN || 0) + 1) % 2 || !REFL.on.value || this.reflFor !== 'race') { this.reflect(); this.reflFor = 'race'; } } else REFL.on.value = 0;
      { const cp = this.camPos || new T.Vector3();
        // (the roofs as strips: pieces in a row joined, so a long tunnel takes one slot and the nearest strips cover
        // every tunnel in view; ranked by the camera's or a car's distance to the strip, whichever is nearer: a TV
        // camera far off still sees the car's tunnel shaded)
        if (!this.roofStrips || this.roofStrips.n !== this.roofs.length) this.roofStrips = roofStrips(this.roofs);
        const cps = [cp, ...CAR_P.value.filter(c => c.w > 0.5)], d2 = (q, c) => Math.max(0, q[0] - c.x, c.x - q[2]) ** 2 + Math.max(0, q[1] - c.z, c.z - q[3]) ** 2;
        const near = this.roofStrips.map(q => [Math.min(...cps.map(c => d2(q, c))), q]).sort((a, b) => a[0] - b[0]);
        for (let i = 0; i < NROOF; i++) {
          const q = near[i] && near[i][1], pad = 10;
          if (!q) { ROOF.a.value[i].set(1, 1, 0, 0); continue; }
          ROOF.a.value[i].set(q[0] - pad, q[1] - pad, q[2] + pad, q[3] + pad); ROOF.lo.value[i] = q[4];
        } }
      this.tunnelShadows(race, cars, ease);   // (after the roofs above: this track's, this frame's)
      CARENV.on.value = 0;   // (cars: a lacquer of fixed light strips now, no reflection of what is round them; see carReflect)
      if (TOD) {   // (the time-of-day mockup: the sky's own colours)
        const du = this.domeMat.uniforms; du.useMid.value = 0;
        if (TOD === 'dusk') { du.zenith.value.setRGB(0.16, 0.12, 0.42).convertSRGBToLinear(); du.horizon.value.setRGB(1.0, 0.55, 0.28).convertSRGBToLinear(); }
        else { du.zenith.value.setRGB(0.01, 0.02, 0.07).convertSRGBToLinear(); du.horizon.value.setRGB(0.06, 0.1, 0.24).convertSRGBToLinear(); }
      }
      if (this.dome.visible) { this.domeMat.uniforms.sunDir.value.copy(this.sun.position).sub(this.sun.target.position).normalize(); this.r.render(this.domeScene, this.cam); }
      if (this.skyQuad.visible) this.r.render(this.skyScene, this.skyCam);
      if (this.bandOn) this.r.render(this.bandScene, this.skyCam);
      if (this.stripOn) this.r.render(this.stripScene, this.skyCam);
      this.giFrame();
      this.r.render(this.scene, this.cam);
      // (the baked light's fine detail, while it is on: the screen's own ambient occlusion over it, for what the volume is
      // too coarse to see: a tree's foot, a kerb, the eaves of a roof)
      const giAO = GI_U.giOn.value > 0.5 && root.StuntsAO ? this.giAO || (this.giAO = new root.StuntsAO(this.r, { radius: +((/[?&]aor=([\d.]+)/.exec(root.location.search) || [])[1] || 16), strength: 0.55 })) : null;
      if (race && (this.aoPass || giAO)) (this.aoPass || giAO).render(this.scene, this.cam, [this.dynShadow.mesh, this.dynCar.mesh, this.cloudDyn.mesh, this.bgDyn.mesh, this.stage].concat(this.grass ? this.grass.map(g => g.mesh) : [], this.blobs || []));
      if (race) this.opaque();
      return true;
    }

    // Where the game drew its horizon sprites in the frame just published: the panorama column at game x 0,
    // found by matching the panorama's bottom rows against the game's own sky picture (exact, whatever the
    // camera). null if the sprites are not in the picture.
    matchSky() {
      try { this.horizonNative(); } catch (_) { return null; }
      const P = this.natIdx, NH = this.natH, I = this.I, b = I[0], base = 16 + b * H.BUF;
      if (!P) return null;
      const L = Math.max(0, I[base + 5]), R = Math.min(320, I[base + 6]), Tt = Math.max(0, I[base + 7]), B = Math.min(200, I[base + 8]);
      if (R - L < 32 || B - Tt < 8) return null;
      const bg = this.bgU8, o0 = b * 64000, grd = this.rw(this.S.skybox_grd_color) & 255;
      // the sprites' bottom row: in most columns, the first row above the ground fill
      const cnt = new Map();
      for (let x = L; x < R; x += 3) { let y = B - 1; while (y > Tt && bg[o0 + y * 320 + x] === grd) y--; if (y < B - 1) cnt.set(y, (cnt.get(y) || 0) + 1); }
      let yb = -1, bc = 0; for (const [y, c] of cnt) if (c > bc) { bc = c; yb = y; }
      if (yb < 0) return null;
      const rows = [0, 2, 4, 7].filter(d => yb - d >= Tt && NH - 1 - d >= 0);
      let best = 0, bs = -1, tot = 0;
      for (let o = 0; o < 1024; o++) {
        let s = 0;
        for (const d of rows) { const pr = (NH - 1 - d) * 1024, gr = o0 + (yb - d) * 320; for (let x = L; x < R; x += 2) { const v = P[pr + ((o + x) & 1023)]; if (v >= 0 && v === bg[gr + x]) s++; } }
        if (s > bs) { bs = s; best = o; }
      }
      for (const d of rows) { const pr = (NH - 1 - d) * 1024; for (let x = L; x < R; x += 2) if (P[pr + ((best + x) & 1023)] >= 0) tot++; }
      if (!(tot > 40 && bs > tot * 0.7)) return null;
      // the sky's colour on each row (its bands), where neither sprite covers it
      const bands = new Int16Array(200).fill(-1), M = this.natSky, c = new Uint16Array(256);
      for (let y = Tt; y <= yb; y++) {
        const pr = NH - 1 - (yb - y); c.fill(0); let top = -1;
        for (let x = L; x < R; x++) if (pr < 0 || M[pr * 1024 + ((best + x) & 1023)]) { const v = bg[o0 + y * 320 + x]; if (++c[v] > (top < 0 ? 0 : c[top])) top = v; }
        bands[y] = top >= 0 ? top : y > Tt ? bands[y - 1] : -1;
      }
      for (let y = yb; y >= Tt; y--) if (bands[y] < 0 && y < yb) bands[y] = bands[y + 1];
      return { o: best, yb, tt: Tt, bands };
    }

    // sets the horizon strip up: panorama column o at game x 0, its foot where the land ends ahead (fwd: the
    // horizontal view direction), as seen through this.cam
    horizonStrip(o, fwd) {
      const R_ = this.ground.scale.x / 2, e = this.camPos.clone().addScaledVector(fwd, R_).setY(0).project(this.cam);
      const u = this.stripMat.uniforms;
      u.map.value = this.stripTex; u.NH.value = this.natH; u.k.value = this.wide || 1;
      u.o.value = ((o % 1024) + 1024) % 1024; u.bottom.value = (1 - e.y) * 100;
      if (OG) { const g = this.groundMat.color.clone().convertLinearToSRGB(); u.below.value.set(g.r, g.g, g.b, 1); } else u.below.value.set(0, 0, 0, 0);
      this.stripOn = true;
    }

    // the car's reflections: a small cube map of the scene round the player's car (every third frame), the sky
    // its background
    carReflect(cars, ease) {
      const o = cars.find(c => this.carIdx && this.carIdx.get(c.ptr) === 2);
      if (!o) { CARENV.on.value = 0; return; }
      if (!this.cubeRT) {
        this.cubeRT = new T.WebGLCubeRenderTarget(128, { generateMipmaps: true, minFilter: T.LinearMipmapLinearFilter });
        this.cubeCam = new T.CubeCamera(20, 80000, this.cubeRT); this.cubeN = 0;
      }
      CARENV.sky.value.copy(this.domeMat.uniforms.horizon.value);
      if (this.cubeN++ % 3 === 0) {
        const M = ease(o), hide = [this.dynCar.mesh, this.dynShadow.mesh, this.stage], vis = hide.map(m => m.visible);
        hide.forEach(m => { m.visible = false; });
        this.cubeCam.position.set(M[3], M[7] + 12, M[11]); this.cubeCam.updateMatrixWorld();
        const bg = this.scene.background, sm = this.r.shadowMap.autoUpdate;
        this.scene.background = this.domeMat.uniforms.horizon.value; this.r.shadowMap.autoUpdate = false; CARENV.on.value = 0;
        this.cubeCam.update(this.r, this.scene);
        this.scene.background = bg; this.r.shadowMap.autoUpdate = sm;
        hide.forEach((m, i) => { m.visible = vis[i]; });
      }
      CARENV.tex.value = this.cubeRT.texture; CARENV.on.value = 1;
    }

    // the water reflection: the scene (and the sky dome) from the camera mirrored in the water's level, at half
    // resolution, above that level only; the ground (in the plane itself) left out
    // Whether any water the reflection would show on is in view: the reflection is the whole scene drawn a
    // second time, so it is left out when none is. The water: the faces of the track's pieces the shader picks
    // (the water colour, or a clear blue, lying flat at the water's level), as world boxes per piece, found
    // once per track; then each frame, those boxes against the camera's view. (Without the track's pieces,
    // none known: always drawn, as before.)
    waterInView() {
      const lv = 0.5, wc = this.rw(this.S.skybox_wat_color) & 255, p = this.pal;
      if (!this.statics.children.length) return true;
      if (!this.water || this.water.wc !== wc) {
        const w = lin([p[wc * 3] / 63, p[wc * 3 + 1] / 63, p[wc * 3 + 2] / 63]), boxes = [], M = new T.Matrix4();
        for (const im of this.statics.children) {
          const g = im.geometry, P = g.attributes.position.array, C = g.attributes.color.array, local = new T.Box3();
          for (let v = 0; v + 2 < P.length / 3; v += 3) {   // (triangles, not indexed)
            const r = C[v * 3], gg = C[v * 3 + 1], b = C[v * 3 + 2];
            if (!(Math.hypot(r - w[0], gg - w[1], b - w[2]) < 0.02 || (b > r + 0.25 && b > gg + 0.05))) continue;
            const y0 = P[v * 3 + 1], y1 = P[v * 3 + 4], y2 = P[v * 3 + 7];
            if (Math.max(y0, y1, y2) - Math.min(y0, y1, y2) > 1) continue;   // (not lying flat)
            for (let k = 0; k < 3; k++) local.expandByPoint(new T.Vector3(P[(v + k) * 3], P[(v + k) * 3 + 1], P[(v + k) * 3 + 2]));
          }
          if (local.isEmpty()) continue;
          for (let j = 0; j < im.count; j++) {
            im.getMatrixAt(j, M);
            const bx = local.clone().applyMatrix4(M);
            if (bx.min.y < lv + 6 && bx.max.y > lv - 6) boxes.push(bx.expandByScalar(2));
          }
        }
        this.water = { wc, boxes, fr: new T.Frustum(), pm: new T.Matrix4() };
      }
      const X = this.water;
      if (!X.boxes.length) return false;
      X.fr.setFromProjectionMatrix(X.pm.multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse));
      return X.boxes.some(b => X.fr.intersectsBox(b));
    }

    reflect() {
      const r = this.r, sz = r.getDrawingBufferSize(new T.Vector2()), q = this.phone ? 2 : 1, w = Math.max(1, sz.x >> q), h = Math.max(1, sz.y >> q);   // (half the picture's size; a phone's a quarter)
      if (!this.reflRT) this.reflRT = new T.WebGLRenderTarget(w, h, { depthBuffer: true });
      if (this.reflRT.width !== w || this.reflRT.height !== h) this.reflRT.setSize(w, h);
      const wc = this.rw(this.S.skybox_wat_color) & 255, p = this.pal, lv = 0.5;
      REFL.waterC.value.setRGB(...lin([p[wc * 3] / 63, p[wc * 3 + 1] / 63, p[wc * 3 + 2] / 63]));
      const cam = this.reflCam || (this.reflCam = new T.Camera());
      cam.matrixAutoUpdate = false; cam.far = this.cam.far; cam.near = this.cam.near;   // (the log depth buffer takes its scale from far)
      cam.projectionMatrix.copy(this.cam.projectionMatrix); cam.projectionMatrixInverse.copy(this.cam.projectionMatrixInverse);
      const mirror = new T.Matrix4().makeTranslation(0, lv, 0).multiply(new T.Matrix4().makeScale(1, -1, 1)).multiply(new T.Matrix4().makeTranslation(0, -lv, 0));
      cam.matrixWorld.copy(mirror).multiply(this.cam.matrixWorld); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      REFL.on.value = 0; REFL.tex.value = null;   // (not bound while it is drawn into)
      const hide = [this.ground, this.stage, this.dynShadow.mesh], vis = hide.map(o => o.visible);
      hide.forEach(o => { o.visible = false; });
      const prevT = r.getRenderTarget(), cp = r.clippingPlanes, sm = r.shadowMap.autoUpdate;
      r.setRenderTarget(this.reflRT); r.clear();
      if (this.dome.visible) r.render(this.domeScene, cam);
      r.clippingPlanes = [new T.Plane(new T.Vector3(0, 1, 0), -lv)];
      r.shadowMap.autoUpdate = false;
      r.render(this.scene, cam);
      r.clippingPlanes = cp; r.shadowMap.autoUpdate = sm; r.setRenderTarget(prevT);
      hide.forEach((o, i) => { o.visible = vis[i]; });
      REFL.tex.value = this.reflRT.texture; REFL.res.value.copy(sz); REFL.level.value = lv; REFL.on.value = /[?&]reflall/.test(root.location.search) ? 2 : 1;
    }

    // the original look's depth shading: towards colour c (sRGB) from distance near to far, at most amt
    // (null: none); the horizon strip, at the far end, the most
    setDepth(c, near, far, amt) {
      if (!c || !OG) { DEPTH.amt.value = 0; this.stripMat.uniforms.haze.value.set(0, 0, 0, 0); return; }
      DEPTH.c.value.copy(c).convertSRGBToLinear(); DEPTH.near.value = near; DEPTH.far.value = far; DEPTH.amt.value = amt;
      this.stripMat.uniforms.haze.value.set(c.r, c.g, c.b, amt);
    }

    // a car's front wheels' angle (shape space, radians): the game turns them by half its steering angle
    // (car_steeringAngle, 1024 a turn); shown STEER_SHOW times that, eased between game frames, in the
    // direction the game's own vertices turn them
    steerOf(o, p) {
      const ci = this.carIdx && this.carIdx.get(o.ptr);
      if (ci == null || !this.raceView) return 0;
      // (the game's own vertices turn the wheel the opposite way to car_steeringAngle's sign, every car: measured,
      // e.g. the Indy and the Countach steering left and right; fixed, not learned, so the first race is right too)
      const a = (this.steerS && this.steerS[ci]) || 0;
      return Math.max(-STEER_MAX, Math.min(STEER_MAX, -a * STEER_SHOW));
    }

    // Tyre marks: off the road (a wheel's surface in the car's state, car_surfaceWhl: 2..4 dirt, grass) each
    // wheel leaves a dark streak on the ground, kept for the race (up to MARKS segments, the oldest go first).
    // Each point is dropped onto the ground under the wheel (a short ray down onto the land pieces and the
    // plain), so the streak lies on slopes and crests rather than along the car's own tilt; no ground within
    // reach: the wheel is off it, and leaves nothing
    tyreMarks(race, cars, ease) {
      const MARKS = 6000;
      const X = this.marks || (this.marks = (() => {
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(new Float32Array(MARKS * 18), 3).setUsage(T.DynamicDrawUsage));
        // (each mark one rank over the surface it lies on, through the same depth bias as that surface: the ground is drawn
        // well behind everything on it, so a mark at its true depth showed through what should hide it)
        g.setAttribute('rank', new T.BufferAttribute(new Float32Array(MARKS * 6), 1).setUsage(T.DynamicDrawUsage));
        // (and each pixel darkened once, however many marks overlap there (the stencil marks it): where the front and rear wheels
        // ran in one groove, or short segments met, the marks were darker, first off the road most of all)
        const mm = new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false, side: T.DoubleSide,
          stencilWrite: true, stencilRef: 2, stencilFunc: T.NotEqualStencilFunc, stencilZPass: T.ReplaceStencilOp, stencilFail: T.KeepStencilOp, stencilZFail: T.KeepStencilOp });   // (2: the car footprint uses 1)
        // (the in-car view: none under your own car, between the wheels: the car isn't drawn there, so the fresh marks under
        // it lay right in front of the camera; footOn, the car's turn (footR) and place (footT), its half size (footH))
        const FOOT = this.markFoot = { footOn: { value: 0 }, footR: { value: new T.Matrix3() }, footT: { value: new T.Vector3() }, footH: { value: new T.Vector2() } };
        mm.onBeforeCompile = sh => {
          Object.assign(sh.uniforms, FOOT);
          sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float rank; varying float vRank; varying vec3 vMW;').replace('#include <logdepthbuf_vertex>', '#include <logdepthbuf_vertex>\nvRank = rank; vMW = position;');
          sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vRank; varying vec3 vMW; uniform float footOn; uniform mat3 footR; uniform vec3 footT; uniform vec2 footH;')
            .replace('void main() {', 'void main() {\n  if (footOn > 0.5) { vec3 l = footR * (vMW - footT); if (abs(l.x) < footH.x && abs(l.z) < footH.y) discard; }')
            .replace('#include <logdepthbuf_fragment>', `#include <logdepthbuf_fragment>
#if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )
{ float d0 = gl_FragDepthEXT, rk = floor((vRank + 0.5) / ${RANKS}.0), ti = vRank - rk * ${RANKS}.0; gl_FragDepthEXT = d0 - rk * (0.6 * fwidth(d0) + 1e-5) - ti * ${TIE_D}; }
#endif`);
        };
        mm.customProgramCacheKey = () => 'marks';
        const mesh = new T.Mesh(g, mm);
        mesh.frustumCulled = false; mesh.renderOrder = 2; this.scene.add(mesh);
        return { g, mesh, n: 0, head: 0, last: new Map() };
      })());
      if (!race) { if (this.lastFrame && !this.raceView) { X.n = 0; X.head = 0; X.last.clear(); X.g.setDrawRange(0, 0); } X.mesh.visible = false; return; }
      const gf = this.rw(this.S.state + GAME_FRAME);
      if (gf + 20 < (X.gf || 0)) { X.n = 0; X.head = 0; X.last.clear(); X.g.setDrawRange(0, 0); }   // (a restart)
      X.gf = gf;
      X.mesh.visible = X.n > 0;
      const D = this.D << 4, P = X.g.attributes.position.array;
      // (the ground: the fixed track pieces, the plain, and the land drawn frame by frame, slopes included;
      // the frame-by-frame buffers change every frame, so they are given a bounding sphere that holds anything)
      for (const d of [this.dyn, this.dynFlat]) if (!d.geo.userData.bigSphere) { d.geo.boundingSphere = new T.Sphere(new T.Vector3(), 1e9); d.geo.userData.bigSphere = true; }
      const ray = this.markRay || (this.markRay = new T.Raycaster()), targets = this.statics.children.concat(this.ground, this.dynFlat.mesh, this.dyn.mesh);
      const DOWN = new T.Vector3(0, -1, 0), nM = new T.Matrix3();
      const onGround = (w, side) => {
        ray.set(w.clone().setY(w.y + 25), DOWN); ray.near = 0; ray.far = 45;
        const hit = ray.intersectObjects(targets, false)[0];
        if (!hit) return null;
        const n = hit.face ? hit.face.normal.clone().applyMatrix3(nM.getNormalMatrix(hit.object.matrixWorld)) : new T.Vector3(0, 1, 0);
        if (hit.instanceId != null) { const im = new T.Matrix4(); hit.object.getMatrixAt(hit.instanceId, im); n.copy(hit.face.normal).applyMatrix3(nM.getNormalMatrix(im)); }
        n.normalize(); if (n.y < 0) n.negate();
        if (n.y < 0.35) return null;   // (a wall, not ground)
        const ra = hit.object.geometry.getAttribute('rank'), rank = (ra && hit.face ? ra.getX(hit.face.a) : 0) + 1;
        return { p: hit.point.clone().addScaledVector(n, 0.2), s: side.clone().addScaledVector(n, -side.dot(n)), rank };
      };
      let added = false;
      this.markFoot.footOn.value = 0;
      // (each car's wheels from its full shape, wherever it is: far off the game draws a car's low-detail shape, which has
      // none, and the car isn't drawn at all from the in-car camera; then its place comes from the game's state)
      const gcf = this.S.gameconfig;
      for (const ci of [2, 3]) {
        if (ci === 3 && !this.mem[D + gcf + 6]) continue;   // (no opponent)
        const st = this.S.state + 0x152 + (ci - 2) * 0xD0;
        const o = cars.find(c => this.carIdx && this.carIdx.get(c.ptr) === ci);
        const c = this.cur.st && this.cur.st[ci - 2], q = this.prev && this.prev.st && this.prev.st[ci - 2];
        const M = o ? ease(o) : c && q ? c.map((v, k) => q[k] + (v - q[k]) * this.easeA) : c;   // (not drawn: eased between frames as a drawn car is)
        if (!M) continue;
        const sh = this.shape(this.rw(this.S.trkObjectList + ci * 14 + 4), o ? o.paint : this.mem[D + gcf + (ci === 2 ? 4 : 11)]);
        if (ci === 2 && sh.bb && this.mem[D + this.S.cameramode] === 0) {   // (your car, from the in-car camera: its footprint, a little over)
          const F = this.markFoot, bb = sh.bb; F.footOn.value = 1;
          F.footR.value.set(M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]);   // (world to the car's own axes: the turn's transpose)
          F.footT.value.set(M[3], M[7], M[11]);
          F.footH.value.set(Math.max(-bb[0], bb[3]) + 4, Math.max(-bb[2], bb[5]) + 4);
        }
        // (which of the game's four wheels each drawn one is: the nearest of the game's own wheel places, car_whlWorldCrds1
        // at +0x74, whose order car_surfaceWhl at +0xC2 follows; guessed from the shape's sides, one wheel on the grass
        // marked the one on the road)
        const gw = [0, 1, 2, 3].map(k => { const a = st + 0x74 + k * 6, s16 = v => (v << 16) >> 16; return [s16(this.rw(a)), s16(this.rw(a + 4))]; });
        const known = gw.some(v => v[0] || v[1]);
        for (const p of sh.prims) {
          if (!p.wheelCtr) continue;
          const c = p.wheelCtr;
          const x = c[0], y = c[1] - p.wheelR, z = -c[2];
          const w = new T.Vector3(M[0] * x + M[1] * y + M[2] * z + M[3], M[4] * x + M[5] * y + M[6] * z + M[7], M[8] * x + M[9] * y + M[10] * z + M[11]);
          let idx = (p.front ? 0 : 2) + (c[0] < 0 ? 0 : 1);
          if (known) { let bd = 1e18; gw.forEach((v, k) => { const d = (v[0] - w.x) ** 2 + (-v[1] - w.z) ** 2; if (d < bd) { bd = d; idx = k; } }); }
          const surf = this.mem[D + ((st + 0xC2 + idx) & 0xFFFF)], key = ci + ':' + idx;
          const side = new T.Vector3(M[0], M[4], M[8]).normalize().multiplyScalar(Math.min(p.wheelHalf || 4, 8));
          const prev = X.last.get(key);
          if (surf < 2 || surf > 4) { X.last.delete(key); continue; }
          if (prev && prev.p.distanceTo(w) < 6) continue;
          const g = onGround(w, side);
          if (!g) { X.last.delete(key); continue; }
          if (!prev || prev.p.distanceTo(w) > 60) { X.last.set(key, { p: w, g }); continue; }   // (short segments: they follow the ground's curve)
          const a0 = prev.g.p.clone().sub(prev.g.s), a1 = prev.g.p.clone().add(prev.g.s), b0 = g.p.clone().sub(g.s), b1 = g.p.clone().add(g.s);
          const o9 = X.head * 18;
          [a0, a1, b1, a0, b1, b0].forEach((v, k) => { P[o9 + k * 3] = v.x; P[o9 + k * 3 + 1] = v.y; P[o9 + k * 3 + 2] = v.z; });
          const RK = X.g.attributes.rank.array, rk = Math.max(prev.g.rank, g.rank); for (let k = 0; k < 6; k++) RK[X.head * 6 + k] = rk;
          X.head = (X.head + 1) % MARKS; X.n = Math.min(MARKS, X.n + 1); added = true;
          X.last.set(key, { p: w, g });
        }
      }
      if (added) { X.g.attributes.position.needsUpdate = true; X.g.attributes.rank.needsUpdate = true; X.g.setDrawRange(0, X.n * 6); X.mesh.visible = true; }
    }

    // Contact shadows: under each car a soft oval, darkest right under it and fading out to its edges (the sun
    // shadow above it keeps the car's outline). Laid on the ground under the car (a ray down, as the tyre marks),
    // turned with the car and the ground's slope; lighter and wider the higher the car is off the ground.
    // Under a tunnel's roof there is no sun, so no sun shadow: each car there gets its own shape, flattened onto the
    // plane under its wheels (along the sun's direction, so it falls as the shadow outside does), as a darker patch.
    tunnelShadows(race, cars, ease) {
      if (!this.footBuf) {
        // (drawn after the ground and before the cars, darkening what is already there; pulled towards the camera so the
        // pipe's curved floor, higher at the sides than the plane under the wheels, does not hide it; a stencil keeps
        // overlapping faces from darkening twice; drawn only where it lands under a roof, so as the car leaves a tunnel,
        // or crosses a gap between two, the sun's shadow outside takes over along the tunnel's mouth, not all at once)
        const m = new T.MeshBasicMaterial({ color: 0x8c8c8c, blending: T.CustomBlending, blendSrc: T.ZeroFactor, blendDst: T.SrcColorFactor, blendEquation: T.AddEquation,
          depthWrite: false, side: T.DoubleSide, fog: false, stencilWrite: true, stencilRef: 1, stencilFunc: T.NotEqualStencilFunc, stencilZPass: T.ReplaceStencilOp });
        m.onBeforeCompile = sh => {
          sh.uniforms.roofA = ROOF.a; sh.uniforms.roofLo = ROOF.lo;
          sh.vertexShader = 'varying vec3 vRw;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vRw = position;\n  mvPosition.xyz *= max(0.2, 1.0 - 30.0 / length(mvPosition.xyz)); gl_Position = projectionMatrix * mvPosition;');
          sh.fragmentShader = `varying vec3 vRw; uniform vec4 roofA[${NROOF}]; uniform float roofLo[${NROOF}];\n` + sh.fragmentShader.replace('void main() {', `void main() {
  bool under = false;
  for ( int i = 0; i < ${NROOF}; i ++ ) { vec4 a = roofA[ i ]; if ( vRw.x > a.x && vRw.x < a.z && vRw.z > a.y && vRw.z < a.w && vRw.y < roofLo[ i ] ) under = true; }
  if ( ! under ) discard;`);
        };
        this.footBuf = new DynBuf(m);
        this.footBuf.solid = true; this.footBuf.mesh.renderOrder = 0.5; this.footBuf.mesh.castShadow = false; this.dynCar.mesh.renderOrder = 1; this.scene.add(this.footBuf.mesh);
      }
      const fb = this.footBuf; fb.mesh.visible = false;
      if (!race) return;
      // (the cars near a roof: their shadows may reach under it)
      const near = (x, y, z, e) => { for (let i = 0; i < NROOF; i++) { const a = ROOF.a.value[i]; if (x > a.x - e && x < a.z + e && z > a.y - e && z < a.w + e && y < ROOF.lo.value[i]) return true; } return false; };
      const list = cars.filter(o => { const M = ease(o); return near(M[3], M[7], M[11], 600); });
      if (!list.length) return;
      // (cast along the sun's direction, as the shadow outside falls, onto the plane under the car's wheels)
      const d = SUN_DIR.value, flat = o => {
        const M = ease(o), bb = this.shape(o.ptr, o.paint).bb, y0 = bb ? bb[1] : 0;
        const l = Math.hypot(M[1], M[5], M[9]) || 1, n = [M[1] / l, M[5] / l, M[9] / l];
        const q = [M[3] + M[1] * y0, M[7] + M[5] * y0, M[11] + M[9] * y0], dv = [d.x, d.y, d.z];
        const nd = Math.max(0.35, n[0] * dv[0] + n[1] * dv[1] + n[2] * dv[2]), nq = n[0] * q[0] + n[1] * q[1] + n[2] * q[2];
        const R = M.slice();
        for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
          const nm = n[0] * M[c] + n[1] * M[4 + c] + n[2] * M[8 + c];
          R[r * 4 + c] = M[r * 4 + c] - dv[r] * (nm - (c === 3 ? nq : 0)) / nd;
        }
        return R;
      };
      fb.fill(this, list, flat, false); fb.mesh.visible = true;
    }

    contactShadows(race, cars, ease) {
      if (!this.blobs) {
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.95, 'rgba(0,0,0,0.4)'); gr.addColorStop(0.99, 'rgba(0,0,0,0)');   // (dark under the car, lighter outwards, then a hard edge: low-poly crisp, not a blur)
        g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
        const tex = new T.CanvasTexture(c);
        this.blobs = [0, 1].map(() => {
          const m = new T.Mesh(new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new T.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6, fog: false }));
          m.renderOrder = 2; m.frustumCulled = false; m.visible = false; this.scene.add(m); return m;
        });
        this.blobRay = new T.Raycaster();
      }
      this.blobs.forEach(b => { b.visible = false; });
      this.stageShadow = null;
      // car select: a soft blob on the turntable, turning with the car. The turntable is the original's picture
      // (the 3D view shows only through the car's own pixels), so the page darkens the picture there: the
      // blob's centre and half-axes in the 320x200 frame (the sun's hard shadow only ever showed as a sliver
      // along the car's outline, flickering as it turned)
      if (!race && this.stageUp && cars.length && !this.previewView) {   // (not the track menu's overview: its blob covered the screen)
        const o = cars[0], M = ease(o), bb = this.shape(o.ptr, o.paint).bb, b = this.blobs[0]; if (!bb) return;
        const X = new T.Vector3(M[0], M[4], M[8]), Y = new T.Vector3(M[1], M[5], M[9]), Z = new T.Vector3(M[2], M[6], M[10]);
        const c = new T.Vector3(M[3], M[7], M[11]).addScaledVector(X, (bb[0] + bb[3]) / 2).addScaledVector(Y, bb[1] + 0.5).addScaledVector(Z, -(bb[2] + bb[5]) / 2);
        b.matrixAutoUpdate = false;
        b.matrix.makeBasis(X.multiplyScalar((bb[3] - bb[0]) * 1.7), Y.normalize(), Z.multiplyScalar((bb[5] - bb[2]) * 1.3)).setPosition(c);
        const px = v => { v.project(this.cam); return [(v.x * (this.wide || 1) + 1) * 160, (1 - v.y) * 100]; };
        const hx = X.clone().multiplyScalar(0.5), hz = Z.clone().multiplyScalar(0.5);
        const p0 = px(c.clone()), pa = px(c.clone().add(hx)), pb = px(c.clone().add(hz));
        // (the turntable opened a little past the car's footprint: its sun shadow, on the stage disc, shows there)
        this.stageShadow = { c: p0, a: [(pa[0] - p0[0]) * 1.5, (pa[1] - p0[1]) * 1.5], b: [(pb[0] - p0[0]) * 1.3, (pb[1] - p0[1]) * 1.3] };
        return;
      }
      CAR_P.value[0].set(0, 0, 0, 0); CAR_P.value[1].set(0, 0, 0, 0);
      if (!race) return;
      // the sun's shadows darker round the cars (see CAR_P); no extra shape of their own
      let q = 0;
      for (const o of cars) {
        if (q >= 2) break;
        const ci = this.carIdx && this.carIdx.get(o.ptr); if (ci == null) continue;
        const M = ease(o); CAR_P.value[q++].set(M[3], M[7], M[11], 1);
      }
      if (q >= 0) return;
      const targets = this.statics.children.concat(this.ground, this.dynFlat.mesh, this.dyn.mesh), nM = new T.Matrix3(), im = new T.Matrix4();
      let k = 0;
      for (const o of cars) {
        if (k >= 2) break;
        const ci = this.carIdx && this.carIdx.get(o.ptr); if (ci == null) continue;
        const M = ease(o), sh = this.shape(o.ptr, o.paint), bb = sh.bb; if (!bb) continue;
        const pos = new T.Vector3(M[3], M[7], M[11]);
        this.blobRay.set(pos.clone().setY(pos.y + 20), new T.Vector3(0, -1, 0)); this.blobRay.near = 0; this.blobRay.far = 400;
        const hit = this.blobRay.intersectObjects(targets, false)[0];
        if (!hit || !hit.face) continue;
        const n = hit.face.normal.clone();
        if (hit.instanceId != null) { hit.object.getMatrixAt(hit.instanceId, im); n.applyMatrix3(nM.getNormalMatrix(im)); } else n.applyMatrix3(nM.getNormalMatrix(hit.object.matrixWorld));
        n.normalize(); if (n.y < 0) n.negate(); if (n.y < 0.35) continue;
        const h = Math.max(0, pos.y + bb[1] - hit.point.y), lift = Math.min(1, h / 250);
        const b = this.blobs[k++];
        // the car's heading laid into the ground's plane
        const fwd = new T.Vector3(M[2], M[6], M[10]); fwd.addScaledVector(n, -fwd.dot(n)).normalize();
        const side = new T.Vector3().crossVectors(n, fwd).normalize();
        b.matrixAutoUpdate = false;
        const grow = 1 + lift * 0.8, w = (bb[3] - bb[0]) * 1.25 * grow, l = (bb[5] - bb[2]) * 1.15 * grow;
        b.matrix.makeBasis(side.multiplyScalar(w), n, fwd.multiplyScalar(l)).setPosition(hit.point.clone().addScaledVector(n, 0.5));
        b.material.opacity = 0.55 * (1 - lift * 0.85);
        b.visible = b.material.opacity > 0.02;
      }
    }

    // Each car's own shadow map: centred on the car, its texels kept fixed along the sun's axes as it moves (no crawling
    // edges); its depths over the same range as the sun's, so its shadow fades from what casts it alike (getShadow).
    // A car's light adds no light: only its shadow counts (getShadow keeps each map's apart; where shadows overlap, darker).
    carSunsAt(race, cars, ease, sunDir) {
      const ax = new T.Vector3().crossVectors(this.sun.up, sunDir).normalize(), ay = new T.Vector3().crossVectors(sunDir, ax), tx = 2 * CAR_SH_R / CAR_SH_N, c = new T.Vector3();
      let q = 0;
      if (race) for (const o of cars) {
        if (q >= 2) break;
        const M = ease(o); c.set(M[3], M[7], M[11]);
        const fx = Math.round(c.dot(ax) / tx) * tx, fy = Math.round(c.dot(ay) / tx) * tx, fz = c.dot(sunDir);
        const l = this.carSuns[q++], sc = l.shadow.camera;
        l.target.position.copy(ax).multiplyScalar(fx).addScaledVector(ay, fy).addScaledVector(sunDir, fz); l.position.copy(l.target.position).addScaledVector(sunDir, 2 * CAR_SH_R);
        if (sc.far - sc.near !== SH_RANGE.value) { sc.near = CAR_SH_R; sc.far = sc.near + SH_RANGE.value; sc.updateProjectionMatrix(); }
        l.shadow.bias = this.sun.shadow.bias; l.shadow.normalBias = this.sun.shadow.normalBias;
        l.target.updateMatrixWorld(); l.updateMatrixWorld(); l.shadow.needsUpdate = true; l.userData.parked = false;
      }
      // (a map not in use: out of the way, far below everything, drawn once more there, empty: the shaders keep a map's last
      // matrix and picture till it's drawn again)
      for (; q < 2; q++) { const l = this.carSuns[q]; if (l.userData.parked) continue; l.target.position.set(0, -1e6, 0); l.position.set(0, -1e6 + 2 * CAR_SH_R, 0); l.target.updateMatrixWorld(); l.updateMatrixWorld(); l.shadow.needsUpdate = l.userData.parked = true; }
      // (drawn now, the cars alone: the renderer draws a shadow map with everything its camera sees, so these are drawn
      // by a camera that sees only layer 5, the cars' casting shape and these lights, and kept out of the main pass's
      // shadows, autoUpdate off; the casting shape draws nothing to the screen)
      if (this.carSuns.some(l => l.shadow.needsUpdate)) this.r.render(this.scene, this.carShCam);
    }

    // The near map: round the camera, a little ahead, its texels fixed along the sun's axes as it moves; its depths over
    // the same range as the sun's (the same offsets and fades); drawn with everything that casts, in the main render
    nearSunAt(race, fwd, sunDir) {
      const l = this.nearSun, sc = l.shadow.camera;
      if (!race || !this.camPos) {
        if (!l.userData.parked) { l.target.position.set(0, -1e6, 0); l.position.set(0, -1e6 + 1000, 0); l.target.updateMatrixWorld(); l.updateMatrixWorld(); l.shadow.needsUpdate = l.userData.parked = true; }
        return;
      }
      const ax = new T.Vector3().crossVectors(this.sun.up, sunDir).normalize(), ay = new T.Vector3().crossVectors(sunDir, ax), tx = 2 * NEAR_SH_R / NEAR_SH_N;
      const c = this.camPos.clone().addScaledVector(fwd.clone().setY(0).normalize(), NEAR_AHEAD), ss = this.sun.shadow.camera, back = this.sun.position.distanceTo(this.sun.target.position);
      const fx = Math.round(c.dot(ax) / tx) * tx, fy = Math.round(c.dot(ay) / tx) * tx, fz = c.dot(sunDir);
      l.target.position.copy(ax).multiplyScalar(fx).addScaledVector(ay, fy).addScaledVector(sunDir, fz); l.position.copy(l.target.position).addScaledVector(sunDir, back);
      if (sc.near !== ss.near || sc.far !== ss.far) { sc.near = ss.near; sc.far = ss.far; sc.updateProjectionMatrix(); }
      l.shadow.bias = this.sun.shadow.bias; l.shadow.normalBias = this.sun.shadow.normalBias;
      l.target.updateMatrixWorld(); l.updateMatrixWorld(); l.shadow.needsUpdate = true; l.userData.parked = false;
    }

    // Your best run on each track, raced again as a see-through ghost car. While you drive, the car's place is
    // kept for every tick of the race clock (state.game_frame: it starts with the throttle); a run that reaches the
    // finish faster than the one kept replaces it (localStorage 'stunts-ghost:TRACK': the frame count, then 12
    // floats a tick). From the next start on that track, the ghost drives it, in step with the clock.
    ghostLap(race, cars, cur, prev, a) {
      if (!this.ghostBuf) {
        // (a see-through car in its own colours: only its nearest surface shows, as a depth-only pass goes first; no
        // wheel or far side seen through its body)
        this.ghostBuf = new DynBuf(new T.MeshBasicMaterial({ vertexColors: true, color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, fog: false, side: T.DoubleSide }));
        this.ghostBuf.solid = true; this.ghostBuf.mesh.renderOrder = 5; this.scene.add(this.ghostBuf.mesh);
        this.ghostDepth = new T.Mesh(this.ghostBuf.mesh.geometry, new T.MeshBasicMaterial({ colorWrite: false, side: T.DoubleSide }));
        this.ghostDepth.renderOrder = 4; this.ghostDepth.frustumCulled = false; this.scene.add(this.ghostDepth);
        this.ghost = { track: null, best: null, run: null };
      }
      const G = this.ghost, gb = this.ghostBuf, D = this.D << 4, S = this.S;
      gb.mesh.visible = this.ghostDepth.visible = false;
      const replay = this.mem[D + S.game_replay_mode] !== 0;
      if (!race) { G.run = null; this.ghostAvail = false; return; }
      // (the replay screen, after a crash or Esc: the run so far is kept, and taken up again where driving goes on)
      if (replay || !cur.gf && cur.gf !== 0) return;
      let track = ''; for (let i = 0; i < 8; i++) { const c = this.mem[D + S.gameconfig + 13 + i]; if (!c) break; track += String.fromCharCode(c); }
      // (a ghost belongs to the track as it is, not its name: one built again or brought in under the same name has its
      // own, and the times in the track's high score file, which come with it from elsewhere, say nothing of a ghost)
      { const e = (this.rw(S.td14_elem_map_main + 2) << 4) + this.rw(S.td14_elem_map_main), t = (this.rw(S.td15_terr_map_main + 2) << 4) + this.rw(S.td15_terr_map_main);
        let h = 0x811c9dc5; for (const a of [e, t]) for (let i = 0; i < 901; i++) h = Math.imul(h ^ this.mem[a + i], 0x01000193);
        track = track.toUpperCase() + ':' + (h >>> 0).toString(36); }
      if (track !== G.track) {
        G.track = track; G.best = null; G.score = Infinity; G.car = null;
        // (on unless you turned it off: G's choice is remembered)
        this.ghostOn = (() => { try { return localStorage.getItem('stunts-ghost-on') !== '0'; } catch (_) { return true; } })();
        // (the ghost and the car that drove it, as it looked (the ghost is that car whichever one you drive now), from
        // this browser's ghost store; it arrives a moment later, and a faster run of this race since keeps its place)
        ghostGet(track).then(v => {
          if (!v || G.track !== track || v.score >= G.score) return;
          G.best = v.best; G.score = v.score;
          G.car = v.car ? { prims: v.car.map(q => ({ tri: Float32Array.from(q.t), c: q.c, pat: q.p, rank: 0, one: 0, cull2: 0 })) } : null;
        });
      }
      const avail = !!G.best; this.ghostAvail = avail;
      const me = cars.find(o => this.carIdx && this.carIdx.get(o.ptr) === 2);
      // (the in-car camera, the default: the car itself isn't drawn; its place from the game's state instead, and its
      // shape and paint from the race's set-up)
      const meW = me ? me.Wm : cur.me, who = me || { ptr: this.rw(S.trkObjectList + 2 * 14 + 4), paint: this.mem[D + S.gameconfig + 4] };
      HEAD.p.value.w = 0;
      if (TOD === 'night' && me) { const M = me.Wm; HEAD.p.value.set(M[3], M[7] + 60, M[11], 1); HEAD.d.value.set(-M[2], -M[6] - 0.05, -M[10]).normalize(); }
      const gf = cur.gf, flag = this.mem[D + ((S.state + 0x152 + 0xC9) & 0xFFFF)];
      // this run: started again (the clock went back), recorded tick by tick, kept if it finished fastest
      // (a restart (the clock back near 0): a new run; driving on from an earlier moment in the replay screen: the run
      // cut back to there and recorded on from it)
      if (!G.run || gf < G.run.last && gf < 3) G.run = { m: [], last: gf, done: false };
      else if (gf < G.run.last) { G.run.m.length = gf + 1; G.run.last = gf; G.run.done = false; }
      if (meW && !G.run.done && gf > 0) { G.run.m[gf] = meW.slice(); G.run.last = gf; }
      if (flag === 3 && !G.run.done && G.run.m.length > 20) {
        G.run.done = true;
        // (kept when its official time is the best: the finish frame and the penalty for any part of the track skipped)
        const n = G.run.m.length, score = n + (this.rw(S.state + 330) || 0);
        if (!G.best || score < G.score) {
          const out = new Float32Array(1 + n * 12); out[0] = n;
          let last = G.run.m.find(x => x) || new Array(12).fill(0);
          for (let i = 0; i < n; i++) { if (G.run.m[i]) last = G.run.m[i]; out.set(last, 1 + i * 12); }
          G.best = out; G.score = score;
          let prims = null;
          {
            const sh = this.shape(who.ptr, who.paint); prims = sh.prims.filter(p => p.pat !== 0 && p.tri.length).map(p => ({ t: Array.from(p.tri, x => Math.round(x * 10) / 10), c: p.c, p: p.pat }));
            G.car = { prims: prims.map(q => ({ tri: Float32Array.from(q.t), c: q.c, pat: q.p, rank: 0, one: 0, cull2: 0 })) };
          }
          ghostSet(track, { best: out, score, car: prims });   // (every track's best run kept, in this browser)
        }
      }
      // the ghost, in step with the clock (eased between ticks as the cars are)
      const B = G.best; if (!B || !meW || !this.ghostOn || !avail) return;
      const n = B[0], t = (prev && prev.gf != null ? prev.gf + (gf - prev.gf) * a : gf);
      if (t <= 0 || t >= n - 1) return;
      const i = Math.floor(t), f = t - i, M = new Array(12);
      for (let k = 0; k < 12; k++) M[k] = B[1 + i * 12 + k] * (1 - f) + B[1 + (i + 1) * 12 + k] * f;
      // (not while the camera is inside it: the in-car camera at the start, the ghost where you are)
      const bb = this.shape(who.ptr, who.paint).bb, cp = this.camPos;
      if (bb && cp) { const dx = cp.x - M[3], dy = cp.y - M[7], dz = cp.z - M[11], x = M[0] * dx + M[4] * dy + M[8] * dz, y = M[1] * dx + M[5] * dy + M[9] * dz, z = -(M[2] * dx + M[6] * dy + M[10] * dz), e = 12;
        if (x > bb[0] - e && x < bb[3] + e && y > bb[1] - e && y < bb[4] + e && z > bb[2] - e && z < bb[5] + e) return; }
      gb.fill(this, [{ ptr: who.ptr, paint: who.paint, ghost: true, sh: G.car || undefined }], () => M, false);
      gb.mesh.visible = this.ghostDepth.visible = true;
    }

    // A car's place as the drawn car's would be (an object's Wm: rows of a 3x4, in the page's world), from the game's own
    // state (state.playerstate, the opponent's after it: car_posWorld1 in 1/64 units, car_rotate in 1/1024 turns: yaw, pitch,
    // roll), for when the car isn't drawn: yours from the in-car camera, the opponent's far off. (Matched against the drawn
    // car: within a hundredth on the rotation; the shape's origin 6.44 units under the car's place.) ci: 2 yours, 3 theirs.
    carFromState(ci) {
      const D = this.D << 4, st = this.S.state + 0x152 + (ci - 2) * 0xD0, m = this.mem, b = o => m[D + ((st + o) & 0xFFFF)];
      const l32 = o => b(o) | b(o + 1) << 8 | b(o + 2) << 16 | b(o + 3) << 24, s16 = o => ((b(o) | b(o + 1) << 8) << 16) >> 16, K = Math.PI / 512;
      // (read while the game runs on: read again till two readings agree, never a value half written)
      const read = () => [l32(0), l32(4), l32(8), s16(0x18), s16(0x1A), s16(0x1C)];
      let v = read();
      for (let k = 0; k < 4; k++) { const w = read(); if (w.every((x, i) => x === v[i])) break; v = w; }
      const R = new T.Matrix4().makeRotationY(v[3] * K).multiply(new T.Matrix4().makeRotationX(v[4] * K)).multiply(new T.Matrix4().makeRotationZ(-v[5] * K)).elements;
      return [R[0], R[4], R[8], v[0] / 64, R[1], R[5], R[9], v[1] / 64 - 6.44, R[2], R[6], R[10], -v[2] / 64];
    }

    // OG mode: the ghost alone, drawn at the original's 320x200 from its own camera, hidden behind the scenery (the
    // scene's depth first, nothing coloured), read back for the page to lay on the original picture (main.js)
    ogGhostDraw() {
      if (!this.ghostBuf || !this.ghostBuf.mesh.visible) return;
      const r = this.r, sc = this.scene, gm = this.ghostBuf.mesh;
      if (!this.ogRT) {
        this.ogRT = new T.WebGLRenderTarget(320, 200); this.ogRT.texture.encoding = T.sRGBEncoding;   // (the shapes' colours are kept linear: back to the palette's)
        this.ogDepthMat = new T.MeshBasicMaterial({ colorWrite: false, side: T.DoubleSide });
        this.ogGhostMat = new T.MeshBasicMaterial({ vertexColors: true, side: T.DoubleSide, fog: false });   // (flat: the palette's colours)
        this.ogPx = new Uint8Array(320 * 200 * 4); this.ogOut = new Uint8Array(320 * 200 * 4);
      }
      const vis = sc.children.map(c => c.visible), mat = gm.material, sm = r.shadowMap.autoUpdate, bgc = sc.background;
      const cc = r.getClearColor(new T.Color()), ca = r.getClearAlpha();
      r.shadowMap.autoUpdate = false; sc.background = null;
      r.setRenderTarget(this.ogRT); r.setClearColor(0x000000, 0); r.clear();
      gm.visible = this.ghostDepth.visible = false; sc.overrideMaterial = this.ogDepthMat;
      r.render(sc, this.cam);
      sc.overrideMaterial = null; sc.children.forEach(c => { c.visible = c === gm; }); gm.material = this.ogGhostMat;
      r.render(sc, this.cam);
      gm.material = mat; sc.children.forEach((c, i) => { c.visible = vis[i]; });
      sc.background = bgc; r.shadowMap.autoUpdate = sm; r.setClearColor(cc, ca);
      r.readRenderTargetPixels(this.ogRT, 0, 0, 320, 200, this.ogPx); r.setRenderTarget(null);
      for (let y = 0; y < 200; y++) this.ogOut.set(this.ogPx.subarray((199 - y) * 1280, (200 - y) * 1280), y * 1280);   // (rows top down)
      this.ogGhost = this.ogOut;
    }

    // A crash: a low-poly explosion instead of the original's 2D one: a burst of flat triangles (fire
    // colours, then a little dark smoke) thrown out and falling, and triangle flames rising from the wreck for
    // as long as the car is crashed (state's car_crashBmpFlag 1). Triangles face the camera.
    explosions(now, race, camWorld) {
      const X = this.boomFx || (this.boomFx = (() => {
        const N = 3000, g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(new Float32Array(N * 9), 3).setUsage(T.DynamicDrawUsage));
        g.setAttribute('color', new T.BufferAttribute(new Float32Array(N * 9), 3).setUsage(T.DynamicDrawUsage));
        const mesh = new T.Mesh(g, new T.MeshBasicMaterial({ vertexColors: true, side: T.DoubleSide, fog: false }));
        mesh.frustumCulled = false; this.scene.add(mesh);
        return { N, g, mesh, parts: [], cars: {}, t: now };
      })());
      const dt = Math.min(0.1, Math.max(0, (now - X.t) / 1000)); X.t = now;
      // (a restart, or a new race: the game's frame counter goes back; nothing of the last one's crash stays)
      const gfr = this.rw(this.S.state + GAME_FRAME);
      if (!race || gfr + 20 < (X.gf || 0)) { X.parts = []; X.cars = {}; X.splash = {}; X.ripples = []; }
      RIPPLE.value.forEach((r, i) => { const q = (X.ripples || [])[i], age = q ? (now - q.t0) / 1000 : 99; r.set(q ? q.x : 0, q ? q.z : 0, age, q && age < 6 ? 1 : 0); });
      X.gf = race ? gfr : 0;
      const D = this.D << 4, rnd = (a, b) => a + Math.random() * (b - a);
      const FIRE = [[1, 0.93, 0.35], [1, 0.62, 0.1], [0.95, 0.3, 0.06], [0.85, 0.12, 0.04]].map(lin), SMOKE = lin([0.22, 0.2, 0.2]), SPLASH = [[1, 1, 1], [0.75, 0.9, 1], [0.35, 0.6, 0.95]].map(lin);
      X.splash = X.splash || {};
      if (race) for (const ci of [2, 3]) {
        // (car_crashBmpFlag: 1 a crash, the original's cracked windscreen; 2 sinking in water; 3 the race over: only 1 explodes)
        const st = this.S.state + 0x152 + (ci - 2) * 0xD0, flag = this.mem[D + ((st + 0xC9) & 0xFFFF)], crashed = flag === 1;
        const rl = o => { const a = D + ((st + o) & 0xFFFF); return this.mem[a] | (this.mem[a + 1] << 8) | (this.mem[a + 2] << 16) | (this.mem[a + 3] << 24); };
        if (flag === 2) {   // into the water: a splash, once (white and water-blue triangles thrown up, falling back)
          if (!X.splash[ci]) {
            X.splash[ci] = true;
            const sp0 = new T.Vector3(rl(0) / 64, rl(4) / 64 + 4, -rl(8) / 64);
            X.ripples = (X.ripples || []).concat([{ x: sp0.x, z: sp0.z, t0: now }]).slice(-2);
            for (let i = 0; i < 160; i++) {
              const ring = i >= 110, a = rnd(0, 2 * Math.PI), up = ring ? rnd(0.15, 0.4) : rnd(0.7, 1), sp = ring ? rnd(120, 260) : rnd(160, 520);
              X.parts.push({ p: sp0.clone().add(new T.Vector3(rnd(-20, 20), 0, rnd(-20, 20))), v: new T.Vector3(Math.cos(a) * Math.sqrt(1 - up * up) * sp, up * sp, Math.sin(a) * Math.sqrt(1 - up * up) * sp),
                g: 520, life: rnd(0.6, 1.4), age: -rnd(0, 0.12), size: rnd(5, 16), rot: rnd(0, 6.3), spin: rnd(-6, 6), c: SPLASH[(Math.random() * 3) | 0], keep: true });
            }
          }
          delete X.cars[ci]; continue;
        }
        X.splash[ci] = false;
        if (!crashed) { delete X.cars[ci]; continue; }
        const pos = new T.Vector3(rl(0) / 64, rl(4) / 64 + 10, -rl(8) / 64);
        let c = X.cars[ci];
        if (!c) {
          const da = rnd(0, 2 * Math.PI);
          c = X.cars[ci] = { pos, flame: 0, t0: now, seed: rnd(0, 1000), dx: Math.cos(da), dz: Math.sin(da) };
          for (let i = 0; i < 170; i++) {   // the burst
            const smoke = i > 150, a = rnd(0, 2 * Math.PI), up = rnd(0.15, 1), sp = smoke ? rnd(30, 90) : rnd(90, 560);
            X.parts.push({ p: pos.clone(), v: new T.Vector3(Math.cos(a) * Math.sqrt(1 - up * up) * sp, up * sp * (smoke ? 1.4 : 1), Math.sin(a) * Math.sqrt(1 - up * up) * sp),
              g: smoke ? -15 : 420, life: smoke ? rnd(0.9, 1.7) : rnd(0.4, 1.5), age: smoke ? -rnd(0.1, 0.4) : 0, size: smoke ? rnd(12, 24) : rnd(5, 20), smoke, rot: rnd(0, 6.3), spin: rnd(-6, 6), c: FIRE[(Math.random() * 4) | 0] });
          }
        }
        c.pos.copy(pos);
        // flames over the wreck
        // (many small flames licking up over the whole car, and a column of dark smoke rising from them)
        c.flame += dt * 150;
        while (c.flame >= 1) {
          c.flame -= 1;
          if (Math.random() < 0.22) { X.parts.push({ p: pos.clone().add(new T.Vector3(rnd(-25, 25), rnd(40, 80), rnd(-25, 25))), v: new T.Vector3(rnd(-10, 10), rnd(60, 110), rnd(-10, 10)), g: -25,
            life: rnd(1.4, 2.6), age: 0, size: rnd(9, 18), smoke: true, rot: rnd(0, 6.3), spin: rnd(-2, 2) }); continue; }
          X.parts.push({ p: pos.clone().add(new T.Vector3(rnd(-45, 45), rnd(-8, 30), rnd(-45, 45))), v: new T.Vector3(rnd(-18, 18), rnd(80, 190), rnd(-18, 18)), g: -20,
            life: rnd(0.25, 0.6), age: 0, size: rnd(3, 8), flame: true, rot: rnd(0, 6.3), spin: rnd(-5, 5) });
        }
      }
      if (!race) { X.cars = {}; X.splash = {}; }
      // move, age, drop the dead
      X.parts = X.parts.filter(q => { q.age += dt; if (q.age < 0) return true; q.v.y -= q.g * dt; q.p.addScaledVector(q.v, dt); q.rot += q.spin * dt; return q.age < q.life; }).slice(-X.N);
      // triangles facing the camera
      const e = camWorld.elements, R = new T.Vector3(e[0], e[1], e[2]), U = new T.Vector3(e[4], e[5], e[6]);
      const P = X.g.attributes.position.array, C = X.g.attributes.color.array;
      let n = 0;
      for (const q of X.parts) {
        if (q.age < 0) continue;
        const f = q.age / q.life, s = q.size * (q.smoke ? 0.6 + f * 0.6 : 1 - f * 0.75);
        const col = q.smoke ? SMOKE : q.flame ? FIRE[Math.min(3, (f * 4) | 0)] : q.keep || f <= 0.7 ? q.c : FIRE[3];   // (splash drops keep their colour)
        for (let k = 0; k < 3; k++) {
          const a = q.rot + k * 2.0944, cx = Math.cos(a) * s, sy = Math.sin(a) * s, o = n * 9 + k * 3;
          P[o] = q.p.x + R.x * cx + U.x * sy; P[o + 1] = q.p.y + R.y * cx + U.y * sy; P[o + 2] = q.p.z + R.z * cx + U.z * sy;
          C[o] = col[0]; C[o + 1] = col[1]; C[o + 2] = col[2];
        }
        n++;
      }
      X.g.setDrawRange(0, n * 3); X.g.attributes.position.needsUpdate = true; X.g.attributes.color.needsUpdate = true;
      X.mesh.visible = n > 0;
    }

    // the scenery's ground colour (skybox_grd_color, a palette index), linear
    groundColor() {
      const c = this.rw(this.S.skybox_grd_color) & 255, p = this.pal;
      return new T.Color(p[c * 3] / 63, p[c * 3 + 1] / 63, p[c * 3 + 2] / 63).convertSRGBToLinear();
    }

    // The track menu's overview in 3D: the whole track (the static meshes) on its land under the scenery's
    // sky and horizon, seen from above and slowly circled. Shown in the 4:3 frame like the menu around it.
    renderPreview(now) {
      const B = this.worldBox;
      if (!B) return false;
      for (let i = 0; i < NROOF; i++) ROOF.a.value[i].set(1, 1, 0, 0);   // (no tunnel shade from the last race on this overview)
      if (this.carSuns) { this.carSunsAt(false, [], null, SUN_DIR.value); this.nearSunAt(false); }   // (nor the cars' shadows, nor the near map's)
      this.domeEased = false;   // (its own sky colours: the next race's are put straight in, not eased from these)
      if (this.marks) { const X = this.marks; X.n = 0; X.head = 0; X.last.clear(); X.g.setDrawRange(0, 0); X.mesh.visible = false; }   // (no tyre marks from the last race)
      if (this.pvT0 == null) { this.pvT0 = this.pvLast = now; this.pvAuto = 0; this.pvZoom = this.pvZoomTo = 1; this.pvHov = this.pvHovTo = 0; this.pvEl = this.pvElTo = null; this.pvDragAt = null; this.pvDragT = 0; }
      const k = this.wide || 1, cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2;
      const r = Math.max(2500, Math.hypot(B.x1 - B.x0, B.z1 - B.z0) / 2 + 600);
      // looking down el, the frame's centre a little below the view axis: more sky above, the horizon in view
      // the track midway between the title and the buttons, the skyline above it; as close as fits the frame's
      // width (the whole canvas, widescreen too) and the space between title and buttons
      // (?pv=el,shift,zoom tries another framing)
      const pv = (/[?&]pv=([-\d.,]+)/.exec(root.location.search) || [])[1], [el0, shift, zoom] = pv ? pv.split(',').map(Number) : [0.19, -0.1, 0.96];
      const fov = 54 * Math.PI / 180, f = 1 / Math.tan(fov / 2);
      LINE_PX.value = 0.1;
      // a turn in about 80 seconds; the pointer over the track (between the title and the buttons, moved in the
      // last few seconds) turns it instead, half a turn across the picture, and it stays where it was left
      const pt = this.pointer, dt = Math.min(100, now - this.pvLast); this.pvLast = now;
      if (this.pvEl == null) this.pvEl = this.pvElTo = el0;
      // dragged with the button held (over the track, between the title and the buttons): left and right turn it,
      // up and down tilt it; let go, and it turns on its own again from there
      const drag = pt && (pt.b & 1) && pt.y > 0.1 && pt.y < 0.82;
      if (drag && this.pvDragAt) {
        this.pvHovTo -= (pt.x - this.pvDragAt.x) * Math.PI * 1.5;
        this.pvElTo = Math.max(0.08, Math.min(0.53, this.pvElTo + (pt.y - this.pvDragAt.y) * 0.6));
      }
      this.pvDragAt = drag ? { x: pt.x, y: pt.y } : null;
      if (drag) this.pvDragT = now;
      if (!drag) this.pvAuto += dt * 0.00008;   // (turning on its own whenever it is not held)
      const ease = 1 - Math.exp(-dt / 180);
      this.pvHov += (this.pvHovTo - this.pvHov) * ease; this.pvEl += (this.pvElTo - this.pvEl) * ease;
      const el = this.pvEl;
      this.pvZoom = (this.pvZoom || 1) + ((this.pvZoomTo || 1) - (this.pvZoom || 1)) * ease;
      const dist = zoom * this.pvZoom * Math.max(2 * r * f / (4 / 3) / k / 1.5, 2 * r * Math.sin(el) * f / 0.8);
      const az = 0.7 + this.pvAuto + this.pvHov;
      const eye = new T.Vector3(cx + Math.sin(az) * Math.cos(el) * dist, B.y1 * 0.5 + Math.sin(el) * dist, cz + Math.cos(az) * Math.cos(el) * dist);
      const target = new T.Vector3(cx, B.y1 * 0.3, cz);
      this.cam.projectionMatrix.set(
        f / (4 / 3) / k, 0, 0, 0,
        0, f, shift, 0,
        0, 0, (FAR + NEAR) / (NEAR - FAR), 2 * FAR * NEAR / (NEAR - FAR),
        0, 0, -1, 0);
      this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert();
      const camWorld = new T.Matrix4().lookAt(eye, target, new T.Vector3(0, 1, 0)).setPosition(eye);
      this.cam.matrixWorld.copy(camWorld); this.cam.matrixWorldInverse.copy(camWorld).invert();
      this.camPos = eye;
      // only the track and its land
      for (const h of this.hidden) { h.im.setMatrixAt(h.j, h.m); h.im.instanceMatrix.needsUpdate = true; }
      this.hidden = [];
      this.statics.visible = true; if (this.loStatics) this.loStatics.visible = true;
      for (const d of [this.dyn, this.dynCar, this.dynShadow, this.dynFlat, this.bgDyn, this.cloudDyn, this.dynCarSh]) if (d) d.fill(this, [], o => o.Wm, true);
      this.stage.visible = false; this.skyQuad.visible = false;
      this.cloudReg = null;
      const gc = this.pvGround || this.groundColor();
      this.ground.visible = true; this.ground.position.set(eye.x, 0, eye.z); this.ground.scale.set(FAR * 1.5, 1, FAR * 1.5);   // (out to the horizon's foot)
      this.groundMat.color.copy(gc); this.hemi.groundColor.copy(gc);
      // the land round the map a shade darker, the map standing out: a dark frame laid on the ground, its hole
      // the map's extent (all its tiles, half a tile past their centres)
      if (!this.pvFrame || this.pvFrame.userData.box !== this.mapBox) {
        if (this.pvFrame) { this.scene.remove(this.pvFrame); this.pvFrame.geometry.dispose(); }
        const b = this.mapBox, R = FAR * 2, sh = new T.Shape([new T.Vector2(-R, -R), new T.Vector2(R, -R), new T.Vector2(R, R), new T.Vector2(-R, R)]);
        sh.holes.push(new T.Path([new T.Vector2(b.x0, b.z0), new T.Vector2(b.x0, b.z1), new T.Vector2(b.x1, b.z1), new T.Vector2(b.x1, b.z0)]));
        // (gone where the haze is: past the land's end it lay over the horizon strip, a hazy band with a hard top edge)
        const fm = new T.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.28, depthWrite: false, side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
        fm.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', '#include <fog_fragment>\n#ifdef USE_FOG\n  gl_FragColor.a *= 1.0 - smoothstep(fogNear, fogFar, fogDepth);\n#endif'); };
        this.pvFrame = new T.Mesh(new T.ShapeGeometry(sh).rotateX(Math.PI / 2), fm);
        this.pvFrame.userData.box = this.mapBox; this.pvFrame.frustumCulled = false; this.pvFrame.position.y = 0.5; this.scene.add(this.pvFrame);
      }
      this.pvFrame.visible = true;
      // sky, horizon and haze as in a race
      this.domeMat.uniforms.zenith.value.setRGB(0.24, 0.5, 0.88).convertSRGBToLinear();
      this.domeMat.uniforms.horizon.value.setRGB(0.78, 0.88, 0.97).convertSRGBToLinear(); this.domeMat.uniforms.useMid.value = 0;
      this.dome.position.copy(eye); this.dome.visible = true;
      for (const m of this.hd.values()) if (m) m.visible = false;
      this.stripOn = false; this.bandOn = false;
      if (USE_STRIP && this.natMesh && this.stripTex) {
        // the original's horizon strip, crisp, scrolled with the heading as the game does (1024 columns a turn,
        // column -heading at game x 0: measured against the game's own pictures in races)
        this.natMesh.visible = false;
        const fwd = target.clone().sub(eye).setY(0).normalize();
        this.horizonStrip(-Math.atan2(fwd.x, fwd.z) * 1024 / (2 * Math.PI), fwd);
      } else if (this.natMesh) {
        // (seen from high up: the horizon stands on the land, past the ground's far corners, in the haze)
        const hz = this.natMesh, s = FAR * 0.75 / 150000; hz.visible = true; hz.position.set(eye.x, 0, eye.z); hz.scale.set(-s, s, s);
        hz.material.uniforms.haze.value.copy(this.domeMat.uniforms.horizon.value).multiplyScalar(0.92).convertLinearToSRGB();
        hz.material.uniforms.foot.value = hz.material.uniforms.hazeAmt.value;   // (no hazier foot: no pale band between the hills and the land)
      }
      this.scene.fog.color.copy(this.domeMat.uniforms.horizon.value).multiplyScalar(0.92).convertLinearToSRGB();   // (sRGB, see above)
      this.scene.fog.near = 1e9; this.scene.fog.far = 2e9;   // (no haze on the overview: the land runs clear to the horizon)
      if (OG) {   // the original look: the scenery's flat sky colour, no haze but the subtle depth
        const c = this.pvSky || this.groundColor();
        this.setDepth(null);   // (the overview: no depth fade over the land)
        { const du = this.domeMat.uniforms, cs = c.clone().convertLinearToSRGB();
          du.horizon.value.copy(cs).lerp(new T.Color(1, 1, 1), 0.35).convertSRGBToLinear(); du.mid.value.copy(c);
          du.zenith.value.copy(cs).lerp(new T.Color(0.1, 0.3, 0.8), 0.6).convertSRGBToLinear(); du.useMid.value = 1; }
        this.scene.fog.near = 1e9; this.scene.fog.far = 2e9;
      }
      // sun shadows over the whole track
      const sunDir = new T.Vector3(-0.36, 0.84, 0.4).normalize(), ext = Math.ceil(r * 1.05), sc = this.sun.shadow.camera;
      const focus = new T.Vector3(cx, 0, cz);
      SUN_DIR.value.copy(sunDir);
      this.sun.target.position.copy(focus); this.sun.position.copy(focus).addScaledVector(sunDir, 3 * ext);
      if (sc.right !== ext) { sc.left = sc.bottom = -ext; sc.right = sc.top = ext; sc.near = ext * 1.2; sc.far = ext * 4.8; sc.updateProjectionMatrix(); }
      SH_FADE.value.set(1e9, 2e9); SH_RANGE.value = sc.far - sc.near;
      this.sun.target.updateMatrixWorld(); this.sun.updateMatrixWorld(); this.sun.shadow.autoUpdate = true;
      if (this.grass) for (const g of this.grass) g.mesh.visible = false;
      this.r.autoClear = false; this.r.clear();
      this.domeMat.uniforms.sunDir.value.copy(sunDir);
      // (the water's reflection seen from this camera, every other frame: not the last race's)
      if (!/[?&]norefl/.test(root.location.search) && this.waterInView()) { if ((this.reflN = (this.reflN || 0) + 1) % 2 || !REFL.on.value || this.reflFor !== 'pv') { this.reflect(); this.reflFor = 'pv'; } } else REFL.on.value = 0;
      this.r.render(this.domeScene, this.cam);
      if (this.stripOn) this.r.render(this.stripScene, this.skyCam);
      this.giFrame();
      this.r.render(this.scene, this.cam);
      if (this.aoPass) this.aoPass.render(this.scene, this.cam, [this.dynShadow.mesh, this.cloudDyn.mesh, this.bgDyn.mesh, this.stage]);
      this.opaque();
      return true;
    }

    // the canvas's alpha set to 1 everywhere: see-through (stipple) surfaces leave less in it, and the page
    // would show what is under the canvas through them
    opaque() {
      const gl = this.r.getContext(), cc = this.r.getClearColor(new T.Color()), ca = this.r.getClearAlpha();
      gl.colorMask(false, false, false, true);
      this.r.setClearColor(0x000000, 1); this.r.clear(true, false, false);
      gl.colorMask(true, true, true, true);
      this.r.setClearColor(cc, ca);
    }

    resize(w, h, dpr, wide = 1) { this.r.setPixelRatio(dpr); this.r.setSize(w, h, false); this.wide = wide; }   // wide: the canvas's width over the 4:3 frame's

    rw(off) { const a = (this.D << 4) + (off & 0xFFFF); return this.mem[a] | (this.mem[a + 1] << 8); }
    s16(v) { return (v << 16) >> 16; }
    far(off) { return ((this.rw(off + 2) << 4) + this.rw(off)) & 0xFFFFF; }

    // material -> colour and fill pattern, through the lists the renderer uses (material_*_ptr_cpy):
    // pattern type 0 solid, 1 a 4x4 stipple mask (mask 0: not drawn, e.g. the windmill's sail disc)
    color(material) {
      const S = this.S, p = this.pal, w = a => this.rw(this.rw(a) + material * 2);
      const mc = w(S.material_clrlist_ptr_cpy) & 0xFF, type = w(S.material_patlist_ptr_cpy);
      const c = [p[mc * 3] / 63, p[mc * 3 + 1] / 63, p[mc * 3 + 2] / 63];
      c.pat = type === 1 ? w(S.material_patlist2_ptr_cpy) : 0xFFFF;
      if (type === 2) {   // two colours: the second one where the mask is clear; shown as their mix
        const m2 = w(S.material_clrlist2_ptr_cpy) & 0xFF;
        c.two = [c.slice(0, 3), [0, 1, 2].map(k => p[m2 * 3 + k] / 63)];
        for (let k = 0; k < 3; k++) c[k] = (c[k] + p[m2 * 3 + k] / 63) / 2;
      }
      return c;
    }

    // SHAPE3D in dseg -> per primitive a triangle list in shape coordinates, with its paint colour
    // the shapes of the track's scenery (trkObjectList 0x97..0xB5: buildings, trees, the windmill, the boat), not its pieces
    isTerrain(ptr) {   // (the terrain's shapes: sceneshapes2, the hills and slopes, water, the land round them)
      if (!this._terrain) { this._terrain = new Set(); for (let t = 1; t < 19; t++) for (const k of [4, 6]) this._terrain.add(this.rw(this.S.sceneshapes2 + t * 14 + k)); }
      return this._terrain.has(ptr);
    }
    isHillRoad(ptr) {   // (trkObjectList 0xB6..0xC5: the pieces a road on a slope becomes, seg004 subst_hillroad_track)
      if (!this._hillRoad) { this._hillRoad = new Set(); for (let e = 0xB6; e <= 0xC5; e++) for (const k of [4, 6]) this._hillRoad.add(this.rw(this.S.trkObjectList + e * 14 + k)); }
      return this._hillRoad.has(ptr);
    }
    isScenery(ptr) {
      if (!this._scenery) { this._scenery = new Set(); for (let e = 0x97; e <= 0xB5; e++) for (const k of [4, 6]) this._scenery.add(this.rw(this.S.trkObjectList + e * 14 + k)); }
      return this._scenery.has(ptr);
    }
    shape(ptr, paint) {
      // (the same shapes are asked for some 200 times a frame, each time hashing their vertices for the key: within one
      // frame, the first answer stands)
      const mk = ptr * 256 + paint, memo = this.shapeMemo && this.shapeMemo.get(mk);
      if (memo) return memo;
      const r_ = this.shapeOnce(ptr, paint);
      if (this.shapeMemo && r_) this.shapeMemo.set(mk, r_);
      return r_;
    }
    shapeOnce(ptr, paint) {
      const nv = this.rw(ptr), np = this.rw(ptr + 6) & 0xFF, npaint = this.rw(ptr + 8) & 0xFF;
      const va = this.far(ptr + 2), pa = this.far(ptr + 10), m = this.mem;
      if (paint >= npaint) paint = 0;
      // vertices can be animated in place (the start banner), so their contents are part of the key
      let h = 0; for (let i = va, e = va + nv * 6; i < e; i++) h = (h * 31 + m[i]) | 0;
      const key = va + ':' + pa + ':' + nv + ':' + np + ':' + paint + ':' + h;
      let sh = this.cache.get(key);
      if (sh) return sh;
      const V = [];
      for (let i = 0; i < nv; i++) { const o = va + i * 6; V.push([0, 2, 4].map(k => this.s16(m[o + k] | (m[o + k + 1] << 8)))); }
      // track pieces (shapes without wheels): points a few units either side of a tile's edge (505..519; 1017..1031 for the
      // two-tile turns) are on the edge, so
      // neighbouring pieces meet with no crack along hill crests and road joins
      let wheels = false;
      // (a car's windows reach up to its roof line, the top 38% of its height: a dark panel lower down, a grille or rear
      // panel (the DAF Siluro's), is not grown or snapped as glass)
      let vlo = 1e9, vhi = -1e9; for (const v of V) { vlo = Math.min(vlo, v[1]); vhi = Math.max(vhi, v[1]); }
      const winY = vlo + (vhi - vlo) * 0.62;
      { for (let i = 0, q = pa; i < np && !wheels; i++) { if (m[q] === 12) wheels = true; q += 2 + npaint + (VCOUNT[m[q]] || 0); }
        if (!wheels) for (const v of V) for (const k of [0, 2]) { const a = Math.abs(v[k]); if (a > 504 && a < 520 && a !== 512) v[k] = Math.sign(v[k]) * 512; else if (a > 1016 && a < 1032 && a !== 1024) v[k] = Math.sign(v[k]) * 1024; } }
      const prims = [];
      let ext = 0; for (const v of V) ext = Math.max(ext, Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
      // the vertices polygon faces use: one lying along another face's edge (a T-junction) is added to that face, so
      // neighbours share the same points and no hairline crack opens between them (see weld())
      const faceVerts = [];
      { const used = new Set();
        for (let i = 0, q = pa; i < np; i++) { const type = m[q], n = VCOUNT[type] || 0; if ((type >= 3 && type <= 10) || type === 13) for (let k = 0; k < n; k++) used.add(m[q + 2 + npaint + k]); q += 2 + npaint + n; }
        for (const i of used) if (V[i]) faceVerts.push(V[i]); }
      let o = pa, baseIdx = -1;
      const c1a = this.far(ptr + 14), c2a = this.far(ptr + 18), rd = a => (m[a] | m[a + 1] << 8 | m[a + 2] << 16 | m[a + 3] << 24) >>> 0;   // per primitive: the view directions it is drawn from, and those it is drawn double-sided from
      for (let i = 0; i < np; i++) {
        const type = m[o], pflags = m[o + 1]; o += 2;
        const mat = m[o + Math.min(paint, npaint - 1)]; o += npaint;
        const n = VCOUNT[type] || 0, idx = Array.from(m.subarray(o, o + n)); o += n;
        let wheel = null, wheelR = 0, wheelPart = null;
        const tri = [], lofs = [], c0 = this.color(mat);
        // (a car's two-colour paint, dots of one on the other: mostly the darker one, as it reads on the original's
        // small screen; an even mix comes out pale, as if see-through)
        let c = c0;
        if (wheels && c0.two) { const [a, b] = c0.two, la = a[0] + a[1] + a[2], lb = b[0] + b[1] + b[2], [d, l] = la < lb ? [a, b] : [b, a]; c = [0, 1, 2].map(k => d[k] * 0.75 + l[k] * 0.25); c.pat = c0.pat; }
        const P = idx.map(i => V[i]);
        if (!P.some(p => !p)) {
          if ((type >= 3 && type <= 10) || type === 13) { const Pw = weld(P, faceVerts); for (let k = 1; k < Pw.length - 1; k++) tri.push(Pw[0], Pw[k], Pw[k + 1]); }
          else if (type === 2) line(tri, P[0], P[1], lofs, Math.min(2.5, Math.max(LINE_W, ext * 0.008)));
          else if (type === 11) sphere(tri, P[0], dist(P[0], P[1]) / 2);   // (the distance is the sphere's width: the original draws it about half that each way, preRender_sphere)
          else if (type === 12) { wheel = []; wheelPart = []; wheelPart.front = idx.every(j => j >= 8 && j < 20); wheelR = dist(P[0], P[1]); cylinder(tri, P[0], P[3], wheelR, wheel, P[1], P[2], wheelPart); }   // (vertices 8..19: the front wheels the game steers, sub_204AE)
          else if (type === 1) line(tri, P[0], P[0], lofs, Math.min(2.5, Math.max(LINE_W, ext * 0.008)));
        }
        const poly = (type >= 3 && type <= 10) || type === 13;
        // decals: primitive flag 2 marks a primitive belonging to the nearest earlier one without it (its base);
        // the original paints it straight after the base whatever the depth, and skips it when the base is
        // hidden. Here it is laid flat onto the base's plane and drawn with a small depth bias.
        let rank = type === 2 || type === 1 ? 1 : 0, plane = null;
        if (pflags & 2 && baseIdx >= 0) {
          // flattened onto a plane it (nearly) lies on: its base, the nearest earlier unflagged primitive, if
          // close enough (on large sloped pieces the markings sit up to ~12 units off, from rounding), else the
          // earlier polygon it lies closest to (the Countach's windscreen pillars follow a small side
          // triangle), else left where it is
          const tol = Math.max(3, 0.03 * ext), far = q => Math.max(...P.map(v => Math.abs(dot(q.plane.n, v) - q.plane.d)));
          let b = prims[baseIdx], on = null;
          if (P.length && !P.some(p => !p)) {
            if (b.plane && far(b) <= tol) on = b;
            else { let best = tol; for (const q of prims) if (!q.decal && q.plane) { const e = far(q); if (e <= best) { best = e; on = q; } } }
          }
          if (on) b = on;
          rank = b.rank + 1;
          if (on) for (let k = 0; k < tri.length; k++) { const v = tri[k], e = dot(on.plane.n, v) - on.plane.d; tri[k] = [v[0] - e * on.plane.n[0], v[1] - e * on.plane.n[1], v[2] - e * on.plane.n[2]]; }
          // (a line's widening to its least width on screen kept in the plane too: across it, half the line stood out of the
          // face, past its edge: the Ferrari GTO's roof trim showed as a black sliver over the roof in the car select)
          if (on) for (let k = 0; k < lofs.length; k++) { const v = lofs[k], e = dot(on.plane.n, v); lofs[k] = [v[0] - e * on.plane.n[0], v[1] - e * on.plane.n[1], v[2] - e * on.plane.n[2]]; }
          // (a car's window: a dark neutral face laid on a body panel, a good share of it. The original drew it a little inside
          // the panel, a body-coloured rim one or two of its pixels wide; in HD that rim was a thick band, the glass looking
          // too small: grown out towards the panel's edges, most of the way, a slim frame left)
          if (on && wheels && poly && tri.length >= 3 && on.tri && on.tri.length >= 9) {
            const sat = Math.max(...c) - Math.min(...c), bv = [];
            for (let k = 0; k + 2 < on.tri.length; k += 3) bv.push([on.tri[k], on.tri[k + 1], on.tri[k + 2]]);
            if (sat < 0.03 && Math.max(...c) < 0.42 && triArea(tri) > 0.15 * triArea(bv) && Math.max(...tri.map(v => v[1])) > winY) { growInside(tri, bv, GLASS_GROW); snapCorners(tri, bv); }
          }
        } else baseIdx = prims.length;
        if (poly && P.length >= 3 && !P.some(p => !p)) plane = planeOf(P);
        // (a wheel in the original's three colours: its material for the tread, the next one for the tyre's
        // side, the one after for the hub; see preRender_wheel's caller)
        prims.push({ mat, f3: poly && P.length >= 3 && !P.some(p => !p) ? facePlane(P) : null, cull1: rd(c1a + i * 4), cull2: rd(c2a + i * 4), one: poly && !(pflags & 1) ? 1 : 0, lofs: lofs.length ? new Float32Array(lofs.flat()) : null, wheel: wheel && new Float32Array(wheel), wheelR, wheelPart: wheelPart && new Uint8Array(wheelPart), front: !!(wheelPart && wheelPart.front && wheelPart.centre), wheelCtr: wheelPart && wheelPart.centre, wheelHalf: wheelPart && wheelPart.halfW, phiGame: wheelPart && wheelPart.phi, wheelC: wheel && [c, this.color(mat + 1), this.color(mat + 2)], idx: prims.length, level: !!plane && Math.abs(plane.n[1]) > 0.95, tri: new Float32Array(tri.flat()), c, poly, rank, plane, box: plane && plane.box, pat: c.pat, decal: !!(pflags & 2) });
      }
      // a building's one-sided face whose back shows from outside is drawn from both sides: seen from behind it is not
      // drawn, and the sky showed through (the barn's upper roof from below, past the gable it overhangs; through that
      // gap, inside the far gable)
      if (!wheels && this.isTerrain(ptr)) for (const p of prims) p.slope = 1;
      // (a road up a hill (the hill-road pieces): its grass and road shaded as the hill around it, not its upright barriers)
      else if (!wheels && this.isHillRoad(ptr)) for (const p of prims) if (p.plane && Math.abs(p.plane.n[1]) > 0.8) p.slope = 1;
      if (!wheels && this.isScenery(ptr)) { const show = prims.filter(p => p.one && p.f3 && backShows(prims, p)); for (const p of show) p.one = 0; }
      let y0 = 1e9, y1 = -1e9;
      for (const v of V) { y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); }
      const bb = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
      for (const v of V) for (let k = 0; k < 3; k++) { bb[k] = Math.min(bb[k], v[k]); bb[k + 3] = Math.max(bb[k + 3], v[k]); }
      // a face lying flat on an earlier one, inside it, without the decal flag (a traffic light's lamp on its box):
      // the original paints it after, over the other; here it is ranked over it as a decal is, so the two do not
      // fight for depth
      for (let i = 1; i < prims.length; i++) {
        const p = prims[i], t = p.tri;
        if (p.decal || !p.plane || !t || t.length < 9) continue;
        for (let j = i - 1; j >= 0; j--) {
          const q = prims[j], u = q.tri;
          if (!q.plane || !u || u.length < 9 || q.rank > p.rank || Math.abs(dot(q.plane.n, p.plane.n)) < 0.999) continue;
          let on = true;
          for (let k = 0; k < t.length && on; k += 3) if (Math.abs(q.plane.n[0] * t[k] + q.plane.n[1] * t[k + 1] + q.plane.n[2] * t[k + 2] - q.plane.d) > 1) on = false;
          if (!on) continue;
          const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
          for (let k = 0; k < u.length; k += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], u[k + c]); hi[c] = Math.max(hi[c], u[k + c]); }
          for (let k = 0; k < t.length && on; k += 3) for (let c = 0; c < 3; c++) if (t[k + c] < lo[c] - 1 || t[k + c] > hi[c] + 1) on = false;
          if (on) {
            p.rank = q.rank + 1;
            // (a window laid this way, no decal flag (the Lancia's rear glass): grown out as one with it is, above)
            if (wheels && p.c) {
              const sat = Math.max(...p.c) - Math.min(...p.c), V = a => { const r = []; for (let k = 0; k + 2 < a.length; k += 3) r.push([a[k], a[k + 1], a[k + 2]]); return r; };
              const pv = V(t), qv = V(u);
              if (sat < 0.03 && Math.max(...p.c) < 0.42 && triArea(pv) > 0.15 * triArea(qv) && Math.max(...pv.map(v => v[1])) > winY) { growInside(pv, qv, GLASS_GROW); snapCorners(pv, qv); p.tri = new Float32Array(pv.flat()); }
            }
            break;
          }
        }
      }
      // a tunnel: see-through faces up over the car, turned down (its roof, a piece of its own over the road): under it
      // all is one shade (see underRoof in the material), the cars' own shadows on top
      {
        const ys = p => { let lo = 1e9, hi = -1e9; for (let k = 1; k < p.tri.length; k += 3) { lo = Math.min(lo, p.tri[k]); hi = Math.max(hi, p.tri[k]); } return [lo, hi]; };
        for (const p of prims) if (p.pat && seeThrough(p.pat) && p.tri.length && p.plane && p.plane.n[1] < -0.2 && ys(p)[0] >= 80) p.roof = true;
      }
      // a loop (or a corkscrew): road bent round, its see-through faces facing up, down and sideways in the one piece. All
      // of them cast, the loop's whole ring of shadow (a fence's stand only upright; a deck's or a tunnel's roof lie flat).
      // And its top, turned down, is no tunnel's roof: under it was all one shade, a box with hard edges inside the loop
      {
        const st = prims.filter(p => p.pat && seeThrough(p.pat) && p.plane && p.tri && p.tri.length);
        if (st.some(p => p.plane.n[1] > 0.85) && st.some(p => p.plane.n[1] < -0.85) && st.some(p => Math.abs(p.plane.n[1]) < 0.5)) for (const p of st) { p.ribbon = true; p.roof = false; }
      }
      // trees: a green canopy held up over a brown trunk. A tree standing alone (nothing in its shape but canopy and
      // trunk) casts its own shadow, canopy and trunk, through the sun's shadow map like everything else, and so does a
      // tree on another piece, as a traffic island's
      {
        const vs = p => { const a = []; for (let k = 0; k < p.tri.length; k += 3) a.push([p.tri[k], p.tri[k + 1], p.tri[k + 2]]); return a; };
        const green = c => c && c[1] > 0.45 && c[1] > c[0] * 1.35 && c[1] > c[2] * 1.35, brown = c => c && c[0] > 0.4 && c[0] > c[1] * 1.3 && c[1] > c[2];
        const cands = prims.filter(p => p.tri.length && green(p.c) && Math.min(...vs(p).map(v => v[1])) >= 40);
        const trunks = prims.filter(p => p.tri.length && brown(p.c));
        const trees = [];
        for (const p of cands) {
          const v = vs(p), cx = v.reduce((a, q) => a + q[0], 0) / v.length, cz = v.reduce((a, q) => a + q[2], 0) / v.length;
          let t = trees.find(t => Math.hypot(t.sx / t.n - cx, t.sz / t.n - cz) < 120);
          if (!t) trees.push(t = { sx: 0, sz: 0, n: 0, ps: [] });
          t.sx += cx; t.sz += cz; t.n++; t.ps.push(p);
        }
        const tree = new Set();
        for (const t of trees) {
          const cx = t.sx / t.n, cz = t.sz / t.n, y0 = Math.min(...t.ps.flatMap(vs).map(v => v[1]));
          for (const p of t.ps) tree.add(p);
          for (const q of trunks) if (vs(q).some(v => Math.hypot(v[0] - cx, v[2] - cz) < 60 && Math.abs(v[1] - y0) < 30)) tree.add(q);
        }
        const alone = trees.length && prims.every(p => !p.tri.length || tree.has(p));
        if (!alone) for (const p of tree) p.onPiece = true;   // (a tree on another piece, a traffic island's: it casts too, canopy and trunk, as one alone)
      }
      closeDecalGaps(prims);
      // a car's see-through faces (the original's dotted glass: windscreens, side windows) solid, dark glass: drawn
      // half see-through they showed the body's inside and a wheel through them (the model has no inside to show)
      // (windows only, reaching up to the roof line; a dotted grille or rear panel lower down (the DAF Siluro's) stays as
      // it was, or it became shiny glass)
      let ylo = 1e9, yhi = -1e9; if (wheels) for (const p of prims) if (!p.wheel && p.f3) for (let k = 1; k < p.tri.length; k += 3) { ylo = Math.min(ylo, p.tri[k]); yhi = Math.max(yhi, p.tri[k]); }
      const ycut = ylo + (yhi - ylo) * 0.34, topY = p => { let t = -1e9; for (let k = 1; k < p.tri.length; k += 3) t = Math.max(t, p.tri[k]); return t; }, ywin = ylo + (yhi - ylo) * 0.62, midY = p => { let my = 0; for (let k = 1; k < p.tri.length; k += 3) my += p.tri[k]; return my / (p.tri.length / 3); };
      // (glass: the shine (spin 0.25, see the car's shading) only on dark neutral faces reaching up to the roof line, the
      // top 38% of the car's height (windscreens, side and rear windows); below, a dark grey face is a grille, bumper or rear panel)
      if (wheels) for (const p of prims) if (!p.wheel && p.tri.length && topY(p) > ywin) p.glass = 1;
      if (wheels) for (const p of prims) if (seeThrough(p.pat) && p.poly && !p.wheel && p.tri.length) { p.pat = 0xFFFF; if (topY(p) > ywin && p.c && Math.max(...p.c) - Math.min(...p.c) < 0.15) p.c = [0.2, 0.2, 0.2]; }   // (every dotted face solid (seen through, the inside of the car and a wheel showed: the Acura's side intake); only windows, up to the roof line, as dark glass: a lower one (the DAF's grille) keeps its colour)
      // a level one-sided face up off the ground (a tunnel's roof, a deck's underside) is drawn from both sides:
      // the original shows a tunnel's roof only from inside, so from outside it looked roofless
      for (const p of prims) if (p.one && p.level && !p.rank && p.tri.length) { let y = 0; for (let k = 1; k < p.tri.length; k += 3) y += p.tri[k]; if (y / (p.tri.length / 3) > y0 + 100) p.one = 0; }
      // a car's chassis (its neutral grey faces: under-tray, valances, floor) a little further in: where one lay
      // just behind a body panel the two cut through each other, a thin grey line across the bumper; the original
      // painted the panel over it (3 units in: 1.2 left a dashed line along the bumper's lower edge again)
      if (wheels) {
        let cx = 0, cy = 0, cz = 0, n = 0;
        for (const p of prims) if (!p.wheel && p.f3) for (let k = 0; k < p.tri.length; k += 3) { cx += p.tri[k]; cy += p.tri[k + 1]; cz += p.tri[k + 2]; n++; }
        cx /= n; cy /= n; cz /= n;
        // (only low on the car, its lower third: the same grey up on the body is glass (windscreens, rear windows), and
        // pushed in it left slits round each pane, the inside of the car seen through them)
        for (const p of prims) {
          const c = p.c; if (p.wheel || !p.f3 || !c || Math.abs(c[0] - c[1]) > 0.02 || Math.abs(c[1] - c[2]) > 0.02 || c[0] < 0.12 || c[0] > 0.45) continue;
          if (midY(p) > ycut) continue;
          for (let k = 0; k < p.tri.length; k += 3) {
            const dx = cx - p.tri[k], dy = cy - p.tri[k + 1], dz = cz - p.tri[k + 2], l = Math.hypot(dx, dy, dz) || 1;
            p.tri[k] += dx / l * 3; p.tri[k + 1] += dy / l * 3; p.tri[k + 2] += dz / l * 3;
          }
        }
      }
      sh = { prims, key, flat: y1 - y0 < 4, bb };   // flat shapes (roads, flat land) lie on the ground: no shadow
      if (this.cache.size > 3000) this.cache.clear();
      this.cache.set(key, sh);
      return sh;
    }

    snapshot(now) {
      const I = this.I, b = I[0], base = 16 + b * H.BUF, n = I[base];
      const Iw = new Int32Array(I.buffer, 4 * (16 + 2 * H.BUF), 18);
      const f = { t: now, p: [I[base + 1], I[base + 2], I[base + 3], I[base + 4]], objs: [] };
      const q = Iw.subarray(b * 9, b * 9 + 9), k = 1 / 16384;
      // MATRIX is stored column-major (_11, _21, _31, _12, ...): row i of the matrix is q[i], q[i+3], q[i+6]
      f.R = new T.Matrix4().set(q[0] * k, q[3] * k, q[6] * k, 0, q[1] * k, q[4] * k, q[7] * k, 0, q[2] * k, q[5] * k, q[8] * k, 0, 0, 0, 0, 1);
      for (let i = 0; i < n; i++) {
        const o = base + H.HDR + i * H.ENT;
        const m = I.subarray(o + 2, o + 11), t = I.subarray(o + 11, o + 14), s = (I[o + 15] ? 0.5 : 1) / 16384;
        f.objs.push({ ptr: I[o], paint: I[o + 1], flags: I[o + 14], varA: I[o + 17], mask: I.slice(o + 18, o + 26), wp: [I[o + 26], I[o + 27], I[o + 28]], C: [m[0] * s, m[3] * s, m[6] * s, t[0], m[1] * s, m[4] * s, m[7] * s, t[1], m[2] * s, m[5] * s, m[8] * s, t[2]], pos: new T.Vector3(t[0], t[1], t[2]) });
      }
      f.cam = I[base + 13] ? [I[base + 10], I[base + 11], I[base + 12]] : null;
      f.preview = !!I[base + 14];   // the track menu's overview (no objects: the page orbits the whole track)
      f.mode = I[base + 15] !== 255 ? I[base + 15] : null;   // the camera it was drawn with (the view plays a little behind the game: after C, the game is already on the next one)
      const ob = base + H.HDR + H.MAX * H.ENT, cnt = I[ob];
      f.order = I.slice(ob + 1, ob + 1 + cnt);
      f.pts = I.slice(ob + 1 + H.ORD, ob + 1 + H.ORD + cnt * H.PTS);
      return f;
    }

    crosses(C, t) {
      for (let i = 0; i < t.length; i += 3) if (C[8] * t[i] + C[9] * t[i + 1] + C[10] * t[i + 2] + C[11] < 12) return true;
      return false;
    }

    // returns false when no 3D frame is current (menus)
    render(now, keep) {
      if (this.modern) return this.renderModern(now, keep);
      const I = this.I, seq = I[1];
      if (seq !== this.seq) {
        this.seq = seq; this.lastFrame = now;
        this.prev = this.cur; this.cur = this.snapshot(now);
        if (this.prev) this.period = Math.min(150, Math.max(16, now - this.prev.t));
      }
      if (!this.cur || (now - this.lastFrame > 400 && !keep)) return false;
      const cur = this.cur, prev = this.prev;
      const a = prev ? Math.min(1, (now - cur.t) / (this.period || 50)) : 1;
      const [p5, p8, p9, p10] = cur.p;
      const near = 8, far = 60000;
      // original projection: px = p5 + x*p9/z, py = p8 - y*p10/z on 320x200; view space is z-mirrored
      this.cam.projectionMatrix.set(
        p9 / 160, 0, -(p5 / 160 - 1), 0,
        0, p10 / 100, -(1 - p8 / 100), 0,
        0, 0, (far + near) / (near - far), 2 * far * near / (near - far),
        0, 0, -1, 0);
      this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert();

      // per shape: camera-space transform, eased from the matching shape of the previous game frame
      // (the same shape whose position, turned by the camera's rotation since, lands nearest)
      let byPtr = null, D = null;
      if (prev && a < 1) {
        byPtr = new Map();
        for (const o of prev.objs) { if (!byPtr.has(o.ptr)) byPtr.set(o.ptr, []); byPtr.get(o.ptr).push(o); }
        D = cur.R.clone().multiply(prev.R.clone().transpose());
      }
      const tmp = new T.Vector3(), Cs = cur.objs.map(o => {
        const list = byPtr && byPtr.get(o.ptr);
        if (!list) return o.C;
        let best = null, bd = Math.pow(150 + o.pos.length() * 0.03, 2);
        for (const po of list) { const d = tmp.copy(po.pos).applyMatrix4(D).distanceToSquared(o.pos); if (d < bd) { bd = d; best = po; } }
        return best ? o.C.map((v, i) => best.C[i] + (v - best.C[i]) * a) : o.C;
      });

      // paint in the original's order
      const P = this.pos, Cc = this.col;
      let nv = 0;
      for (let k = 0; k < cur.order.length; k++) {
        const e = cur.order[k], oi = e >> 8, pi = e & 255, o = cur.objs[oi];
        if (!o) continue;
        const pr = this.shape(o.ptr, o.paint).prims[pi];
        if (!pr || !pr.tri.length || pr.pat === 0) continue;
        const C = Cs[oi], t = pr.tri, c = pr.c;
        if (nv + t.length / 3 > MAXV) break;

        for (let i = 0; i < t.length; i += 3) {
          const x = t[i], y = t[i + 1], z = t[i + 2], j = nv * 3;
          P[j] = C[0] * x + C[1] * y + C[2] * z + C[3];
          P[j + 1] = C[4] * x + C[5] * y + C[6] * z + C[7];
          P[j + 2] = -(C[8] * x + C[9] * y + C[10] * z + C[11]);
          Cc[j] = c[0]; Cc[j + 1] = c[1]; Cc[j + 2] = c[2];
          nv++;
        }
      }
      this.geo.setDrawRange(0, nv);
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
      this.r.render(this.scene, this.cam);
      return true;
    }
  }

  // (the nearest the camera draws: small, so the in-car view never cuts away a wall or road right beside it; the
  // logarithmic depth buffer keeps its precision however near)
  const NEAR = 1, FAR = 400000;
  const LAYER = 4;
  const HZ_R = 56000;   // the race horizon's distance (the fog's far end is 60000)
  const HD_SKY = /[?&]hdsky/.test(root.location ? root.location.search : '');
  const SUN_DIR = { value: new T.Vector3(0, 1, 0) };
  // Baked light (L): how much of the sky each place round the track sees, worked out once per track (bakeGI) and kept
  // in a coarse volume over it; the light from the sky is dimmed by it (corners, under bridges, beside buildings), and
  // the ground's colour, close under a place, lights faces turned away from the sky. The volume's layers sit side by
  // side in one 2D texture (giTiles of them across, down), each giRes.x by giRes.z texels.
  const GI_U = { tGI: { value: null }, giOn: { value: 0 }, giMin: { value: new T.Vector3() }, giSize: { value: new T.Vector3(1, 1, 1) },
    giRes: { value: new T.Vector3(1, 1, 1) }, giTiles: { value: new T.Vector2(1, 1) }, giAmt: { value: 1 }, giBounce: { value: 1.2 }, giDbg: { value: 0 }, giSoft: { value: 0 }, giTexW: { value: 1 } };
  const GI_GLSL = `uniform sampler2D tGI; uniform float giOn; uniform vec3 giMin; uniform vec3 giSize; uniform vec3 giRes; uniform vec2 giTiles; uniform float giAmt; uniform float giBounce; uniform float giDbg;
vec4 giTap( vec3 p ) {
  vec3 q = ( p - giMin ) / giSize * giRes - 0.5;
  float ly = clamp( q.y, 0.0, giRes.y - 1.0 ), l0 = floor( ly ), l1 = min( l0 + 1.0, giRes.y - 1.0 );
  vec2 xz = clamp( q.xz, vec2( 0.0 ), giRes.xz - 1.0 ) + 0.5, at = giTiles * giRes.xz;
  vec2 t0 = vec2( mod( l0, giTiles.x ), floor( l0 / giTiles.x ) ), t1 = vec2( mod( l1, giTiles.x ), floor( l1 / giTiles.x ) );
  return mix( texture2D( tGI, ( t0 * giRes.xz + xz ) / at ), texture2D( tGI, ( t1 * giRes.xz + xz ) / at ), ly - l0 );
}
`;
  const LINE_PX = { value: 0.3 };
  // the car select's picture (wall, curtains, carpet, turntable) for the cars' reflections there (on: car select only)
  const CARPIC = { tex: { value: null }, on: { value: 0 } };
  // ripples where a car went into the water: (x, z, seconds since, on), rings spreading over the reflection
  const RIPPLE = { value: [new T.Vector4(), new T.Vector4()] };
  // headlights (the night mockup, ?tod=night): the player's car's place (w 1: on) and heading
  const HEAD = { p: { value: new T.Vector4() }, d: { value: new T.Vector3() } };
  const TOD = (/[?&]tod=(dusk|night)/.exec(root.location ? root.location.search : '') || [])[1] || '';
  const SH_RANGE = { value: 1 };   // the sun's shadow camera, far minus near
  const CAR_SH_R = 400, CAR_SH_N = 2048;   // each car's own shadow map (carSunsAt): its reach either side of the car, its texels
  const NEAR_SH_R = 1200, NEAR_SH_N = 4096, NEAR_AHEAD = 800;   // the near map round the camera (a race: the scenery's shadows close by crisp), centred this far ahead
  const SH_FADE = { value: new T.Vector2(1e9, 2e9) };   // (a race: the shadows fade out between these distances from the camera, well inside the shadow map's reach)
  const NROOF = 16, ROOF = { a: { value: Array.from({ length: NROOF }, () => new T.Vector4(1, 1, 0, 0)) }, lo: { value: new Array(NROOF).fill(0) } };   // the nearest tunnel roofs' extents (world x0, z0, x1, z1) and heights: under them, shade
  const CAR_P = { value: [new T.Vector4(), new T.Vector4()] };   // the cars' places (w 1: there): their sun shadows darker close to them   // lines' least width on screen, in the original's pixels (the track preview, seen from far: thinner)
  // water reflections (races): the scene mirrored in the water's level, drawn into a texture each frame; flat
  // faces in the scenery's water colour show it, more at a glancing angle
  // depth in the original look: distant things fade a little towards the sky near the horizon
  const DEPTH = { c: { value: new T.Color() }, near: { value: 4000 }, far: { value: 45000 }, amt: { value: 0 } };
  const CARENV = { tex: { value: null }, on: { value: 0 }, sky: { value: new T.Color(1, 1, 1) }, amt: { value: 0.18 } };   // (only ever darkens: kept light so the paint keeps its colour)
  const REFL = { tex: { value: null }, on: { value: 0 }, waterC: { value: new T.Color() }, res: { value: new T.Vector2(1, 1) }, level: { value: 0 } };   // world direction towards the sun (shadow normal offset)
  const CLOCK_SLEW = 0.05;  // the most the playback clock speeds up or slows down to keep its distance
  const PLAY_DELAY = 1.15;   // game frame periods the view plays behind the newest frame (smooth motion)
  const FOLLOW_LAG = 0.12;   // s: how far the chase camera trails the car's turns
  const MAX_SWING = 0.12;   // rad: the most it trails (keeps it out of walls and hills in tight turns)
  const CAM_DAMP = 0.09;    // s: damping of the game camera's distance, height and pitch steps
  const SCENERY = ['desert', 'tropical', 'alpine', 'city', 'country'], NATIVE_H = [24, 29, 30, 20, 16];   // load_skybox's files, their pictures' heights
  // measured against the game's own horizon: the panorama column facing heading a (three.js, atan2(x, z)) is
  // 160 - a * 1024 / 360 (it scrolls 1024 columns per turn, the other way round)
  const HD_OFFSET = 160 / 1024;
  const HD_SCALE = 1.05;   // a reimagined panorama stands about this much higher than the original picture (rows / 155 rad)
  const ROW_ASPECT = 230 / 155;
  const SMOOTH_ANGLE = 38;  // degrees: car body faces bending less than this are shaded as one curved surface
  const CAR_Y = 7.35;       // height of a car's origin over the road while it drives on it
  const TRUCK = [0x7fd6];   // its shape (game3dshapes are at fixed places in the data segment)
  // the rank attribute: a face's decal rank (over the face it lies on, by its depth slope) times RANKS, plus its place in
  // its shape (coplanar faces of one shape: the later one, painted later by the original, wins by a fixed hair; by
  // the slope it pulled faces seen edge-on, a car's underside, through the bumper in front of it)
  const RANKS = 4096, TIE_D = 2e-7;
  const GAME_FRAME = 36452 - 36132;   // offset of state.game_frame
  // palette colour -> linear, a little more saturated (punchier than the VGA palette)
  // The look: by default the original's (its palette colours exactly, flat, unlit, no textures or haze, its
  // sky and horizon), with sun shadows; ?realistic: lighting, textures, glossy cars, haze, ambient occlusion.
  const OG = !(root.location && /[?&]realistic/.test(root.location.search));
  const OG_SHADOW = 0.32;
  const SKY_WRAPS = 4;
  const SKY_NARROW = 1;   // the horizon's width shrunk by this, its height kept (1: the original's pixel proportions)   // times the horizon panorama goes round (1: the original's 1024 columns a turn, larger)
  const USE_STRIP = !!(root.location && /[?&]skystrip/.test(root.location.search));   // the horizon as a screen strip, as the original draws it
  // the original's facing test looks at a polygon's first three corners only (is_facing_camera): a twisted
  // polygon (the corkscrew's road) faces the camera as a whole or not at all. Its plane, mirrored-z:
  // the first corner and the normal of the first three, per vertex as attributes f0 and fn.
  function facePlane(P) {
    const a = [P[0][0], P[0][1], -P[0][2]], b = [P[1][0], P[1][1], -P[1][2]], c = [P[2][0], P[2][1], -P[2][2]];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n) || 1;
    return [a, n.map(x => x / l)];
  }
  // the sun's shadow map for static pieces: their see-through (stippled) faces standing up cast no shadow (a fence's shadow is
  // its posts), as up close (dynShadow.noSee); lying flat facing up (a bridge's deck) they do, and a loop's all do (its ring
  // of road, connected): nocast 2, set per face in shapeGeo, the same rule as the pieces near the camera (DynBuf.fill)
  let _dns = null;
  function depthNoSee() {
    if (_dns) return _dns;
    _dns = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
    _dns.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float pat; attribute float nocast; varying float vPatD;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvPatD = nocast > 1.5 ? 65535.0 : nocast > 0.5 ? 0.0 : pat;').replace('#include <project_vertex>', '#include <project_vertex>\nif ( nocast > 1.5 ) { mvPosition.z -= 8.0; gl_Position = projectionMatrix * mvPosition; }');   // (a see-through deck that casts: a few units farther from the sun in its map, so it shades the ground under it but not itself: in the sun's coarser map it did, and lit up in a step as the near map took over)   // (a tree on another piece, as a traffic island's: no shadow, see shape)
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vPatD;').replace('void main() {', 'void main() {\n  float pd = floor(vPatD + 0.5); if (pd < 65535.0) discard;');
    };
    return _dns;
  }
  // vector_op_unk2: a view direction -> sector 0..31 (15 round the level, 15 round looking up, then straight down, up)
  // (the check in tools/gaps.mjs, for one face: rays from points on it out of its back; one that gets out to open air
  // (or down to the ground well away) meeting no face drawn as seen from there means a camera there sees its back.
  // They start just in front of it: a face back to back with it, drawn the other way, stops them)
  function backShows(prims, f) {
    const F = [];
    let ground = Infinity;
    for (const p of prims) {
      if (!p.poly || p.decal || !p.tri || p.tri.length < 9) continue;
      const t = p.tri;
      for (let k = 0; k + 8 < t.length; k += 9) {
        const a = [t[k], t[k + 1], -t[k + 2]], e1 = [t[k + 3] - a[0], t[k + 4] - a[1], -t[k + 5] - a[2]], e2 = [t[k + 6] - a[0], t[k + 7] - a[1], -t[k + 8] - a[2]];
        F.push({ a, e1, e2, p, one: p.one && p.f3 ? 1 : 0, fn: p.f3 && p.f3[1] });
        ground = Math.min(ground, a[1], t[k + 4], t[k + 7]);
      }
    }
    const drawn = (q, d) => !q.one || dot(q.fn, d) < 0 || (-d[1] <= 0 && ((q.p.cull2 >>> (31 - viewSector(-d[0], -d[1], d[2]))) & 1));
    const hit = (o, d, q) => {
      const pv = cross3(d, q.e2), det = dot(q.e1, pv); if (Math.abs(det) < 1e-9) return -1;
      const tv = [o[0] - q.a[0], o[1] - q.a[1], o[2] - q.a[2]], u = dot(tv, pv) / det; if (u < -1e-4 || u > 1 + 1e-4) return -1;
      const qv = cross3(tv, q.e1), v = dot(d, qv) / det; if (v < -1e-4 || u + v > 1 + 1e-4) return -1;
      const t = dot(q.e2, qv) / det; return t > 1e-3 ? t : -1;
    };
    let n = 0;
    for (const q of F) {
      if (q.p !== f) continue;
      for (const [u, v] of [[1 / 3, 1 / 3], [0.1, 0.1], [0.8, 0.1], [0.1, 0.8]]) {
        const p = [0, 1, 2].map(k => q.a[k] + q.e1[k] * u + q.e2[k] * v - q.fn[k] * 0.05);
        if (p[1] < ground + 1) continue;
        for (const d of SPHERE) {
          if (dot(d, q.fn) <= 0.05 || drawn(q, d)) continue;
          const tg = d[1] < 0 ? (p[1] - ground) / -d[1] : Infinity;
          if (tg < 40) continue;
          if (!F.some(r => r.p !== f && drawn(r, d) && (t => t > 0 && t < tg)(hit(p, d, r)))) n++;
        }
      }
    }
    return n >= 3;
  }
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const SPHERE = (() => { const n = 96, out = []; for (let i = 0; i < n; i++) { const y = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - y * y), f = i * Math.PI * (3 - Math.sqrt(5)); out.push([r * Math.cos(f), y, r * Math.sin(f)]); } return out; })();
  function viewSector(x, y, z) {
    const h = Math.hypot(x, z);
    if (h < Math.abs(y)) return y < 0 ? 30 : 31;
    let ang = -Math.round(Math.atan2(z, -x) * 512 / Math.PI);
    if (ang < 0) ang += 1024;
    return (y > 0 ? 15 : 0) + ((ang * 15) >> 10);
  }
  // the original's 4x4 stipple masks (loops, ramps, grates, glass): flat colour, as see-through as the share of
  // their dots, blended after the solid faces (and writing depth: what is behind them stays behind)
  const seeThrough = pat => pat !== 0xFFFF && pat !== 0;
  function popcount16(v) { let n = 0; for (; v; v &= v - 1) n++; return n; }
  // the ghosts: one per track (its contents), your best run there, in this browser's IndexedDB ('stunts-ghosts': room
  // for every track, apart from the tracks and replays in localStorage). Those once kept in localStorage move over.
  let ghostDb = null;
  const gdb = () => ghostDb || (ghostDb = new Promise((res, rej) => {
    const r = indexedDB.open('stunts-ghosts', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('g');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }).then(async db => {
    // (each kept one moved over and dropped from localStorage at once; one that won't read is dropped)
    let keys = []; try { for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); } catch (_) {}
    for (const k of keys) {
      const m = /^stunts-ghost:(.+:.+)$/.exec(k);
      if (m) try {
        const t = m[1], b = new Float32Array(Uint8Array.from(atob(localStorage.getItem(k)), c => c.charCodeAt(0)).buffer);
        let car = null; try { car = JSON.parse(localStorage.getItem('stunts-ghost-car:' + t)); } catch (_) {}
        const sc = +localStorage.getItem('stunts-ghost-t:' + t);
        await putBetter(db, t, { best: b, score: sc > 0 ? sc : b[0], car });
      } catch (_) {}
      try { if (/^stunts-ghost(-car|-t)?:|^stunts-ghosts$|^stunts-ghost-idx-v2$/.test(k)) localStorage.removeItem(k); } catch (_) {}
    }
    return db;
  }));
  // (a run is stored only if it beats the one stored: one transaction, so two never cross)
  const putBetter = (db, track, v) => new Promise(res => {
    const q = db.transaction('g', 'readwrite'), st = q.objectStore('g'), r = st.get(track);
    r.onsuccess = () => { if (!r.result || v.score < r.result.score) st.put(v, track); };
    q.oncomplete = q.onerror = q.onabort = res;
  });
  const ghostGet = track => gdb().then(db => new Promise(res => { const r = db.transaction('g').objectStore('g').get(track); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); })).catch(() => null);
  const ghostSet = (track, v) => gdb().then(db => putBetter(db, track, v)).catch(() => {});
  // a static shape's geometry with its own per-instance sector attribute (the shape's attributes shared)
  function withSec(g, isec) {
    const n = new T.BufferGeometry();
    for (const k in g.attributes) n.setAttribute(k, g.attributes[k]);
    n.setAttribute('isec', isec); for (const gr of g.groups) n.addGroup(gr.start, gr.count, gr.materialIndex); n.userData = g.userData; n.boundingSphere = g.boundingSphere; n.boundingBox = g.boundingBox;
    return n;
  }
  const NOCULL = /[?&]nocull/.test(root.location ? root.location.search : '');   // (debug: no back-face culling)
  const NOSEC = /[?&]nosec/.test(root.location ? root.location.search : '');   // (debug: the facing test everywhere)
  const SLOPE_K = /[?&]noslope/.test(root.location ? root.location.search : '') ? 0 : 1.3;   // (hills shaded by the sun: how much a slope's angle to it lightens or darkens it; ?noslope: none, as the original)
  const GAPVIZ = /[?&]gapviz/.test(root.location ? root.location.search : '');   // (debug, tools/gaps.py: the sky in magenta, the horizon's pictures left out: what shows through a gap)
  const ONE_FRONT = /[?&]flipcull/.test(root.location ? root.location.search : '');   // (which winding faces the camera, the game's mirrored: checked against the original, e.g. the tunnel by the DEFAULT loop; ?flipcull for the other)
  const STEER_MAX = 0.55;   // the most the front wheels are shown turned (radians, about 32 degrees)
  const STEER_SHOW = 2.2;   // how much more the front wheels are shown turned than the game turns them
  const DEPTH_AMT = /[?&]nodepth/.test(root.location ? root.location.search : '') ? 0 : 0.3;   // the depth shading's strength (the most, far off)   // how much a sun shadow darkens a colour in the original look
  const lin = c => { const m = (c[0] + c[1] + c[2]) / 3; return [c[0], c[1], c[2]].map(v => OG ? v : Math.min(1, Math.max(0, m + (v - m) * 1.1))).map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); };
  // the game's camera matrix (16384ths) as a unit quaternion: unnormalised, slerp between two nearly equal
  // ones (|q| > 1, so their dot product is >= 1) returns the first unchanged: the camera then turns in steps
  const quat = R => new T.Quaternion().setFromRotationMatrix(mirror(R)).normalize();
  // Decals of one colour that make one marking (a sign's arrow: shaft, bend, head) sometimes leave a
  // unit or two between them in the game's data, closed by its low resolution: a corner that close to
  // another such decal is moved onto it (a little past), so the marking is one piece at any resolution.
  // how far a car's window laid on a panel is grown towards the panel's edges
  const GLASS_GROW = 0.85;
  // the area of a triangle list ([v0, v1, v2, ...], each [x, y, z])
  function triArea(t) { let a = 0; for (let k = 0; k + 2 < t.length; k += 3) { const u = t[k + 1].map((x, i) => x - t[k][i]), w = t[k + 2].map((x, i) => x - t[k][i]); a += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2; } return a; }
  // a decal's corners moved out from its middle, frac of the way to where that line leaves its base face (both flat on one
  // plane: the base's triangles tested by barycentric coordinates, the crossing found by halving)
  function growInside(t, base, frac) {
    const uniq = new Map(); for (const v of t) uniq.set(v.join(','), v);
    const vs = [...uniq.values()], c = [0, 1, 2].map(i => vs.reduce((s, v) => s + v[i], 0) / vs.length);
    const inside = p => { for (let k = 0; k + 2 < base.length; k += 3) { const a = base[k], b = base[k + 1], cc = base[k + 2];
      const v0 = cc.map((x, i) => x - a[i]), v1 = b.map((x, i) => x - a[i]), v2 = p.map((x, i) => x - a[i]);
      const d00 = dot(v0, v0), d01 = dot(v0, v1), d02 = dot(v0, v2), d11 = dot(v1, v1), d12 = dot(v1, v2), den = d00 * d11 - d01 * d01;
      if (Math.abs(den) < 1e-9) continue; const u = (d11 * d02 - d01 * d12) / den, w = (d00 * d12 - d01 * d02) / den;
      if (u >= -1e-3 && w >= -1e-3 && u + w <= 1 + 1e-3) return true; } return false; };
    const moved = new Map();
    for (const [key, v] of uniq) {
      const d = v.map((x, i) => x - c[i]), L = Math.hypot(...d); if (L < 1e-6 || !inside(v)) { moved.set(key, v); continue; }
      let lo = 1, hi = 3; for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (inside(c.map((x, k) => x + d[k] * m))) lo = m; else hi = m; }
      const s = 1 + (lo - 1) * frac; moved.set(key, c.map((x, k) => x + d[k] * s));
    }
    for (let k = 0; k < t.length; k++) t[k] = moved.get(t[k].join(','));
  }
  // a window's corners onto its panel's own, where one is near (within a third of the window's size): the glass meets the
  // body's lines exactly, as the shell's points are
  function snapCorners(t, base) {
    const bk = new Map(); for (const v of base) bk.set(v.join(','), v); const bs = [...bk.values()];
    let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (const v of t) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], v[i]); hi[i] = Math.max(hi[i], v[i]); }
    const tol = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 3, moved = new Map();
    for (const v of t) { const k = v.join(','); if (moved.has(k)) continue; let best = null, bd = tol;
      for (const b of bs) { const d = Math.hypot(b[0] - v[0], b[1] - v[1], b[2] - v[2]); if (d < bd) { bd = d; best = b; } }
      moved.set(k, best ? best.slice() : v); }
    for (let k = 0; k < t.length; k++) t[k] = moved.get(t[k].join(','));
  }
  function closeDecalGaps(prims) {
    const ds = prims.filter(p => p.decal && p.tri.length >= 9);
    if (ds.length < 2) return;
    const near = (px, py, pz, ax, ay, az, bx, by, bz) => {
      const ux = bx - ax, uy = by - ay, uz = bz - az, l2 = ux * ux + uy * uy + uz * uz || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * ux + (py - ay) * uy + (pz - az) * uz) / l2));
      return [ax + ux * t, ay + uy * t, az + uz * t];
    };
    for (const A of ds) for (const B of ds) {
      if (A === B || A.c[0] !== B.c[0] || A.c[1] !== B.c[1] || A.c[2] !== B.c[2]) continue;
      const ta = A.tri, tb = B.tri;
      for (let i = 0; i < ta.length; i += 3) {
        let best = null, bd = 2.6;
        for (let j = 0; j < tb.length; j += 9) for (let e = 0; e < 3; e++) {
          const a = j + e * 3, b = j + ((e + 1) % 3) * 3;
          const q = near(ta[i], ta[i + 1], ta[i + 2], tb[a], tb[a + 1], tb[a + 2], tb[b], tb[b + 1], tb[b + 2]);
          const d = Math.hypot(q[0] - ta[i], q[1] - ta[i + 1], q[2] - ta[i + 2]);
          if (d < bd) { bd = d; best = q; }
        }
        if (best && bd > 0.05) {
          const ox = ta[i], oy = ta[i + 1], oz = ta[i + 2], k = (bd + 0.4) / bd;
          const nx = ox + (best[0] - ox) * k, ny = oy + (best[1] - oy) * k, nz = oz + (best[2] - oz) * k;
          for (let m = 0; m < ta.length; m += 3) if (ta[m] === ox && ta[m + 1] === oy && ta[m + 2] === oz) { ta[m] = nx; ta[m + 1] = ny; ta[m + 2] = nz; }
        }
      }
    }
  }

  // is the camera (in shape space) right at a primitive: within NEAR_FACE of its plane and over it?
  const NEAR_FACE = 40;
  function atCamera(p, c) {
    if (!p.nearPlane) {
      const t = p.tri, b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
      for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], t[i + k]); b[k + 3] = Math.max(b[k + 3], t[i + k]); }
      let n = [0, 0, 0];
      if (t.length >= 9) { const u = [t[3] - t[0], t[4] - t[1], t[5] - t[2]], v = [t[6] - t[0], t[7] - t[1], t[8] - t[2]]; n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; }
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      p.nearPlane = { n: n.map(x => x / l), d: (n[0] * t[0] + n[1] * t[1] + n[2] * t[2]) / l, b };
    }
    const { n, d, b } = p.nearPlane, m = NEAR_FACE;
    if (Math.abs(n[0] * c[0] + n[1] * c[1] + n[2] * c[2] - d) > m) return false;
    return c[0] > b[0] - m && c[0] < b[3] + m && c[1] > b[1] - m && c[1] < b[4] + m && c[2] > b[2] - m && c[2] < b[5] + m;
  }

  // Scale2x (EPX): a pixel picture twice the size, corners filled where two neighbours agree (smooth diagonals,
  // no new colours); values: palette indices, -1 see-through; wraps round horizontally (a panorama)
  function scale2x(src, w, h) {
    const out = new Int16Array(w * h * 4), W2 = w * 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const P = src[y * w + x], A = y > 0 ? src[(y - 1) * w + x] : P, D = y < h - 1 ? src[(y + 1) * w + x] : P;
      const C = src[y * w + ((x + w - 1) % w)], B = src[y * w + ((x + 1) % w)];
      const o = y * 2 * W2 + x * 2;
      out[o] = C === A && C !== D && A !== B ? A : P;
      out[o + 1] = A === B && A !== C && B !== D ? B : P;
      out[o + W2] = D === C && D !== B && C !== A ? C : P;
      out[o + W2 + 1] = B === D && B !== A && D !== C ? D : P;
    }
    return out;
  }
  const mirror = R => { const m = R.clone(), e = m.elements; e[2] = -e[2]; e[6] = -e[6]; e[8] = -e[8]; e[9] = -e[9]; return m; };
  // lit, fogged, shadowed; plus the original's 4x4 stipple masks and a depth bias for decals
  // grain: subtle world-space texture (asphalt, walls, ground); patch: broad colour variation (ground)
  function modernMaterial(o, grain = 0, patch = 0, car = false) {
    const m = new (car ? T.MeshPhysicalMaterial : T.MeshStandardMaterial)(Object.assign({ vertexColors: true, flatShading: true, side: T.DoubleSide, roughness: 0.92, metalness: 0 }, o));
    if (OG) { grain = 0; patch = 0; }
    m.customProgramCacheKey = () => 'm' + grain + ':' + patch + ':' + car + ':' + !!(o.alphaToCoverage || o.transparent) + ':' + OG + ':' + (o.fog === false);
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, GI_U);
      sh.uniforms.sunDirW = SUN_DIR; sh.uniforms.roofA = ROOF.a; sh.uniforms.roofLo = ROOF.lo; sh.uniforms.linePx = LINE_PX; sh.uniforms.carP = CAR_P; sh.uniforms.headP = HEAD.p; sh.uniforms.headD = HEAD.d; sh.uniforms.ripple = RIPPLE; sh.uniforms.tCarPic = CARPIC.tex; sh.uniforms.carPicOn = CARPIC.on; sh.uniforms.shRange = SH_RANGE; sh.uniforms.shFade = SH_FADE; sh.uniforms.tRefl = REFL.tex; sh.uniforms.reflOn = REFL.on; sh.uniforms.waterC = REFL.waterC; sh.uniforms.reflRes = REFL.res; sh.uniforms.waterY = REFL.level; sh.uniforms.depthC = DEPTH.c; sh.uniforms.depthNear = DEPTH.near; sh.uniforms.depthFar = DEPTH.far; sh.uniforms.depthAmt = DEPTH.amt; sh.uniforms.tCarEnv = CARENV.tex; sh.uniforms.carEnvOn = CARENV.on; sh.uniforms.carEnvSky = CARENV.sky; sh.uniforms.carEnvAmt = CARENV.amt;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform vec3 sunDirW; uniform float linePx;\nattribute float rank; attribute float pat; attribute float spin; attribute vec3 lofs; attribute float isec; attribute vec2 c2; attribute vec3 f0; attribute vec3 fn; varying float vOne; varying float vRank; varying float vPat; varying float vSpin; varying vec3 vWPos;')
        .replace('#include <logdepthbuf_vertex>', `#include <logdepthbuf_vertex>\nvRank = rank; vPat = pat; vSpin = spin; vOne = 0.0;\nif (dot(fn, fn) > 0.25) { vec4 p0 = vec4(f0, 1.0); vec3 n0 = fn;\n#ifdef USE_INSTANCING\np0 = instanceMatrix * p0; n0 = mat3(instanceMatrix) * n0;\n#endif\nvec4 e0 = modelViewMatrix * p0; vOne = (dot(mat3(modelViewMatrix) * n0, -e0.xyz) > 0.0) == ${ONE_FRONT ? 'false' : 'true'} && ${NOCULL ? 'false' : 'true'} ? 1.0 : 0.0; }\n#ifdef USE_INSTANCING\nif (isec > 0.5) { float b = 32.0 - isec; float w = b < 16.0 ? c2.x : c2.y; if (mod(floor(w / exp2(mod(b, 16.0))), 2.0) > 0.5) vOne = 0.0; }\n#endif\n`)
        // lines (cables, letters on signs, a car's strokes): their built width, shrinking with distance, but
        // never under 0.3 of the original's pixels on screen (its pixel: 1/230 of a radian, its race projection),
        // nearby
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  float lw = length(lofs) * 0.7071;
  if (lw > 0.0) {
    vec4 c4 = vec4(position - lofs, 1.0);
    #ifdef USE_INSTANCING
    c4 = instanceMatrix * c4;
    #endif
    // (the floor itself thins out far away, to a fifth by 8 tiles: rows of distant fence posts drew as a solid
    // white band; under a pixel wide, the antialiasing draws them faint)
    float dz = -(modelViewMatrix * c4).z, want = dz * linePx / 460.0 * mix(1.0, 0.22, smoothstep(1200.0, 8000.0, dz));
    transformed = position - lofs + lofs * max(1.0, want / lw);
  }`)
        // the shapes' windings are not consistent (many faces' normals point inwards): the shadow lookup's normal
        // offset uses the normal turned towards the sun, never into the surface (else lit faces shadow themselves)
        .replace('#include <shadowmap_vertex>', () => T.ShaderChunk.shadowmap_vertex.replace('vec3 shadowWorldNormal = inverseTransformDirection( transformedNormal, viewMatrix );',
          s => s + '\n\t\tif ( dot( shadowWorldNormal, sunDirW ) < 0.0 ) shadowWorldNormal = -shadowWorldNormal;'))
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vec4 wp4 = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  wp4 = instanceMatrix * wp4;
  #endif
  vWPos = (modelMatrix * wp4).xyz;`);
      // shadows fade out towards the edge of the shadow map instead of stopping at a hard line
      sh.fragmentShader = sh.fragmentShader.replace('#include <shadowmap_pars_fragment>', () => T.ShaderChunk.shadowmap_pars_fragment.replace(
        'float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {',
        s => s.replace('getShadow', 'getShadowRaw').replace(' {', ';') + `
// Each map's shadow kept apart (told by their radius, which the soft filter doesn't use: 1 the sun's, 2 the near one, 3 and 4
// the two cars'): the sun's, reaching far; the near one round the camera, finer (NEAR_SH: the scenery's shadows close by
// crisp, handing over to the sun's at its edge); each car's own (CAR_SH).
float ogSunV = 1.0, ogNearV = 1.0, ogNearE = 2.0, ogCarV0 = 1.0, ogCarD0 = 0.0, ogCarV1 = 1.0, ogCarD1 = 0.0;
uniform float shRange; uniform vec2 shFade; uniform float giSoft; uniform float giTexW;
float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
  vec2 e = abs( shadowCoord.xy / shadowCoord.w - 0.5 ) * 2.0;
  if ( max( e.x, e.y ) >= 1.0 ) return 1.0;   // (outside this map: no shadow from it, and nothing to look up)
  bool sun = shadowRadius < 1.5, near = !sun && shadowRadius < 2.5;
  // (the baked light's mode: no near map, and the sun's shadow soft, as sunlight is: its edge the softer the further the
  // shadow falls from what casts it; the blockers' average depth first, then that much blur, 16 taps turned per pixel)
  if ( giSoft > 0.5 && near ) return 1.0;
  float v;
  if ( giSoft > 0.5 && sun ) {
    vec3 sc = shadowCoord.xyz / shadowCoord.w; float zr = sc.z + shadowBias, rot = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * 6.2831853;
    vec2 tx = 1.0 / shadowMapSize; float bs = 0.0, bn = 0.0;
    for ( int i = 0; i < 12; i ++ ) { float a = float( i ) * 2.39996 + rot, r = sqrt( ( float( i ) + 0.5 ) / 12.0 ) * 60.0;
      float d = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + vec2( cos( a ), sin( a ) ) * r * tx ) ); if ( d < zr ) { bs += d; bn += 1.0; } }
    if ( bn < 0.5 ) v = 1.0;
    else {
      float dz = max( 0.0, zr - bs / bn ) * shRange, rad = clamp( dz * 0.022 / giTexW, 1.2, 28.0 ), lit = 0.0;
      for ( int i = 0; i < 16; i ++ ) { float a = float( i ) * 2.39996 + rot, r = sqrt( ( float( i ) + 0.5 ) / 16.0 ) * rad;
        lit += unpackRGBAToDepth( texture2D( shadowMap, sc.xy + vec2( cos( a ), sin( a ) ) * r * tx ) ) < zr ? 0.0 : 1.0; }
      v = lit / 16.0;
    }
  } else v = smoothstep( 0.42, 0.58, getShadowRaw( shadowMap, shadowMapSize, shadowBias, shadowRadius, shadowCoord ) );   // (the filtered edge's middle, made hard again: it runs straight between the map's texels)
  if ( !near ) v = mix( v, 1.0, smoothstep( 0.8, 0.98, max( e.x, e.y ) ) );   // (fading out at the map's edge; the near map hands over to the sun's instead)
  v = mix( v, 1.0, smoothstep( shFade.x, shFade.y, distance( vWPos, cameraPosition ) ) );   // (far off, a long fade by distance: the map's edge, sweeping ahead with the car, made shadows pop in)
  if ( sun ) ogSunV = v;
  else if ( near ) { ogNearV = v; ogNearE = max( e.x, e.y ); }
  else {
    // (a car's shadow: how far along the sun's ray the car is, for its shadow a little lighter the higher it flies; only
    // the taps that see the car count, so the edge doesn't come out darker than the middle)
    vec3 sc = shadowCoord.xyz / shadowCoord.w; vec2 tx = 1.5 / shadowMapSize;
    float d0 = unpackRGBAToDepth( texture2D( shadowMap, sc.xy ) ), d1 = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + vec2( tx.x, 0.0 ) ) ), d2 = unpackRGBAToDepth( texture2D( shadowMap, sc.xy - vec2( tx.x, 0.0 ) ) );
    float d3 = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + vec2( 0.0, tx.y ) ) ), d4 = unpackRGBAToDepth( texture2D( shadowMap, sc.xy - vec2( 0.0, tx.y ) ) );
    float lim = sc.z - 0.0004, s = 0.0, n = 0.0;
    if ( d0 < lim ) { s += d0; n += 1.0; } if ( d1 < lim ) { s += d1; n += 1.0; } if ( d2 < lim ) { s += d2; n += 1.0; } if ( d3 < lim ) { s += d3; n += 1.0; } if ( d4 < lim ) { s += d4; n += 1.0; }
    float d = max( 0.0, sc.z - ( n > 0.0 ? s / n : d0 ) ) * shRange;
    if ( shadowRadius < 3.5 ) { ogCarV0 = v; ogCarD0 = d; } else { ogCarV1 = v; ogCarD1 = d; }
  }
  return v;
}
` + s.replace('getShadow', 'getShadowRaw')));
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform sampler2D tRefl; uniform float reflOn; uniform vec3 waterC; uniform vec2 reflRes; uniform float waterY;
uniform vec3 depthC; uniform float depthNear; uniform float depthFar; uniform float depthAmt;
uniform vec4 roofA[${NROOF}]; uniform float roofLo[${NROOF}];
uniform samplerCube tCarEnv; uniform float carEnvOn; uniform vec3 carEnvSky; uniform float carEnvAmt; uniform vec4 carP[2]; uniform vec4 headP; uniform vec3 headD; uniform vec4 ripple[2]; uniform vec3 sunDirW; uniform sampler2D tCarPic; uniform float carPicOn;
varying float vRank; varying float vPat; varying float vSpin; varying vec3 vWPos; varying float vOne;
bool underRoof() { for ( int i = 0; i < ${NROOF}; i ++ ) { vec4 a = roofA[ i ]; if ( vWPos.x > a.x && vWPos.x < a.z && vWPos.z > a.y && vWPos.z < a.w && vWPos.y < roofLo[ i ] ) return true; } return false; }
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
.replace('vec3 outgoingLight = reflectedLight.directDiffuse', OG ? `// the original look: the palette colour as it is, darker only in a sun shadow (on faces towards the sun)
  float ogNdl = 1.0;
  #if NUM_DIR_LIGHTS > 0
  ogNdl = dot( geometry.normal, directionalLights[ 0 ].direction );
  #endif
  // (every shadow the same shade, a car's as the scenery's, and darker again where they overlap (a car's in a bridge's, the two
  // cars'); the scenery's from the near map close by, the sun's further off, mixed across the near map's edge; a car's a
  // little lighter the higher it flies)
  float scnV = mix( ogNearV, ogSunV, smoothstep( 0.7, 0.92, ogNearE ) ), ogShadow = min( scnV, min( ogCarV0, ogCarV1 ) );
  float shadeL = 1.0;
  if ( ogNdl > 0.02 ) {
    float K = giSoft > 0.5 ? 0.5 : ${OG_SHADOW.toFixed(3)};   // (darker in the baked light's mode: its shadows soft, they'd read faint)
    shadeL = 1.0 - K * ( 1.0 - scnV );
    shadeL *= 1.0 - K * ( 1.0 - 0.6 * smoothstep( 150.0, 1200.0, ogCarD0 ) ) * ( 1.0 - ogCarV0 );
    shadeL *= 1.0 - K * ( 1.0 - 0.6 * smoothstep( 150.0, 1200.0, ogCarD1 ) ) * ( 1.0 - ogCarV1 );
  }
  vec3 outgoingLight = diffuseColor.rgb * shadeL;
  if ( vSpin < -0.5 ) {   // (a hill's slopes (spin -1): lighter turned towards the sun, darker turned away; level ground as it is)
    vec3 sW = normalize( sunDirW ), wN = normalize( inverseTransformDirection( geometry.normal, viewMatrix ) );
    if ( wN.y < 0.0 ) wN = -wN;
    outgoingLight *= clamp( 1.0 + ${SLOPE_K.toFixed(2)} * ( dot( wN, sW ) - sW.y ), 0.5, 1.35 );
  }
  #if ${car ? 1 : 0}
  // cars: lit by the sun, the sky and a cool rim light, but only ever by scaling the palette colour as a whole (its hue
  // stays the original's), then a neutral lacquer: two broad studio light strips and the rim of the body at glancing
  // angles, kept within what the colour can take without washing out
  {
    vec3 cN = normalize( geometry.normal ), cV = normalize( geometry.viewDir ), wN = normalize( inverseTransformDirection( cN, viewMatrix ) );
    vec3 sunW = normalize( sunDirW ), wV = normalize( cameraPosition - vWPos );
    float lit = ogNdl > 0.02 ? ogShadow : 1.0;
    float hemi = 0.5 + 0.5 * wN.y, key = max( dot( wN, sunW ), 0.0 ) * lit, rim = max( dot( wN, normalize( vec3( -0.6, 0.45, -0.6 ) ) ), 0.0 );
    float spec = vSpin < 0.5 || vSpin > 2.5 ? min( pow( max( dot( reflect( -wV, wN ), sunW ), 0.0 ), 80.0 ) * 0.5 * lit, 0.5 ) : 0.0;
    float li = 0.35 * hemi + 0.55 * key + 0.1 * rim;   // (a face square to the sun: 1, its palette colour as it is)
    vec3 col = diffuseColor.rgb * ( mix( 0.5, 1.0, clamp( li, 0.0, 1.0 ) ) + spec );
    if ( vSpin < 0.5 ) {
      vec3 R = reflect( -cV, cN );
      float s1 = pow( max( dot( R, normalize( vec3( -0.35, 0.75, 0.55 ) ) ), 0.0 ), 70.0 ), s2 = pow( max( dot( R, normalize( vec3( 0.55, 0.45, 0.7 ) ) ), 0.0 ), 110.0 );
      float fr = pow( 1.0 - clamp( dot( cN, cV ), 0.0, 1.0 ), 5.0 );
      col += vec3( 1.0, 0.98, 0.95 ) * ( s1 * 0.55 + s2 * 0.45 + fr * 0.06 );   // (highlights only: the paint itself stays its colour)
    }
    // glass: a car's dark neutral faces up on the car (spin 0.25: its windows, black or the original's grey), darker, with the sky in them
    // (gradient: the sky above, the ground below), a strong sheen at grazing angles and the sun's glint
    { vec3 dc = diffuseColor.rgb; float sat = max( max( dc.r, dc.g ), dc.b ) - min( min( dc.r, dc.g ), dc.b ), lumG = dot( dc, vec3( 0.3, 0.59, 0.11 ) );
      if ( vSpin > 0.1 && vSpin < 0.5 && sat < 0.02 && lumG < 0.12 ) {
        vec3 R = reflect( -cV, cN ), Rw = normalize( inverseTransformDirection( R, viewMatrix ) );
        vec3 env = Rw.y > 0.0 ? mix( vec3( 0.62, 0.74, 0.86 ), vec3( 0.2, 0.42, 0.78 ), clamp( Rw.y * 1.6, 0.0, 1.0 ) ) : vec3( 0.07, 0.08, 0.06 );
        float fr = 0.12 + 0.88 * pow( 1.0 - clamp( dot( cN, cV ), 0.0, 1.0 ), 4.0 );
        float glint = pow( max( dot( Rw, sunW ), 0.0 ), 400.0 ) * 3.0 * lit;
        col = dc * 0.55 * mix( 0.5, 1.0, clamp( li, 0.0, 1.0 ) ) + env * fr * 0.55 + vec3( 1.0, 0.97, 0.9 ) * glint;
      } }
    outgoingLight = col;
  }
  #endif
  if ( headP.w > 0.5 ) {   // (night: two beams ahead of the car, flat-lit)
    vec3 L = vWPos - headP.xyz; float dist = length( L ); vec3 Ln = L / max( dist, 1.0 );
    float beam = smoothstep( 0.86, 0.95, dot( Ln, headD ) ) * ( 1.0 - smoothstep( 500.0, 4200.0, dist ) ) * step( 60.0, dist );
    outgoingLight += diffuseColor.rgb * vec3( 1.0, 0.95, 0.8 ) * beam * 2.6;
  }
  outgoingLight = mix( outgoingLight, depthC, ${o.fog === false ? '0.0' : 'depthAmt'} * smoothstep( depthNear, depthFar, length( vWPos - cameraPosition ) ) );   // (none on the sky's things: clouds)
  vec3 _unusedLight = reflectedLight.directDiffuse` : 'vec3 outgoingLight = reflectedLight.directDiffuse')
.replace('#include <color_fragment>', `#include <color_fragment>
  #if ${car ? 0 : 1}
  if (reflOn > 0.5 && abs(vWPos.y - waterY) < 6.0 && (distance(diffuseColor.rgb, waterC) < 0.02 || (diffuseColor.b > diffuseColor.r + 0.25 && diffuseColor.b > diffuseColor.g + 0.05))) {   // (the water colour, or another clear blue lying flat at its level)
    vec3 fn = normalize(cross(dFdx(vWPos), dFdy(vWPos)));
    if (abs(fn.y) > 0.97) {
      vec3 V = normalize(cameraPosition - vWPos);
      float fres = reflOn > 1.5 ? 1.0 : 0.05 + 0.13 * pow(1.0 - clamp(V.y, 0.0, 1.0), 3.0);
      vec2 ruv = gl_FragCoord.xy / reflRes;
      // (ripples: rings running out from where a car went in, a few waves behind the front, bending the reflection)
      float rip = 0.0;
      for (int ri = 0; ri < 2; ri++) if (ripple[ri].w > 0.5) {
        float d = distance(vWPos.xz, ripple[ri].xy), age = ripple[ri].z, front = 60.0 + age * 300.0;
        float u = (d - front) / 260.0, env = exp(-u * u) * exp(-age * 0.7) * step(d, front + 120.0);
        rip += sin(d * 0.06 - age * 14.0) * env;
      }
      ruv.y += rip * 0.02;
      diffuseColor.rgb *= 1.0 + rip * 0.06;
      diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(tRefl, ruv).rgb * 0.82, fres);   // (the water's own colour stays first)
    }
  }
  #endif
  if (${OG ? 'false' : 'true'} && vSpin > 2.5) { float sp = fract((vSpin - 3.0) * 5.0); diffuseColor.rgb = vec3(0.78, 0.79, 0.82) * (0.5 + 0.5 * smoothstep(0.25, 0.35, sp) * (1.0 - smoothstep(0.65, 0.75, sp))); }   // rim with five spokes
  else if (${OG ? 'false' : 'true'} && vSpin > 0.5) diffuseColor.rgb = vec3(0.035, 0.035, 0.04) * (0.85 + 0.3 * step(0.5, fract(vSpin * 9.0)));   // rubber, the tread turns
  #if ${grain > 0 ? 1 : 0}
  { vec3 c0 = diffuseColor.rgb;
    float mx = max(c0.r, max(c0.g, c0.b)), mn = min(c0.r, min(c0.g, c0.b)), lum = dot(c0, vec3(0.3, 0.59, 0.11));
    float green = clamp((c0.g - max(c0.r, c0.b)) * 6.0, 0.0, 1.0);
    float grey = (1.0 - clamp((mx - mn) * 14.0, 0.0, 1.0)) * (1.0 - smoothstep(0.25, 0.5, lum)) * (1.0 - green);   // asphalt, concrete
    // detail fades out where a pixel covers more than its wavelength (no shimmer in the distance)
    float px = length(fwidth(vWPos));
    float w1 = clamp(1.0 - px * 0.7 * 1.2, 0.0, 1.0), w2 = clamp(1.0 - px * 0.16 * 1.2, 0.0, 1.0), w3 = clamp(1.0 - px * 0.035 * 1.2, 0.0, 1.0);
    float f1 = vnoise(vWPos * 0.7) - 0.5, f2 = vnoise(vWPos * 0.16) - 0.5, f3 = vnoise(vWPos * 0.035) - 0.5, f4 = vnoise(vWPos * 0.008) - 0.5;
    float asph = f1 * 0.12 * w1 + f2 * 0.07 * w2 + f3 * 0.07 * w3 + f4 * 0.06;                       // aggregate, patches, wear
    float stripe = (step(0.5, fract(vWPos.x / 340.0)) - 0.5) * 0.045;                               // mowing stripes along the grid
    float grass = f1 * 0.06 * w1 + f2 * 0.08 * w2 + f3 * 0.09 * w3 + f4 * 0.1 + stripe * w3;
    float other = (f1 * 0.25 * w1 + f2 * 0.25 * w2) * ${grain.toFixed(3)};
    diffuseColor.rgb *= 1.0 + grey * asph + green * grass + (1.0 - grey - green) * other;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.03, 1.0, 0.92), green * smoothstep(0.12, 0.3, f4 + f3 * 0.4));   // drier patches
  }
  #endif
  #if ${patch > 0 ? 1 : 0}
  { float q = vnoise(vWPos * 0.0025) * 0.6 + vnoise(vWPos * 0.011) * 0.4; diffuseColor.rgb *= 1.0 + ${patch.toFixed(3)} * (q - 0.5); }
  #endif`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  #if ${car ? 1 : 0}
  { float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
    if (vSpin > 2.5) roughnessFactor = 0.3; else if (vSpin > 0.5) roughnessFactor = 0.88; else if (lum < 0.02) roughnessFactor = 0.08; }   // rims, rubber, glass and black trim
  #endif`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  #if ${car ? 1 : 0}
  if (vSpin > 2.5) metalnessFactor = 0.6; else if (vSpin > 0.5) metalnessFactor = 0.0;
  #endif`)
        .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
  #if ${car ? 1 : 0} && defined( CLEARCOAT )
  if (vSpin > 0.5) material.clearcoat = 0.0;   // no lacquer on tyres and rims
  #endif`)
        .replace('void main() {', GI_GLSL + `void main() {
  // the original's 4x4 stipple masks: as see-through as the share of their dots, through the multisampled
  // coverage (alpha to coverage: no sorting); without it, the dots themselves
  if (vOne > 0.5) discard;   // (the original's back-face test: one-sided polygons seen from behind)
  float pm = floor(vPat + 0.5), cov = 1.0;
  if (pm < 65535.0) {
    #if ${o.alphaToCoverage || o.transparent ? 1 : 0}
    cov = 0.0; for (int i = 0; i < 16; i++) cov += mod(floor(pm / exp2(float(i))), 2.0); cov /= 16.0;
    if (cov <= 0.0) discard;
    #else
    if (pm < 0.5) discard;   // (no dot pattern: the far-off and sky shapes drawn solid)
    #endif
  }`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  if ( giOn > 0.5 ) {
    // (the face's own normal, turned to the camera: flat shading's, from the screen; the volume read a little out from
    // the face, a texel's size, so not from inside what it is on)
    vec3 nW = normalize( inverseTransformDirection( normal, viewMatrix ) );
    vec4 g = giTap( vWPos + nW * giSize / giRes * 1.1 );
    // (the sky a face could see, alone in the open: all of it facing up, half facing sideways; what it sees here, against that)
    float ao = clamp( g.a / max( 0.5 + 0.5 * nW.y, 0.25 ), 0.0, 1.0 );
    reflectedLight.indirectDiffuse *= mix( 1.0, ao * ao * ( 3.0 - 2.0 * ao ), giAmt );
    reflectedLight.directDiffuse *= mix( 1.0, 0.75 + 0.25 * ao, giAmt );   // (a little in the sun too: a corner's contact)
    reflectedLight.indirectDiffuse += g.rgb * diffuseColor.rgb * giBounce * clamp( 0.65 - 0.65 * nW.y, 0.0, 1.0 );
  }`)
        .replace('#include <tonemapping_fragment>', `  #if ${OG ? 1 : 0}
  if ( giOn > 0.5 ) {
    // (the original look: its colour kept, only darker where less of the sky reaches, and tinted by the ground's
    // colour close under a face turned away from the sky)
    vec3 nW = normalize( inverseTransformDirection( normal, viewMatrix ) );
    vec4 g = giTap( vWPos + nW * giSize / giRes * 1.1 );
    float ao = clamp( g.a / max( 0.5 + 0.5 * nW.y, 0.25 ), 0.0, 1.0 );
    // (stronger than the sky alone would make it, as a painter would: open ground as it was, a corner or a wall's
    // foot clearly darker, under a bridge or a roof darkest)
    float k = clamp( ( ao - 0.35 ) / 0.6, 0.0, 1.0 );
    gl_FragColor.rgb *= mix( 1.0, mix( 0.55, 1.0, k * k ), giAmt );
    gl_FragColor.rgb += g.rgb * diffuseColor.rgb * giBounce * 0.5 * clamp( 0.65 - 0.65 * nW.y, 0.0, 1.0 );
    if ( giDbg > 0.5 ) gl_FragColor.rgb = giDbg > 2.5 ? vec3( g.a ) : giDbg > 1.5 ? g.rgb : vec3( ao );
    if ( giDbg > 6.5 ) gl_FragColor.rgb = vec3( giTiles.x / 8.0, giRes.x / 384.0, giRes.y / 32.0 ); else
    if ( giDbg > 5.5 ) { gl_FragColor.rgb = clamp( ( vWPos + nW * giSize / giRes * 1.1 - giMin ) / giSize, 0.0, 1.0 ); gl_FragColor.g *= 10.0; } else
    if ( giDbg > 3.5 ) gl_FragColor.rgb = giDbg > 4.5 ? vec3( texture2D( tGI, gl_FragCoord.xy / vec2( 1280.0, 720.0 ) ).a ) : fract( ( vWPos - giMin ) / giSize * 4.0 );   // (?gidebug: 1 the share of sky against the open, 2 the ground's colour, 3 the raw share)
  }
  #endif
  if (underRoof()) gl_FragColor.rgb = diffuseColor.rgb * 0.55;
#include <tonemapping_fragment>`)
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= cov < 1.0 ? min(1.0, cov * 1.1) : 1.0;')   // (as see-through as the share of dots, a little more, at every distance: it was solid up close); solid close by: the deck you drive on is not a window)
        .replace('#include <logdepthbuf_fragment>', `#include <logdepthbuf_fragment>\n#if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )\n{ float d0 = gl_FragDepthEXT, rk = floor((vRank + 0.5) / ${RANKS}.0), ti = vRank - rk * ${RANKS}.0; gl_FragDepthEXT = vSpin > 0.5 ? d0 : d0 - rk * (0.6 * fwidth(d0) + 1e-5) - ti * ${TIE_D}; }\n#endif`);   // (decals over their base by the surface's own depth slope: nothing farther off shows through what is in front)
    };
    return m;
  }
  // one frame's captured shapes, transformed on the CPU into a single buffer
  // the tunnel roofs' extents in the world (x0, z0, x1, z1, the roof's underside), pieces that meet edge to edge at
  // the same height joined into one strip
  function roofStrips(roofs) {
    const v = new T.Vector3(), q = roofs.map(r => {
      const b = r.b; let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
      for (const [x, z] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) { v.set(x, 0, z).applyMatrix4(r.m); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z); }
      return [x0, z0, x1, z1, v.set(0, b[4], 0).applyMatrix4(r.m).y];
    });
    const near = (a, b) => Math.abs(a - b) < 2;
    for (let joined = true; joined;) {
      joined = false;
      for (let i = 0; i < q.length && !joined; i++) for (let j = i + 1; j < q.length && !joined; j++) {
        const a = q[i], b = q[j]; if (!near(a[4], b[4])) continue;
        const alongZ = near(a[0], b[0]) && near(a[2], b[2]) && (near(a[3], b[1]) || near(b[3], a[1]));
        const alongX = near(a[1], b[1]) && near(a[3], b[3]) && (near(a[2], b[0]) || near(b[2], a[0]));
        if (alongZ || alongX) { q[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3]), a[4]]; q.splice(j, 1); joined = true; }
      }
    }
    q.n = roofs.length; return q;
  }

  class DynBuf {
    constructor(mat, N = 200000) {
      this.pos = new Float32Array(N * 3); this.col = new Float32Array(N * 3); this.nrm = new Float32Array(N * 3); this.spin = new Float32Array(N); this.rank = new Float32Array(N); this.pat = new Float32Array(N); this.lofs = new Float32Array(N * 3); this.one = new Float32Array(N); this.f0 = new Float32Array(N * 3); this.fn = new Float32Array(N * 3); this.N = N;
      const g = this.geo = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(this.pos, 3).setUsage(T.DynamicDrawUsage));
      g.setAttribute('color', new T.BufferAttribute(this.col, 3).setUsage(T.DynamicDrawUsage));
      g.setAttribute('normal', new T.BufferAttribute(this.nrm, 3).setUsage(T.DynamicDrawUsage));
      g.setAttribute('rank', new T.BufferAttribute(this.rank, 1).setUsage(T.DynamicDrawUsage));
      g.setAttribute('pat', new T.BufferAttribute(this.pat, 1).setUsage(T.DynamicDrawUsage));
      g.setAttribute('spin', new T.BufferAttribute(this.spin, 1).setUsage(T.DynamicDrawUsage));
      g.setAttribute('lofs', new T.BufferAttribute(this.lofs, 3).setUsage(T.DynamicDrawUsage));
      g.setAttribute('f0', new T.BufferAttribute(this.f0, 3).setUsage(T.DynamicDrawUsage)); g.setAttribute('fn', new T.BufferAttribute(this.fn, 3).setUsage(T.DynamicDrawUsage));
      this.mesh = new T.Mesh(g, mat); this.mesh.frustumCulled = false;
    }
    fill(view, objs, ease, onlyDrawn) {
      let v = 0, nSolid = 0;
      const P = this.pos, Cc = this.col, split = Array.isArray(this.mesh.material) && !this.solid;
      // (split: solid faces first, then the stippled ones, drawn see-through by the second material)
      for (const pass of split ? [0, 1] : [-1]) {
      if (pass === 1) nSolid = v;
      // (the see-through faces farthest first, as they blend: one seen through another, both show)
      let order = null;
      if (pass === 1 && view.camPos) {
        const cp = view.camPos; order = [];
        for (const o of objs) {
          const sh = o.sh || view.shape(o.ptr, o.paint), M = ease(o);
          sh.prims.forEach((p, i) => {
            if (!seeThrough(p.pat) || !p.tri.length) return;
            if (!p.cen) { const t = p.tri, c = [0, 0, 0]; for (let k = 0; k < t.length; k += 3) { c[0] += t[k]; c[1] += t[k + 1]; c[2] -= t[k + 2]; } p.cen = c.map(x => x / (t.length / 3)); }
            const [x, y, z] = p.cen, dx = M[0] * x + M[1] * y + M[2] * z + M[3] - cp.x, dy = M[4] * x + M[5] * y + M[6] * z + M[7] - cp.y, dz = M[8] * x + M[9] * y + M[10] * z + M[11] - cp.z;
            order.push({ o, sh, M, p, i, d: dx * dx + dy * dy + dz * dz });
          });
        }
        order.sort((a, b) => b.d - a.d);
      }
      const runs = order ? order.map(e => [e.o, e.M, [[e.p, e.i]]]) : objs.map(o => { const sh = o.sh || view.shape(o.ptr, o.paint); return [o, ease(o), sh.prims.map((p, i) => [p, i])]; });
      for (const [o, M, list] of runs) {
        list.forEach(([p, i]) => {
          if (p.pat === 0 || !p.tri.length) return;
          if (pass >= 0 && seeThrough(p.pat) !== (pass === 1)) return;
          if (this.noSee && (p.canopy || seeThrough(p.pat) && !(this.noSee === 'upright' && (p.ribbon || p.plane && p.plane.n[1] > 0.85)))) return;   // (as the static pieces' shadows: nocast in shapeGeo)
          // (a face the original left out because it was at its camera: left out too, if it is really there,
          // within a few units of ours, as when the camera dips into a slope; the rest, e.g. the posts and
          // walls beside the camera the original dropped at its near plane or outside its 4:3 view, are drawn)
          if (onlyDrawn && o.inside && !p.level && !(o.mask[i >> 5] & (1 << (i & 31))) && (!o.camL || atCamera(p, o.camL))) return;
          const t = p.tri, c = p.lc || (p.lc = lin(p.c)), wc = p.wheelC && (p.wlc || (p.wlc = p.wheelC.map(lin)));
          if (v + t.length / 3 > this.N) return;
          const turn = p.wheel ? (o.roll || 0) / (2 * Math.PI * p.wheelR) : 0;
          // a front wheel turned about its centre by the car's steering (shape space)
          const st = p.front ? view.steerOf(o, p) : 0, sc = Math.cos(st), ss = Math.sin(st), wc0 = p.wheelCtr;
          // (a crashed car's wheel moves whole, as the body does at its centre: still round, still on the car)
          let wsh = null;
          if (o.crumple && p.wheel && wc0) { const q = crumple(wc0[0], wc0[1], -wc0[2], o.crumple); wsh = [q[0] - wc0[0], q[1] - wc0[1], q[2] + wc0[2]]; }
          for (let k = 0; k < t.length; k += 3, v++) {
            if (p.wheel) { const w = p.wheel[k / 3], rim = w >= 2 ? 2 : 0; this.spin[v] = 1 + rim + ((w - rim + turn) % 1 + 1) % 1; } else this.spin[v] = p.slope ? -1 : p.glass ? 0.25 : 0;   // 0: not a wheel; 1..2 tyre, 3..4 rim; -1 a hill's face (shaded by the sun)
            let x = t[k], y = t[k + 1], z = -t[k + 2];
            if (o.crumple && !p.wheel) [x, y, z] = crumple(x, y, z, o.crumple);
            if (st) { const dx = t[k] - wc0[0], dz = t[k + 2] - wc0[2]; x = wc0[0] + dx * sc - dz * ss; z = -(wc0[2] + dx * ss + dz * sc); }
            if (wsh) { x += wsh[0]; y += wsh[1]; z += wsh[2]; }
            const j = v * 3;
            P[j] = M[0] * x + M[1] * y + M[2] * z + M[3];
            P[j + 1] = M[4] * x + M[5] * y + M[6] * z + M[7];
            P[j + 2] = M[8] * x + M[9] * y + M[10] * z + M[11];
            const cc = wc ? wc[p.wheelPart[k / 3]] : c;
            this.one[v] = this.solid || (!NOSEC && (o.varA & p.cull2)) ? 0 : p.one;
            if (!(p.f3 && this.one[v])) this.fn[j] = this.fn[j + 1] = this.fn[j + 2] = 0; else { const [a, n] = p.f3; this.f0[j] = M[0] * a[0] + M[1] * a[1] + M[2] * a[2] + M[3]; this.f0[j + 1] = M[4] * a[0] + M[5] * a[1] + M[6] * a[2] + M[7]; this.f0[j + 2] = M[8] * a[0] + M[9] * a[1] + M[10] * a[2] + M[11]; this.fn[j] = M[0] * n[0] + M[1] * n[1] + M[2] * n[2]; this.fn[j + 1] = M[4] * n[0] + M[5] * n[1] + M[6] * n[2]; this.fn[j + 2] = M[8] * n[0] + M[9] * n[1] + M[10] * n[2]; }
            if (p.lofs) { const ox = p.lofs[k], oy = p.lofs[k + 1], oz = -p.lofs[k + 2]; this.lofs[j] = M[0] * ox + M[1] * oy + M[2] * oz; this.lofs[j + 1] = M[4] * ox + M[5] * oy + M[6] * oz; this.lofs[j + 2] = M[8] * ox + M[9] * oy + M[10] * oz; } else { this.lofs[j] = this.lofs[j + 1] = this.lofs[j + 2] = 0; }
            Cc[j] = cc[0]; Cc[j + 1] = cc[1]; Cc[j + 2] = cc[2]; this.rank[v] = (p.rank + (o.layer || 0)) * RANKS + i; this.pat[v] = this.solid ? 65535 : p.pat;
          }
        });
      }
      }
      if (split) { this.geo.clearGroups(); this.geo.addGroup(0, nSolid, 0); this.geo.addGroup(nSolid, v - nSolid, 2); this.geo.addGroup(nSolid, v - nSolid, 1); }
      // face normals (three.js's shadow lookup offsets along them; shading itself uses flat derivatives),
      // or, for cars, normals smoothed across gentle bends (see smoothNormals)
      const Nn = this.nrm;
      if (this.smooth) {
        let w = 0;
        for (const o of objs) {
          const sh = view.shape(o.ptr, o.paint), M = ease(o);
          if (!sh.smoothed) { smoothNormals(sh.prims, Math.cos(SMOOTH_ANGLE * Math.PI / 180)); flatPanels(sh.prims); sh.smoothed = true; }
          sh.prims.forEach((p, i) => {
            if (p.pat === 0 || !p.tri.length) return;
            if (o.inside && !p.level && !(o.mask[i >> 5] & (1 << (i & 31)))) return;
            if (w + p.tri.length / 3 > this.N) return;
            const n = p.snrm;
            if (o.crumple && !p.wheel) {   // (crumpled: each face lit by its new shape)
              for (let k = 0; k < n.length; k += 9, w += 3) {
                const j = w * 3, ax = P[j + 3] - P[j], ay = P[j + 4] - P[j + 1], az = P[j + 5] - P[j + 2], bx = P[j + 6] - P[j], by = P[j + 7] - P[j + 1], bz = P[j + 8] - P[j + 2];
                let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
                for (let q = 0; q < 9; q += 3) { Nn[j + q] = nx; Nn[j + q + 1] = ny; Nn[j + q + 2] = nz; }
              }
              return;
            }
            for (let k = 0; k < n.length; k += 3, w++) {
              const x = -n[k], y = -n[k + 1], z = n[k + 2], j = w * 3;   // mirrored space: -S n (the winding flips)
              Nn[j] = M[0] * x + M[1] * y + M[2] * z; Nn[j + 1] = M[4] * x + M[5] * y + M[6] * z; Nn[j + 2] = M[8] * x + M[9] * y + M[10] * z;
            }
          });
        }
        this.upload(v);
        return;
      }
      for (let i = 0; i + 2 < v; i += 3) {
        const a = i * 3, b = a + 3, c = a + 6;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        for (let k = 0; k < 9; k += 3) { Nn[a + k] = nx; Nn[a + k + 1] = ny; Nn[a + k + 2] = nz; }
      }
      this.upload(v);
    }
    // only the v vertices in use go to the GPU (the buffers hold 200,000: sent whole, some 17 MB a buffer, every frame)
    upload(v) {
      const g = this.geo; g.setDrawRange(0, v);
      for (const k of ['position', 'color', 'normal', 'rank', 'pat', 'spin', 'lofs', 'f0', 'fn']) {
        const a = g.attributes[k]; a.updateRange.offset = 0; a.updateRange.count = Math.max(1, v) * a.itemSize; a.needsUpdate = true;
      }
    }
  }
  // per-vertex normals of a shape's triangles, averaged over the faces at the same point that bend by less
  // than the crease angle (cosA): rounded bodies, sharp edges where the model has them
  // a car's polygons shaded flat, each with one normal (its triangles' area-weighted sum): no crease across a slightly
  // warped four-sided face; wheels and spheres keep their rounded normals
  // a crashed car's body bent out of shape (shape space, k: 0..1 as it happens): every point moved by an amount
  // fixed by where it is (shared corners move together: no cracks), the side towards the impact pushed in, the
  // roof pressed down
  function crumple(x, y, z, c) {
    // (a smooth field of wrinkles, a few across the car: points close together move nearly alike, so a light or a
    // badge laid on a panel stays on it)
    const k = c.k, e = c.ext, f = 5.5 / e, s0 = c.seed;
    const w = (a, b, o) => Math.sin(a * f + s0 * 1.3 + o) * Math.cos(b * f * 1.7 + s0 * 0.7 - o) + 0.5 * Math.sin((a + b) * f * 2.3 + s0 + o * 2);
    let X = x + w(z, y, 0.3) * e * 0.1, Y = y + w(x, z, 1.9) * e * 0.07, Z = z + w(x, y, 3.7) * e * 0.1;
    const d = (c.dx * x + c.dz * z) / e; if (d > 0.05) { const push = (d - 0.05) * e * 0.8; X -= c.dx * push; Z -= c.dz * push; Y -= push * 0.35; }   // (crushed in where it hit)
    const r = c.top * 0.4; if (y > r) Y -= (y - r) * 0.6;   // (the roof pressed down)
    return [x + (X - x) * k, y + (Y - y) * k, z + (Z - z) * k];
  }
  function flatPanels(prims) {
    for (const p of prims) {
      if (!p.f3 || !p.snrm) continue;
      const t = p.tri; let x = 0, y = 0, z = 0;
      for (let i = 0; i + 8 < t.length; i += 9) {
        const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2], vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
        x += uy * vz - uz * vy; y += uz * vx - ux * vz; z += ux * vy - uy * vx;
      }
      const l = Math.hypot(x, y, z); if (!l) continue;
      for (let k = 0; k < p.snrm.length; k += 3) { p.snrm[k] = x / l; p.snrm[k + 1] = y / l; p.snrm[k + 2] = z / l; }
    }
  }
  function smoothNormals(prims, cosA) {
    const at = new Map(), key = (t, i) => Math.round(t[i] * 8) + ',' + Math.round(t[i + 1] * 8) + ',' + Math.round(t[i + 2] * 8);
    const faces = [];
    for (const p of prims) {
      const t = p.tri;
      for (let i = 0; i + 8 < t.length; i += 9) {
        const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2], vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
        const f = { n: [nx / l, ny / l, nz / l], w: l };
        faces.push(f);
        for (let k = 0; k < 9; k += 3) { const q = key(t, i + k); if (!at.has(q)) at.set(q, []); at.get(q).push(f); }
      }
    }
    let fi = 0;
    for (const p of prims) {
      const t = p.tri, out = p.snrm = new Float32Array(t.length);
      for (let i = 0; i + 8 < t.length; i += 9, fi++) {
        const f = faces[fi];
        for (let k = 0; k < 9; k += 3) {
          let x = 0, y = 0, z = 0;
          for (const g of at.get(key(t, i + k))) { const d = g.n[0] * f.n[0] + g.n[1] * f.n[1] + g.n[2] * f.n[2]; if (d > cosA) { x += g.n[0] * g.w; y += g.n[1] * g.w; z += g.n[2] * g.w; } }
          const l = Math.hypot(x, y, z) || 1;
          out[i + k] = x / l; out[i + k + 1] = y / l; out[i + k + 2] = z / l;
        }
      }
    }
  }
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  function planeOf(P) {
    const a = P[0];
    for (let i = 1; i < P.length - 1; i++) {
      const u = [P[i][0] - a[0], P[i][1] - a[1], P[i][2] - a[2]], v = [P[i + 1][0] - a[0], P[i + 1][1] - a[1], P[i + 1][2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n);
      if (l > 1e-3) {
        for (let k = 0; k < 3; k++) n[k] /= l;
        const box = [0, 1, 2].map(k => [Math.min(...P.map(p => p[k])), Math.max(...P.map(p => p[k]))]);
        return { n, d: dot(n, a), box };
      }
    }
    return null;
  }
  const overlap = (A, B) => A && B && A.every((r, k) => r[0] <= B[k][1] + 1 && B[k][0] <= r[1] + 1);
  // lines become two thin crossed strips so they can be painted in order with the polygons
  // a line (cables, wires, antennas, lettering, a car's strokes): a square tube, as wide in the world as suits
  // its shape's size (shape(): a car's strokes fine, a sign's letters bolder, a bridge's cables at most 2.5), so
  // it shrinks with distance like the rest; the vertex shader keeps it from going below about 1.5 screen pixels
  // (0.3 of the original's pixels), so far ones don't vanish (see lofs)
  const LINE_W = 0.6;
  // a polygon's points with each face-vertex that lies on one of its edges (not at an end) added along that edge, in order:
  // a neighbouring face that has the point as a corner then meets this one exactly, instead of along a longer edge
  function weld(P, verts) {
    const out = [];
    for (let k = 0; k < P.length; k++) {
      const a = P[k], b = P[(k + 1) % P.length], ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
      out.push(a);
      if (!l2) continue;
      const on = [];
      for (const v of verts) {
        if (v === a || v === b) continue;
        const t = ((v[0] - a[0]) * ab[0] + (v[1] - a[1]) * ab[1] + (v[2] - a[2]) * ab[2]) / l2;
        if (t <= 0.005 || t >= 0.995) continue;
        const dx = v[0] - a[0] - ab[0] * t, dy = v[1] - a[1] - ab[1] * t, dz = v[2] - a[2] - ab[2] * t;
        if (dx * dx + dy * dy + dz * dz < 0.5) on.push([t, v]);
      }
      on.sort((p, q) => p[0] - q[0]);
      for (const [, v] of on) out.push(v);
    }
    return out;
  }
  function line(tri, a, b, ofs, width = LINE_W) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(d[0], d[1], d[2]), h = width / 2;
    const u = len > 1e-6 ? d.map(v => v / len) : [0, 1, 0];
    const t = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let p = [u[1] * t[2] - u[2] * t[1], u[2] * t[0] - u[0] * t[2], u[0] * t[1] - u[1] * t[0]]; const pl = Math.hypot(...p); p = p.map(v => v / pl * h);
    const q = [u[1] * p[2] - u[2] * p[1], u[2] * p[0] - u[0] * p[2], u[0] * p[1] - u[1] * p[0]];
    if (len < 1e-6) { b = [a[0] + u[0] * h * 2, a[1] + u[1] * h * 2, a[2] + u[2] * h * 2]; }
    const c = (o, s1, s2) => [o[0] + p[0] * s1 + q[0] * s2, o[1] + p[1] * s1 + q[1] * s2, o[2] + p[2] * s1 + q[2] * s2];
    const sides = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
    for (let i = 0; i < 4; i++) {
      const [s1, s2] = sides[i], [r1, r2] = sides[(i + 1) % 4];
      const a0 = c(a, s1, s2), a1 = c(a, r1, r2), b0 = c(b, s1, s2), b1 = c(b, r1, r2);
      tri.push(a0, a1, b1, a0, b1, b0);
      if (ofs) { const o0 = c([0, 0, 0], s1, s2), o1 = c([0, 0, 0], r1, r2); ofs.push(o0, o1, o1, o0, o1, o0); }   // (each corner's offset from the axis: the shader widens by it)
    }
  }
  function sphere(tri, c, r) {
    const N = 8, M = 12, pt = (i, j) => { const t = Math.PI * i / N, f = 2 * Math.PI * j / M; return [c[0] + r * Math.sin(t) * Math.cos(f), c[1] + r * Math.cos(t), c[2] + r * Math.sin(t) * Math.sin(f)]; };
    for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) tri.push(pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j), pt(i + 1, j + 1), pt(i, j + 1));
  }
  // wheels: a tyre (tread and sidewalls) with a silver rim set into each side; us gets per-vertex u
  // around the wheel (tread/sidewall: u, rim: 2 + u) so the shader can turn the pattern
  // (a wheel primitive: disc centres a0 and b0, and on the first disc a point up (p1) and one forward (p2):
  // steering turns the discs, which the forward point shows; the line between the centres is not their
  // axis. The wheel is a true cylinder on the discs' axis, between the two discs.)
  function cylinder(tri, a0, b0, r, us, p1, p2, parts) {   // parts (per vertex): 0 tread, 1 tyre side, 2 hub
    if (p1 && p2) {
      const A = new T.Vector3(...a0), B = new T.Vector3(...b0);
      const up = new T.Vector3(...p1).sub(A), fw = new T.Vector3(...p2).sub(A), n = new T.Vector3().crossVectors(up, fw);
      if (n.lengthSq() > 1e-6) {
        n.normalize(); if (n.x < 0) n.negate();   // every wheel's axis the same way across the car: all roll the same way
        // a steered (front) wheel is built straight (its vertices' angle jitters on small wheels: they are
        // whole numbers); the drawing turns it by the car's smoothed steering (see DynBuf.fill)
        if (parts && parts.front) { parts.phi = Math.atan2(n.z, n.x); const l = Math.hypot(n.x, n.z); n.x = l; n.z = 0; }
        const c = A.clone().add(B).multiplyScalar(0.5), half = Math.max(1, Math.abs(B.clone().sub(A).dot(n)) / 2);
        a0 = c.clone().addScaledVector(n, -half).toArray(); b0 = c.clone().addScaledVector(n, half).toArray();
        if (parts) { parts.centre = c.toArray(); parts.halfW = half; }
      }
    } else if (b0[0] < a0[0]) [a0, b0] = [b0, a0];
    const a = new T.Vector3(...a0), b = new T.Vector3(...b0), axis = b.clone().sub(a), len = axis.length(), ax = axis.clone().normalize();
    const u = Math.abs(ax.y) < 0.9 ? new T.Vector3(0, 1, 0) : new T.Vector3(1, 0, 0);
    const v1 = u.clone().cross(ax).normalize(), v2 = ax.clone().cross(v1).normalize();
    const S = 18, rr = r * 0.66, inset = Math.min(len * 0.18, r * 0.25);
    const ring = (o, i, rad) => { const t = 2 * Math.PI * i / S; return o.clone().addScaledVector(v1, Math.cos(t) * rad).addScaledVector(v2, Math.sin(t) * rad).toArray(); };
    const ai = a.clone().addScaledVector(ax, inset), bi = b.clone().addScaledVector(ax, -inset);
    for (let i = 0; i < S; i++) {
      const u0 = i / S, u1 = (i + 1) / S, um = (u0 + u1) / 2;
      const quad = (p0, p1, q0, q1, w0, w1, part) => { tri.push(p0, q0, q1, p0, q1, p1); if (us) us.push(w0, w0, w1, w0, w1, w1); if (parts) parts.push(part, part, part, part, part, part); };
      quad(ring(a, i, r), ring(a, i + 1, r), ring(b, i, r), ring(b, i + 1, r), u0, u1, 0);        // tread
      for (const [o, oi, sgn] of [[a, ai, 1], [b, bi, -1]]) {
        const s0 = ring(o, i, r), s1 = ring(o, i + 1, r), t0 = ring(o, i, rr), t1 = ring(o, i + 1, rr);
        quad(s0, s1, t0, t1, u0, u1, 1);                                                           // sidewall
        quad(t0, t1, ring(oi, i, rr), ring(oi, i + 1, rr), u0, u1, 1);                            // lip down to the rim
        tri.push(oi.toArray(), ring(oi, sgn > 0 ? i + 1 : i, rr), ring(oi, sgn > 0 ? i : i + 1, rr));   // rim face
        if (us) us.push(2 + um, 2 + (sgn > 0 ? u1 : u0), 2 + (sgn > 0 ? u0 : u1));
        if (parts) parts.push(2, 2, 2);
      }
    }
  }
  root.HiresView = HiresView;
})(window);
