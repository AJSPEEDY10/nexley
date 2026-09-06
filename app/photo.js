/* Nexley — a photograph of a page, turned into something you can write on.
 *
 * THE PROBLEM THIS SOLVES IS NOT "INSERT AN IMAGE". Anybody can drop a photo
 * into a note. A photo of a whiteboard or a textbook page taken in a classroom
 * is grey, unevenly lit, yellow on one side and shadowed on the other, and
 * putting that in a notebook gives you a murky rectangle you cannot read and
 * certainly cannot annotate. What makes it useful is the clean-up: the page
 * comes out white, the writing comes out black, and the shadow your own head
 * cast across it goes away.
 *
 * HOW THE CLEAN-UP WORKS, in one line: divide the image by a heavily blurred
 * copy of itself. That blurred copy IS the lighting — every slow change across
 * the frame, none of the fast ones, because letters are small and shadows are
 * large. Dividing by it cancels the lighting and leaves the marks. It is the
 * standard trick for exactly this and it is about twenty lines, which is why
 * it is here instead of a library.
 *
 * WHY THE RESULT GOES IN THE NOTE BODY AS A DATA URI, and what that costs.
 * The alternative is a storage bucket: another service, another set of
 * permissions, another thing that can be offline when the notebook is not.
 * A data URI rides every path Nexley already has — it syncs, exports, imports,
 * restores from a snapshot and draws under the ink overlay, all with no new
 * code and no migration. The cost is size, so the pipeline is aggressive about
 * it: greyscale, capped at MAX_EDGE, and JPEG rather than PNG, which for a
 * photograph is several times smaller for no visible loss. A page comes out
 * around 120-250KB. There is a hard ceiling, and hitting it is an error the
 * student can act on rather than a note that silently fails to sync.
 *
 * NO PERSPECTIVE CORRECTION. Straightening a photo taken at an angle needs the
 * four corners of the page, and finding them reliably in a classroom photo is
 * a genuinely hard problem that fails quietly and often. Rotating in quarter
 * turns covers the case that actually happens — the phone was sideways — and
 * a mildly skewed but legible page is worth far more than an occasionally
 * mangled one.
 */
(function () {
  'use strict';

  var MAX_EDGE = 1500;        // px on the long edge
  var JPEG_Q = 0.72;
  var MAX_BYTES = 900 * 1024; // of data URI, after everything

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('Could not read that file.')); };
      fr.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('That does not look like an image.')); };
      img.src = src;
    });
  }

  /* Quarter turns only — see the header. Returns a canvas, not a data URI, so
     the caller can rotate and clean up without a re-encode in between. */
  function draw(img, turns) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    var dw = Math.round(w * scale), dh = Math.round(h * scale);
    var swap = turns % 2 === 1;

    var c = document.createElement('canvas');
    c.width = swap ? dh : dw;
    c.height = swap ? dw : dh;
    var ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(turns * Math.PI / 2);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    return c;
  }

  /* A box blur run twice approximates a Gaussian closely enough for this, and
     separating it into a horizontal then a vertical pass makes the cost
     independent of how wide the blur is — which matters, because the blur has
     to be wide enough to erase the writing and keep only the lighting. */
  function blurGrey(grey, w, h, r) {
    var tmp = new Float32Array(grey.length);
    var out = new Float32Array(grey.length);
    var x, y, i, sum, n;
    for (y = 0; y < h; y++) {
      sum = 0; n = 0;
      for (x = -r; x <= r; x++) { if (x >= 0 && x < w) { sum += grey[y * w + x]; n++; } }
      for (x = 0; x < w; x++) {
        tmp[y * w + x] = sum / n;
        var add = x + r + 1, sub = x - r;
        if (add < w) { sum += grey[y * w + add]; n++; }
        if (sub >= 0) { sum -= grey[y * w + sub]; n--; }
      }
    }
    for (x = 0; x < w; x++) {
      sum = 0; n = 0;
      for (y = -r; y <= r; y++) { if (y >= 0 && y < h) { sum += tmp[y * w + x]; n++; } }
      for (y = 0; y < h; y++) {
        out[y * w + x] = sum / n;
        var addY = y + r + 1, subY = y - r;
        if (addY < h) { sum += tmp[addY * w + x]; n++; }
        if (subY >= 0) { sum -= tmp[subY * w + x]; n--; }
      }
    }
    return out;
  }

  /* Greyscale, divide out the lighting, then stretch what is left. The
     stretch is deliberately gentle rather than a hard threshold: a threshold
     turns faint pencil into nothing at all, and faint pencil is exactly what a
     photographed page of someone's working is made of. */
  function clean(canvas) {
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d');
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var grey = new Float32Array(w * h);
    var i, p;

    for (i = 0, p = 0; i < d.length; i += 4, p++) {
      grey[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }

    /* Wide enough to blur away letters, in proportion to the image so it
       behaves the same on a phone photo and a tablet one. */
    var r = Math.max(6, Math.round(Math.max(w, h) / 40));
    var bg = blurGrey(grey, w, h, r);

    for (i = 0, p = 0; i < d.length; i += 4, p++) {
      var base = bg[p] < 1 ? 1 : bg[p];
      var v = (grey[p] / base) * 255;      // 255 = same as its surroundings
      v = (v - 150) * (255 / (250 - 150)); // stretch the useful band
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* Returns { url, bytes, width, height }. `cleanUp` false gives the plain
     downscaled photo, for the cases where the colour was the point — a
     diagram, a marked paper with red pen on it. */
  function process(file, opts) {
    var o = opts || {};
    return readFile(file).then(loadImage).then(function (img) {
      var c = draw(img, o.turns || 0);
      if (o.cleanUp) clean(c);
      var url = c.toDataURL('image/jpeg', JPEG_Q);
      if (url.length > MAX_BYTES) {
        throw new Error('That photo is too big even after shrinking. Try one page at a time.');
      }
      /* `cleaned` travels with the result so the caller can mark the image as
         a scan — which is what lets it be inverted in dark mode. A colour
         photo must never be. */
      return { url: url, bytes: url.length, width: c.width, height: c.height,
               cleaned: !!o.cleanUp };
    });
  }

  window.NexleyPhoto = { process: process, MAX_BYTES: MAX_BYTES };
})();
