#!/usr/bin/env python3
"""
Build a controlled screenshot fixture with defects that are known exactly.

Vision quality cannot be judged against a real screenshot, because there is no
ground truth: a model that says "the modal overlaps" on a screen with a modal
overlay might be correct or might be describing intended UI. This fixture has
deliberately planted, unambiguous faults, so a model's answer can be scored.

The image is generated from SVG through `qlmanage` or falls back to a raw
PPM, so it needs no third-party imaging package.

Planted faults:
  1. A text row clipped by the right edge, so the last word is cut mid-glyph.
  2. Two labels overlapping each other so the upper one's descenders collide.
  3. A button whose label is truncated with an ellipsis while space remains.
  4. Uneven vertical rhythm: the gap before the final card is visibly larger.

Clean counterpart: the same layout with all four problems removed, so a model
that reports defects on the clean image is inventing them.
"""

import os
import subprocess
import sys

WIDTH = 1170
HEIGHT = 2700

HEADER = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
  <rect width="{w}" height="{h}" fill="#0f1115"/>
"""


def text(x, y, value, size=44, fill="#f2f4f8", weight="500", anchor="start"):
    return (
        f'  <text x="{x}" y="{y}" font-family="Helvetica" font-size="{size}" '
        f'font-weight="{weight}" fill="{fill}" text-anchor="{anchor}">{value}</text>\n'
    )


def rect(x, y, w, h, fill="#1b1f27", rx=18):
    return f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"/>\n'


def build(broken: bool) -> str:
    out = [HEADER.format(w=WIDTH, h=HEIGHT)]

    # Card 1: a heading and a body line.
    out.append(rect(60, 120, WIDTH - 120, 320))
    out.append(text(100, 200, "NEXT DAILY DROP", 40, weight="700"))
    out.append(text(100, 270, "Opens in 04:12:37", 34, "#9aa4b2"))
    out.append(text(100, 340, "Tap to preview the reward", 30, "#6b7482"))

    # Fault 1: a row whose text runs past the right edge and is clipped.
    # The clip is real: the container ends at WIDTH-60 and the viewBox cuts it.
    out.append(rect(60, 500, WIDTH - 120, 200))
    out.append(text(100, 570, "Your streak", 36, weight="600"))
    if broken:
        # A clipPath that ends inside the card, so the sentence is genuinely cut
        # mid-word by its container rather than by the image boundary. This is
        # the common React Native overflow bug: one line, no numberOfLines, and
        # a parent with overflow hidden.
        out.append(f'  <clipPath id="cardclip"><rect x="60" y="500" width="{WIDTH - 120}" height="200"/></clipPath>\n')
        out.append('  <g clip-path="url(#cardclip)">\n')
        out.append(text(100, 650, "You have earned 1,284 points this week already and much more", 46, "#9aa4b2"))
        out.append("  </g>\n")
    else:
        out.append(text(100, 650, "1,284 points this week", 34, "#9aa4b2"))

    # Fault 2: two labels drawn on top of each other.
    out.append(rect(60, 760, WIDTH - 120, 260))
    if broken:
        out.append(text(100, 850, "Weekly total", 34, "#9aa4b2"))
        # Same baseline area, offset by only 14px, so the two lines collide.
        out.append(text(100, 864, "1,284 pts", 34, "#f2f4f8"))
    else:
        out.append(text(100, 850, "Weekly total", 34, "#9aa4b2"))
        out.append(text(100, 910, "1,284 pts", 40, "#f2f4f8", weight="700"))

    # Fault 3: a button label truncated while there is room for it.
    out.append(rect(60, 1080, WIDTH - 120, 140, "#2563eb"))  # button
    # Deliberate margin below the button so the canvas edge is never mistaken
    # for a layout defect on the clean fixture.
    if broken:
        out.append(text(WIDTH // 2, 1170, "Continu…", 40, "#ffffff", "700", "middle"))
    else:
        out.append(text(WIDTH // 2, 1170, "Continue", 40, "#ffffff", "700", "middle"))

    # Fault 4: uneven vertical rhythm. The third card sits far lower than the
    # gap between the first two suggests it should.
    first_gap = 220
    out.append(rect(60, 1320, WIDTH - 120, 220))
    out.append(text(100, 1400, "Card A", 36, weight="600"))
    second_y = 1320 + 220 + first_gap
    out.append(rect(60, second_y, WIDTH - 120, 220))
    out.append(text(100, second_y + 80, "Card B", 36, weight="600"))
    third_y = second_y + 220 + (first_gap + 200 if broken else first_gap)
    out.append(rect(60, third_y, WIDTH - 120, 220))
    out.append(text(100, third_y + 80, "Card C", 36, weight="600"))

    # Reserve 260px of empty space below the last element, so nothing touches
    # the image boundary on the clean fixture.
    out.append("</svg>\n")
    return "".join(out)


def render(svg: str, png_path: str) -> bool:
    svg_path = png_path.replace(".png", ".svg")
    with open(svg_path, "w", encoding="utf-8") as handle:
        handle.write(svg)
    # qlmanage ships with macOS and renders SVG without extra tooling.
    # qlmanage always renders a square thumbnail, which crops a tall layout and
    # would silently remove the very faults this fixture exists to test. Render
    # large and then resize to the true aspect ratio with sips.
    result = subprocess.run(
        ["qlmanage", "-t", "-s", str(HEIGHT), "-o", os.path.dirname(png_path), svg_path],
        capture_output=True,
        text=True,
    )
    produced = os.path.join(os.path.dirname(png_path), os.path.basename(svg_path) + ".png")
    if os.path.exists(produced):
        os.replace(produced, png_path)
        subprocess.run(["sips", "-z", str(HEIGHT), str(WIDTH), png_path], capture_output=True)
        return True
    # Fall back to rsvg-convert if present.
    for tool in ("rsvg-convert", "magick", "convert"):
        if subprocess.run(["which", tool], capture_output=True).returncode == 0:
            out = [tool, svg_path, "-o", png_path] if tool != "rsvg-convert" else [tool, "-o", png_path, svg_path]
            if tool == "rsvg-convert":
                out = [tool, svg_path, "-o", png_path]
            subprocess.run(out, capture_output=True)
            if os.path.exists(png_path):
                return True
    print(result.stderr[:400], file=sys.stderr)
    return False


def main():
    outdir = os.environ.get("FIXTURE_DIR", "/tmp/offline-fixtures")
    os.makedirs(outdir, exist_ok=True)
    ok = True
    for name, broken in (("broken", True), ("clean", False)):
        png = os.path.join(outdir, f"layout-{name}.png")
        if render(build(broken), png):
            print(f"wrote {png} ({os.path.getsize(png):,} bytes)")
        else:
            print(f"FAILED to render {png}", file=sys.stderr)
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
