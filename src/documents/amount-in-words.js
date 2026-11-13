// An amount in dirhams written out in French, as a Moroccan receipt or credit
// note states it: « Arrêté le présent reçu à la somme de : douze mille cinq
// cents dirhams ». The traditional spelling is used: hyphens between tens and
// units only, « et » before un and onze, « vingts » and « cents » plural only
// when nothing follows.

const UNITS = Object.freeze([
  "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf",
  "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"
]);
const TENS = Object.freeze(["", "", "vingt", "trente", "quarante", "cinquante", "soixante"]);

// 0 to 99.
function belowHundred(value, { final }) {
  if (value < 20) {
    return UNITS[value];
  }
  if (value < 70) {
    const ten = Math.floor(value / 10);
    const unit = value % 10;
    if (unit === 0) {
      return TENS[ten];
    }
    return unit === 1 ? `${TENS[ten]} et un` : `${TENS[ten]}-${UNITS[unit]}`;
  }
  if (value < 80) {
    return value === 71 ? "soixante et onze" : `soixante-${UNITS[value - 60]}`;
  }
  if (value === 80) {
    return final ? "quatre-vingts" : "quatre-vingt";
  }
  return `quatre-vingt-${UNITS[value - 80]}`;
}

// 0 to 999. final: nothing follows, so « cents » and « vingts » take their s.
function belowThousand(value, { final }) {
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const parts = [];
  if (hundreds === 1) {
    parts.push("cent");
  } else if (hundreds > 1) {
    parts.push(rest === 0 && final ? `${UNITS[hundreds]} cents` : `${UNITS[hundreds]} cent`);
  }
  if (rest > 0) {
    parts.push(belowHundred(rest, { final }));
  }
  return parts.join(" ");
}

export function integerInWords(value) {
  const number = Math.floor(Math.abs(Number(value)));
  if (!Number.isFinite(number)) {
    return "";
  }
  if (number === 0) {
    return UNITS[0];
  }
  const millions = Math.floor(number / 1_000_000);
  const thousands = Math.floor((number % 1_000_000) / 1000);
  const rest = number % 1000;
  const parts = [];
  if (millions > 0) {
    parts.push(`${belowThousand(millions, { final: true })} million${millions > 1 ? "s" : ""}`);
  }
  if (thousands > 0) {
    // « mille » never takes an s, and « un mille » is just « mille ».
    parts.push(thousands === 1 ? "mille" : `${belowThousand(thousands, { final: false })} mille`);
  }
  if (rest > 0) {
    parts.push(belowThousand(rest, { final: true }));
  }
  return parts.join(" ");
}

// 12500 → « douze mille cinq cents dirhams » ; 1250.5 → « mille deux cent
// cinquante dirhams et cinquante centimes ».
export function dirhamsInWords(value) {
  const cents = Math.round(Math.abs(Number(value)) * 100);
  if (!Number.isFinite(cents)) {
    return "";
  }
  const dirhams = Math.floor(cents / 100);
  const centimes = cents % 100;
  const main = `${integerInWords(dirhams)} dirham${dirhams > 1 ? "s" : ""}`;
  // « un million de dirhams », « deux millions de dirhams ».
  const withDe = dirhams > 0 && dirhams % 1_000_000 === 0 ? main.replace(/ dirham/, " de dirham") : main;
  return centimes > 0 ? `${withDe} et ${integerInWords(centimes)} centime${centimes > 1 ? "s" : ""}` : withDe;
}
