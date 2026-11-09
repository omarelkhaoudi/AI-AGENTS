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
      let result;
      try {
        result = await client.audio.transcriptions.create({
          file: await toFile(bytes, filename || `vocal.${extensionOf(mimeType)}`, { type: mimeType }),
          model,
          prompt: VOCABULARY
        });
      } catch (cause) {
        throw new TranscriptionError(
          cause?.status === 401 ? "La clé OpenAI est refusée : vérifiez OPENAI_API_KEY dans .env." : "Le message vocal n'a pas pu être transcrit.",
          "TRANSCRIPTION_FAILED"
        );
      }
      const text = typeof result === "string" ? result : String(result?.text ?? "");
      return text.trim();
    }
  });
}

function extensionOf(mimeType) {
  return { "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr", "audio/wav": "wav", "audio/webm": "webm" }[mimeType] ?? "ogg";
}

async function defaultClientFactory({ apiKey }) {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey });
}
