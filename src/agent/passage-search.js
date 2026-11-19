// The search an agent runs in its reference documents (catalogue, price list,
// procedure, technical sheet). No model and no index to keep: the passages are
// ranked by the words of the question, as the workshop says them.
//
//  - Words, not pieces of words: « lit » finds « lits », not « politique ».
//  - A plural or a feminine is the same word: « armoires », « laquée ».
//  - The trade's synonyms count: a « placard » question finds the
//    « armoire » line, a « tarif » question the « prix ».
//  - A word found in few passages weighs more than one found everywhere:
//    « château » decides, « lit » in a bed catalogue barely does.
//  - The words of the question side by side in the passage (« lit cabane »)
//    rank it above a passage that has them apart.

const STOP_WORDS = new Set([
  "les", "des", "une", "est", "pour", "dans", "avec", "sur", "par", "que", "qui", "quel", "quelle", "quels", "quelles",
  "son", "ses", "aux", "pas", "plus", "the", "and", "combien", "prix", "coute", "coutent", "cout", "notre", "nos",
  "vous", "nous", "elle", "ils", "leur", "leurs", "fait", "faut", "est-ce", "quoi", "comment", "cette", "ces", "donne"
]);

// Words the workshop uses for the same thing. A question word in a group
// finds every word of the group, the word itself counting a little more.
const SYNONYMS = Object.freeze([
  ["prix", "tarif", "tarifs", "cout", "montant"],
  ["armoire", "placard", "penderie", "dressing"],
  ["lit", "couchette"],
  ["superpose", "mezzanine"],
  ["bureau", "table"],
  ["commode", "chiffonnier"],
  ["etagere", "bibliotheque", "rangement"],
  ["delai", "duree", "semaines"],
  ["livraison", "livrer", "transport"],
  ["pose", "montage", "installation"],
  ["acompte", "avance"],
  ["garantie", "sav"],
  ["mdf", "medium"],
  ["laque", "laquage", "peinture"],
  ["dimension", "dimensions", "taille", "mesure", "mesures"],
  ["remise", "reduction", "promotion", "promo"]
]);

const SYNONYMS_OF = new Map();
for (const group of SYNONYMS) {
  for (const word of group) {
    const stem = stemOf(word);
    SYNONYMS_OF.set(stem, [...new Set([...(SYNONYMS_OF.get(stem) ?? []), ...group.map(stemOf)])]);
  }
}

export function fold(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// The same word in the singular masculine: « armoires » → « armoire »,
// « laquées » → « laque », « châteaux » → « chateau ».
export function stemOf(word) {
  let stem = word;
  // « prix » keeps its x, « bureaux » loses it.
  if ((stem.length > 3 && /s$/.test(stem)) || /(au|eu)x$/.test(stem)) {
    stem = stem.slice(0, -1);
  }
  if (stem.length > 4 && /ee$/.test(stem)) {
    stem = stem.slice(0, -1);
  }
  return stem;
}

function wordsOf(text) {
  return fold(text).split(/[^a-z0-9]+/).filter(Boolean);
}

// What the question asks about: its words, without the small ones, each with
// the words that mean the same.
export function queryTerms(query) {
  const words = wordsOf(query);
  // A size (« 140 ») is a word of the question too.
  const meaningful = words.filter((word) => (word.length >= 3 && !STOP_WORDS.has(word)) || /^\d{2,}$/.test(word));
  // A price question is still about prices: the word is kept when it is all
  // there is.
  const kept = meaningful.length > 0 ? meaningful : words.filter((word) => word.length >= 3);
  const stems = [...new Set(kept.map(stemOf))].slice(0, 12);
  return stems.map((stem) => Object.freeze({ stem, alternatives: Object.freeze(SYNONYMS_OF.get(stem) ?? [stem]) }));
}

function counts(text) {
  const stems = wordsOf(text).map(stemOf);
  const map = new Map();
  for (const stem of stems) {
    map.set(stem, (map.get(stem) ?? 0) + 1);
  }
  return { map, stems };
}

// How often a term is in a passage: its own word fully, a synonym for half.
function hitsOf(term, words) {
  let hits = 0;
  for (const alternative of term.alternatives) {
    const count = words.get(alternative) ?? 0;
    hits += alternative === term.stem ? count : count / 2;
  }
  return hits;
}

// The best passages for the question, among { document, title, passage }.
// Each kept one gets its score; none when no word of the question is in it.
export function rankPassages(query, candidates, { limit = 5 } = {}) {
  const terms = queryTerms(query);
  if (terms.length === 0 || candidates.length === 0) {
    return [];
  }
  const read = candidates.map((candidate) => ({ ...candidate, words: counts(candidate.passage), title: counts(candidate.title ?? "").map }));
  // A word found in few passages decides more than a word found in all.
  const total = read.length;
  const weights = terms.map((term) => {
    const found = read.filter((candidate) => hitsOf(term, candidate.words.map) > 0).length;
    return Math.log(1 + total / (1 + found)) + 0.5;
  });
  const pairs = terms.slice(1).map((term, index) => `${terms[index].stem} ${term.stem}`);
  const scored = [];
  for (const candidate of read) {
    let score = 0;
    let matched = 0;
    terms.forEach((term, index) => {
      const hits = hitsOf(term, candidate.words.map);
      if (hits > 0) {
        matched += 1;
        score += weights[index] * (10 + Math.min(hits, 5));
      }
      if (hitsOf(term, candidate.title) > 0) {
        score += weights[index] * 3;
      }
    });
    if (score === 0) {
      continue;
    }
    // Every word of the question there, and side by side: the passage that
    // answers, not one that mentions.
    if (matched === terms.length && terms.length > 1) {
      score += 15;
    }
    const sequence = candidate.words.stems.join(" ");
    score += pairs.filter((pair) => sequence.includes(pair)).length * 8;
    scored.push({ candidate, score });
  }
  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ candidate, score }) => ({ document: candidate.document, passage: candidate.passage, score: Math.round(score * 10) / 10 }));
}
