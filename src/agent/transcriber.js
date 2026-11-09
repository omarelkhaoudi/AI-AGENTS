// Voice notes turned into text, so the Director reads what Hiba said on
// WhatsApp as it reads what she types. Same OpenAI key as the agents; no
// language is imposed, since a note may mix French and Darija.

export const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-transcribe";
// Words the model would otherwise mishear in a furniture workshop's notes.
const VOCABULARY = "H-KIDS, mobilier pour enfants, Marrakech. Devis, bon de commande (BC), facture, acompte, DH, dirhams, lit cabane, CNC, laque, MDF.";

export class TranscriptionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TranscriptionError";
    this.code = code;
  }
}

export function createOpenAiTranscriberFromEnv({ env = process.env, clientFactory = defaultClientFactory } = {}) {
  const apiKey = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  if (apiKey === "") {
    return null;
  }
  const model = typeof env.OPENAI_TRANSCRIBE_MODEL === "string" && env.OPENAI_TRANSCRIBE_MODEL.trim() !== "" ? env.OPENAI_TRANSCRIBE_MODEL.trim() : DEFAULT_TRANSCRIBE_MODEL;
  return createOpenAiTranscriber({ apiKey, model, clientFactory });
}

export function createOpenAiTranscriber({ apiKey, model = DEFAULT_TRANSCRIBE_MODEL, clientFactory = defaultClientFactory }) {
  let client = null;
  return Object.freeze({
    async transcribe({ bytes, mimeType = "audio/ogg", filename = "" }) {
      client ??= await clientFactory({ apiKey });
      const { toFile } = await import("openai");
      const run = async (prompt) => {
        try {
          const result = await client.audio.transcriptions.create({
            file: await toFile(bytes, filename || `vocal.${extensionOf(mimeType)}`, { type: mimeType }),
            model,
            ...(prompt ? { prompt } : {})
          });
          return (typeof result === "string" ? result : String(result?.text ?? "")).trim();
        } catch (cause) {
          throw new TranscriptionError(
            cause?.status === 401 ? "La clé OpenAI est refusée : vérifiez OPENAI_API_KEY dans .env." : "Le message vocal n'a pas pu être transcrit.",
            "TRANSCRIPTION_FAILED"
          );
        }
      };
      const text = await run(VOCABULARY);
      // On a note it hears badly (one of Hiba's, in November 2026) the model
      // gave back the vocabulary itself as what was said. Then it is asked
      // again without it, and the vocabulary is never passed on as words.
      if (!echoesVocabulary(text)) {
        return text;
      }
      const again = await run("");
      return echoesVocabulary(again) ? "" : again;
    }
  });
}

export function echoesVocabulary(text) {
  const words = (value) => value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+/g) ?? [];
  const heard = words(text);
  if (heard.length === 0) {
    return false;
  }
  const vocabulary = new Set(words(VOCABULARY));
  return heard.filter((word) => vocabulary.has(word)).length / heard.length >= 0.8;
}

function extensionOf(mimeType) {
  return { "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr", "audio/wav": "wav", "audio/webm": "webm" }[mimeType] ?? "ogg";
}

async function defaultClientFactory({ apiKey }) {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey });
}
