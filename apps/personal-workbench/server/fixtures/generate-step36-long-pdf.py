"""Creates a non-sensitive 20-page text-layer PDF fixture for hierarchy acceptance."""
from __future__ import annotations

import sys
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas


def main() -> None:
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("STEP36-long-text-fixture.pdf")
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas = Canvas(str(output), pagesize=A4)
    width, height = A4
    for page in range(1, 21):
        chapter = (page - 1) // 4 + 1
        canvas.setFont("Helvetica-Bold", 18)
        canvas.drawString(72, height - 80, f"Chapter {chapter}: Local Study Material")
        canvas.setFont("Helvetica", 12)
        lines = [
            f"Page {page} introduces concept {chapter} for the Personal Workbench hierarchy fixture.",
            "A clear source anchor lets readers return to the original page during review.",
            "Chunk summaries group nearby content before a document-level learning note is generated.",
            "Document search returns a relevant page and the extracted supporting text.",
        ] * 10
        y = height - 120
        for line in lines:
            if y < 72:
                break
            canvas.drawString(72, y, line)
            y -= 17
        canvas.showPage()
    canvas.save()


if __name__ == "__main__":
    main()
