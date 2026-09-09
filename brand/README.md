# brand/

Printable and shareable assets that are not part of the app itself. Nothing in here is served
to a browser — `app/` is the site, this is the stuff that goes on paper or into a video.

## `nexley-qr.svg` / `nexley-qr.png`

The site URL as a QR code, in Nexley's own palette: ink `#1A1815` on sheet `#FFFDF7`. The SVG
has a transparent background so it can sit on whatever the sticker stock is; the PNG carries
the sheet colour for when it needs to be opaque.

**Regenerate it like this** (needs `pip install segno`, a pure-Python encoder with no
dependencies — it is a build-time tool and never ships to the app):

```python
import segno
URL = 'https://ajspeedy10.github.io/nexley/'      # ← update when the domain moves
q = segno.make(URL, error='q')
q.save('brand/nexley-qr.svg', scale=10, border=4, dark='#1A1815', light=None)
q.save('brand/nexley-qr.png', scale=20, border=4, dark='#1A1815', light='#FFFDF7')
```

**Then verify it, every time.** A QR that does not scan is worse than no sticker, and you
cannot tell by looking:

```python
import cv2
data, _, _ = cv2.QRCodeDetector().detectAndDecode(cv2.imread('brand/nexley-qr.png'))
assert data == URL, data
```

### Two decisions worth not re-making

**Error correction is `q` (25%), not `h` (30%).** `h` is genuinely better for something that
goes on a wall and gets scuffed, rained on and half-peeled — that was the first choice. But
`h` puts this URL at version 5, and OpenCV would not decode that here at any scale or
contrast, while `l`, `m` and `q` all decoded first try. The asset was downgraded because it
could not be *verified*, not because `q` is better. If a decoder that handles version 5
turns up, `h` is the right level for a sticker.

**🔴 Do not print these yet.** They encode `ajspeedy10.github.io/nexley/`, and the domain is
about to move to `nexley.app` (see the `nexley_go_private` open item). A printed sticker
outlives the URL printed on it — regenerate after the domain lands, then print. The plan the
stickers belong to is `GROWTH_AND_LAUNCH.md` §13.
