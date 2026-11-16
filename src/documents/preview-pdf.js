import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { renderHkidsPdf } from "./pdf-renderer.js";

// The PDF of a document that is prepared but not validated yet: exactly what
// will be generated, with a mark across each page so it cannot pass for the
// document itself. Nothing is written and no number is taken.
export const PREVIEW_MARK = "APERÇU — NON VALIDÉ";

export async function renderPreviewPdf(document) {
  const pdf = await PDFDocument.load(await renderHkidsPdf(document));
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.min(54, (width * 1.05) / (font.widthOfTextAtSize(PREVIEW_MARK, 1) || 1));
    const length = font.widthOfTextAtSize(PREVIEW_MARK, size);
    const angle = Math.atan2(height, width);
    page.drawText(PREVIEW_MARK, {
      x: width / 2 - (Math.cos(angle) * length) / 2,
      y: height / 2 - (Math.sin(angle) * length) / 2,
      size,
      font,
      color: rgb(0.78, 0.12, 0.12),
      opacity: 0.2,
      rotate: degrees((angle * 180) / Math.PI)
    });
  }
  pdf.setTitle(`${PREVIEW_MARK} — ${pdf.getTitle() ?? "H-KIDS"}`);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
