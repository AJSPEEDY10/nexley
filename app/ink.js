/* Nexley — handwriting and diagrams, with a pencil, on the note itself.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: A PENCIL DRAWS, A FINGER SCROLLS.
 * This is the single thing that separates a usable ink surface on an iPad from
 * an infuriating one. A canvas that draws on any touch means you cannot scroll
 * the page your hand is resting on, and you cannot rest your hand on it while
 * writing either. So:
 *
 *   pointerType 'pen'    -> draws, always
 *   pointerType 'mouse'  -> draws (a laptop has no stylus and still needs to
 *                           be able to sketch)
 *   pointerType 'touch'  -> NEVER draws. The event is not consumed, so the
 *                           browser scrolls the page exactly as it would if
 *                           this canvas were not here.
 *
 * That last line is why `touch-action` is set to `pan-y` rather than `none`:
 * `none` would kill scrolling over the canvas even though we ignore the event,
 * which is the bug this rule exists to prevent.
 *
 * WHY VECTOR STROKES AND NOT A BITMAP. A PNG drawn at iPad width is blurry on
 * a desktop and unreadable at sidebar width; strokes redraw at any size. Undo
 * and erase-a-stroke are trivial on a list and impossible on a flattened
 * image. And strokes are just numbers, so they ride the existing sync path as
 * one more jsonb column rather than needing blob storage.
 *
 * COORDINATES ARE STORED 0..1, NOT IN PIXELS. The same note is opened on a
 * phone, an iPad and a laptop, and the canvas is a different width in each. A
 * stroke recorded at x=380px is meaningless anywhere but the device that drew
 * it; a stroke at x=0.42 is the same mark everywhere. Height is expressed in
 * the same unit as width — the aspect ratio is fixed by the caller — so ink
 * cannot stretch when the column does.
 */
(function () {
  'use strict';

  /* One pen. Deliberately not a palette: this is for annotating your own
     notes, and a colour picker is the kind of thing that turns a study tool
     into an art app you then tidy instead of revise with. Pressure varies the
     width, which is the part that actually makes handwriting legible. */
  var BASE_WIDTH = 2.2;
  var PRESSURE_RANGE = 2.6;   // width = BASE + pressure * RANGE
  var ERASER_RADIUS = 0.02;   // in normalised units, ~2% of the width

  function Ink(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.current = null;
    this.mode = 'draw';
    this.onChange = (opts && opts.onChange) || function () {};
    this.ratio = (opts && opts.ratio) || 0.62;   // height / width

    /* pan-y, not none: a finger must still scroll the page. See the header. */
    canvas.style.touchAction = 'pan-y';

    var self = this;
    canvas.addEventListener('pointerdown', function (e) { self._down(e); });
    canvas.addEventListener('pointermove', function (e) { self._move(e); });
    canvas.addEventListener('pointerup', function (e) { self._up(e); });
    canvas.addEventListener('pointercancel', function (e) { self._up(e); });
    /* Leaving the canvas mid-stroke ends it. Without this, drawing off the
       edge and back on rejoins with a straight line across the page. */
    canvas.addEventListener('pointerleave', function (e) { self._up(e); });
  }

  Ink.prototype.setMode = function (mode) { this.mode = mode; };

  Ink.prototype.load = function (strokes) {
    this.strokes = Array.isArray(strokes) ? strokes.slice() : [];
    this.redraw();
  };

  Ink.prototype.toJSON = function () {
    return this.strokes.length ? this.strokes : null;
  };

  Ink.prototype.isEmpty = function () { return !this.strokes.length; };

  Ink.prototype.undo = function () {
    if (!this.strokes.length) return;
    this.strokes.pop();
    this.redraw();
    this.onChange();
  };

  Ink.prototype.clear = function () {
    if (!this.strokes.length) return;
    this.strokes = [];
    this.redraw();
    this.onChange();
  };

  /* Only pen and mouse draw. A touch is left entirely alone — not
     preventDefault'ed, not captured — so the page scrolls under it. */
  Ink.prototype._draws = function (e) {
    return e.pointerType === 'pen' || e.pointerType === 'mouse';
  };

  Ink.prototype._point = function (e) {
    var r = this.canvas.getBoundingClientRect();
    /* Normalised by WIDTH in both axes, so the shape of a letter is preserved
       when the column is a different width elsewhere. */
    return [
      (e.clientX - r.left) / r.width,
      (e.clientY - r.top) / r.width,
      /* Chrome reports 0.5 for a mouse and 0 for some pens on the first event;
         both would draw a hairline. Anything falsy becomes a normal press. */
      e.pressure > 0 ? e.pressure : 0.5
    ];
  };

  Ink.prototype._down = function (e) {
    if (!this._draws(e)) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);

    if (this.mode === 'erase') { this._erase(this._point(e)); return; }

    this.current = { p: [this._point(e)] };
    this.strokes.push(this.current);
  };

  Ink.prototype._move = function (e) {
    if (!this._draws(e)) return;
    if (this.mode === 'erase') {
      if (this.current === 'erasing') this._erase(this._point(e));
      return;
    }
    if (!this.current) return;
    e.preventDefault();

    var pt = this._point(e);
    var last = this.current.p[this.current.p.length - 1];
    /* Drop points closer than a hair apart. A stylus reports at 120Hz+ and
       most of those samples are noise that costs storage and draws worse. */
    if (Math.abs(pt[0] - last[0]) < 0.0015 && Math.abs(pt[1] - last[1]) < 0.0015) return;
    this.current.p.push(pt);
    this._drawSegment(last, pt);
  };

  Ink.prototype._up = function (e) {
    if (this.mode === 'erase') { this.current = null; return; }
    if (!this.current) return;
    /* A tap with no movement is a dot, and a dot is a legitimate mark — but a
       stroke of one point draws nothing, so give it a second point. */
    if (this.current.p.length === 1) this.current.p.push(this.current.p[0].slice());
    this.current = null;
    this.redraw();
    this.onChange();
  };

  /* Erases whole strokes, not pixels. Pixel erasing on vector strokes means
     splitting them, which is a lot of code for a worse result — and "the line
     I just drew is wrong" is the actual thing people erase. */
  Ink.prototype._erase = function (pt) {
    this.current = 'erasing';
    var before = this.strokes.length;
    this.strokes = this.strokes.filter(function (s) {
      return !s.p.some(function (p) {
        return Math.abs(p[0] - pt[0]) < ERASER_RADIUS
            && Math.abs(p[1] - pt[1]) < ERASER_RADIUS;
      });
    });
    if (this.strokes.length !== before) { this.redraw(); this.onChange(); }
  };

  /* Sized to the element's CSS width times devicePixelRatio, so ink is sharp
     on a retina screen instead of being drawn at half resolution and scaled
     up — the most common way a canvas ends up looking like a fax. */
  Ink.prototype.resize = function () {
    var r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    var dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.width * this.ratio * dpr);
    this.canvas.style.height = (r.width * this.ratio) + 'px';
    this.redraw();
  };

  Ink.prototype._px = function (p) {
    var dpr = window.devicePixelRatio || 1;
    var w = this.canvas.width / dpr;
    return [p[0] * w, p[1] * w];
  };

  Ink.prototype._drawSegment = function (a, b) {
    var dpr = window.devicePixelRatio || 1;
    var ctx = this.ctx;
    var pa = this._px(a), pb = this._px(b);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = this.colour();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = BASE_WIDTH + b[2] * PRESSURE_RANGE;
    ctx.beginPath();
    ctx.moveTo(pa[0], pa[1]);
    ctx.lineTo(pb[0], pb[1]);
    ctx.stroke();
    ctx.restore();
  };

  /* Reads the ink colour off the stylesheet rather than hardcoding it, so
     handwriting is the same colour as typing in both themes and follows any
     future repalette without this file being touched. */
  Ink.prototype.colour = function () {
    var c = getComputedStyle(this.canvas).getPropertyValue('--ink-stroke');
    return (c && c.trim()) || '#1A1815';
  };

  Ink.prototype.redraw = function () {
    var dpr = window.devicePixelRatio || 1;
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    var self = this;
    this.strokes.forEach(function (s) {
      for (var i = 1; i < s.p.length; i++) self._drawSegment(s.p[i - 1], s.p[i]);
    });
  };

  window.NexleyInk = Ink;
})();
