// <buddy-cat>: the long-haired black cat.
//   mode   = auto | sit | groom | sleep | nag | alert | wave | walk
//            nag (or alert) = a habit is still missing today: the cat shows its mean face with a "!"
//   height = stage height in px (default 150) · start = 0..1, where the cat begins · floor = line | none
//   base   = folder of the pictures (default "cat/")
//   outfit = the name of an outfit (e.g. "chef"). If cat/outfits/<name>/ holds a full set of pictures (same
//            file names as cat/), the cat does everything it normally does, wearing the outfit. Until it does,
//            the single picture cat/outfits/<name>.png is shown, and it can only hop and waddle.
//   cue    = "celebrate:1" | "alert:1" | "wake:1": change the number to play it again.
//
// The pictures are all filmed, in one side/front view and at one size, so they join without a visible change.
//     fa/main, fa/mean     the cat sitting and looking at you: calm (the main pose), and the mean face
//     fa/hp00..hp36        happy (mouth open, tail up) -> calm      (the celebration)
//     fa/zz00..zz68        calm -> eyes narrow and close -> lies down -> asleep
//     walk/w00..w43        one full step cycle, seen from the side
//     vid/sd00..sd16       standing -> sitting down, from the side (played backwards: standing up)
//     vid/gr00..gr44       sitting, raising a paw and washing its face
//     tr/tr00..tr84        walking right, turning round through the camera, walking left (played mirrored for the other way)
//
// How it moves
//  - Everything the cat does is a queue of small steps (sit, stand up, walk to a spot, wash, jump, ...).
//  - It is drawn on a <canvas>. Every picture is decoded into memory once, before it is ever shown.
//  - Its main pose is the one facing you. To walk it blends to the side view (the head stays near the
//    same place), stands up, walks, sits down, and blends back. Walking shows the frame that matches the
//    distance travelled, so the paws keep pace with the ground.
//  - Pictures of the same view follow each other without any blending. The faces (calm, mean) blend into
//    each other because they are the same picture apart from the face.
(function () {
  if (customElements.get('buddy-cat')) return;

  var SIT_H = 390;                       // reference height that sets the cat's size on the stage (source px)
  var STATIC_SCALE = 0.8;                // a single costume picture is drawn at this share of its size
  var WALK_FRAMES = 44, SD_N = 17, GR_N = 45, HP_N = 37, ZZ_N = 69, TR_N = 85;     // filmed frames in each clip
  var WALK_W = 482;                      // the filmed cat is as wide as this many source px (same size as the other pictures)
  var WORLD_W = 1114;                    // ...which is this many pixels of the film frame ("world" pixels)
  var WORLD_C = 557;                     // world x of the middle of the walking pictures: where the cat's `x` is
  var WORLD_PER_PX = 1114 / 560;         // world pixels per pixel of a picture file
  var FA_X0 = -141;                      // world x of the left edge of the fa/ pictures (they are a little wider)
  var WALK_HEAD = 0.3589;                // side view: the head is this share of the picture's width right of its middle
  var FACE_HEAD = 182;                   // facing you: the head is this many world pixels left of the middle (before mirroring)
  var WALK_STAND_FRAME = 16;             // the walk frame that looks most like standing still: walks start from it
  var HAPPY_FRAME = 10;                  // the frame of the happy clip that is the celebration pose: mouth open, tail up high
  var TR_END_FRAME = 12;                 // the walk frame the turn clip ends on (mirrored): the walk carries on from it
  var TR_FPS = 36;                       // a turn takes about 2.4 seconds
  var FPS = 30;                          // speed of the filmed clips
  var FADE_MS = 320;                     // costume pictures
  var FADE_STILL_MS = 240;               // calm <-> mean face
  var FADE_FACE_MS = 340;                // facing you <-> side view
  var FADE_VID_MS = 130;                 // side view: walk <-> standing: almost the same picture
  var FADE_FLIP_MS = 260;                // turning to face the other way

  // Walking. `len` = how far the cat travels during one stride (source px), `v` = top speed (source px
  // per second), `lean` = degrees of forward lean. Measured in the filmed walk, the paws on the ground move
  // back 228 source px per cycle, so with len = 228 a planted paw stays where it landed.
  var GAIT = {
    stroll: { len: 228, v: 125, bob: 0, lean: 0 },
    walk:   { len: 228, v: 215, bob: 0, lean: 0 },
    run:    { len: 228, v: 340, bob: 0, lean: 2 }
  };
  // A single costume picture cannot walk: it waddles (hop, hop, hop) instead.
  var WADDLE = {
    stroll: { len: 130, v: 100, bob: 0.7, lean: 2 },
    walk:   { len: 150, v: 170, bob: 1,   lean: 3 },
    run:    { len: 140, v: 330, bob: 1.5, lean: 5 }
  };

  var CSS =
    ':host{display:block;position:relative;overflow:hidden;user-select:none;-webkit-user-select:none;cursor:pointer}' +
    'canvas{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}' +
    '.floor{position:absolute;left:0;right:0;bottom:10px;height:1px;background:var(--color-divider,rgba(255,255,255,.16))}' +
    '.fx{position:absolute;pointer-events:none;font-family:var(--font-heading,system-ui);font-weight:700;width:0;height:0;left:0;bottom:0}' +
    '.fx span{position:absolute;left:0;bottom:0;opacity:0;white-space:nowrap}' +
    '.zzz{color:var(--color-neutral-600,#888);font-size:18px;font-style:italic}.bang{color:var(--color-accent-300,#ffc46b);font-size:36px}' +
    '[data-fx=sleep] .zzz{animation:zz 3.6s ease-in infinite}[data-fx=alert] .bang{animation:bp .9s ease-in-out infinite}' +
    '@keyframes zz{0%{opacity:0;transform:scale(.7)}20%{opacity:.95}80%{opacity:.6}100%{opacity:0;transform:translate(22px,-42px) scale(1.15)}}' +
    '@keyframes bp{0%,100%{opacity:.9;transform:translateY(0) scale(1)}50%{opacity:1;transform:translateY(-8px) scale(1.15)}}' +
    '.conf{position:absolute;inset:0;pointer-events:none}.conf i{position:absolute;left:0;bottom:0;width:5px;height:9px;border-radius:1px;opacity:0;animation:cb 1.1s ease-out 1}' +
    '@keyframes cb{0%{opacity:1;transform:none}100%{opacity:0;transform:translate(var(--dx),var(--dy)) rotate(var(--rot)) scale(.5)}}' +
    '@media (prefers-reduced-motion:reduce){.fx span{animation:none!important}}';

  function R(a, b) { return a + Math.random() * (b - a); }
  function J(ms) { return ms * R(0.85, 1.15); }                     // a little randomness so nothing loops mechanically
  function pick(w) { var t = 0, k; for (k in w) t += w[k]; var r = Math.random() * t; for (k in w) { r -= w[k]; if (r <= 0) return k; } return k; }
  function ease(t) { return t * t * (3 - 2 * t); }                  // smoothstep
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Pictures: loaded once, kept as decoded bitmaps. sprites[path] = { w, h, draw, ready, failed }.
  var sprites = {};
  function preload(path) {
    if (sprites[path]) return;
    var s = sprites[path] = { ready: false, failed: false };
    var img = new Image();
    img.onload = function () {
      s.w = img.naturalWidth; s.h = img.naturalHeight; s.draw = img; s.ready = true;
      if (window.createImageBitmap) createImageBitmap(img).then(function (b) { s.draw = b; }).catch(function () {});
    };
    img.onerror = function () { s.failed = true; };
    img.src = path;
  }
  function isReady(path) { var s = sprites[path]; return !!(s && s.ready); }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function walkPath(dir, n) { return dir + 'walk/w' + two(n) + '.webp'; }
  function sidePath(dir, set, n) { return dir + 'vid/' + set + two(n) + '.webp'; }       // set: sd | gr
  function facePath(dir, name) { return dir + 'fa/' + name + '.webp'; }                  // main | mean
  function faceFrame(dir, set, n) { return dir + 'fa/' + set + two(n) + '.webp'; }       // set: hp | zz
  var COUNTS = { walk: WALK_FRAMES, sd: SD_N, gr: GR_N, hp: HP_N, zz: ZZ_N, tr: TR_N };
  // Settings of a set of pictures. The plain cat's are these; an outfit folder has its own set.json with
  // the same fields (it usually has fewer clips: a walk, a turn and a main pose).
  //   walk, tr: number of frames · trEnd: walk frame the turn ends on · len: stride (source px per step cycle)
  //   stand: walk frame that looks like standing · mainSide: the main pose is standing side-on (no front view)
  //   mainFlip: false = never mirror the main pose · mainX0: world x of the main picture's left edge · faceHead
  var BASE_META = { walk: WALK_FRAMES, tr: TR_N, trEnd: 12, trFps: 36, len: 228, stand: 16, mainSide: false, mainFlip: null, mainX0: FA_X0, faceHead: FACE_HEAD };
  var metas = {};                                                  // folder -> settings (loaded set.json)
  function setPath(dir, set, n) {
    return set === 'walk' ? walkPath(dir, n) : set === 'tr' ? dir + 'tr/tr' + two(n) + '.webp'
      : (set === 'sd' || set === 'gr') ? sidePath(dir, set, n) : faceFrame(dir, set, n);
  }
  function preloadAll(dir, meta) {
    if (!meta) { Object.keys(COUNTS).forEach(function (set) { for (var i = 0; i < COUNTS[set]; i++) preload(setPath(dir, set, i)); }); preload(facePath(dir, 'mean')); }
    else ['walk', 'tr', 'sd', 'gr', 'hp', 'zz'].forEach(function (set) { for (var i = 0; i < (meta[set] || 0); i++) preload(setPath(dir, set, i)); });
    preload(facePath(dir, 'main'));
  }

  class BuddyCat extends HTMLElement {
    static get observedAttributes() { return ['mode', 'cue', 'height', 'floor', 'outfit']; }

    constructor() {
      super();
      var r = this.attachShadow({ mode: 'open' });
      r.innerHTML = '<style>' + CSS + '</style><div class="floor"></div><canvas></canvas>' +
        '<div class="fx"><span class="zzz">z z Z</span><span class="bang">!</span></div><div class="conf"></div>';
      this.$canvas = r.querySelector('canvas'); this.ctx = this.$canvas.getContext('2d');
      this.$fx = r.querySelector('.fx'); this.$conf = r.querySelector('.conf'); this.$floor = r.querySelector('.floor');
      // pose: main | mean | happy | sleep (facing you) · sit | stand (side view) · clip (a filmed clip is playing)
      this.c = { x: 40, y: 0, dir: 1, v: 0, pose: 'main', energy: R(0.7, 1), fx: 'none', clipSet: 'sd', clipFrame: 16,
                 sx: 1, sy: 1, tx: 1, ty: 1, rot: 0, phase: 0, jump: null, turnFrom: 1, afterTurn: false };
      this.vis = { a: null, b: null, mix: 1, fade: FADE_MS };
      this.T = 0; this.W = 0; this.H = 0; this.awakeUntil = 0; this.outfitLoaded = false;
      this.q = []; this.cur = null; this.gait = null; this.gaitName = 'walk';
      this.addEventListener('click', (e) => this.onClick(e));
    }

    get _base() { return this.getAttribute('base') || 'cat/'; }
    get _mode() {
      var m = this.getAttribute('mode') || 'auto';
      return m === 'sleep' && this.awakeUntil > performance.now() ? 'auto' : m;   // a cat that was woken stays up
    }
    get _nag() { var m = this._mode; return m === 'nag' || m === 'alert'; }
    get _outfit() { return this.getAttribute('outfit') || ''; }
    get _h() { return parseFloat(this.getAttribute('height')) || 150; }
    // source pixels -> screen pixels. Never so big that the filmed cat is wider than the stage.
    get k() { return Math.min(this._h * 0.72 / SIT_H, ((this.clientWidth || 300) - 6) / WALK_W); }
    get u() { return this.k * WALK_W / WORLD_W; }                    // screen pixels per world pixel
    headOff() { return WALK_HEAD * WALK_W * this.k; }                // side view: the head is this far from the middle
    headX() {                                                         // where the head is on the stage, in the picture shown now
      var c = this.c, b = this.vis && this.vis.b, fam = b ? b.fam : 'face';
      if (fam === 'face') { var mt = this._meta; return c.x + (mt.mainFlip === false ? 1 : c.dir) * mt.faceHead * this.u; }   // facing you: a little to the side
      if (fam === 'front') return c.x + 165 * this.k * 0.35;
      return c.x + c.dir * this.headOff();                                                     // side view
    }
    gaits() {
      if (this._costume) return WADDLE;
      var L = this._meta.len || 228;                                  // the stride of this set, so the paws stay planted
      return { stroll: Object.assign({}, GAIT.stroll, { len: L }), walk: Object.assign({}, GAIT.walk, { len: L }), run: Object.assign({}, GAIT.run, { len: L }) };
    }

    // The outfit: a full set of pictures in cat/outfits/<name>/ ("dressed": the cat does everything), or, until
    // there is one, the single picture cat/outfits/<name>.png ("costume": it can only hop and waddle).
    get _outfitDir() { return this._base + 'outfits/' + this._outfit + '/'; }
    get _dressed() { return !!this._outfit && !!metas[this._outfitDir] && isReady(facePath(this._outfitDir, 'main')); }
    get _meta() { return this._dressed ? metas[this._outfitDir] : BASE_META; }
    // An outfit without its own filmed pictures is shown as the plain cat, so it still does everything
    // (the old single picture could only hop). The "costume" code below is kept for that picture, but unused.
    get _costume() { return false; }
    get _dir() { return this._dressed ? this._outfitDir : this._base; }       // where the pictures for the cat are
    has(set) { return isReady(setPath(this._dir, set, 0)); }
    canWalk() { return !this._costume && this.has('walk'); }

    connectedCallback() {
      preloadAll(this._base);
      this.loadOutfit();
      this.size();
      var start = parseFloat(this.getAttribute('start'));
      this.c.x = (this.clientWidth || 300) * (isNaN(start) ? 0.4 : start);
      this.c.dir = Math.random() < 0.5 ? 1 : -1;
      var m = this._mode;
      this.c.pose = m === 'sleep' ? 'sleep' : (m === 'nag' || m === 'alert') ? 'mean' : 'main';
      if (m === 'sleep') this.c.energy = 0;
      this.clamp();
      this.q = []; this.think();
      this.last = performance.now();
      this.paint(0);
      this.raf = requestAnimationFrame((t) => this.tick(t));
      this.ro = new ResizeObserver(() => { this.size(); this.clamp(); }); this.ro.observe(this);
    }
    disconnectedCallback() { cancelAnimationFrame(this.raf); this.ro && this.ro.disconnect(); }

    loadOutfit() {                                                    // the outfit's settings and pictures (or, failing that, its single picture)
      this.outfitLoaded = false;
      if (!this._outfit) return;
      var dir = this._outfitDir;
      if (metas[dir] === undefined) {
        metas[dir] = null;
        fetch(dir + 'set.json').then(function (r) { return r.ok ? r.json() : null; })
          .then(function (m) { if (m) { metas[dir] = Object.assign({}, BASE_META, { mainX0: 0, faceHead: 0 }, m); preloadAll(dir, metas[dir]); } })
          .catch(function () {});
      }
    }

    attributeChangedCallback(n, o, v) {
      if (!this.$canvas || o === v) return;
      if (n === 'height' || n === 'floor') { this.size(); this.clamp(); }
      if (n === 'outfit') { this.loadOutfit(); if (this.raf) this.interrupt([]); }
      if (n === 'mode' && this.raf) { this.awakeUntil = 0; this.interrupt(this.asleepNow() && v !== 'sleep' ? this.wakeSteps() : []); }
      if (n === 'cue' && v && this.raf) this.cue(v.split(':')[0]);
    }

    size() {
      var hpx = this._h + 'px';
      if (this.style.height !== hpx) this.style.height = hpx;
      this.$floor.style.display = this.getAttribute('floor') === 'none' ? 'none' : '';
      var w = this.clientWidth || 300, h = this._h, dpr = window.devicePixelRatio || 1;
      if (w !== this.W || h !== this.H || dpr !== this.dpr) {
        this.W = w; this.H = h; this.dpr = dpr;
        this.$canvas.width = Math.round(w * dpr); this.$canvas.height = Math.round(h * dpr);
      }
    }
    // Where the middle of the cat may be: the filmed cat has to fit inside the stage, whichever way it faces.
    bounds() {
      var W = this.clientWidth || 300, half = WALK_W * this.k / 2 + 2;
      return half * 2 >= W ? { min: W / 2, max: W / 2 } : { min: half, max: W - half };
    }
    clamp() { var b = this.bounds(), c = this.c; c.x = Math.max(b.min, Math.min(b.max, c.x)); }
    asleepNow() { return this.c.pose === 'sleep'; }

    // ---------- step builders ----------
    hold(p, ms, o) { return Object.assign({ pose: p, ms: J(ms) }, o || {}); }
    call(fn) { return { call: fn }; }
    // A filmed clip: frames from..to of a set (from > to plays it backwards); then the cat is in pose `end`.
    clip(set, from, to, end, hold, fps) { return { clip: set, from: from, to: to, end: end, hold: hold || 0, fps: fps || FPS }; }
    rest(ms) {                                                        // what the cat does between things: look at you (or, if a habit is missing, scowl)
      return this._nag ? this.hold('mean', ms, { fx: 'alert' }) : this.hold('main', ms);
    }
    // Get into the facing-you pose / the side-view sitting pose / the side-view standing pose, from wherever it is.
    toFace() {
      if (this._costume) return [];
      if (!this.has('sd')) return [{ pose: 'main', ms: FADE_FACE_MS, onlyIf: ['stand', 'sit'] }];
      return [Object.assign(this.clip('sd', 0, SD_N - 1, 'sit'), { onlyIf: ['stand'] }), { pose: 'main', ms: FADE_FACE_MS, onlyIf: ['sit'] }];
    }
    toSit() {
      if (this._costume) return [];
      if (!this.has('sd')) return [];                                 // (it goes straight back to its main pose)
      return [{ pose: 'sit', ms: FADE_FACE_MS, onlyIf: ['main', 'mean', 'happy'] }, Object.assign(this.clip('sd', 0, SD_N - 1, 'sit'), { onlyIf: ['stand'] })];
    }
    toStand() {
      if (this._costume) return [];
      if (!this.has('sd')) return [{ pose: 'stand', ms: FADE_VID_MS + 120, onlyIf: ['main', 'mean', 'happy', 'sit'] }];
      return [{ pose: 'sit', ms: FADE_FACE_MS, onlyIf: ['main', 'mean', 'happy'] }, Object.assign(this.clip('sd', SD_N - 1, 0, 'stand'), { onlyIf: ['sit'] })];
    }
    canTurn() { return !this._costume && this.has('tr') && this.canWalk(); }

    // Washing its face: sit (side view), raise a paw, lick it, lower it again.
    groomSteps() {
      if (this._costume || !this.has('gr') || !this.canWalk()) return [];
      return this.toSit().concat([this.hold('sit', 300), this.clip('gr', 0, GR_N - 1, 'clip'), this.clip('gr', GR_N - 1, 0, 'sit'), this.hold('sit', 300)]);
    }
    // Jumping: crouch, spring up, land. Calm face: the happy face is kept for celebrations (a habit was logged).
    hopSteps(h) {
      var self = this;
      return this.toFace().concat([
        this.hold('main', 240, { sq: [1.05, 0.9] }),                                  // crouch
        this.call(function () { self.arc(650, h || 1); }),
        { pose: 'main', ms: 650, sq: [0.97, 1.05] },                                  // in the air
        this.hold('main', 230, { sq: [1.06, 0.9] }),                                  // landing squash
        this.rest(300)]);
    }
    // Celebrating: once. Confetti, the happy face with the tail up and a little hop, then calm again.
    celebrateSteps() {
      var self = this;
      if (this._costume || !this.has('hp')) return this.toFace().concat([this.call(function () { self.burst(); })], this.hopSteps(0.7));
      return this.toFace().concat([
        this.call(function () { self.burst(); }),
        this.clip('hp', HP_N - 1, HAPPY_FRAME, 'happy', 0, 48),                       // calm -> happy (the tail rises, the mouth opens)
        this.call(function () { self.arc(560, 0.45); }),
        { pose: 'happy', ms: 1100 },
        this.clip('hp', HAPPY_FRAME, HP_N - 1, 'main', 0, 48),                        // happy -> calm
        this.rest(400)]);
    }
    // "!": the mean face with the exclamation mark.
    alertSteps(ms) {
      if (this._costume) return [this.hold('main', ms || 1700, { fx: 'alert', sq: [1.03, 1.05] }), this.hold('main', 300)];
      return this.toFace().concat([this.hold('mean', ms || 1700, { fx: 'alert' }), this._nag ? this.rest(300) : this.hold('main', 300)]);
    }
    // Patrolling: walk to one side of the stage, turn round on the way and walk back (and sometimes turn round again).
    patrolSteps() {
      if (!this.canTurn()) return [];
      var b = this.bounds(), c = this.c, left = b.min + R(0, 25), right = b.max - R(0, 25);
      if (right - left < 160) return [];
      var first = (c.x - left) > (right - c.x) ? left : right, other = first === left ? right : left;
      var steps = [{ faceTo: first }].concat(this.toStand(), [{ move: first, gait: 'walk' }, { turnWalk: first === left ? 1 : -1 }, { move: other, gait: 'walk' }]);
      if (Math.random() < 0.5) steps.push({ turnWalk: other === left ? 1 : -1 }, { move: (left + right) / 2 + R(-40, 40), gait: 'stroll' });
      return steps.concat(this.toSit(), [this.rest(500)]);
    }
    // Falling asleep: the eyes narrow and close, it lowers itself down and sleeps. Waking up is the same thing backwards.
    sleepSteps() {
      if (this._costume) return [this.hold('main', 1200, { sq: [1.05, 0.88] }), { pose: 'sleep', ms: J(12000), fx: 'sleep' }];
      if (!this.has('zz')) return [];
      return this.toFace().concat([this.clip('zz', 0, ZZ_N - 1, 'sleep'), { pose: 'sleep', ms: J(12000), fx: 'sleep' }]);
    }
    wakeSteps() {
      var self = this, tail = [this.hold('main', 400), this.call(function () { self.c.energy = R(0.8, 1); })];
      if (this._costume || !this.has('zz')) return [this.hold('main', 500)].concat(tail);
      return [this.clip('zz', ZZ_N - 1, 0, 'main')].concat(tail);
    }
    goTo(x, gait) {
      var c = this.c, b = this.bounds(); x = Math.max(b.min, Math.min(b.max, x));
      if (Math.abs(x - c.x) < 12) return [];
      if (!this.canWalk()) return [{ move: x, gait: gait }, this.rest(600)];          // a costume (or incomplete set): waddle there
      // turn to face it if needed, stand up, walk there, sit down, look at you again
      return [{ faceTo: x }].concat(this.toStand(), [{ move: x, gait: gait }], this.toSit(), [this.rest(500)]);
    }

    // ---------- the brain: what to do next ----------
    think() {
      var c = this.c, m = this._mode, b = this.bounds(), s = [];
      if (m === 'sleep') { s = this.asleepNow() ? [{ pose: 'sleep', ms: J(7500), fx: 'sleep' }] : this.sleepSteps(); if (!s.length) s = [this.rest(5000)]; }
      else if (m === 'walk') {
        s = this.patrolSteps();
        if (!s.length) { var far = c.x - b.min < b.max - c.x ? b.max - R(0, 30) : b.min + R(0, 30); s = this.goTo(far, Math.random() < 0.3 ? 'stroll' : 'walk'); }
        s = s.concat([this.rest(R(1200, 2600))]);
      }
      else if (m === 'wave') s = this.hopSteps(0.7).concat([this.rest(R(2500, 4000))]);   // a hello, not a celebration
      else if (m === 'groom') { s = this.groomSteps(); s = s.length ? s.concat([this.rest(R(1500, 2500))]) : [this.rest(R(3000, 5000))]; }
      else s = this.autoPlan();                                       // auto, sit, nag, alert
      this.q = this.q.concat(s);
    }
    autoPlan() {
      var c = this.c, b = this.bounds(), w = b.max - b.min, nag = this._nag;
      if (this.asleepNow()) {
        if (Math.random() < 0.25) return this.wakeSteps();
        return [{ pose: 'sleep', ms: J(10000), fx: 'sleep' }];
      }
      if (!nag) {
        c.energy = Math.max(0, c.energy - R(0.02, 0.04));
        if (c.energy < 0.1) { var sl = this.sleepSteps(); if (sl.length) return sl; }
      }
      // Like a real cat: mostly it sits and looks at you, now and then it strolls somewhere, washes, or jumps.
      // (With a habit missing it does the same, but it scowls at you whenever it sits.)
      var p = pick({ rest: 5, stroll: 3, wander: 2, patrol: this.canTurn() ? 1.6 : 0, groom: this.groomSteps().length ? 1.2 : 0, hop: 1.2, alert: nag ? 0 : 0.4 });
      if (p === 'rest') return [this.rest(R(3500, 8000))];
      if (p === 'stroll') return this.goTo(c.x + (Math.random() < 0.5 ? -1 : 1) * R(90, 240), 'stroll').concat([this.rest(R(3000, 7000))]);
      if (p === 'wander') { var t = b.min + Math.random() * w; return this.goTo(t, 'walk').concat([this.rest(R(3000, 7000))]); }
      if (p === 'patrol') return this.patrolSteps().concat([this.rest(R(2500, 6000))]);
      if (p === 'groom') return this.groomSteps().concat([this.rest(R(3000, 6000))]);
      if (p === 'hop') return this.hopSteps().concat([this.rest(R(2500, 6000))]);
      return this.alertSteps().concat([this.rest(R(3000, 6000))]);
    }

    interrupt(prefix) {
      var cur = this.cur;
      if (cur && cur.clip) { this.c.pose = cur.end === 'clip' ? 'sit' : cur.end; if (cur.turnTo !== undefined) this.c.dir = cur.turnTo; }   // a clip that is cut short counts as finished
      this.cur = null; this.c.v = 0; this.c.jump = null; this.c.y = 0; this.q = prefix || []; if (!this.q.length) this.think(); this.next();
    }
    cue(a) {
      var pre = this.asleepNow() ? this.wakeSteps() : [];
      var s = a === 'celebrate' ? this.celebrateSteps()                // only app.js sends it, after a habit is logged
        : a === 'jump' ? this.hopSteps()
        : a === 'alert' ? this.alertSteps(1700)
        : a === 'stretch' ? this.alertSteps(1300)
        : a === 'wake' ? this.wakeSteps() : [];
      this.interrupt(pre.concat(s));
    }
    arc(ms, h) { this.c.jump = { t0: performance.now(), ms: ms, h: h }; }
    burst() {
      var el = this.$conf; el.innerHTML = '';
      var cols = ['var(--color-accent,#a5bcd6)', 'var(--color-accent-300,#ffc46b)', '#e2452b', '#f5efc6'];
      var b = this.vis.b;
      this.confY = 10 + (b && b.fam === 'face' ? b.h : SIT_H * this.k) * 0.62;   // face height; paint() keeps it on the head
      for (var i = 0; i < 18; i++) {
        var s = document.createElement('i'), a = Math.PI * 2 * i / 18 + Math.random() * 0.3, d = 50 + Math.random() * 55;
        s.style.setProperty('--dx', Math.cos(a) * d + 'px'); s.style.setProperty('--dy', (Math.sin(a) * d - 10) + 'px');
        s.style.setProperty('--rot', Math.random() * 380 + 'deg'); s.style.background = cols[i % 4];
        s.style.animationDelay = Math.random() * 0.06 + 's'; el.appendChild(s);
      }
    }
    onClick(e) {
      var c = this.c, rect = this.getBoundingClientRect(), x = e.clientX - rect.left;
      var onCat = Math.abs(x - c.x) < WALK_W * this.k * 0.4;
      var wasAsleep = this.asleepNow();
      if (this.getAttribute('mode') === 'sleep') this.awakeUntil = performance.now() + 90000;
      var go;
      if (onCat) { c.energy = Math.min(1, c.energy + 0.35); go = this.alertSteps(1800); }          // a click on the cat: the mean face and "!"
      else go = this.goTo(x, Math.abs(x - c.x) > this.W * 0.6 ? 'run' : 'walk');                   // a click elsewhere: walk there
      this.interrupt((wasAsleep ? this.wakeSteps() : []).concat(go));
    }

    // ---------- runtime ----------
    next() {
      while (true) {
        if (!this.q.length) this.think();
        var s = this.q.shift(), c = this.c;
        if (s.call) { s.call(); continue; }
        if (s.onlyIf && s.onlyIf.indexOf(c.pose) < 0) continue;           // e.g. "sit down" only if standing
        if (s.turnWalk !== undefined) {                                   // turn round while on its feet: the filmed turn (mirrored for the other way)
          if (s.turnWalk === c.dir || !this.canTurn()) { c.dir = s.turnWalk; continue; }
          c.turnFrom = c.dir;
          var mt = this._meta;
          this.cur = { acc: 0, clip: 'tr', from: 0, to: mt.tr - 1, end: 'stand', hold: 0, fps: mt.trFps, turnTo: s.turnWalk, clipMs: (mt.tr - 1) / mt.trFps * 1000 };
          c.pose = 'clip'; c.clipSet = 'tr'; c.clipFrame = 0; c.fx = 'none'; c.tx = 1; c.ty = 1; c.v = 0;
          return;
        }
        if (s.faceTo !== undefined) {                                     // turn round, if the target is behind the cat
          var wantDir = s.faceTo >= c.x ? 1 : -1;
          if (wantDir === c.dir || !this.canWalk()) { c.dir = wantDir; continue; }
          if (c.pose === 'stand' && this.canTurn()) { this.q.unshift({ turnWalk: wantDir }); continue; }     // already on its feet: turn round walking
          if (this._meta.mainSide && this.canTurn()) { this.q.unshift.apply(this.q, this.toStand().concat([{ turnWalk: wantDir }])); continue; }
          // The cat faces you, then settles facing the other way: the picture mirrors, with a short blend.
          var self = this;
          this.q.unshift.apply(this.q, this.toFace().concat([this.call(function () { self.c.dir = wantDir; }), this.hold('main', 300)]));
          continue;
        }
        this.cur = Object.assign({ acc: 0 }, s);
        if (s.clip) {
          var dur = Math.abs(s.to - s.from) / s.fps * 1000 + s.hold;
          this.cur.clipMs = dur;
          if (!this._costume) { c.pose = 'clip'; c.clipSet = s.clip; c.clipFrame = s.from; }
          c.fx = 'none'; c.tx = 1; c.ty = 1;
          return;
        }
        if (s.pose) c.pose = s.pose;
        c.fx = s.fx || 'none';
        c.tx = s.sq ? s.sq[0] : 1; c.ty = s.sq ? s.sq[1] : 1;
        if (this._costume && !s.sq && s.pose === 'sleep') { c.tx = 1.05; c.ty = 0.88; }   // a costume cannot lie down: it squashes instead
        if (s.move != null) {
          this.gaitName = s.gait || 'walk'; this.gait = this.gaits()[this.gaitName]; c.tx = 1; c.ty = 1;
          c.dir = s.move >= c.x ? 1 : -1;
          if (this.canWalk()) c.phase = (c.afterTurn ? this._meta.trEnd : this._meta.stand) / this._meta.walk;   // set off from the stride that looks like where it is
          c.afterTurn = false;
        }
        return;
      }
    }
    tick(now) {
      var c = this.c, dt = Math.min(64, now - this.last); this.last = now; this.T += dt;
      if (!this.cur) this.next();
      var s = this.cur, k = this.k, moving = false;
      if (s.move != null) {
        var g = this.gait, d = s.move - c.x, ad = Math.abs(d);
        if (d * c.dir < 0) ad = 0;                                   // already past the target
        if (this.gaitName === 'run' && ad < 90 * k * 2) { this.gaitName = 'walk'; g = this.gait = this.gaits().walk; }
        var vmax = g.v * k;
        var vT = Math.min(vmax, 20 + ad * 2.2);                      // slow down smoothly before the target
        var acc = vmax * 1.5 * dt / 1000;
        c.v += Math.max(-acc * 1.5, Math.min(acc, vT - c.v));        // speed up gently, brake a bit harder
        var step = Math.min(ad, c.v * dt / 1000);
        c.x += c.dir * step;
        c.phase += step / (g.len * k);                               // one stride = g.len source pixels of travel
        moving = true;
        if (ad - step < 1.5) { c.v = 0; this.cur = null; }
      } else if (s.clip) {
        s.acc += dt; c.v = 0;
        var n = Math.abs(s.to - s.from), run = n / s.fps * 1000, sign = s.to >= s.from ? 1 : -1;
        var fi = Math.min(n, Math.floor(Math.min(s.acc, run) * s.fps / 1000));
        if (!this._costume) c.clipFrame = s.from + sign * fi;
        if (s.acc >= s.clipMs) {
          if (!this._costume) c.pose = s.end;
          if (s.turnTo !== undefined) { c.dir = s.turnTo; c.afterTurn = true; }
          this.cur = null;
        }
      } else {
        s.acc += dt;
        if (s.acc >= s.ms) this.cur = null;
        c.v = 0;
      }
      if (c.jump) {
        var p = (now - c.jump.t0) / c.jump.ms;
        if (p >= 1) { c.jump = null; c.y = 0; } else c.y = 4 * p * (1 - p) * this._h * 0.2 * c.jump.h;   // a parabola: slow at the top
      }
      // squash and stretch ease towards their target instead of snapping
      var f = 1 - Math.exp(-dt / 55);
      c.sx += (c.tx - c.sx) * f; c.sy += (c.ty - c.sy) * f;
      this.paint(dt, moving);
      this.raf = requestAnimationFrame((t) => this.tick(t));
    }

    // ---------- drawing ----------
    // Each picture is described by: src, its height on screen, the world x of its left edge, whether it is
    // mirrored, and fam: 'walk' | 'vid' (side view) | 'face' (facing you) | 'front' (a single costume picture).
    mk(src, fam, o) {
      var sp = sprites[src], u = this.u, ready = sp && sp.ready;
      var flip = fam === 'face' ? this.c.dir === 1 : this.c.dir === -1;        // the facing-you pictures have the head on the left
      return { src: src, fam: fam, pad: 0, x0: (o && o.x0) || 0, u: u, flip: flip, still: !!(o && o.still),
               h: (ready ? sp.h : 330) * WORLD_PER_PX * u };
    }
    geom(pose) {
      var c = this.c, d = this._dir;
      if (this._costume) {                                                      // a single picture of the cat in its outfit
        var os = this._base + 'outfits/' + this._outfit + '.png', sp = sprites[os], oh = sp && sp.ready ? sp.h : 370;
        return { src: os, pad: 6 * this.k, h: this.k * oh * STATIC_SCALE, flip: false, fam: 'front', center: true, x0: 0, u: this.u, still: false };
      }
      var hasSd = this.has('sd');
      if (pose === 'sit') return hasSd ? this.mk(sidePath(d, 'sd', SD_N - 1), 'vid') : this.mainGeom();
      if (pose === 'stand') return hasSd ? this.mk(sidePath(d, 'sd', 0), 'vid') : this.walkGeom(this._meta.stand);
      // (an outfit's set may lack some pictures: it then falls back to its main picture)
      if (pose === 'mean') return isReady(facePath(d, 'mean')) ? this.mk(facePath(d, 'mean'), 'face', { x0: FA_X0, still: true }) : this.mainGeom();
      if (pose === 'happy') return isReady(faceFrame(d, 'hp', HAPPY_FRAME)) ? this.mk(faceFrame(d, 'hp', HAPPY_FRAME), 'face', { x0: FA_X0, still: true }) : this.mainGeom();
      if (pose === 'sleep') return this.mk(faceFrame(d, 'zz', ZZ_N - 1), 'face', { x0: FA_X0, still: true });
      if (pose === 'clip') {
        var face = c.clipSet === 'hp' || c.clipSet === 'zz';
        var g = this.mk(setPath(d, c.clipSet, c.clipFrame), face ? 'face' : 'vid', { x0: face ? FA_X0 : 0 });
        if (c.clipSet === 'tr') g.flip = c.turnFrom === -1;                  // the clip turns from facing right to facing left
        return g;
      }
      return this.mainGeom();
    }
    mainGeom() {                                                     // the main pose: facing you, or (an outfit with no front view) standing side-on
      var m = this._meta, src = facePath(this._dir, 'main');
      if (m.mainSide) { var gs = this.mk(src, 'vid'); gs.still = true; return gs; }
      var g = this.mk(src, 'face', { x0: m.mainX0, still: true });
      if (m.mainFlip === false) g.flip = false;
      return g;
    }
    walkGeom(frame) { return this.mk(walkPath(this._dir, frame), 'walk'); }
    drawSprite(g, alpha) {                                           // feet at the origin
      var sp = sprites[g.src];
      if (!sp || !sp.ready) return;
      var ctx = this.ctx, w = g.h * sp.w / sp.h, left = g.center ? -w / 2 : (g.x0 - WORLD_C) * g.u;
      ctx.save();
      ctx.globalAlpha = alpha;
      if (g.flip) ctx.scale(-1, 1);
      ctx.drawImage(sp.draw, left, -g.h + g.pad, w, g.h);
      ctx.restore();
    }
    paint(dt, moving) {
      this.size();
      var c = this.c, v = this.vis, k = this.k, costume = this._costume, ctx = this.ctx, dpr = this.dpr || 1;
      var bob = 0, lean = 0, rotTarget = 0, shape = 1, squashX = 1, want;

      if (moving) {
        var ph = c.phase * 2 * Math.PI, g = this.gait, speed = Math.min(1, c.v / (g.v * k));
        if (this.canWalk()) {
          // Walking: the frame follows the distance travelled.
          var wn = this._meta.walk;
          want = this.walkGeom(Math.floor(((c.phase % 1) + 1) % 1 * wn) % wn);
          lean = g.lean * c.dir * speed;
        } else {
          // A single picture waddles: hop, hop, hop, rocking onto the paw it lands on, leaning into the walk.
          want = this.geom('main');
          bob = Math.abs(Math.sin(ph)) * this._h * 0.045 * g.bob * speed;
          lean = (g.lean * c.dir + Math.sin(ph) * 5 * g.bob) * speed;
          shape = 1 - 0.05 * speed * (1 - Math.abs(Math.sin(ph)));      // flattens a little when it lands
          squashX = 1 + 0.03 * speed * (1 - Math.abs(Math.sin(ph)));
        }
        c.rot = lean;
      } else {
        want = this.geom(c.pose);
        if (costume) {                                                // one picture cannot change expression, so it sways instead
          rotTarget = c.pose === 'mean' ? 4 : c.pose === 'sleep' ? 0 : Math.sin(this.T / 1400) * 1.1;
        }
        c.rot += (rotTarget - c.rot) * (1 - Math.exp(-dt / 90));       // ease the sway in and out
      }

      // Which picture is on screen. Pictures of one view follow each other without blending; the two faces blend into
      // each other; facing you <-> side view and a change of direction are short blends.
      if (!v.b) { v.b = want; v.a = null; v.mix = 1; }
      else if (v.b.src !== want.src) {
        var a = v.b, b = want;
        if (a.fam === 'front' || b.fam === 'front') { v.a = a; v.b = b; v.mix = 0; v.fade = FADE_MS; }
        else if (a.fam === b.fam) {
          if (a.still && b.still) { v.a = a; v.b = b; v.mix = 0; v.fade = FADE_STILL_MS; }   // calm <-> mean <-> happy
          else v.b = b;                                                                       // the next frame
        } else { v.a = a; v.b = b; v.mix = 0; v.fade = (a.fam === 'face' || b.fam === 'face') ? FADE_FACE_MS : FADE_VID_MS; }
      } else if (v.b.flip !== want.flip) { v.a = v.b; v.b = want; v.mix = 0; v.fade = FADE_FLIP_MS; }   // turned the other way
      else v.b = want;
      v.mix = Math.min(1, v.mix + dt / (v.fade || FADE_MS));
      if (v.mix >= 1) v.a = null;

      // breathing, when the cat is still
      var calm = c.pose === 'main' || c.pose === 'mean' || c.pose === 'sit' || c.pose === 'sleep';
      var breath = (!moving && !c.jump && !costume && !reduced && calm) ? Math.sin(this.T / (c.pose === 'sleep' ? 900 : 600)) * (c.pose === 'sleep' ? 0.014 : 0.008) : 0;

      // ---- draw ----
      var W = this.W, H = this.H, floorY = H - 10;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      var air = Math.min(1, (c.y + bob) / (this._h * 0.2));            // 0 on the ground, 1 at the top of a jump
      var sw = (costume ? 165 * k * 0.75 : WALK_W * k * 0.3) * (1 - 0.3 * air);   // shadow radius
      ctx.save();
      ctx.translate(c.x, floorY + 2); ctx.scale(1, 0.14);
      var grad = ctx.createRadialGradient(0, 0, 0, 0, 0, sw);
      grad.addColorStop(0, 'rgba(0,0,0,' + (0.5 * (1 - 0.5 * air)).toFixed(2) + ')'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, sw, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.translate(c.x, floorY - c.y - bob);
      ctx.rotate(c.rot * Math.PI / 180);
      ctx.scale(c.sx * squashX * (1 + breath), c.sy * shape * (1 - breath));
      if (v.a) this.drawSprite(v.a, 1);
      this.drawSprite(v.b, v.a ? ease(v.mix) : 1);
      ctx.restore();

      // the "!" and the "z z Z" float above the head
      var hh = v.b ? v.b.h : this._h * 0.7, hx = this.headX(), fh = 0.97;
      if (c.pose === 'sleep' && !costume) { hx = c.x + c.dir * WALK_W * k * 0.5; fh = 0.62; }  // lying down: the head is low, far to the side
      this.$fx.style.transform = 'translate3d(' + hx.toFixed(1) + 'px,' + (-(hh * fh + 8 + c.y)).toFixed(1) + 'px,0)';
      if (this.$fx.dataset.fx !== c.fx) this.$fx.dataset.fx = c.fx;
      if (this.confY) this.$conf.style.transform = 'translate3d(' + hx.toFixed(1) + 'px,' + (-this.confY).toFixed(1) + 'px,0)';   // confetti around the face
    }
  }
  customElements.define('buddy-cat', BuddyCat);
})();
