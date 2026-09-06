/* Nexley — handwriting and diagrams, with a pencil, on the note itself.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: A PENCIL DRAWS, A FINGER SCROLLS.
 * This is the single thing that separates a usable ink surface on an iPad from
 * an infuriating one. A canvas that draws on any touch means you cannot scroll
 * the page your hand is resting on, and you cannot rest your hand on it while
 * writing either. So:
 *
 *   pointerType 'pen'    -> draws, always, routed in by app.js even when the
 *                           canvas is a pointer-events:none overlay
 *   pointerType 'mouse'  -> draws only in the explicit Draw mode, because as
 *                           an overlay it otherwise sits between the reader
 *                           and their own text
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

  /* A pen and a highlighter, in four colours each. Deliberately NOT Apple's
     six nib types and a full colour wheel: this is for marking up your own
     notes, and an art-supplies drawer is how a study tool becomes something
     you tidy instead of revise with. Four is enough to mean something — one
     colour per subject, or ink for notes and red for corrections — and few
     enough that the choice is not a decision. Pressure varies pen width,
     which is the part that makes handwriting legible. */
  var BASE_WIDTH = 2.2;
  var PRESSURE_RANGE = 2.6;   // width = BASE + pressure * RANGE
  var ERASER_RADIUS = 0.02;   // in normalised units, ~2% of the width
  var HIGHLIGHT_WIDTH = 15;   // px, fixed: a chisel tip has one width

  function Ink(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.current = null;
    this.mode = 'draw';
    this.selection = [];   // indices into strokes, set by the lasso
    this.lasso = null;     // the loop being drawn right now
    this.drag = null;      // an in-progress move of the selection
    this.line = null;      // an in-progress straight line
    this.colourKey = 'ink';  // a TOKEN NAME, never a hex — see colourOf()
    this.highlight = false;  // is the pen a highlighter right now
    this.onChange = (opts && opts.onChange) || function () {};
    /* Selecting is not a change to the drawing, so it must not go through
       onChange — that marks the note dirty and would make circling something
       count as an edit. It still has to reach the UI, because the Delete
       button only exists while there is a selection. Hence a second callback. */
    this.onSelect = (opts && opts.onSelect) || function () {};
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

  /* Leaving the lasso drops the selection. A highlighted set of strokes with
     no tool that acts on it is just decoration, and worse, it looks live. */
  Ink.prototype.setMode = function (mode) {
    this.mode = mode;
    if (mode !== 'lasso' && this.selection.length) {
      this.selection = [];
      this.redraw();
      this.onSelect();
    }
  };

  /* Events routed in from outside. The canvas is pointer-events:none when it
     is an overlay — that is what lets a finger scroll and a mouse select
     through it — so it cannot hear its own pointer events and app.js hands
     them over instead. Same handlers either way, so there is one code path for
     "a pen wrote on the page" no matter which side caught the event. */
  Ink.prototype.handle = function (type, e) {
    if (type === 'pointerdown') this._down(e);
    else if (type === 'pointermove') this._move(e);
    else this._up(e);
  };

  /* Colours are stored as token NAMES and resolved through the stylesheet at
     draw time. Storing a hex would freeze a stroke at the colour of whichever
     theme it was drawn in — write a note in dark mode and every mark comes
     back as pale grey on white paper the next morning. */
  Ink.prototype.setColour = function (key) { this.colourKey = key || 'ink'; };
  Ink.prototype.setHighlight = function (on) { this.highlight = !!on; };

  Ink.prototype.colourOf = function (key) {
    var v = getComputedStyle(this.canvas).getPropertyValue('--ink-' + (key || 'ink'));
    return (v && v.trim()) || this.colour();
  };

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

  /* ---------- what a press means, by mode ----------
     draw   a stroke
     line   a straight stroke, previewed while you drag
     object rub out whole strokes
     pixel  rub out the parts of strokes you pass over, splitting them
     lasso  circle some strokes to select them, then drag to move them

     Apple offers all five. Their ruler is a draggable on-screen object you
     rotate with two fingers; the outcome anyone actually wants from it is a
     straight line, and a line tool gets there without a rotatable ruler
     sitting on the page waiting to be knocked. */

  Ink.prototype._down = function (e) {
    if (!this._draws(e)) return;
    e.preventDefault();
    /* Capture keeps a stroke going when the pointer leaves the element, but a
       pointer-events:none overlay cannot capture — the call throws, and an
       exception here would abandon the stroke before it starts. The routed
       path does not need it: it listens on the surface, which is bigger. */
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    var pt = this._point(e);

    if (this.mode === 'object') { this.current = 'erasing'; this._eraseObject(pt); return; }
    if (this.mode === 'pixel') { this.current = 'erasing'; this._erasePixels(pt); return; }

    if (this.mode === 'lasso') {
      /* Pressing INSIDE an existing selection drags it; pressing outside
         starts a new one. That is what every drawing tool does, and getting it
         wrong means you can never move the same thing twice. */
      if (this.selection.length && this._inSelection(pt)) {
        this.drag = { from: pt, moved: false };
      } else {
        this.selection = [];
        this.lasso = [pt];
      }
      this.redraw();
      return;
    }

    if (this.mode === 'line') { this.line = { a: pt, b: pt }; this.redraw(); return; }

    /* A stroke carries its own colour and tool. Both are omitted when they are
       the default, so a page of ordinary handwriting stores exactly what it
       stored before this existed and old notes keep working untouched. */
    this.current = { p: [pt] };
    if (this.colourKey !== 'ink') this.current.c = this.colourKey;
    if (this.highlight) this.current.h = 1;
    this.strokes.push(this.current);
  };

  Ink.prototype._move = function (e) {
    if (!this._draws(e)) return;
    var pt;

    if (this.mode === 'object' || this.mode === 'pixel') {
      if (this.current !== 'erasing') return;
      pt = this._point(e);
      if (this.mode === 'object') this._eraseObject(pt); else this._erasePixels(pt);
      return;
    }

    if (this.mode === 'lasso') {
      pt = this._point(e);
      if (this.drag) {
        var dx = pt[0] - this.drag.from[0], dy = pt[1] - this.drag.from[1];
        this._translateSelection(dx, dy);
        this.drag.from = pt;
        this.drag.moved = true;
        this.redraw();
      } else if (this.lasso) {
        this.lasso.push(pt);
        this.redraw();
      }
      return;
    }

    if (this.mode === 'line') {
      if (!this.line) return;
      e.preventDefault();
      this.line.b = this._point(e);
      this.redraw();
      return;
    }

    if (!this.current) return;
    e.preventDefault();
    pt = this._point(e);
    var last = this.current.p[this.current.p.length - 1];
    /* Drop points closer than a hair apart. A stylus reports at 120Hz+ and
       most of those samples are noise that costs storage and draws worse. */
    if (Math.abs(pt[0] - last[0]) < 0.0015 && Math.abs(pt[1] - last[1]) < 0.0015) return;
    this.current.p.push(pt);
    /* Passing the stroke means an in-progress highlight is drawn as a
       highlight rather than as a thin pen line that changes on release. */
    this._drawSegment(last, pt, false, this.current);
  };

  Ink.prototype._up = function (e) {
    if (this.mode === 'object' || this.mode === 'pixel') { this.current = null; return; }

    if (this.mode === 'lasso') {
      if (this.drag) {
        var moved = this.drag.moved;
        this.drag = null;
        if (moved) this.onChange();
      } else if (this.lasso) {
        this.selection = this.lasso.length > 3 ? this._strokesInside(this.lasso) : [];
        this.lasso = null;
        this.onSelect();
      }
      this.redraw();
      return;
    }

    if (this.mode === 'line') {
      if (!this.line) return;
      var a = this.line.a, b = this.line.b;
      this.line = null;
      /* A tap with no drag is not a line, it is a slip. Dropping it is right:
         committing a zero-length line leaves an invisible stroke that undo
         then appears to do nothing to. */
      if (Math.abs(b[0] - a[0]) > 0.004 || Math.abs(b[1] - a[1]) > 0.004) {
        var st = { p: [a, b] };
        if (this.colourKey !== 'ink') st.c = this.colourKey;
        if (this.highlight) st.h = 1;
        this.strokes.push(st);
        this.onChange();
      }
      this.redraw();
      return;
    }

    if (!this.current) return;
    /* A tap with no movement is a dot, and a dot is a legitimate mark — but a
       stroke of one point draws nothing, so give it a second point. */
    if (this.current.p.length === 1) this.current.p.push(this.current.p[0].slice());
    this.current = null;
    this.redraw();
    this.onChange();
  };

  /* ---------- erasers ---------- */

  /* Whole strokes. "The line I just drew is wrong" is the common case, and one
     press removing one mark is the least surprising thing that can happen. */
  /* Distance from the eraser to the SEGMENT, not to the sample points.
     Testing points alone looks fine with a stylus, which reports every couple
     of pixels — and fails completely on a straight line from the Line tool,
     which has exactly two points and a long empty gap between them that the
     eraser would pass straight through. You would be unable to rub out a line
     you could plainly see. */
  function distToSegment(p, a, b) {
    var vx = b[0] - a[0], vy = b[1] - a[1];
    var wx = p[0] - a[0], wy = p[1] - a[1];
    var len2 = vx * vx + vy * vy;
    var t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
    var dx = a[0] + t * vx - p[0], dy = a[1] + t * vy - p[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  function strokeHit(stroke, pt, r) {
    if (stroke.p.length === 1) {
      return distToSegment(pt, stroke.p[0], stroke.p[0]) < r;
    }
    for (var i = 1; i < stroke.p.length; i++) {
      if (distToSegment(pt, stroke.p[i - 1], stroke.p[i]) < r) return true;
    }
    return false;
  }

  Ink.prototype._eraseObject = function (pt) {
    var before = this.strokes.length;
    this.strokes = this.strokes.filter(function (s) {
      return !strokeHit(s, pt, ERASER_RADIUS);
    });
    if (this.strokes.length !== before) { this.redraw(); this.onChange(); }
  };

  /* Parts of strokes, which means SPLITTING them: a stroke with its middle
     rubbed out becomes two strokes, not one with a gap. Doing it any other way
     — a mask, a list of holes — would mean the stored shape no longer
     describes what is on the page, and everything else here reads that shape. */
  /* Add points along any segment longer than the eraser, so there is something
     to keep on either side of the hole. A straight line from the Line tool is
     two points a whole page apart: without this, rubbing out its middle finds
     no surviving run on either side and deletes the entire line — which is the
     object eraser's job, not this one's. Only ever done to a stroke that is
     actually being erased, so ordinary handwriting keeps the point count it
     was drawn with. */
  function densify(points, step) {
    var out = [points[0]];
    for (var i = 1; i < points.length; i++) {
      var a = points[i - 1], b = points[i];
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var dist = Math.sqrt(dx * dx + dy * dy);
      var n = Math.floor(dist / step);
      for (var k = 1; k < n; k++) {
        var t = k / n;
        out.push([a[0] + dx * t, a[1] + dy * t, b[2]]);
      }
      out.push(b);
    }
    return out;
  }

  Ink.prototype._erasePixels = function (pt) {
    var r = ERASER_RADIUS * 0.6;      // finer than the object eraser, on purpose
    var out = [], changed = false;
    this.strokes.forEach(function (s) {
      if (!strokeHit(s, pt, r)) { out.push(s); return; }
      changed = true;
      var pts = densify(s.p, r * 0.8);
      var run = [];
      pts.forEach(function (p) {
        if (distToSegment(pt, p, p) < r) {
          if (run.length > 1) out.push({ p: run });
          run = [];
        } else {
          run.push(p);
        }
      });
      if (run.length > 1) out.push({ p: run });
    });
    if (changed) { this.strokes = out; this.redraw(); this.onChange(); }
  };

  /* ---------- lasso ---------- */

  /* Ray casting. A stroke counts as selected when its MIDPOINT is inside the
     loop rather than any point of it: circling the end of a long line and
     dragging would otherwise take the whole line with you, which reads as a
     bug even though "any point" is a defensible rule. */
  Ink.prototype._pointInPath = function (pt, path) {
    var inside = false;
    for (var i = 0, j = path.length - 1; i < path.length; j = i++) {
      var xi = path[i][0], yi = path[i][1], xj = path[j][0], yj = path[j][1];
      if (((yi > pt[1]) !== (yj > pt[1])) &&
          (pt[0] < (xj - xi) * (pt[1] - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
    }
    return inside;
  };

  Ink.prototype._strokesInside = function (path) {
    var self = this, out = [];
    this.strokes.forEach(function (s, i) {
      var mid = s.p[Math.floor(s.p.length / 2)];
      if (self._pointInPath(mid, path)) out.push(i);
    });
    return out;
  };

  Ink.prototype._inSelection = function (pt) {
    var self = this, hit = false;
    this.selection.forEach(function (i) {
      var s = self.strokes[i];
      if (!s) return;
      if (s.p.some(function (p) {
        return Math.abs(p[0] - pt[0]) < 0.03 && Math.abs(p[1] - pt[1]) < 0.03;
      })) hit = true;
    });
    return hit;
  };

  Ink.prototype._translateSelection = function (dx, dy) {
    var self = this;
    this.selection.forEach(function (i) {
      var s = self.strokes[i];
      if (!s) return;
      s.p = s.p.map(function (p) { return [p[0] + dx, p[1] + dy, p[2]]; });
    });
  };

  Ink.prototype.hasSelection = function () { return this.selection.length > 0; };

  Ink.prototype.clearSelection = function () {
    if (!this.selection.length) return;
    this.selection = [];
    this.redraw();
    this.onSelect();
  };

  /* Deleting what you circled is the other half of the lasso: selecting
     something is only worth doing if you can do more than move it. */
  Ink.prototype.deleteSelection = function () {
    if (!this.selection.length) return;
    var sel = this.selection;
    this.strokes = this.strokes.filter(function (s, i) { return sel.indexOf(i) === -1; });
    this.selection = [];
    this.redraw();
    this.onChange();
    this.onSelect();
  };

  /* Sized to the element's CSS width times devicePixelRatio, so ink is sharp
     on a retina screen instead of being drawn at half resolution and scaled
     up — the most common way a canvas ends up looking like a fax. */
  /* Takes explicit dimensions because as an overlay the canvas is sized to the
     TEXT it covers, which can be far taller than the visible box — ink drawn
     at the bottom of a long note would otherwise land outside the bitmap.
     Backed by devicePixelRatio so strokes are sharp on a retina screen rather
     than drawn at half resolution and scaled up, which is the most common way
     a canvas ends up looking like a fax. */
  Ink.prototype.resize = function (cssWidth, cssHeight) {
    var w = cssWidth || this.canvas.getBoundingClientRect().width;
    if (!w) return;
    var h = cssHeight || w * this.ratio;
    var dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.cssWidth = w;
    this.redraw();
  };

  /* Measured from the canvas's OWN rect, which is exactly what _point()
     normalised against. Using anything else — the width the caller passed in,
     the bitmap width over dpr — puts recording and playback on two different
     scales, and the error grows with distance down the page: the first version
     of the overlay clipped the top of every stroke because of precisely this.
     One source of truth, even at the cost of a layout read per segment. */
  Ink.prototype._px = function (p) {
    var w = this.canvas.getBoundingClientRect().width;
    return [p[0] * w, p[1] * w];
  };

  Ink.prototype._drawSegment = function (a, b, selected, stroke) {
    var dpr = window.devicePixelRatio || 1;
    var ctx = this.ctx;
    var pa = this._px(a), pb = this._px(b);
    var hi = stroke ? !!stroke.h : this.highlight;
    var key = stroke ? (stroke.c || 'ink') : this.colourKey;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.strokeStyle = selected ? this.accent() : this.colourOf(hi ? 'hi-' + key : key);
    ctx.lineCap = hi ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    if (hi) {
      /* Fixed width and no pressure: a highlighter has a chisel tip and does
         not get thinner when you press lightly. multiply so overlapping passes
         darken like real ink rather than stacking to opaque and hiding the
         words underneath — which is the one thing a highlighter must not do. */
      ctx.globalAlpha = 0.38;
      ctx.globalCompositeOperation = 'multiply';
      ctx.lineWidth = HIGHLIGHT_WIDTH;
    } else {
      ctx.lineWidth = BASE_WIDTH + b[2] * PRESSURE_RANGE;
    }
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
    var ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    var self = this;
    /* Highlighter first, pen second, always. A highlight drawn after the
       writing would wash over it; drawn before, it sits behind the words the
       way a real one does — under the ink, over the paper. Two passes is the
       whole trick. */
    [true, false].forEach(function (hiPass) {
      self.strokes.forEach(function (s, i) {
        if (!!s.h !== hiPass) return;
        var on = self.selection.indexOf(i) > -1;
        for (var k = 1; k < s.p.length; k++) self._drawSegment(s.p[k - 1], s.p[k], on, s);
      });
    });
    if (this.lasso) this._drawGuide(this.lasso, true);
    if (this.line) this._drawGuide([this.line.a, this.line.b], false);
  };

  /* The lasso loop and the line preview are not ink and must not look like it:
     dashed, thin, and in the accent rather than the writing colour, so there
     is never a moment where you cannot tell what will still be there when you
     let go. */
  Ink.prototype._drawGuide = function (path, close) {
    var dpr = window.devicePixelRatio || 1;
    var ctx = this.ctx, self = this;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.accent();
    ctx.beginPath();
    path.forEach(function (p, i) {
      var q = self._px(p);
      if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
    });
    if (close) ctx.closePath();
    ctx.stroke();
    ctx.restore();
  };

  Ink.prototype.accent = function () {
    var c = getComputedStyle(this.canvas).getPropertyValue('--ink-accent');
    return (c && c.trim()) || '#21493B';
  };

  window.NexleyInk = Ink;
})();
