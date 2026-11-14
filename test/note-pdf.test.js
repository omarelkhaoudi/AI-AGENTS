import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { parseBlocks, pdfFileName, renderNotePdf } from "../src/documents/note-pdf.js";

// The Director hands a text to the direction as a PDF joined to its answer:
// it never says it cannot attach a file.

const CONTENT = [
  "Exemple à confirmer par l'atelier.",
  "",
  "## Séquence",
  "1. Air-cut pour valider les trajectoires",
  "2. Poche 60 × 40, profondeur 6 mm",
  "- **Matière** : MDF 18 mm ✅",
  "",
  "| Opération | Fraise |",
  "| --- | --- |",
  "| Poche | Ø6 |"
].join("\n");

test("simple Markdown is read as titles, steps, bullets and tables", () => {
  const blocks = parseBlocks(CONTENT);
  assert.deepEqual(blocks.map((block) => block.kind), ["paragraph", "space", "heading", "step", "step", "bullet", "space", "table"]);
  assert.deepEqual(blocks.at(-1).rows, [["Opération", "Fraise"], ["Poche", "Ø6"]], "the separator row is dropped");
  assert.ok(!blocks[5].text.includes("✅"), "what the font cannot draw is left out");
  assert.equal(pdfFileName("Fiche atelier — Découpe MDF", new Date("2026-11-14T10:00:00Z")), "2026-11-14_fiche-atelier-decoupe-mdf.pdf");
});

test("a long text becomes a real PDF over several pages", async () => {
  const long = `${CONTENT}\n${Array.from({ length: 90 }, (_, index) => `- Point n° ${index + 1}`).join("\n")}`;
  const bytes = await renderNotePdf({ title: "Fiche atelier", content: long, date: new Date("2026-11-14T10:00:00Z") });
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 2);
  assert.equal(pdf.getTitle(), "H-KIDS — Fiche atelier");
});

test("asked for a PDF, the Director joins it to its answer with a button to save it", async (t) => {
  const calls = [];
  const turns = [
    { output: [{ type: "function_call", name: "joindre_pdf", call_id: "p1", arguments: JSON.stringify({ titre: "Fiche atelier — Poche MDF", contenu: CONTENT }) }] },
    { output: [{ type: "function_call", name: "joindre_pdf", call_id: "p2", arguments: JSON.stringify({ titre: "Vide", contenu: "  " }) }] },
    { output_text: "Le PDF est joint sous ma réponse.", output: [] }
  ];
  const agent = createDirectorAgent({
    client: { responses: { create: async (payload) => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      return turns.shift();
    } } },
    documentService: new HkidsDocumentService({ repository: new InMemoryRepository() }),
    clock: () => new Date("2026-11-14T10:00:00Z")
  });

  const answer = await agent.chat({ message: "Envoie-moi la fiche en PDF." });
  assert.ok(calls[0].tools.some((tool) => tool.name === "joindre_pdf"));
  assert.match(calls[0].instructions, /Ne dis jamais que tu ne peux pas joindre un fichier PDF/);
  assert.equal(answer.exports.length, 1, "an empty document is refused, not joined");
  const [file] = answer.exports;
  assert.equal(file.name, "2026-11-14_fiche-atelier-poche-mdf.pdf");
  assert.equal(file.mimeType, "application/pdf");
  assert.equal(file.label, "Fichier PDF");
  assert.equal(Buffer.from(file.data, "base64").subarray(0, 5).toString("latin1"), "%PDF-");
  const outputs = calls.at(-1).input.filter((item) => item.type === "function_call_output").map((item) => JSON.parse(item.output));
  assert.equal(outputs[0].ok, true);
  assert.match(outputs[1].erreur, /contenu/);
});
