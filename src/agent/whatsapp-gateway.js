import { SPECIALISTS } from "./agent-team.js";
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

export function createWhatsAppGateway({ config, client, inbox, teamBook, agent, log = () => {} }) {
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

  async function fromDirection(message) {
    if (message.text === "") {
      return reply(message, "Je ne lis pas encore les photos, vocaux ni fichiers envoyés par WhatsApp. Écrivez-moi le message, ou envoyez la pièce depuis le cockpit.");
    }
    let answer;
    try {
      const outcome = await agent.chat({
        message: message.text,
        conversationId: await inbox.conversationOf(message.from),
        userId: `whatsapp:${message.from}`
      });
      await inbox.setConversation(message.from, outcome.conversationId);
      answer = [outcome.reply, ...waiting(outcome)].join("\n\n");
    } catch (error) {
      log(error);
      answer = error.code === "AGENT_NOT_CONFIGURED" || error.code === "AGENT_MODEL_UNAVAILABLE"
        ? error.message
        : "Je n'ai pas pu traiter ce message. Réessayez dans un instant, ou passez par le cockpit.";
    }
    return reply(message, answer);
  }

  async function fromTeam(message, { agent: agentId, member }) {
    const label = SPECIALISTS[agentId]?.label ?? agentId;
    await teamBook.log({
      agent: agentId,
      kind: "compte_rendu",
      text: `Compte rendu de ${member.name} par WhatsApp : ${message.text || `(${message.type} sans texte)`}`,
      by: member.name
    });
    return reply(message, `Bien reçu, ${member.name}. Votre compte rendu est transmis à la direction et à l'agent ${label}.`);
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
    const sender = owner ? "direction" : team ? "equipe" : "contact";
    const recorded = await inbox.receive({
      metaId: message.id,
      number: message.from,
      name: team?.member.name ?? message.name,
      sender,
      agent: team?.agent ?? null,
      type: message.type,
      text: message.text,
      at: message.at
    });
    if (!recorded) {
      return;
    }
    if (owner) {
      await fromDirection(message);
    } else if (team) {
      await fromTeam(message, team);
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
