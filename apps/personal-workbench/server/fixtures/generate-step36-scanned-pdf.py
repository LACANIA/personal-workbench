"""Creates a deterministic image-only PDF fixture for the local OCR acceptance path."""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def page(lines: list[str]) -> Image.Image:
    image = Image.new("RGB", (1600, 1000), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 48)
    y = 130
    for line in lines:
        draw.text((120, y), line, fill="black", font=font)
        y += 110
    return image


def main() -> None:
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("STEP36-scanned-pdf-fixture.pdf")
    output.parent.mkdir(parents=True, exist_ok=True)
    first = page([
        "Personal Workbench Scan PDF Test",
        "Machine learning includes supervised learning.",
        "It also includes unsupervised learning.",
    ])
    second = page([
        "Neural Network Notes",
        "A neural network contains multiple computation layers.",
        "Each layer transforms information for the next layer.",
    ])
    first.save(output, "PDF", resolution=150.0, save_all=True, append_images=[second])


if __name__ == "__main__":
    main()
