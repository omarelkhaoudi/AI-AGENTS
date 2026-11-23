import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { HKIDS_FIXED_IDENTITY } from "./hkids-template.js";
import { resolveDocumentFontPath } from "./pdf-renderer.js";

// A delivery note the client signed on their follow-up link (CDC section 7:
// « Bon de livraison — émission et signature électronique »). The PDF is the
// delivery note exactly as it was when signed, followed by one page: who
// signed, when, the drawn signature, and the fingerprint of the note signed.
//
// It is a simple electronic signature: an acknowledgement of receipt given
// through the order's own unguessable link. It is not the « signature
// électronique sécurisée » of the Moroccan law 53-05, which needs a certificate
// from an approved provider; the page says what it is and no more.

const PAGE = Object.freeze({ width: 595.28, height: 841.89, margin: 56 });
const INK = rgb(0.12, 0.14, 0.13);
const MUTED = rgb(0.42, 0.45, 0.43);
const ACCENT = rgb(0.13, 0.33, 0.28);
const RULE = rgb(0.82, 0.85, 0.83);

export function fingerprint(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// signedAt: ISO date; the day and the hour are written in Morocco's time.
export function signatureMoment(signedAt) {
  const date = new Date(signedAt);
  const part = (options) => new Intl.DateTimeFormat("fr-FR", { timeZone: "Africa/Casablanca", ...options }).format(date);
  return `${part({ day: "2-digit", month: "2-digit", year: "numeric" })} à ${part({ hour: "2-digit", minute: "2-digit" })} (heure du Maroc)`;
}

export async function renderSignedPdf({ pdfBytes, signaturePng, name, signedAt, documentLabel, orderNumber, client = "", ip = "", reserves = "", fontPath = process.env.HKIDS_DOCUMENT_FONT_PATH ?? null, boldFontPath = process.env.HKIDS_DOCUMENT_BOLD_FONT_PATH ?? null }) {
  const pdf = await PDFDocument.load(pdfBytes);
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await readFile(await resolveDocumentFontPath("regular", fontPath)), { subset: true });
  const bold = await pdf.embedFont(await readFile(await resolveDocumentFontPath("bold", boldFontPath)), { subset: true });
  const image = await pdf.embedPng(signaturePng);
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const width = PAGE.width - 2 * PAGE.margin;
  let y = PAGE.height - PAGE.margin;

  const line = (text, { size = 10.5, face = font, color = INK, gap = 6 } = {}) => {
    for (const wrapped of wrap(text, face, size, width)) {
      page.drawText(wrapped, { x: PAGE.margin, y, size, font: face, color });
      y -= size + gap;
    }
  };

  line(HKIDS_FIXED_IDENTITY.companyName, { size: 12, face: bold, color: ACCENT });
  y -= 10;
  line("Accusé de réception signé en ligne", { size: 18, face: bold, color: ACCENT, gap: 8 });
  page.drawLine({ start: { x: PAGE.margin, y: y + 2 }, end: { x: PAGE.margin + width, y: y + 2 }, thickness: 0.8, color: RULE });
  y -= 16;
  line(`${documentLabel} — bon de commande n° ${orderNumber}${client ? ` — ${client}` : ""}`, { face: bold });
  y -= 6;
  if (reserves) {
    // The réserves are the signer's own words, written before signing.
    line(`Je soussigné(e) ${name} reconnais avoir reçu la marchandise décrite dans le ${documentLabel.toLowerCase()} qui précède, sous les réserves suivantes, écrites par moi avant de signer :`);
    y -= 2;
    for (const said of String(reserves).split("\n")) {
      line(`« ${said} »`, { face: bold });
    }
  } else {
    line(`Je soussigné(e) ${name} reconnais avoir reçu la marchandise décrite dans le ${documentLabel.toLowerCase()} qui précède, en bon état apparent, sauf réserves communiquées à ${HKIDS_FIXED_IDENTITY.companyName}.`);
  }
  y -= 8;
  line(`Signé le ${signatureMoment(signedAt)}`, { face: bold });
  line(`par ${name}`, { face: bold });
  y -= 6;

  const box = { width: 260, height: 110 };
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const drawn = { width: image.width * scale, height: image.height * scale };
  page.drawRectangle({ x: PAGE.margin, y: y - box.height, width: box.width, height: box.height, borderColor: RULE, borderWidth: 0.8 });
  page.drawImage(image, { x: PAGE.margin + (box.width - drawn.width) / 2, y: y - box.height + (box.height - drawn.height) / 2, width: drawn.width, height: drawn.height });
  y -= box.height + 22;

  line("Ce que vaut cette signature", { size: 9.5, face: bold, color: MUTED });
  line("Signature électronique simple, recueillie sur le lien de suivi personnel et sécurisé de cette commande. Elle vaut accusé de réception ; elle n'est pas une signature électronique sécurisée au sens de la loi marocaine n° 53-05.", { size: 9, color: MUTED, gap: 4 });
  y -= 4;
  line(`Empreinte SHA-256 du bon de livraison signé : ${fingerprint(pdfBytes)}`, { size: 8, color: MUTED, gap: 3 });
  if (ip) {
    line(`Adresse de connexion du signataire : ${ip}`, { size: 8, color: MUTED, gap: 3 });
  }
  const legal = HKIDS_FIXED_IDENTITY.legalLine;
  page.drawText(legal, { x: (PAGE.width - font.widthOfTextAtSize(legal, 6.5)) / 2, y: PAGE.margin - 22, size: 6.5, font, color: MUTED });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

function wrap(text, face, size, maxWidth) {
  const lines = [];
  let current = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (face.widthOfTextAtSize(candidate, size) <= maxWidth || current === "") {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) {
    lines.push(current);
  }
  // A single word wider than the page (the fingerprint) is cut where it fits.
  return lines.flatMap((line) => {
    const pieces = [];
    let rest = line;
    while (face.widthOfTextAtSize(rest, size) > maxWidth) {
      let cut = rest.length - 1;
      while (cut > 1 && face.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) {
        cut -= 1;
      }
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    return [...pieces, rest];
  });
}
