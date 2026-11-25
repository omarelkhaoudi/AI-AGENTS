import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { TranscriptionError } from "../src/agent/transcriber.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// The Briefing's microphone: the recording goes to the same transcriber as
// WhatsApp's voice notes, and what was said comes back as text. The words are
// invented; the "audio" is filler bytes, since the transcriber is a stand-in.
const AUDIO = Buffer.alloc(4000, 7).toString("base64");

async function api(t, transcriber) {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), whatsAppTranscriber: transcriber });
  t.after(() => app.close());
  return (payload) => inject({ method: "POST", url: "/api/agent/transcribe", payload });
}

test("what is said in the cockpit comes back as text, from the browsers' formats", async (t) => {
  const heard = [];
  const send = await api(t, { transcribe: async ({ bytes, mimeType }) => { heard.push([bytes.length, mimeType]); return "Bghit devis dyal sarir cabane"; } });

  const response = await send({ audio: `data:audio/webm;codecs=opus;base64,${AUDIO}`, mimeType: "audio/webm;codecs=opus" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(JSON.parse(response.body).text, "Bghit devis dyal sarir cabane");
  assert.deepEqual(heard, [[4000, "audio/webm"]], "the codecs are dropped, the bytes passed whole");
  assert.equal((await send({ audio: AUDIO, mimeType: "audio/mp4" })).statusCode, 200, "Safari records mp4");
});

test("a bad recording, silence or a failing model is said, never guessed", async (t) => {
  const answers = ["", new TranscriptionError("Le message vocal n'a pas pu être transcrit.", "TRANSCRIPTION_FAILED")];
  const send = await api(t, { transcribe: async () => { const next = answers.shift(); if (next instanceof Error) throw next; return next; } });
  const code = async (payload) => { const response = await send(payload); return [response.statusCode, JSON.parse(response.body).details?.code]; };

  assert.deepEqual(await code({ audio: AUDIO, mimeType: "video/mp4" }), [400, "VOICE_AUDIO_INVALID"]);
  assert.deepEqual(await code({ audio: "pas du base64 !", mimeType: "audio/webm" }), [400, "VOICE_AUDIO_INVALID"]);
  assert.deepEqual(await code({ audio: "AAAA", mimeType: "audio/webm" }), [400, "VOICE_AUDIO_INVALID"], "too short to be speech");
  assert.deepEqual(await code({ audio: AUDIO, mimeType: "audio/webm" }), [422, "VOICE_NOTHING_HEARD"]);
  assert.deepEqual(await code({ audio: AUDIO, mimeType: "audio/webm" }), [502, "TRANSCRIPTION_FAILED"]);
});

test("without the OpenAI key the microphone says it is not available", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), whatsAppTranscriber: null });
  t.after(() => app.close());
  const status = JSON.parse((await inject({ method: "GET", url: "/api/agent/status" })).body);
  assert.equal(status.voice, false);
  const response = await inject({ method: "POST", url: "/api/agent/transcribe", payload: { audio: AUDIO, mimeType: "audio/webm" } });
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).details.code, "VOICE_NOT_CONFIGURED");
});
