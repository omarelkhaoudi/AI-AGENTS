import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { HKIDS_FIXED_IDENTITY, HKIDS_LOGO_PATH, HKIDS_TEMPLATE_VARIABLES, checksumFile } from "../src/index.js";

// The two H-KIDS reference templates are not versioned with the project. The
// real ones were filled documents carrying a customer's name, their order and
// its amounts, so they were removed; and a blank replacement cannot be invented
// here, because the company has to approve what its own documents look like.
//
// The suite therefore builds its own throwaway templates. A blank page of the
// right count and size exercises every line of the renderer — it copies pages,
// paints covers, draws the table frames and writes the text — without a single
// byte of real data, and without adding a file to the repository.
//
// What these templates do not carry is the H-KIDS letterhead, which lives in
// the template background rather than in code. The tests can therefore prove
// that generation works; only a real template proves that it looks right.
const TEMPLATE_GEOMETRY = Object.freeze({
  invoice: Object.freeze({ pageCount: 2, size: Object.freeze([595.56, 842.04]) }),
  delivery_note: Object.freeze({ pageCount: 3, size: Object.freeze([595.32, 841.92]) })
});

// Stamped on every page so a document built on one of these can never be
// mistaken for a real H-KIDS document. The band sits at the very bottom of the
// page, below every cover rectangle the renderer paints, so it survives
// generation and stays readable on the produced PDF.
export const DEV_TEMPLATE_MARK =
  "GABARIT DE DEVELOPPEMENT - SANS VALEUR OFFICIELLE - NE PAS TRANSMETTRE A UN CLIENT";

// Where the letterhead may be drawn without being erased. The renderer paints
// white rectangles over the variable areas of the page before writing its own
// values, so anything the template puts under one of them disappears. These two
// bands are outside every cover of both document types:
//
//   invoice        covers  x 20..580 y 25..627   and  x 305..563 y 748..812
//   delivery note  covers  x 20..575 y 37..650   and  x 305..563 y 772..822
//
// The left column above the table, and the strip below the covers, are free on
// both. The code also writes its own header from x 306 rightwards, which is why
// the identity block stays on the left.
const LETTERHEAD = Object.freeze({
  centerX: 155,
  logo: Object.freeze({ maxWidth: 96, maxHeight: 54, top: 802 }),
  companyY: 735,
  addressY: 723,
  contactY: 700,
  legalLineY: 16,
  markY: 6
});

function drawCentered(page, text, { y, size, font, color }) {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: LETTERHEAD.centerX - width / 2, y, size, font, color });
}

// The company logo, when it is readable. It is versioned, it carries no metadata
// and it belongs to the company, so a development template may show it; a
// missing file is not an error, the template simply has no picture.
async function embedLogo(pdf) {
  const configured = typeof process.env.HKIDS_LOGO_PATH === "string" ? process.env.HKIDS_LOGO_PATH.trim() : "";
  try {
    return await pdf.embedJpg(await readFile(configured === "" ? HKIDS_LOGO_PATH : configured));
  } catch {
    return null;
  }
}

export async function createBlankTemplate(documentType) {
  const geometry = TEMPLATE_GEOMETRY[documentType];
  if (!geometry) {
    throw new Error(`No synthetic geometry for document type: ${documentType}`);
  }

  const pdf = await PDFDocument.create();
  // Helvetica is one of the fourteen standard PDF fonts: it needs no .ttf on
  // disk, so building a template never depends on the font configuration the
  // renderer itself requires.
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = await embedLogo(pdf);
  const ink = rgb(0.09, 0.13, 0.16);
  const warning = rgb(0.62, 0.16, 0.07);

  for (let page = 0; page < geometry.pageCount; page += 1) {
    const added = pdf.addPage([...geometry.size]);

    if (logo) {
      const size = logo.scaleToFit(LETTERHEAD.logo.maxWidth, LETTERHEAD.logo.maxHeight);
      added.drawImage(logo, {
        x: LETTERHEAD.centerX - size.width / 2,
        y: LETTERHEAD.logo.top - size.height,
        width: size.width,
        height: size.height
      });
    }

    drawCentered(added, HKIDS_FIXED_IDENTITY.companyName, { y: LETTERHEAD.companyY, size: 9, font: boldFont, color: ink });
    HKIDS_FIXED_IDENTITY.addressLines.forEach((line, index) => {
      drawCentered(added, line, { y: LETTERHEAD.addressY - index * 10, size: 6.6, font, color: ink });
    });
    drawCentered(added, `E-mail : ${HKIDS_FIXED_IDENTITY.email}`, { y: LETTERHEAD.contactY, size: 6.6, font, color: ink });
    drawCentered(added, `Tél : ${HKIDS_FIXED_IDENTITY.phone}`, { y: LETTERHEAD.contactY - 11, size: 6.6, font, color: ink });

    // Centred on the page, like the real documents, and low enough to survive.
    const legal = HKIDS_FIXED_IDENTITY.legalLine;
    added.drawText(legal, {
      x: (geometry.size[0] - font.widthOfTextAtSize(legal, 5.5)) / 2,
      y: LETTERHEAD.legalLineY,
      size: 5.5,
      font,
      color: ink
    });

    // Last, and never removed: the letterhead above makes this template look
    // official, and it is not. Every page says so.
    added.drawText(DEV_TEMPLATE_MARK, { x: 20, y: LETTERHEAD.markY, size: 6, font: boldFont, color: warning });
  }

  // No title, no author, no producer beyond what pdf-lib writes: a fixture must
  // not grow metadata either.
  pdf.setTitle("");
  pdf.setAuthor("");
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

// Points the template variables at freshly built blank files for the duration of
// one test, and puts the environment back exactly as it was afterwards.
export async function useSyntheticHkidsTemplates(t, { lock = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "hkids-templates-"));
  const restore = new Map();
  const paths = {};

  for (const [documentType, variables] of Object.entries(HKIDS_TEMPLATE_VARIABLES)) {
    const path = join(directory, `${documentType}.pdf`);
    await writeFile(path, await createBlankTemplate(documentType));
    paths[documentType] = path;

    remember(restore, variables.path);
    process.env[variables.path] = path;

    remember(restore, variables.checksum);
    if (lock) {
      process.env[variables.checksum] = await checksumFile(path);
    } else {
      delete process.env[variables.checksum];
    }
  }

  t.after(async () => {
    for (const [name, value] of restore) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });

  return { directory, paths };
}

function remember(restore, name) {
  if (!restore.has(name)) {
    restore.set(name, process.env[name]);
  }
}
