// French, Arabic and Darija (CDC section 3: « compréhension du français, de
// l'arabe, de la darija et des notes vocales »). The agents read all three, in
// Arabic letters or in Latin ones with digits (« 3 » for ع, « 7 » for ح, « 9 »
// for ق). Documents stay in French.
//
// The trap is money: in Darija an amount is often counted in rials or
// centimes, twenty to the dirham. « mlyoun » is 10 000 DH, « 100 alf » usually
// 100 000 rials, 5 000 DH. An agent reading « mlyoun » as a million would record
// a payment a hundred times too big, so the cockpit spots these words itself,
// works out the dirhams and has the amount confirmed before anything is kept.

const UNDERSTAND = "Langues : on écrit en français, en arabe ou en darija marocaine, en lettres arabes ou latines (« 3 » = ع, « 7 » = ح, « 9 » = ق, « 2 » = ء, « 5 » = خ ; ex. « bghit devis dyal sarir », « chhal khelsat Mme Alami ? »), et une note vocale transcrite peut mélanger les trois. Comprends-les toutes, sans demander de traduire.";
const DIRECTION_REPLY = "Réponds à la direction dans sa langue : en français si elle écrit en français ou mélange les langues, en darija (dans la même écriture qu'elle) si elle n'écrit qu'en darija ou en arabe ; ne mélange jamais lettres arabes et latines dans un même mot ou une même phrase. Une mission confiée à un responsable s'écrit toujours en français, montants en DH.";
const DRAFTS = "Un message préparé pour un client est écrit dans la langue et l'écriture du client quand on la connaît (ses messages, la mission), en français sinon. Les documents (devis, factures, bons…) restent toujours en français, comme les noms de produits du catalogue.";
const AMOUNTS = "Montants en darija : on compte souvent en rials (20 rials = 1 DH) ou en centimes (100 centimes = 1 DH). « mlyoun » / « مليون » = 10 000 DH ; « jouj mlayn » = 20 000 DH ; « alf ryal » = 50 DH ; « 100 alf » sans unité = le plus souvent 100 000 rials = 5 000 DH ; « alf derham » / « ألف درهم » = 1 000 DH. Quand un montant est dit ainsi, écris l'équivalent en DH et fais-le confirmer en une question (« Je comprends 10 000 DH, c'est bien ça ? ») AVANT de l'enregistrer en caisse, de le mettre dans un document ou de le transmettre à un responsable.";

// For the Director, who talks with the direction.
export const DIRECTOR_LANGUAGE_RULE = [UNDERSTAND, DIRECTION_REPLY, DRAFTS, AMOUNTS].join("\n");
// For the specialists, who answer the Director in French but read the
// clients' messages and write to them.
export const TEAM_LANGUAGE_RULE = [UNDERSTAND, DRAFTS, AMOUNTS].join("\n");

const DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
const COUNTS = new Map([
  ["wa7ed", 1], ["wahed", 1], ["jouj", 2], ["jooj", 2], ["juj", 2], ["zouj", 2], ["tlata", 3], ["tlat", 3], ["rb3a", 4], ["reb3a", 4], ["arba3a", 4], ["khamsa", 5], ["5amsa", 5], ["setta", 6], ["sitta", 6], ["sb3a", 7], ["seb3a", 7], ["tmenya", 8], ["tmanya", 8], ["ts3ud", 9], ["tes3oud", 9], ["3achra", 10], ["achra", 10],
  ["واحد", 1], ["جوج", 2], ["زوج", 2], ["تلاتة", 3], ["ثلاثة", 3], ["ربعة", 4], ["أربعة", 4], ["خمسة", 5], ["ستة", 6], ["سبعة", 7], ["تمنية", 8], ["تسعود", 9], ["عشرة", 10]
]);
const HALF = /^(?:o\s*nos|w\s*nos|ou\s*nos|و\s*نص|ونص)/i;

function dh(value) {
  return `${Math.round(value).toLocaleString("fr-FR").replace(/ | /g, " ")} DH`;
}

function countBefore(words) {
  const last = words.at(-1) ?? "";
  if (/^\d+(?:[.,]\d+)?$/.test(last)) {
    return Number(last.replace(",", "."));
  }
  return COUNTS.get(last.toLowerCase()) ?? null;
}

// The Darija amounts in a message, each with what it is in dirhams. Only the
// ways of saying that are not in doubt: « mlyoun » and « ryal », said with
// their unit. A bare « 100 alf » is flagged, its unit to be asked.
export function darijaAmounts(text) {
  const said = String(text ?? "").replace(/[٠-٩]/g, (digit) => DIGITS[digit]);
  const found = [];
  // Whole words only: « malfaçon » holds no « alf ».
  const pattern = /(?<![\p{L}])(mly?o?u?n|mlayen|mlayn|mlyoun|malayin|مليون|ملايين|ملاين|alf|alaf|ألف|الف|آلاف|ryal|riyal|rial|ريال|centimes?|santim|سنتيم)(?![\p{L}])/giu;
  let match;
  while ((match = pattern.exec(said)) !== null) {
    const word = match[0].toLowerCase();
    const before = said.slice(0, match.index).trim().split(/\s+/).filter(Boolean);
    const after = said.slice(match.index + match[0].length);
    const isMillion = /^(?:mly?o?u?n|mlayen|mlayn|mlyoun|malayin|مليون|ملايين|ملاين)$/i.test(word);
    const isThousand = /^(?:alf|alaf|ألف|الف|آلاف)$/i.test(word);
    const isRial = /^(?:ryal|riyal|rial|ريال|centimes?|santim|سنتيم)$/i.test(word);
    if (isMillion) {
      const count = countBefore(before) ?? (/(mlayen|mlayn|ملايين|ملاين|malayin)/i.test(word) ? null : 1);
      if (count !== null) {
        const half = HALF.test(after.trim()) ? 0.5 : 0;
        found.push({ said: [before.at(-1) && countBefore(before) !== null ? before.at(-1) : "", match[0], half ? "o nos" : ""].filter(Boolean).join(" "), dirhams: (count + half) * 10_000 });
      }
    } else if (isThousand) {
      const count = countBefore(before) ?? 1;
      const unit = /^\s*(ryal|riyal|rial|ريال|centimes?|santim|سنتيم|derham|dirham|dh|درهم)/i.exec(after)?.[1]?.toLowerCase() ?? "";
      if (/^(ryal|riyal|rial|ريال|centimes?|santim|سنتيم)$/.test(unit)) {
        const perDirham = /^(ryal|riyal|rial|ريال)$/.test(unit) ? 20 : 100;
        found.push({ said: `${countBefore(before) !== null ? before.at(-1) : ""} ${match[0]} ${unit}`.trim(), dirhams: count * 1000 / perDirham });
        pattern.lastIndex = match.index + match[0].length + unit.length + 1;
      } else if (!unit && count >= 10) {
        found.push({ said: `${count} ${match[0]}`, dirhams: count * 1000 / 20, doubtful: true });
      }
    } else if (isRial) {
      const count = countBefore(before);
      if (count !== null && !/(alf|alaf|ألف|الف|آلاف)$/i.test(before.at(-1) ?? "")) {
        found.push({ said: `${before.at(-1)} ${match[0]}`, dirhams: count / (/^(ryal|riyal|rial|ريال)$/.test(word) ? 20 : 100) });
      }
    }
  }
  // « 50 centimes » is no trap worth a question.
  return found.filter((amount) => amount.dirhams >= 1);
}

// What the cockpit tells the agents about the amounts it spotted: added to the
// turn's briefing, never to what the person wrote.
export function darijaAmountNote(text) {
  const found = darijaAmounts(text);
  if (found.length === 0) {
    return "";
  }
  const lines = found.map((amount) => amount.doubtful
    ? `« ${amount.said} » = ${dh(amount.dirhams)} si ce sont des rials (le plus courant), ${dh(amount.dirhams * 20)} si ce sont des dirhams : à demander`
    : `« ${amount.said} » = ${dh(amount.dirhams)}`);
  return `Note du cockpit, montants en darija repérés dans ce message : ${lines.join(" ; ")}. Fais confirmer le montant en DH avant de l'enregistrer, de le mettre dans un document ou de le transmettre.`;
}

// A team member's word on their task, in French or Darija: « tâche 4 résolue »,
// « mohima 4 salat », « المهمة 4 تقضات », « ana 3la tâche 4 ».
const TASK_NUMBER = /(?:t[âa]che|mo?u?hi?mm?a|مهمة|المهمة|مهمه)\s*(?:n\s*[°o.]?\s*|رقم\s*)?(\d+|[٠-٩]+)/i;
const RESOLVED = /r[ée]solu|r[ée]gl[ée]|termin[ée]|\bfini|\bsal(?:a|at|it|et)\b|\btsal(?:a|at)\b|\bkmmel(?:t|at)?\b|\bkmel(?:t|at)?\b|\bt9ad(?:a|at)\b|\btqad(?:a|at)\b|\bsafi\b|تسالات|سالات|ساليت|كملت|كملات|تقضات|تقادات|صافي/i;
const TAKEN = /prise? en charge|m'en occupe|en cours|ana\s*3l(?:i|ih)ha|ana\s*3liha|ghadi\s*n?dir(?:ha)?|kan(?:dir|khdem)\s*(?:fiha|3liha)|انا\s*عليها|أنا\s*عليها|غادي\s*ندير|كنخدم\s*عليها/i;

export function taskWords(said) {
  const text = String(said ?? "").replace(/[٠-٩]/g, (digit) => DIGITS[digit]);
  const number = TASK_NUMBER.exec(text)?.[1] ?? null;
  if (!number) {
    return null;
  }
  const action = RESOLVED.test(text) ? "resolue" : TAKEN.test(text) ? "prise_en_charge" : null;
  return action ? { number, action } : null;
}
