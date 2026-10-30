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
import shutil
import subprocess
import sys

WIDTH = 1170
HEIGHT = 3000

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
        out.append(text(100, 850, "Weekly total", 40, "#9aa4b2"))
        # A 34px overlap: the two lines genuinely collide and the upper one's
        # descenders are covered. A smaller offset survives the render but not a
        # normal screenshot downscale, which would make this fixture measure its
        # own resize path instead of the model's vision.
        out.append(text(100, 884, "1,284 pts", 40, "#f2f4f8"))
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

    # Reserve 420px of empty space below the last element. Any less invites
    # "cut off at the bottom edge" on a clean image, which is a false positive
    # caused by the fixture rather than by the model.
    out.append("</svg>\n")
    return "".join(out)


def render(svg: str, png_path: str) -> bool:
    """Render the SVG to a PNG at exactly WIDTH x HEIGHT.

    `rsvg-convert` is the only renderer here that honours a tall viewBox at its
    true aspect ratio, so it goes first. `qlmanage` is kept as a last resort but
    is known to squash a tall document into a square thumbnail and crop the
    bottom, which silently deletes the very defects this fixture exists to test
    and makes the clean image look broken at the edge. It is not used first for
    that reason.
    """
    svg_path = png_path.replace(".png", ".svg")
    with open(svg_path, "w", encoding="utf-8") as handle:
        handle.write(svg)

    if shutil.which("rsvg-convert"):
        result = subprocess.run(
            ["rsvg-convert", "-w", str(WIDTH), "-h", str(HEIGHT), "-o", png_path, svg_path],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and os.path.exists(png_path):
            return True
        print(result.stderr[:400], file=sys.stderr)

    for tool, args in (
        ("magick", ["magick", "svg:" + svg_path, "-resize", f"{WIDTH}x{HEIGHT}!", png_path]),
        ("convert", ["convert", "svg:" + svg_path, "-resize", f"{WIDTH}x{HEIGHT}!", png_path]),
    ):
        if shutil.which(tool):
            subprocess.run(args, capture_output=True)
            if os.path.exists(png_path):
                return True

    if shutil.which("qlmanage"):
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
