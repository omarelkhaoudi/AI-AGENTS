import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { exportExcel } from "../src/agent/director-agent.js";
import { parseDate, parseFigure, renderXlsx, xlsxFileName } from "../src/documents/xlsx-writer.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// Hiba, 11/11/2026: « exporte-moi ça en Excel ». A table becomes an .xlsx whose
// figures are figures, whose dates are dates, and whose total is a formula.

// The files of a zip, read with what Node has: enough for the few small parts
// of an .xlsx, whether stored or deflated.
function unzip(buffer) {
  const files = {};
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const flags = buffer.readUInt16LE(offset + 6);
    let size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    if (flags & 0x08) {
      // Sizes come after the data: find the descriptor.
      let end = start;
      while (buffer.readUInt32LE(end) !== 0x08074b50) {
        end += 1;
      }
      size = end - start;
      files[name] = method === 8 ? inflateRawSync(buffer.subarray(start, end)).toString() : buffer.subarray(start, end).toString();
      offset = end + 16;
    } else {
      files[name] = method === 8 ? inflateRawSync(buffer.subarray(start, start + size)).toString() : buffer.subarray(start, start + size).toString();
      offset = start + size;
    }
  }
  return files;
}

test("amounts, percentages and dates are read as Excel reads them", () => {
  assert.deepEqual(parseFigure("3 200,00 DH"), { value: 3200, percent: false });
  assert.deepEqual(parseFigure("62 699,99 DH"), { value: 62699.99, percent: false });
  assert.deepEqual(parseFigure("1.200 MAD"), { value: 1200, percent: false });
  assert.deepEqual(parseFigure("60 %"), { value: 0.6, percent: true });
  assert.equal(parseFigure("Lit cabane"), null);
  assert.equal(parseFigure("06 61 23 45 67"), null, "a phone number is not an amount");
  assert.equal(parseDate("10/11/2026"), 46336);
  assert.equal(xlsxFileName("Devis de novembre 2026 !", new Date("2026-11-11T10:00:00Z")), "2026-11-11_devis-de-novembre-2026.xlsx");
});

test("the file has the title, a green header, real figures, and a SUM total that skips the numbers", async () => {
  const bytes = await renderXlsx({
    title: "Devis H-KIDS",
    sheetName: "Devis",
    columns: ["Date", "N°", "Client", "Montant TTC", "Acompte"],
    rows: [
      ["10/11/2026", "171", "Nadia Berrada", "3 200,00 DH", "60 %"],
      ["04/11/2026", "170", "Mamoun <Bouanani> & fils", "62 699,99 DH", "60 %"]
    ],
    total: true
  });
  const files = unzip(bytes);
  assert.ok(files["[Content_Types].xml"].includes("spreadsheetml.sheet.main+xml"));
  const sheet = files["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<c r="A1" t="inlineStr" s="6"><is><t>Devis H-KIDS<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="A4" s="3"><v>46336<\/v><\/c>/, "a date is a date");
  assert.match(sheet, /<c r="B4" t="inlineStr" s="0"><is><t xml:space="preserve">171<\/t>/, "a quote number stays as written");
  assert.match(sheet, /<c r="D4" s="2"><v>3200<\/v><\/c>/, "an amount is a number");
  assert.match(sheet, /<c r="E4" s="7"><v>0.6<\/v><\/c>/);
  assert.match(sheet, /Mamoun &lt;Bouanani&gt; &amp; fils/, "text is escaped");
  assert.match(sheet, /<c r="D6" s="5"><f>SUM\(D4:D5\)<\/f><\/c>/, "the total is a formula");
  assert.ok(!sheet.includes("SUM(B4"), "quote numbers are never added up");
  assert.ok(!sheet.includes("SUM(E4"), "percentages are never added up");
  assert.match(sheet, /<pane ySplit="3"/, "the header stays in view");
  assert.match(sheet, /<autoFilter ref="A3:E5"\/>/);
  assert.match(files["xl/workbook.xml"], /<sheet name="Devis"/);
  assert.match(files["xl/styles.xml"], /<name val="Arial"\/>/);
});

test("the Director's export goes with the answer, and into Exports when the PC files documents", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hkids-exports-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outcome = { exports: [] };
  const result = await exportExcel({ titre: "Caisse de novembre", colonnes: ["Date", "Libellé", "Montant"], lignes: [["02/11/2026", "Acompte Mouna", "1 800 DH"]], total: true }, { archive: { dir }, outcome, clock: () => new Date("2026-11-11T10:00:00Z") });
  assert.equal(result.ok, true);
  assert.equal(result.fichier, "2026-11-11_caisse-de-novembre.xlsx");
  assert.equal(outcome.exports.length, 1);
  assert.equal(outcome.exports[0].rows, 1);
  const saved = await readFile(join(dir, "Exports", "2026-11-11_caisse-de-novembre.xlsx"));
  assert.deepEqual(saved, Buffer.from(outcome.exports[0].data, "base64"), "the button saves the same file as the folder holds");
  assert.equal((await exportExcel({ titre: "Vide", colonnes: [], lignes: [], total: false }, { archive: {}, outcome })).ok, false);
});

test("the register is exported as searched, from the cockpit", async (t) => {
  const issued = [
    { type: "quote", number: "171", stem: "devis_HKIDS_171_10_11_2026", date: "10/11/2026", client: "Mme Barada", object: "Lit cabane", totalTtc: 3200 },
    { type: "invoice", number: "165", stem: "facture_HKIDS_165_2026-09-05", date: "2026-09-05", client: "Madame Benchakroun", object: "Chambre", totalTtc: 8760 }
  ];
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository, documentService: { outputDir: tmpdir(), listIssued: async () => issued } });
  t.after(() => app.close());
  const response = await inject({ method: "GET", url: "/api/documents/register.xlsx?client=barada" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-disposition"], /registre-des-documents\.xlsx/);
  const sheet = unzip(response.rawPayload)["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /Mme Barada/);
  assert.ok(!sheet.includes("Benchakroun"), "only what the search found");
  assert.match(sheet, /<v>3200<\/v>/);
});
