import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { forWhatsApp } from "../src/agent/whatsapp-gateway.js";

// Hiba, 11/11/2026: « le cockpit est incapable de créer des tableaux ». The
// Director now answers with Markdown tables; the cockpit draws them, and
// WhatsApp, which cannot, gets one line per row.

const TABLE = [
  "**Devis du mois**",
  "",
  "| Date | N° | Client | TTC |",
  "| --- | --- | --- | ---: |",
  "| 10/11/2026 | 171 | Nadia Berrada | 3 200 DH |",
  "| 04/11/2026 | 170 | Mamoun Bouanani | 62 699,99 DH |",
  "| **Total** | | | **65 899,99 DH** |"
].join("\n");

test("on WhatsApp a table becomes one line per row, and bold is WhatsApp's", () => {
  assert.equal(forWhatsApp(TABLE), [
    "*Devis du mois*",
    "",
    "• Date — N° — Client — TTC",
    "• 10/11/2026 — 171 — Nadia Berrada — 3 200 DH",
    "• 04/11/2026 — 170 — Mamoun Bouanani — 62 699,99 DH",
    "• *Total* — *65 899,99 DH*"
  ].join("\n"));
  assert.equal(forWhatsApp("Bonjour, rien à signaler."), "Bonjour, rien à signaler.", "a plain answer is left alone");
});

// The cockpit's formatter, run as the page runs it.
async function formatter() {
  const source = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function formatAgentText(");
  const end = source.indexOf("\nfunction documentCard(", start);
  const escapeHtml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return new Function("escapeHtml", `${source.slice(start, end)}; return formatAgentText;`)(escapeHtml);
}

test("the cockpit draws a table, with figures aligned and nothing unescaped", async () => {
  const format = await formatter();
  const html = format(TABLE);
  assert.match(html, /<p><strong>Devis du mois<\/strong><\/p>/);
  assert.match(html, /<div class="answer-table"><table><thead><tr><th>Date<\/th><th>N°<\/th><th>Client<\/th><th>TTC<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>Nadia Berrada<\/td><td class="num">3 200 DH<\/td>/);
  assert.equal((html.match(/<tr>/g) ?? []).length, 4, "the header and three rows");
  assert.ok(!html.includes("| ---"), "the separator line is not shown");

  const hostile = format("| A | B |\n| --- | --- |\n| <img src=x onerror=alert(1)> | 1 |");
  assert.ok(!hostile.includes("<img"), "a cell is text, never HTML");
});

test("titles and lists are drawn too, and a plain answer keeps its lines", async () => {
  const format = await formatter();
  assert.equal(format("## Urgences\n- Devis 170 à relancer\n- Facture 165 en double"), "<h4>Urgences</h4><ul><li>Devis 170 à relancer</li><li>Facture 165 en double</li></ul>");
  assert.equal(format("1. Couper\n2. Peindre"), "<ol><li>Couper</li><li>Peindre</li></ol>");
  assert.equal(format("Bonjour Hiba,\nTout va bien."), "<p>Bonjour Hiba,<br>Tout va bien.</p>");
});
