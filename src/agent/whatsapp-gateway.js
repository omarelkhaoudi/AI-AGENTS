import { SPECIALISTS } from "./agent-team.js";
import { TranscriptionError } from "./transcriber.js";
import { MAX_CNC_FILE_BYTES, WorkshopError, isCncFileName } from "./workshop-book.js";
import { MAX_TEXT_LENGTH, WhatsAppCloudError, parseWebhookMessages } from "../integrations/whatsapp-cloud.js";

// What happens to a message written to the company's WhatsApp number, by who
// wrote it:
// - the direction (WHATSAPP_OWNER_NUMBERS): it is an order for the Director,
//   exactly as if typed in the cockpit, and the Director's answer goes back on
//   WhatsApp. What needs a validation (messages to send, documents) waits in
//   the cockpit, as it does from the cockpit;
// - a team member linked to an agent: it is a report. It goes in the team
//   feed, where the Director and that agent read it, and is acknowledged;
// - anyone else (a client, a supplier): it is kept for the cockpit and nobody
//   answers automatically. A person decides.
//
// The draughtsman of an order (their number is on the order, in the design
// office) reports like a member of the Production team. A G-code or DXF file
// sent by them, by the team or by the direction goes on the order named in its
// caption (« BC 171 »), or on their only order in progress, and waits there for
// the direction's validation, which is told at once.
//
// A voice note from the direction or the team is transcribed first, and its
// words are read like typed ones; a photo or a document from the direction
// reaches the Director as if joined in the cockpit.

// The Director's own limits for what it reads (src/agent/director-agent.js).
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const DOCUMENT_EXTENSIONS = Object.freeze({
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
  "text/csv": "csv"
});
// The Director's errors the sender can act on, told word for word.
const TOLD_AS_IS = Object.freeze(["AGENT_NOT_CONFIGURED", "AGENT_MODEL_UNAVAILABLE", "AGENT_PHOTO_INVALID", "AGENT_FILE_INVALID"]);

export function createWhatsAppGateway({ config, client, inbox, teamBook, agent, workshop = null, transcriber = null, log = () => {} }) {
  // One number's messages are handled in the order they came.
  const lanes = new Map();
  const inLane = (number, task) => {
    const run = (lanes.get(number) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => {});
    lanes.set(number, settled);
    settled.then(() => {
      if (lanes.get(number) === settled) {
        lanes.delete(number);
      }
    });
    return run;
  };

  async function teamMemberOf(number) {
    const members = await teamBook.members();
    const found = Object.entries(members).find(([, member]) => member.phone === number);
    return found ? { agent: found[0], member: found[1] } : null;
  }

  // The orders in progress this number draws for, with its name.
  async function drafterOf(number) {
    if (!workshop) {
      return null;
    }
    const orders = (await workshop.book()).filter((order) => !order.finished && order.team?.drafterPhone === number);
    return orders.length > 0 ? { name: orders[0].team.drafter || "Dessinateur", orders } : null;
  }

  async function send({ to, text, name = "", by, kind = "autre" }) {
    if (!client) {
      throw new WhatsAppCloudError("L'API WhatsApp Business n'est pas configurée.", "WHATSAPP_NOT_CONFIGURED");
    }
    try {
      const result = await client.sendText(to, text);
      return await inbox.sent({ number: result.to, name, text: text.slice(0, MAX_TEXT_LENGTH), by, kind, metaId: result.id });
    } catch (error) {
      if (error instanceof WhatsAppCloudError) {
        await inbox.sent({ number: String(to), name, text, by, kind, status: "failed", error: error.message });
      }
      throw error;
    }
  }

  // What the file joined to a message brings: the words of a voice note, a
  // photo or a document for the Director. A file that cannot be read gives a
  // problem to tell the sender, never a guess.
  async function readMedia(message, { forDirector }) {
    const media = message.media;
    if (!media) {
      return {};
    }
    try {
      if (message.type === "audio") {
        if (!transcriber) {
          return { problem: "Je ne peux pas écouter les vocaux : la clé OpenAI n'est pas configurée. Écrivez-moi le message." };
        }
        const file = await client.downloadMedia(media.id);
        const heard = await transcriber.transcribe({ bytes: file.bytes, mimeType: file.mimeType || media.mimeType });
        return heard ? { heard } : { problem: "Je n'ai rien entendu dans ce vocal. Pouvez-vous le refaire ou l'écrire ?" };
      }
      if (!forDirector) {
        return {};
      }
      if (message.type === "image") {
        const file = await client.downloadMedia(media.id, { maxBytes: MAX_PHOTO_BYTES });
        const mimeType = file.mimeType || media.mimeType;
        if (!["image/jpeg", "image/png"].includes(mimeType)) {
          return { problem: "Je ne lis que les photos JPEG ou PNG." };
        }
        return { photos: [`data:${mimeType};base64,${file.bytes.toString("base64")}`] };
      }
      if (message.type === "document") {
        const file = await client.downloadMedia(media.id, { maxBytes: MAX_DOCUMENT_BYTES });
        const name = media.filename || `document.${DOCUMENT_EXTENSIONS[file.mimeType] ?? "pdf"}`;
        return { files: [{ name, data: `data:${file.mimeType || "application/octet-stream"};base64,${file.bytes.toString("base64")}` }] };
      }
      return { problem: "Je ne lis pas les vidéos ni les autocollants. Écrivez-moi le message, ou envoyez une photo." };
    } catch (error) {
      if (error instanceof WhatsAppCloudError || error instanceof TranscriptionError) {
        return { problem: `${error.message} Écrivez-moi le message, ou envoyez la pièce depuis le cockpit.` };
      }
      throw error;
    }
  }

  async function fromDirection(message, recorded) {
    const read = await readMedia(message, { forDirector: true });
    if (read.heard) {
      await inbox.transcribed(recorded.id, [read.heard, message.text].filter(Boolean).join("\n\n"));
    }
    const typed = [read.heard ? `(Message vocal) ${read.heard}` : "", message.text].filter(Boolean).join("\n\n");
    const hasContent = typed !== "" || read.photos || read.files;
    if (!hasContent) {
      return reply(message, read.problem ?? "Je n'ai rien trouvé à lire dans ce message.");
    }
    let answer;
    try {
      const outcome = await agent.chat({
        message: typed,
        photos: read.photos ?? [],
        files: read.files ?? [],
        conversationId: await inbox.conversationOf(message.from),
        userId: `whatsapp:${message.from}`
      });
      await inbox.setConversation(message.from, outcome.conversationId);
      answer = [outcome.reply, ...waiting(outcome)].join("\n\n");
    } catch (error) {
      log(error);
      answer = TOLD_AS_IS.includes(error.code)
        ? error.message
        : "Je n'ai pas pu traiter ce message. Réessayez dans un instant, ou passez par le cockpit.";
    }
    // What was heard comes first, so a misheard word is caught at once.
    return reply(message, [
      read.heard ? `J'ai entendu : « ${clip(read.heard, 500)} »` : "",
      read.problem ?? "",
      answer
    ].filter(Boolean).join("\n\n"));
  }

  async function fromTeam(message, { agent: agentId, member }, recorded) {
    const label = SPECIALISTS[agentId]?.label ?? agentId;
    const read = await readMedia(message, { forDirector: false });
    if (read.heard) {
      await inbox.transcribed(recorded.id, [read.heard, message.text].filter(Boolean).join("\n\n"));
    }
    const said = [read.heard ? `(vocal) ${read.heard}` : "", message.text].filter(Boolean).join(" — ");
    await teamBook.log({
      agent: agentId,
      kind: "compte_rendu",
      text: `Compte rendu de ${member.name} par WhatsApp : ${said || `(${message.type} sans texte)`}`,
      by: member.name
    });
    return reply(message, [
      `Bien reçu, ${member.name}. Votre compte rendu est transmis à la direction et à l'agent ${label}.`,
      read.problem && !said ? read.problem : ""
    ].filter(Boolean).join("\n\n"));
  }

  // A machine file: on its order, waiting for the direction. A draughtsman
  // only reaches the orders they draw for.
  async function fromDrafting(message, { name, orders = null }) {
    const named = orderNumberIn(message.text) ?? orderNumberIn(message.media.filename);
    const mine = orders?.map((order) => order.number) ?? null;
    const number = named ?? (mine?.length === 1 ? mine[0] : null);
    if (!number) {
      return reply(message, mine?.length > 1
        ? `Pour quel bon de commande ? Vous dessinez les BC n° ${mine.join(", ")}. Renvoyez le fichier avec « BC ${mine[0]} » en légende.`
        : "Pour quel bon de commande ? Renvoyez le fichier avec « BC 171 » (son numéro) en légende.");
    }
    if (mine && !mine.includes(number)) {
      return reply(message, `Vous n'êtes pas enregistré comme dessinateur du BC n° ${number}. Vos commandes en cours : BC n° ${mine.join(", ")}.`);
    }
    let order;
    try {
      const file = await client.downloadMedia(message.media.id, { maxBytes: MAX_CNC_FILE_BYTES });
      await workshop.depositCncFile(number, { content: file.bytes, name: message.media.filename, note: message.text, by: name });
      order = await workshop.order(number);
    } catch (error) {
      if (error instanceof WorkshopError || error instanceof WhatsAppCloudError) {
        return reply(message, `Fichier non enregistré : ${error.message}`);
      }
      throw error;
    }
    const fileName = order.cnc.at(-1).name;
    await teamBook.log({ agent: "production", kind: "atelier", text: `BC ${number} (${order.client}) — fichier CNC « ${fileName} » reçu de ${name} par WhatsApp, à valider par la direction.`, ref: `bc:${number}`, by: name });
    await reply(message, `Bien reçu, ${name}. « ${fileName} » est enregistré sur le BC n° ${number} (${order.client}). Il attend la validation de la direction ; la découpe commencera après.`);
    // The direction is told at once; a number outside its 24-hour window
    // sees it in the cockpit instead.
    for (const owner of config.ownerNumbers.filter((candidate) => candidate !== message.from)) {
      await send({ to: owner, text: `${name} a envoyé le fichier CNC « ${fileName} » pour le BC n° ${number} (${order.client}) : à valider dans le cockpit, vue Atelier, avant la découpe.`, by: "director", kind: "alerte" }).catch(log);
    }
  }

  async function reply(message, text) {
    try {
      await send({ to: message.from, text, name: message.name, by: "director", kind: "reponse" });
    } catch (error) {
      log(error);
    }
  }

  async function handle(message) {
    const owner = config.ownerNumbers.includes(message.from);
    const team = owner ? null : await teamMemberOf(message.from);
    const drafter = owner || team ? null : await drafterOf(message.from);
    const sender = owner ? "direction" : team || drafter ? "equipe" : "contact";
    const recorded = await inbox.receive({
      metaId: message.id,
      number: message.from,
      name: team?.member.name ?? drafter?.name ?? message.name,
      sender,
      agent: team?.agent ?? (drafter ? "production" : null),
      type: message.type,
      text: message.text,
      at: message.at
    });
    if (!recorded) {
      return;
    }
    if (workshop && message.type === "document" && isCncFileName(message.media?.filename) && (owner || team || drafter)) {
      await fromDrafting(message, { name: owner ? "La direction" : team?.member.name ?? drafter.name, orders: drafter?.orders ?? null });
    } else if (owner) {
      await fromDirection(message, recorded);
    } else if (team) {
      await fromTeam(message, team, recorded);
    } else if (drafter) {
      await fromTeam(message, { agent: "production", member: { name: drafter.name } }, recorded);
    }
  }

  return Object.freeze({
    configured: Boolean(client),

    // A webhook call. Each message is handled in the background, so Meta gets
    // its answer at once and does not send the call again.
    receive(body) {
      const messages = parseWebhookMessages(body);
      return Promise.all(messages.map((message) => inLane(message.from, () => handle(message).catch(log))));
    },

    send,

    // For tests: resolves once every number's messages were handled.
    async idle() {
      while (lanes.size > 0) {
        await Promise.all(lanes.values());
      }
    }
  });
}

// What waits in the cockpit after the Director's answer.
function waiting(outcome) {
  const lines = [];
  if (outcome.messages?.length > 0) {
    lines.push(`${outcome.messages.length} message(s) préparé(s) : à relire et envoyer depuis le cockpit.`);
  }
  if (outcome.documents?.length > 0) {
    lines.push(`${outcome.documents.length} document(s) préparé(s) : à retrouver dans le cockpit.`);
  }
  return lines;
}

// « BC 171 », « bon de commande n° 171 », « BC171_panneaux.nc ».
function orderNumberIn(text) {
  return /(?<![a-z])(?:bc|bon de commande|commande)[\s_-]*(?:n\s*[°o.]?\s*)?(\d{2,6})(?!\d)/i.exec(String(text ?? ""))?.[1] ?? null;
}

function clip(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
