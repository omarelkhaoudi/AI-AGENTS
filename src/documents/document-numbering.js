import { HKIDS_DOCUMENT_TYPES, isControlledDocumentType } from "./document-schema.js";

/**
 * Document numbers are assigned by the company's official register, and this
 * module never substitutes for it.
 *
 * A number identifies a document in the company's accounts. Inventing one would
 * put a document into the world under an identity the register does not know,
 * and two documents could end up sharing it. So when the register cannot be
 * reached, this module says exactly that and returns no number at all. It is a
 * refusal, not a fallback.
 */

// The sentence the cockpit and the documents must show while the register has
// not answered. It is a value rather than a string literal spread around the
// code, so it stays identical everywhere it appears.
export const QUOTE_NUMBER_PENDING_MESSAGE = "Numéro de devis à attribuer après vérification du registre.";

export const NUMBER_PENDING_MESSAGES = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.QUOTE]: QUOTE_NUMBER_PENDING_MESSAGE,
  [HKIDS_DOCUMENT_TYPES.INVOICE]: "Numéro de facture à attribuer après vérification du registre.",
  [HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE]: "Numéro de bon de livraison à attribuer après vérification du registre."
});

// The shape a quote number takes once the register has given a sequence. The
// prefix and the layout are known; the sequence is not, and this module has no
// way of guessing it. `SEQUENCE_PLACEHOLDER` exists so the format can be shown
// to a reader without ever being mistaken for a real number.
export const QUOTE_NUMBER_PREFIX = "DEV-HK";
export const SEQUENCE_PLACEHOLDER = "XXXX";
export const QUOTE_NUMBER_FORMAT = `${QUOTE_NUMBER_PREFIX}-{year}-{sequence}`;

// Only the quote series is known today. The invoice and delivery-note series
// are declared as unknown rather than guessed: the existing H-KIDS invoices are
// numbered plainly, and deciding a prefix here would be inventing one.
export const DOCUMENT_NUMBER_SERIES = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.QUOTE]: Object.freeze({
    prefix: QUOTE_NUMBER_PREFIX,
    format: QUOTE_NUMBER_FORMAT,
    known: true
  }),
  [HKIDS_DOCUMENT_TYPES.INVOICE]: Object.freeze({ prefix: null, format: null, known: false }),
  [HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE]: Object.freeze({ prefix: null, format: null, known: false })
});

export class DocumentNumberingError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "DocumentNumberingError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function pendingMessageFor(documentType) {
  return NUMBER_PENDING_MESSAGES[documentType] ?? null;
}

/**
 * Formats a quote number from a sequence the register supplied.
 *
 * It refuses to run without one. The placeholder in QUOTE_NUMBER_FORMAT is for
 * showing the shape, never for filling in.
 */
export function formatQuoteNumber({ year, sequence } = {}) {
  const parsedYear = Number(year);
  if (!Number.isInteger(parsedYear) || parsedYear < 2000 || parsedYear > 9999) {
    throw new DocumentNumberingError("A quote number needs a four digit year.", "NUMBER_YEAR_INVALID", { year });
  }

  const parsedSequence = Number(sequence);
  if (!Number.isInteger(parsedSequence) || parsedSequence <= 0) {
    throw new DocumentNumberingError(
      "A quote number needs a sequence from the official register. None may be invented.",
      "NUMBER_SEQUENCE_REQUIRED",
      { sequence }
    );
  }

  return `${QUOTE_NUMBER_PREFIX}-${parsedYear}-${String(parsedSequence).padStart(4, "0")}`;
}

/**
 * The register interface, described so an implementation can be plugged in
 * later without touching the callers.
 *
 * An implementation provides:
 *   isAvailable()                      -> boolean
 *   nextSequence(documentType, year)   -> positive integer, or null
 *   isTaken(documentType, number)      -> boolean
 *   reserve(documentType, number)      -> void
 *
 * No implementation ships with the project. Until the company provides one,
 * every request answers `pending_registry`.
 */
export const DOCUMENT_REGISTER_CONTRACT = Object.freeze([
  "isAvailable",
  "nextSequence",
  "isTaken",
  "reserve"
]);

export function isUsableRegister(register) {
  return Boolean(register) && DOCUMENT_REGISTER_CONTRACT.every((method) => typeof register[method] === "function");
}

export function createDocumentNumberingService({ register = null, clock = () => new Date() } = {}) {
  if (register !== null && !isUsableRegister(register)) {
    throw new DocumentNumberingError(
      `A document register must implement ${DOCUMENT_REGISTER_CONTRACT.join(", ")}.`,
      "REGISTER_CONTRACT_INVALID"
    );
  }

  function assertKnownType(documentType) {
    if (!isControlledDocumentType(documentType)) {
      throw new DocumentNumberingError(`Unknown document type: ${documentType}`, "DOCUMENT_TYPE_UNKNOWN", { documentType });
    }
  }

  return Object.freeze({
    /**
     * Asks the register for the next number of a series.
     *
     * Returns a result rather than throwing, because "the register has not
     * answered yet" is a normal state of the file and not a failure: the
     * document is prepared, and the number is filled in once a person has
     * checked the register.
     */
    requestNumber(documentType, { year = clock().getUTCFullYear() } = {}) {
      assertKnownType(documentType);

      if (!register || register.isAvailable() !== true) {
        return Object.freeze({
          status: "pending_registry",
          documentType,
          number: null,
          message: pendingMessageFor(documentType),
          series: DOCUMENT_NUMBER_SERIES[documentType]
        });
      }

      const sequence = register.nextSequence(documentType, year);
      if (!Number.isInteger(sequence) || sequence <= 0) {
        return Object.freeze({
          status: "pending_registry",
          documentType,
          number: null,
          message: pendingMessageFor(documentType),
          series: DOCUMENT_NUMBER_SERIES[documentType]
        });
      }

      const number = documentType === HKIDS_DOCUMENT_TYPES.QUOTE
        ? formatQuoteNumber({ year, sequence })
        : String(sequence);

      if (register.isTaken(documentType, number) === true) {
        throw new DocumentNumberingError(
          `The register already holds ${documentType} number ${number}.`,
          "NUMBER_ALREADY_TAKEN",
          { documentType, number }
        );
      }

      register.reserve(documentType, number);
      return Object.freeze({ status: "assigned", documentType, number, message: null, series: DOCUMENT_NUMBER_SERIES[documentType] });
    },

    /**
     * Records a number a person read from the register, refusing a duplicate.
     * This is the path that will be used first: a human checks the register and
     * types the number in.
     */
    claimNumber(documentType, number) {
      assertKnownType(documentType);
      const claimed = typeof number === "string" ? number.trim() : "";
      if (claimed === "") {
        throw new DocumentNumberingError(
          "A number read from the register cannot be empty.",
          "NUMBER_REQUIRED",
          { documentType }
        );
      }
      if (register && register.isAvailable() === true && register.isTaken(documentType, claimed) === true) {
        throw new DocumentNumberingError(
          `The register already holds ${documentType} number ${claimed}.`,
          "NUMBER_ALREADY_TAKEN",
          { documentType, number: claimed }
        );
      }
      if (register && register.isAvailable() === true) {
        register.reserve(documentType, claimed);
      }
      return Object.freeze({ status: "assigned", documentType, number: claimed, message: null });
    },

    registerAvailable() {
      return Boolean(register) && register.isAvailable() === true;
    }
  });
}

/**
 * A register held in memory, holding nothing until a caller puts something in
 * it. It exists so duplicate prevention can be exercised; it is not the
 * company's register and contains no number of its own.
 */
export function createInMemoryDocumentRegister({ available = true, sequences = {}, taken = {} } = {}) {
  const counters = new Map(Object.entries(sequences));
  const reserved = new Map(
    Object.entries(taken).map(([documentType, numbers]) => [documentType, new Set(numbers)])
  );

  return Object.freeze({
    isAvailable() {
      return available === true;
    },
    nextSequence(documentType) {
      const current = counters.get(documentType);
      if (!Number.isInteger(current) || current <= 0) {
        return null;
      }
      counters.set(documentType, current + 1);
      return current;
    },
    isTaken(documentType, number) {
      return reserved.get(documentType)?.has(number) === true;
    },
    reserve(documentType, number) {
      if (!reserved.has(documentType)) {
        reserved.set(documentType, new Set());
      }
      reserved.get(documentType).add(number);
    }
  });
}
