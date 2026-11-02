/**
 * What a commercial file needs before an installation can be planned, and what
 * is still missing from it.
 *
 * This module reports; it never fills anything in. A delivery date nobody gave,
 * a floor nobody stated, a handle model nobody chose — each of them is a
 * question for the customer, and answering it here would put an invented fact
 * on a document that goes out under the company's name.
 */

export const PROJECT_INFORMATION_FIELDS = Object.freeze([
  Object.freeze({ id: "desiredDeliveryDate", label: "Date de livraison souhaitée", critical: true }),
  Object.freeze({ id: "fullAddress", label: "Adresse complète", critical: true }),
  Object.freeze({ id: "floor", label: "Étage", critical: true }),
  Object.freeze({ id: "elevator", label: "Ascenseur", critical: true }),
  Object.freeze({ id: "finalDimensions", label: "Dimensions finales", critical: true }),
  Object.freeze({ id: "railPosition", label: "Position de la glissière", critical: false }),
  Object.freeze({ id: "powerOutlets", label: "Prises électriques", critical: false }),
  Object.freeze({ id: "colours", label: "Couleurs", critical: false }),
  Object.freeze({ id: "handleModel", label: "Modèle de poignées", critical: false }),
  Object.freeze({ id: "wallpaperVisual", label: "Visuel papier peint", critical: false }),
  Object.freeze({ id: "truckAccess", label: "Accès camion", critical: true }),
  Object.freeze({ id: "personPresentAtInstallation", label: "Personne présente à l'installation", critical: true })
]);

// A field is answered when it holds something a person actually wrote. A
// placeholder is not an answer, and neither is a blank.
const NON_ANSWERS = Object.freeze(["", "-", "?", "n/a", "na", "à définir", "a definir", "à compléter", "a completer", "tbd"]);

export function isAnswered(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  const text = String(value).trim();
  return text !== "" && !NON_ANSWERS.includes(text.toLowerCase());
}

export const INFORMATION_STATUSES = Object.freeze({
  PROVIDED: "provided",
  MISSING: "missing"
});

/**
 * Every field of the file, said to be answered or not.
 *
 * Listing only what is missing leaves a reader unable to tell a field that was
 * answered from one nobody thought to ask about. Both are reported, in the
 * order of PROJECT_INFORMATION_FIELDS, so two runs on the same file read the
 * same way.
 *
 * An answered field carries the value as it was given. Nothing is completed,
 * normalised or guessed: this module still only reports.
 */
export function reviewProjectInformation(project = {}) {
  return Object.freeze(PROJECT_INFORMATION_FIELDS.map((field) => {
    const answered = isAnswered(project[field.id]);
    return Object.freeze({
      id: field.id,
      label: field.label,
      critical: field.critical,
      status: answered ? INFORMATION_STATUSES.PROVIDED : INFORMATION_STATUSES.MISSING,
      // The value as the caller gave it, and null when there is none — never a
      // placeholder standing in for an answer.
      value: answered ? project[field.id] : null,
      // Said plainly, because this text is meant to be shown to whoever has to
      // go and ask the customer.
      message: answered
        ? `${field.label} : renseignée.`
        : `${field.label} : information manquante, à demander au client.`
    });
  }));
}

/**
 * Lists what the file does not yet state. A filter over the review above, so
 * there is one place that decides whether a field counts as answered.
 */
export function detectMissingInformation(project = {}) {
  return Object.freeze(
    reviewProjectInformation(project).filter((entry) => entry.status === INFORMATION_STATUSES.MISSING)
  );
}

export function detectProvidedInformation(project = {}) {
  return Object.freeze(
    reviewProjectInformation(project).filter((entry) => entry.status === INFORMATION_STATUSES.PROVIDED)
  );
}

export function hasCriticalMissingInformation(project = {}) {
  return detectMissingInformation(project).some((entry) => entry.critical);
}

/**
 * A one-line summary for a cockpit card. Returns null when nothing is missing,
 * so the caller can tell "nothing to report" from "not computed".
 */
export function summariseMissingInformation(project = {}) {
  const missing = detectMissingInformation(project);
  if (missing.length === 0) {
    return null;
  }
  const critical = missing.filter((entry) => entry.critical).length;
  return `${missing.length} information(s) manquante(s), dont ${critical} bloquante(s) pour l'installation.`;
}
