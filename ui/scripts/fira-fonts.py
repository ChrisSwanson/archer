# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools", "brotli", "freetype-py"]
# ///
"""Build Archer's bundled Fira Sans from Google Fonts' static TTFs.

    uv run ui/scripts/fira-fonts.py <dir>

<dir> holds FiraSans-Regular.ttf, -Medium.ttf, -SemiBold.ttf, -Bold.ttf, -Italic.ttf and OFL.txt from
https://github.com/google/fonts/tree/main/ofl/firasans. Writes, from the repository root:

- ui/src/theme/fonts/fira-sans-latin-{400,500,600,700,400-italic}.woff2: the latin subset (the range
  `theme/current-font.css` declares), with its hinting and every layout feature kept;
- ui/src/theme/fonts/FiraSans-OFL.txt: the licence, unchanged;
- ui/src/layout/fira-metrics.ts: the advance of every character in the subset in each face the
  canvas draws in (400, 600, 700 and 400 italic; 500 is chrome only), which the layout measures
  text with (`layout/text-measure.ts`), and the same advances hinted at each size the canvas sets.

Hinted, because Chromium on Linux (CI, and most servers) draws without subpixel positioning: each
glyph advances by its hinted width at that size, a whole pixel that is not always the nearest one
(a 15px `a` in Regular is 8.2px exactly and 9px drawn). FreeType's own hinting of the subset is what
Chromium does there (it matched 97% of 10,516 single-glyph widths measured in the CI image; the rest
were kerned repeats and the invisible soft hyphen). Unhinted, FreeType's autohinter moved advances
by up to a pixel either way, so the hinting stays in.

The SemiBold TTF names itself family "Fira Sans SemiBold" with no typographic family, so a renderer
that matches by name (resvg, for PNG export) cannot find weight 600 of "Fira Sans" and draws Bold.
The subset gains the typographic family and subfamily (name IDs 16 and 17) the other faces imply.
Fira Sans has no Reserved Font Name, so the OFL allows the modified subset to keep its name.
"""

import io
import json
import math
import shutil
import sys
from pathlib import Path

import freetype
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
FONTS = ROOT / "ui/src/theme/fonts"
METRICS = ROOT / "ui/src/layout/fira-metrics.ts"

# The latin subset Google Fonts serves, and the four arrows. `current-font.css` declares the same range.
UNICODES = (
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,"
    "U+2000-206F,U+20AC,U+2122,U+2190-2193,U+2212,U+2215,U+FEFF,U+FFFD"
)

# Every size the canvas sets text at, in px (the layout's *_FONT constants), and the half sizes between.
HINTED_SIZES = [10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 16]

# (source, output stem, metrics key or None, typographic subfamily)
FACES = [
    ("FiraSans-Regular.ttf", "fira-sans-latin-400", "regular", "Regular"),
    ("FiraSans-Medium.ttf", "fira-sans-latin-500", None, "Medium"),
    ("FiraSans-SemiBold.ttf", "fira-sans-latin-600", "semibold", "SemiBold"),
    ("FiraSans-Bold.ttf", "fira-sans-latin-700", "bold", "Bold"),
    ("FiraSans-Italic.ttf", "fira-sans-latin-400-italic", "italic", "Italic"),
]


def subset_face(source: Path, out: Path, subfamily: str) -> TTFont:
    options = subset.Options()
    options.layout_features = ["*"]
    options.flavor = "woff2"  # pyright: ignore[reportAttributeAccessIssue]  # Options takes any option name
    font = subset.load_font(str(source), options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
    subsetter.subset(font)
    name = font["name"]
    for platform, encoding, language in {(r.platformID, r.platEncID, r.langID) for r in name.names if r.nameID == 1}:
        name.setName("Fira Sans", 16, platform, encoding, language)
        name.setName(subfamily, 17, platform, encoding, language)
    subset.save_font(font, str(out), options)
    return font


def advances(font: TTFont) -> dict[int, int]:
    cmap = font.getBestCmap()
    assert cmap is not None, f"{font} has no Unicode cmap"
    hmtx = font["hmtx"]
    return {cp: hmtx[glyph][0] for cp, glyph in cmap.items()}


def js_round(x: float) -> int:
    """`Math.round`: halves up, as the estimator rounds."""
    return math.floor(x + 0.5)


def hinted_offsets(font: TTFont, table: dict[int, int], chars: list[int], upm: int) -> dict[float, str]:
    """Per size, each character's hinted advance less its rounded exact one, as a digit (4 is none)."""
    ttf = io.BytesIO()
    plain = TTFont(io.BytesIO(font_bytes(font)))
    plain.flavor = None
    plain.save(ttf)
    face = freetype.Face(io.BytesIO(ttf.getvalue()))
    rows = {}
    for px in HINTED_SIZES:
        face.set_char_size(round(px * 64), 0, 72, 72)
        digits = []
        for cp in chars:
            face.load_char(chr(cp), freetype.FT_LOAD_DEFAULT)  # pyright: ignore[reportAttributeAccessIssue]  # set by freetype-py at import
            offset = round(face.glyph.advance.x / 64) - js_round(table[cp] / upm * px)
            assert -4 <= offset <= 5, (chr(cp), px, offset)
            digits.append(str(offset + 4))
        rows[px] = "".join(digits)
    return rows


def font_bytes(font: TTFont) -> bytes:
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def main(source_dir: str) -> None:
    src = Path(source_dir)
    tables: dict[str, dict[int, int]] = {}
    built: dict[str, TTFont] = {}
    upm: int | None = None
    for source, stem, key, subfamily in FACES:
        font = subset_face(src / source, FONTS / f"{stem}.woff2", subfamily)
        units = font["head"].unitsPerEm  # pyright: ignore[reportAttributeAccessIssue]  # fontTools tables fill attributes on decompile
        upm = upm or units
        assert units == upm
        if key is not None:
            tables[key] = advances(font)
            built[key] = TTFont(FONTS / f"{stem}.woff2")
    assert upm is not None, "FACES is empty"
    shutil.copyfile(src / "OFL.txt", FONTS / "FiraSans-OFL.txt")

    # Characters every face draws, without the controls (they draw nothing).
    common = set.intersection(*(set(t) for t in tables.values()))
    chars = sorted(cp for cp in common if cp >= 0x20 and not 0x7F <= cp <= 0x9F)
    text = "".join(chr(cp) for cp in chars)
    lines = [
        "// Generated by `ui/scripts/fira-fonts.py` from the bundled Fira Sans faces; do not edit.",
        "//",
        "// Each face's advance for every character the latin subset draws, in font units",
        f"// ({upm} to the em), in the order of `FIRA_CHARS`.",
        "",
        f"export const FIRA_UNITS_PER_EM = {upm};",
        "",
        f"export const FIRA_CHARS = {json.dumps(text, ensure_ascii=True)};",
        "",
        "export const FIRA_ADVANCES = {",
    ]
    for key, table in tables.items():
        lines.append(f"  {key}: [{', '.join(str(table[cp]) for cp in chars)}],")
    lines.append("} as const;")
    lines += [
        "",
        "// Per size in px, each face's hinted advances: digit d is the rounded exact advance plus d - 4 px.",
        "export const FIRA_HINTED: Readonly<Record<number, Readonly<Record<keyof typeof FIRA_ADVANCES, string>>>> = {",
    ]
    offsets = {key: hinted_offsets(built[key], tables[key], chars, upm) for key in tables}
    for px in HINTED_SIZES:
        lines.append(f"  {px}: {{")
        for key in tables:
            lines.append(f"    {key}: \"{offsets[key][px]}\",")
        lines.append("  },")
    lines.append("};")
    METRICS.write_text("\n".join(lines) + "\n")
    print(f"{len(chars)} characters, {len(tables)} faces")


if __name__ == "__main__":
    main(sys.argv[1])
