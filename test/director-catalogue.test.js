import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { catalogueFromRows, createCatalogueLoader, searchCatalogue } from "../src/agent/catalogue.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { readXlsxSheets } from "../src/business-memory/xlsx-reader.js";
import { buildXlsx } from "../test-support/xlsx-fixture.js";

// Invented products and prices: the real catalogue lives in data/, which git ignores.
const HEADER = ["Référence", "Produit", "Description", "Prix TTC (DH)", "Unité", "Mots-clés", "Actif", "Remarque"];
const ROWS = [
  HEADER,
  ["EX-001", "Produit exemple", "", 1000, "U", "", "oui", "Exemple fictif : à remplacer"],
  ["LN-01", "Lit nuage", "Lit enfant en forme de nuage, 90x190", 3000, "U", "nuage, cloud", "oui", ""],
  ["LC-01", "Lit cabane 90x190", "Lit cabane en pin", 4500, "U", "cabane", "oui", ""],
  ["LC-02", "Lit cabane 140x190", "Lit cabane double", 5800, "U", "cabane", "oui", ""],
  ["BU-01", "Bureau enfant", "Bureau avec deux tiroirs", 3200, "U", "bureau", "non", ""]
];

async function catalogueFile(t) {
  const dir = await mkdtemp(join(tmpdir(), "hkids-catalogue-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "catalogue-hkids.xlsx");
  await writeFile(path, await buildXlsx({ Catalogue: ROWS }));
  return path;
}

test("the catalogue skips the template example and inactive products", async (t) => {
  const load = createCatalogueLoader({ path: await catalogueFile(t) });
  const { available, catalogue } = await load();

  assert.equal(available, true);
  assert.deepEqual(catalogue.map((entry) => entry.name), ["Lit nuage", "Lit cabane 90x190", "Lit cabane 140x190"]);
  assert.equal(catalogue[0].priceTtc, 3000);
});

test("the delivered template is readable and contributes nothing but its example", async () => {
  const sheets = readXlsxSheets(await readFile(new URL("../docs/catalogue-hkids.xlsx", import.meta.url)));
  assert.equal(catalogueFromRows(sheets.Catalogue).length, 0);
});

test("a product is found by its name or a keyword, in the words she uses", async (t) => {
  const { catalogue } = await createCatalogueLoader({ path: await catalogueFile(t) })();

  assert.equal(searchCatalogue(catalogue, "un lit nuage pour Meriem")[0].name, "Lit nuage");
  assert.equal(searchCatalogue(catalogue, "cloud bed")[0].name, "Lit nuage");
  assert.equal(searchCatalogue(catalogue, "un lit cabane").length >= 2, true, "two sizes: she is asked which");
  assert.deepEqual(searchCatalogue(catalogue, "armoire"), []);
});

test("without a catalogue file the agent is told to ask for the price", async () => {
  const load = createCatalogueLoader({ path: join(tmpdir(), "aucun-catalogue-ici.xlsx") });
  assert.equal((await load()).available, false);
});

test("asked for a quote without a price, the agent prices it from the catalogue", async (t) => {
  const path = await catalogueFile(t);
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-agent-cat-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));

  const calls = [];
  const turns = [
    { output: [{ type: "function_call", name: "chercher_catalogue", call_id: "c1", arguments: JSON.stringify({ recherche: "lit nuage" }) }] },
    { output: [{ type: "function_call", name: "preparer_document", call_id: "c2", arguments: JSON.stringify({
      type: "devis", client_nom: "Meriem Exemple", client_adresse: "Marrakech", objet: "Lit nuage",
      lignes: [{ designation: "Lit nuage", quantite: 1, prix_unitaire: 3000, prix_ttc: true }],
      caracteristiques: [], conditions_paiement: "60/20/20", reference_devis: "", reference_bl: "", numero: ""
    }) }] },
    { output_text: "Devis prêt au prix catalogue : 3 000 DH TTC.", output: [] }
  ];
  const agent = createDirectorAgent({
    client: { responses: { create: async (payload) => { calls.push(JSON.parse(JSON.stringify(payload))); return turns.shift(); } } },
    documentService: new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir }),
    loadCatalogue: createCatalogueLoader({ path }),
    clock: () => new Date("2026-11-02T10:00:00Z")
  });

  const result = await agent.chat({ message: "un devis pour Meriem à Marrakech, un lit nuage" });

  const lookup = JSON.parse(calls[1].input.find((item) => item.type === "function_call_output").output);
  assert.equal(lookup.produits[0].produit, "Lit nuage");
  assert.equal(lookup.produits[0].prix_ttc, 3000);
  assert.equal(result.documents[0].preview.document.totals.totalTtc, 3000);
  assert.ok(calls[0].tools.some((tool) => tool.name === "chercher_catalogue"));
  assert.match(calls[0].instructions, /chercher_catalogue/);
});
