from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "icons"
OUT.mkdir(parents=True, exist_ok=True)


def make_icon(size: int) -> None:
    scale = size / 512
    image = Image.new("RGB", (size, size), "#FFF9E8")
    draw = ImageDraw.Draw(image)
    def box(values):
        return tuple(round(v * scale) for v in values)
    draw.rounded_rectangle(box((42, 42, 470, 470)), radius=round(96 * scale), fill="#E8F5DF")
    draw.ellipse(box((84, 78, 428, 422)), fill="#D8EDC9")
    draw.rounded_rectangle(box((226, 248, 286, 420)), radius=round(20 * scale), fill="#8A5A3B")
    draw.polygon([box((256, 115))[0:2], box((155, 350))[0:2], box((357, 350))[0:2]], fill="#2F7D4A")
    for values, color in [
        ((112, 118, 254, 260), "#4E9C5F"),
        ((250, 102, 404, 256), "#3F8C55"),
        ((142, 196, 298, 352), "#59A868"),
        ((252, 190, 402, 340), "#2F7D4A"),
    ]:
        draw.ellipse(box(values), fill=color)
    # Three pale word-leaves suggest kana without depending on a bundled font.
    for values in ((144, 155, 184, 195), (300, 143, 340, 183), (276, 258, 316, 298)):
        draw.ellipse(box(values), fill="#FFF5B8")
    image.save(OUT / f"kotoba-no-ki-{size}.png", optimize=True)


for icon_size in (192, 512):
    make_icon(icon_size)
