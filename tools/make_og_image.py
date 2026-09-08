"""Generate Nexley's Open Graph share image.

WHY THIS IS A SCRIPT AND NOT JUST A PNG. A binary dropped in app/ with no
provenance is a thing nobody can change later without redoing it from scratch,
and it silently goes stale when the palette or the tagline moves. This is
checked in so the image can be regenerated, and so the next person can see
exactly which colours and which words it was built from.

    python tools/make_og_image.py

Writes app/og.png at 1200x630 - the size every platform crops from, and the
reason the app icon was the wrong thing to use: a 512x512 square gets letterboxed
or centre-cropped into a wide card, so the link preview was a small logo floating
in grey rather than anything that says what Nexley is.

The face is the REAL Newsreader shipped in app/fonts, decompressed from woff2 on
the fly rather than substituting a lookalike, so the card matches the site.
"""
import io
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")

W, H = 1200, 630

# Straight from app.css :root - if the palette moves, move these with it.
PAPER = "#EFEBE1"
CARD = "#FFFDF7"
INK = "#1A1815"
MUTED = "#7E7669"
RULE = "#D5CEC0"
STRUCTURE = "#21493B"   # eucalypt
MARK = "#E7E24C"        # the one accent


def newsreader(size, weight="regular"):
    """The real display face, out of the woff2 the site actually serves."""
    from fontTools.ttLib import TTFont

    path = os.path.join(APP, "fonts", "newsreader-latin.woff2")
    f = TTFont(path)
    buf = io.BytesIO()
    f.flags = getattr(f, "flags", None)
    f.save(buf)
    buf.seek(0)
    return ImageFont.truetype(buf, size)


def ui(size, bold=False):
    """Segoe UI for the mono/UI bits, matching --ui's first real entry."""
    for name in (("segoeuib.ttf", "segoeui.ttf") if bold else ("segoeui.ttf",)):
        p = os.path.join("C:\\Windows\\Fonts", name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def mono(size):
    for name in ("consola.ttf", "cour.ttf"):
        p = os.path.join("C:\\Windows\\Fonts", name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def main():
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)

    # The card, inset - the same "sheet on a desk" the app itself is built on.
    pad = 46
    d.rounded_rectangle([pad, pad, W - pad, H - pad], radius=18, fill=CARD,
                        outline=RULE, width=1)

    left = pad + 62
    # ---- the glyph: three concentric rings, same as the app's inline SVG ----
    cx, cy = left + 26, pad + 78
    for r, w in ((26, 3), (16, 3), (7, 3)):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=STRUCTURE, width=w)

    d.text((cx + 48, cy - 22), "Nexley", font=newsreader(42), fill=INK)

    # ---- the line that has to do the work in a feed ----
    try:
        title = newsreader(66)
    except Exception as e:                                    # noqa: BLE001
        print("could not load Newsreader (%s) - falling back to Georgia" % e)
        title = ImageFont.truetype("C:\\Windows\\Fonts\\georgia.ttf", 66)

    d.text((left, pad + 156), "Your notes belong", font=title, fill=INK)
    d.text((left, pad + 232), "to the syllabus.", font=title, fill=INK)

    sub = ui(27)
    d.text((left, pad + 330),
           "Every note files against the dot point it answers,",
           font=sub, fill=MUTED)
    d.text((left, pad + 368),
           "so a year of work stays findable.",
           font=sub, fill=MUTED)

    # ---- the syllabus rows: the actual product idea, shown not described ----
    rows = [("HM-11-04", "Skeletal and muscular systems", True),
            ("HM-11-05", "Energy systems", True),
            ("HM-11-06", "Biomechanics", False)]
    ry = pad + 156
    # Width is set by the LONGEST row name, measured rather than guessed: at 396
    # the first row ran under its own pip, which is the one detail that would
    # make this look thrown together in a feed.
    code_f, name_f = mono(17), ui(19)
    name_w = max(d.textlength(n, font=name_f) for _, n, _ in rows)
    panel_w = 108 + int(name_w) + 58          # code column + name + room for the pip
    rx = W - pad - 62 - panel_w
    d.rounded_rectangle([rx - 22, ry - 20, W - pad - 62, ry + 150],
                        radius=10, fill=PAPER)
    for code, name, done in rows:
        d.text((rx, ry + 6), code, font=code_f, fill=MUTED)
        d.text((rx + 108, ry + 4), name, font=name_f, fill=INK)
        # the pip: filled in the accent when written up, hollow when not - the
        # gap being visible is the entire point of the product
        px, py = W - pad - 62 - 26, ry + 15
        if done:
            d.ellipse([px - 6, py - 6, px + 6, py + 6], fill=MARK)
        else:
            d.ellipse([px - 6, py - 6, px + 6, py + 6], outline=RULE, width=2)
        ry += 48

    # ---- footer ----
    foot = ui(21)
    d.text((left, H - pad - 62), "Free  ·  works offline  ·  no app store",
           font=foot, fill=MUTED)

    out = os.path.join(APP, "og.png")
    img.save(out, "PNG", optimize=True)
    print("wrote %s  (%dx%d, %.0f KB)"
          % (out, img.width, img.height, os.path.getsize(out) / 1024))


if __name__ == "__main__":
    sys.exit(main())
