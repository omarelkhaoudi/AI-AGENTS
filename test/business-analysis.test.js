import assert from "node:assert/strict";
import test from "node:test";
import { cashForecast, orderMargins } from "../src/agent/business-analysis.js";
import { forecast, margins } from "../src/agent/analysis-tools.js";
import { createMemoryCashBook } from "../src/agent/cash-book.js";

const step = (id, extra = {}) => ({ id, status: "a_faire", plannedDate: null, ...extra });
const order = (number, totalTtc, extra = {}) => ({
  number, date: "05/11/2026", client: `Client ${number}`, object: "Lit cabane", totalTtc, quoteNumber: String(Number(number) + 100),
  received: 0, finished: false, steps: [step("controle_qualite"), step("livraison_installation")], ...extra
});
let next = 0;
const entry = (kind, amount, extra = {}) => ({ number: ++next, day: "2026-11-10", kind, amount, category: kind === "entree" ? "acompte_client" : "achat_matiere", quoteNumber: "", orderNumber: "", confidential: false, ...extra });

test("the margin of an order is its sale before tax less the expenses tied to it; without any, it is not measured", () => {
  const orders = [
    order("166", 12_000, { finished: true }),
    order("167", 24_000, { object: "Chambre complète" }),
    order("168", 6_000),
    order("150", 9_000, { date: "05/09/2026" })
  ];
  const entries = [
    entry("sortie", 3_000, { orderNumber: "166" }),
    entry("sortie", 1_000, { quoteNumber: "266", category: "fournisseur" }),
    entry("sortie", 8_000, { orderNumber: "167" }),
    entry("sortie", 500, { orderNumber: "167", cancelled: { reason: "erreur" } }),
    entry("sortie", 4_000, { category: "loyer" }),
    entry("sortie", 6_000, { category: "salaire", confidential: true }),
    entry("sortie", 700, { orderNumber: "99" })
  ];
  const report = orderMargins(orders, entries, { from: "2026-11-01", to: "2026-11-30" });
  assert.deepEqual(report.orders.map((line) => line.number), ["166", "167", "168"], "the BC of September is out of the period");
  const bc166 = report.orders[0];
  assert.deepEqual([bc166.salesHt, bc166.costs, bc166.margin, bc166.rate], [10_000, 4_000, 6_000, 60]);
  assert.equal(report.orders[1].costs, 8_000, "a cancelled expense does not count");
  assert.deepEqual(report.unmeasured, ["168"]);
  assert.deepEqual(report.byProduct.map((product) => [product.object, product.rate]), [["Lit cabane", 60], ["Chambre complète", 60]]);
  assert.equal(report.grossMargin, 18_000);
  assert.equal(report.overheadTotal, 10_000);
  assert.deepEqual(report.strays.map((stray) => stray.reference), ["BC 99"]);

  const masked = orderMargins(orders, entries, { from: "2026-11-01", to: "2026-11-30", confidential: false });
  assert.deepEqual(masked.overheads.map((line) => line.category).sort(), ["confidentiel", "loyer"]);
});

test("the forecast counts the cash in hand, what clients owe and when, and spending at the recent pace", () => {
  const today = new Date("2026-11-19T09:00:00Z");
  const orders = [
    // Deposit paid, delivery planned on the 25th: 20 % due that day.
    order("170", 10_000, { steps: [step("controle_qualite"), step("livraison_installation", { plannedDate: "2026-11-25" })] }),
    // No deposit yet: 60 % already due.
    order("171", 5_000),
    // Installed, 80 % paid: the last 20 % is due now.
    order("172", 20_000, { finished: true, received: 16_000 }),
    // Paid in full.
    order("173", 3_000, { received: 3_000 }),
    // Deposit paid, no delivery date: not counted, said.
    order("174", 8_000)
  ];
  const entries = [
    entry("entree", 2_000, { category: "solde_depart", day: "2026-10-20" }),
    entry("entree", 6_000, { quoteNumber: "270", day: "2026-11-02" }),
    entry("entree", 4_800, { orderNumber: "174", day: "2026-11-03" }),
    entry("sortie", 3_000, { day: "2026-11-12" }),
    entry("sortie", 1_500, { day: "2026-10-10" })
  ];
  const result = cashForecast(orders, entries, { today, days: 15 });
  assert.equal(result.balance, 2_000 + 6_000 + 4_800 - 3_000 - 1_500);
  assert.deepEqual(result.expected.map((line) => [line.order, line.amount, line.day, line.late]), [
    ["171", 3_000, "2026-11-19", true],
    ["172", 4_000, "2026-11-19", true],
    ["170", 2_000, "2026-11-25", false]
  ]);
  assert.equal(result.overdue, 7_000);
  assert.equal(result.perDay, 100, "3 000 DH spent over the last 30 days");
  assert.equal(result.closing, 8_300 + 9_000 - 1_500);
  assert.deepEqual(result.undated, ["171", "174"], "their 20 % before delivery has no day");
  assert.equal(result.firstNegative, null);
});

test("the tools answer in the agents' words, and say when the books are empty", async () => {
  const clock = () => new Date("2026-11-19T09:00:00Z");
  const cash = createMemoryCashBook({ clock });
  const workshop = { book: async () => [order("166", 12_000, { finished: true, received: 12_000 })] };
  const context = { books: { cash }, workshop, clock };

  assert.match((await forecast({ jours: 15 }, context)).info, /journal de caisse est vide/);
  await cash.record({ kind: "entree", amount: 5_000, category: "solde_depart" });
  await cash.record({ kind: "sortie", amount: 3_000, category: "achat_matiere", orderNumber: "166", label: "MDF" });

  const answer = await margins({ du: "", au: "" }, context);
  assert.match(answer.par_commande[0], /BC 166 .* ventes HT 10 000 DH, dépenses 3 000 DH \[Achat de matières 3 000 DH\], marge 7 000 DH \(70 %\)/);
  assert.match(answer.par_produit[0], /^Lit cabane : 1 commande/);

  const outlook = await forecast({ jours: 15 }, context);
  assert.equal(outlook.solde_aujourdhui, "2 000 DH");
  assert.match(outlook.depenses_estimees, /^1 500 DH \(100 DH par jour/);
  assert.equal(outlook.solde_prevu_fin, "500 DH");

  assert.match((await margins({ du: "", au: "" }, { books: {}, clock })).erreur, /je n'ai pas l'information/);
});
