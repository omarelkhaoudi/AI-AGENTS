import assert from "node:assert/strict";
import test from "node:test";
import { queryTerms, rankPassages, stemOf } from "../src/agent/passage-search.js";

// An invented catalogue, as in every committed fixture.
const document = { id: "catalogue" };
const passages = [
  "Politique de retour : tout article non conforme est repris sous 8 jours.",
  "Lit cabane 90 x 190 : 14 500 DH TTC, pin massif.",
  "Lit château 140 x 190 : 32 000 DH TTC, MDF laqué.",
  "Placards sur mesure : 4 200 DH le mètre linéaire, portes laquées.",
  "Délais de fabrication : 4 à 6 semaines après l'acompte.",
  "Montage et pose à Marrakech offerts ; autres villes sur devis."
].map((passage) => ({ document, title: "Catalogue", passage }));

const best = (query) => rankPassages(query, passages)[0]?.passage ?? "";

test("a word is found as a word, singular or plural, never inside another", () => {
  assert.deepEqual(["armoires", "lits", "chateaux", "laquees", "lit"].map(stemOf), ["armoire", "lit", "chateau", "laque", "lit"]);
  assert.deepEqual(queryTerms("Combien coûte le lit château ?").map((term) => term.stem), ["lit", "chateau"]);
  assert.deepEqual(queryTerms("prix ?").map((term) => term.stem), ["prix"], "a price question is still about prices");
  assert.ok(rankPassages("lit", passages).every((found) => !/Politique/.test(found.passage)), "« lit » is not in « politique »");
  assert.match(best("les lits château"), /Lit château/);
});

test("the trade's synonyms, the rare words and the words side by side rank the passage that answers", () => {
  assert.match(best("prix d'une armoire"), /Placards sur mesure/, "an armoire question finds the placards");
  assert.match(best("quel délai de livraison ?"), /Délais de fabrication/);
  assert.match(best("installation à Fès ?"), /Montage et pose/);
  assert.match(best("lit cabane"), /Lit cabane/, "both words side by side beat « lit » alone");
  assert.match(best("lit 140"), /Lit château 140/, "a size is a word of the question");
  assert.deepEqual(rankPassages("canapé d'angle", passages), [], "nothing said when nothing matches");
});
