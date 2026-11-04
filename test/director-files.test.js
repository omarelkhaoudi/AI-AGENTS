import assert from "node:assert/strict";
import test from "node:test";
import yazl from "yazl";
import { InMemoryRepository } from "../src/index.js";
import { readAttachments } from "../src/agent/chat-attachments.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";
import { buildXlsx } from "../test-support/xlsx-fixture.js";

// The direction joins a document to a message: a client's plan, a supplier's
// quote, a list of orders. The model reads a PDF itself; Word, Excel and text
// reach it as text. Invented names and figures only.
const dataUrl = (mime, buffer) => `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
const PDF = dataUrl("application/pdf", "%PDF-1.4\n%fake\n");

async function buildDocx(paragraphs) {
  const zip = new yazl.ZipFile();
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("");
  zip.addBuffer(Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Lit nuage</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3 000 DH</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`), "word/document.xml");
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const isDirector = (payload) => payload.instructions.startsWith("Tu es le Director IA");
const say = (text) => ({ output_text: text, output: [] });

function scripted(answers) {
  const calls = [];
  return {
    calls,
    responses: {
      async create(payload) {
        calls.push(JSON.parse(JSON.stringify(payload)));
        assert.ok(isDirector(payload));
        return answers.shift();
      }
    }
  };
}

function directorWith(client) {
  return createDirectorAgent({ client, documentService: {}, toolRegistry: { list: () => [] }, executeTool: async () => ({ ok: true }) });
}

const parts = (payload) => payload.input.flatMap((item) => (Array.isArray(item.content) ? item.content : []));

test("a PDF goes to the model as a file, Word and Excel as their text", async () => {
  const docx = await buildDocx(["Devis fournisseur Bois Exemple", "Panneaux MDF : 40 plaques"]);
  const xlsx = await buildXlsx({ Commandes: [["Client", "Montant"], ["Client Exemple", 14000]] });

  const [pdf, word, excel, text] = readAttachments([
    { name: "plan.pdf", data: PDF },
    { name: "devis-fournisseur.docx", data: dataUrl("application/octet-stream", docx) },
    { name: "commandes.xlsx", data: dataUrl("application/octet-stream", xlsx) },
    { name: "notes.txt", data: dataUrl("text/plain", "Livraison le 12/11") }
  ]);

  assert.deepEqual(pdf.part, { type: "input_file", filename: "plan.pdf", file_data: PDF });
  assert.match(word.part.text, /^\[Document n° 2 « devis-fournisseur\.docx »\]\nDevis fournisseur Bois Exemple\nPanneaux MDF : 40 plaques\nLit nuage \| 3 000 DH/);
  assert.match(excel.part.text, /Feuille « Commandes » \(1 lignes\)\nClient \| Montant\nClient Exemple \| 14000/);
  assert.match(text.part.text, /Livraison le 12\/11/);
});

test("a file of another kind, an old .doc, or one too large is refused with the reason", () => {
  assert.throws(() => readAttachments([{ name: "photo.exe", data: PDF }]), /n'est pas pris en charge/);
  assert.throws(() => readAttachments([{ name: "ancien.doc", data: PDF }]), /\.docx ou \.xlsx/);
  assert.throws(() => readAttachments([{ name: "gros.pdf", data: dataUrl("application/pdf", Buffer.alloc(5 * 1024 * 1024 + 1)) }]), /dépasse 5 Mo/);
  assert.throws(() => readAttachments([{ name: "abime.docx", data: dataUrl("application/octet-stream", "pas un zip") }]), /abîmé/);
  assert.throws(() => readAttachments(Array(5).fill({ name: "a.pdf", data: PDF })), /au plus 4/);
});

test("the Director reads the document in its message and remembers its start afterwards", async () => {
  const client = scripted([say("Le devis fournisseur porte sur 40 plaques de MDF."), say("40 plaques.")]);
  const agent = directorWith(client);
  const docx = await buildDocx(["Devis fournisseur Bois Exemple", "Panneaux MDF : 40 plaques"]);

  const first = await agent.chat({ message: "", files: [{ name: "devis.docx", data: dataUrl("application/octet-stream", docx) }, { name: "plan.pdf", data: PDF }] });
  await agent.chat({ message: "Combien de plaques ?", conversationId: first.conversationId });

  assert.match(parts(client.calls[0])[0].text, /^Voici un document\./);
  assert.match(parts(client.calls[0])[1].text, /Panneaux MDF : 40 plaques/);
  assert.equal(parts(client.calls[0])[2].type, "input_file");
  const remembered = client.calls[1].input[0].content;
  assert.equal(typeof remembered, "string", "the files are not sent again");
  assert.match(remembered, /Document n° 1 « devis\.docx », lu à ce message\. Début :\]\nDevis fournisseur/);
  assert.match(remembered, /Document n° 2 « plan\.pdf » : PDF lu à ce message/);
});

test("the chat route takes a document of several megabytes and refuses an unsupported one", async (t) => {
  const client = scripted([say("Document reçu.")]);
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), agentClient: client });
  t.after(() => app.close());
  const big = dataUrl("application/pdf", Buffer.alloc(4 * 1024 * 1024, 1));

  const ok = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "voici", files: [{ name: "plan.pdf", data: big }] } });
  const refused = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "voici", files: [{ name: "virus.exe", data: PDF }] } });

  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(refused.statusCode, 400);
  assert.equal(JSON.parse(refused.body).details.code, "AGENT_FILE_INVALID");
});
