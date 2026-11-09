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
// Tasks (CDC recette scenario 5): the person a task is given to is told, and
// answers « tâche 4 prise en charge », then « tâche 4 résolue : … »; the
// direction is told it is resolved and answers « clôture tâche 4 » (or
// « rouvrir tâche 4 : … »). A grave anomaly is told to the direction at once,
// the others in a summary each morning, and a task past its deadline is
// reminded to its person each day until it is resolved.
//
// The chef de charge and the draughtsman of an order (their numbers are on the
// order, in the design office) report like members of the Production team.
// The chef de charge is told on WhatsApp of each step of their order that
// gets blocked or late, once per anomaly. A G-code or DXF file
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

export function createWhatsAppGateway({ config, client, inbox, teamBook, agent, workshop = null, recordFollowUp = null, tasks = null, transcriber = null, log = () => {} }) {
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

  // Who this number is on the orders in progress: their chef de charge, their
  // draughtsman. orders: those they draw for.
  async function orderPersonOf(number) {
    if (!workshop) {
      return null;
    }
    const open = (await workshop.book()).filter((order) => !order.finished);
    const orders = open.filter((order) => order.team?.drafterPhone === number);
    const leads = open.filter((order) => order.team?.leadPhone === number);
    if (orders.length === 0 && leads.length === 0) {
      return null;
    }
    return { name: orders[0]?.team.drafter || leads[0]?.team.lead || "Équipe atelier", orders };
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
    const task = await fromTaskWords(said, member.name);
    // « Relance du devis 170 faite, elle réfléchit » is a follow-up made.
    const quote = /relanc/i.test(said) ? /devis\s*(?:n\s*[°o.]?\s*)?(\d{2,6})(?!\d)/i.exec(said)?.[1] : null;
    const followUp = quote && recordFollowUp ? await recordFollowUp(quote, { note: said, by: member.name }) : null;
    return reply(message, [
      `Bien reçu, ${member.name}. Votre compte rendu est transmis à la direction et à l'agent ${label}.`,
      followUp ? (followUp.ok ? `Relance du devis n° ${quote} enregistrée.` : followUp.erreur) : "",
      task ?? "",
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

  // « tâche 4 prise en charge », « je m'en occupe, tâche 4 », « tâche 4
  // résolue : … » from the person it was given to. Returns what to answer.
  async function fromTaskWords(said, by) {
    const number = tasks ? /t[âa]che\s*(?:n\s*[°o.]?\s*)?(\d+)/i.exec(said)?.[1] : null;
    if (!number) {
      return null;
    }
    const action = /r[ée]solu|r[ée]gl[ée]|termin[ée]|\bfini/i.test(said) ? "resolue" : /prise? en charge|m'en occupe|en cours/i.test(said) ? "prise_en_charge" : null;
    if (!action) {
      return null;
    }
    const note = action === "resolue" ? (said.split(/\s*:\s*/).slice(1).join(" : ").trim() || said) : "";
    const result = await tasks.update(number, action, { note, by });
    return result.ok
      ? (action === "resolue" ? `Tâche n° ${number} notée résolue : la direction va confirmer sa clôture.` : `Tâche n° ${number} notée prise en charge.`)
      : result.erreur;
  }

  // The direction's own word on a task: « clôture tâche 4 », « rouvrir tâche
  // 4 : le client rappelle ». Null when the message is not that.
  async function directionTaskWord(message) {
    if (!tasks || message.type !== "text") {
      return null;
    }
    const close = /^\s*(?:je\s+confirme\s+(?:la\s+)?)?cl[ôo]tur\w*\s+(?:de\s+)?(?:la\s+)?t[âa]che\s*(?:n\s*[°o.]?\s*)?(\d+)\s*[.!]?\s*$/i.exec(message.text);
    const reopen = /^\s*rouvr\w*\s+(?:la\s+)?t[âa]che\s*(?:n\s*[°o.]?\s*)?(\d+)\s*[:,-]?\s*(.*)$/i.exec(message.text);
    if (!close && !reopen) {
      return null;
    }
    const number = (close ?? reopen)[1];
    const result = await tasks.update(number, close ? "cloturer" : "rouvrir", { note: reopen ? reopen[2].trim() : "", by: "direction (WhatsApp)" });
    return result.ok
      ? (close ? `Clôture de la tâche n° ${number} confirmée.` : `Tâche n° ${number} rouverte : la personne en charge est prévenue.`)
      : result.erreur;
  }

  async function toDirection(text) {
    if (!client) {
      return;
    }
    for (const owner of config.ownerNumbers) {
      await send({ to: owner, text, by: "director", kind: "alerte" }).catch(log);
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
    const drafter = owner || team ? null : await orderPersonOf(message.from);
    const taskPerson = owner || team || drafter || !tasks ? null : await tasks.personOf(message.from);
    const sender = owner ? "direction" : team || drafter || taskPerson ? "equipe" : "contact";
    const recorded = await inbox.receive({
      metaId: message.id,
      number: message.from,
      name: team?.member.name ?? drafter?.name ?? taskPerson?.name ?? message.name,
      sender,
      agent: team?.agent ?? (drafter ? "production" : taskPerson?.agent ?? null),
      type: message.type,
      text: message.text,
      at: message.at
    });
    if (!recorded) {
      return;
    }
    if (workshop && message.type === "document" && isCncFileName(message.media?.filename) && (owner || team || drafter?.orders.length > 0)) {
      await fromDrafting(message, { name: owner ? "La direction" : team?.member.name ?? drafter.name, orders: drafter?.orders ?? null });
    } else if (owner) {
      const word = await directionTaskWord(message);
      await (word ? reply(message, word) : fromDirection(message, recorded));
    } else if (team) {
      await fromTeam(message, team, recorded);
    } else if (drafter) {
      await fromTeam(message, { agent: "production", member: { name: drafter.name } }, recorded);
    } else if (taskPerson) {
      await fromTeam(message, { agent: taskPerson.agent, member: { name: taskPerson.name } }, recorded);
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

    // The anomalies just found in the workshop book, told to the chef de
    // charge of their order. One without a number is seen in the cockpit
    // only; a message Meta refuses is written to the team feed.
    async alertLeads(anomalies, orders) {
      if (!client) {
        return;
      }
      for (const anomaly of anomalies.filter((entry) => entry.source === "atelier")) {
        const order = orders.find((candidate) => String(candidate.number) === anomaly.orderNumber);
        if (!order) {
          continue;
        }
        const { lead = "", leadPhone = "" } = order.team ?? {};
        const what = anomaly.fact.replace(/^BC \S+ \([^)]*\) : /, "");
        // A late delivery is also the Commercial's: the client is to be told.
        if (anomaly.step === "livraison_installation" && anomaly.kind === "retard") {
          const commercial = await teamBook.member("commercial");
          if (commercial?.phone) {
            await send({ to: commercial.phone, text: `Bonjour ${commercial.name}, la livraison du BC n° ${order.number} (${order.client}) est en retard : ${what}. Prévenez le client et convenez d'une nouvelle date avec lui.`, name: commercial.name, by: "director", kind: "alerte" })
              .then(() => teamBook.log({ agent: "commercial", kind: "relance", text: `Retard de livraison du BC ${order.number} signalé par WhatsApp à ${commercial.name}.`, ref: `bc:${order.number}`, by: "director" }))
              .catch(log);
          }
        }
        if (!leadPhone) {
          continue;
        }
        const text = `Bonjour${lead ? ` ${lead}` : ""}, alerte sur le BC n° ${order.number} (${order.client}) dont vous êtes chef de charge : ${what}. Répondez ici avec la cause et la nouvelle date : la direction et l'agent Production seront informés.`;
        try {
          await send({ to: leadPhone, text, name: lead, by: "director", kind: "alerte" });
          await teamBook.log({ agent: anomaly.owner, kind: "atelier", text: `Alerte envoyée par WhatsApp à ${lead || leadPhone} (chef de charge) : ${anomaly.fact}`, ref: `bc:${order.number}`, by: "director" });
        } catch (error) {
          log(error);
          await teamBook.log({ agent: anomaly.owner, kind: "atelier", text: `Alerte non envoyée à ${lead || leadPhone} (chef de charge) : ${error.message}`, ref: `bc:${order.number}`, by: "director" });
        }
      }
    },

    // The quotes with no news for too long: to the person behind the
    // Commercial agent, and to the direction for those twice as late (or all
    // of them when nobody is behind the Commercial). One message each.
    async remindFollowUps(quotes, { days }) {
      if (!client || quotes.length === 0) {
        return;
      }
      const commercial = await teamBook.member("commercial");
      const line = (quote) => `- Devis n° ${quote.number}, ${quote.client}${quote.totalTtc === null ? "" : `, ${formatDh(quote.totalTtc)}`} : ${quote.daysSilent} jours sans nouvelles${quote.followUps.length > 0 ? " (dernière relance le " + frenchDate(quote.followUps.at(-1).day) + ")" : ""}`;
      const late = quotes.filter((quote) => quote.level === 2);
      const toDirection = commercial?.phone ? late : quotes;
      if (commercial?.phone) {
        await send({
          to: commercial.phone,
          text: [`Bonjour ${commercial.name}, devis à relancer :`, ...quotes.map(line), "Une fois la relance faite, répondez ici, par exemple « relance du devis " + quotes[0].number + " faite, le client réfléchit »."].join("\n"),
          name: commercial.name, by: "director", kind: "relance"
        }).catch(log);
      }
      if (toDirection.length > 0) {
        const intro = commercial?.phone
          ? `Relances en retard (sans nouvelles depuis ${days * 2} jours ou plus ; ${commercial.name} a été prévenu(e)) :`
          : `Devis à relancer (sans nouvelles depuis ${days} jours ou plus ; aucun responsable commercial relié) :`;
        for (const owner of config.ownerNumbers) {
          await send({ to: owner, text: [intro, ...toDirection.map(line)].join("\n"), by: "director", kind: "relance" }).catch(log);
        }
      }
      await teamBook.log({ agent: "commercial", kind: "relance", text: `Rappel de relance envoyé par WhatsApp : devis n° ${quotes.map((quote) => quote.number).join(", ")}.`, by: "director" });
    },

    // A grave anomaly, told to the direction as soon as it is found.
    async alertSevere(anomalies) {
      for (const anomaly of anomalies.filter((entry) => entry.severity === "haute")) {
        await toDirection(`Anomalie grave n° ${anomaly.number} : ${anomaly.fact}. Confiez-la en répondant par exemple « assigne l'anomalie ${anomaly.number} à ${SPECIALISTS[anomaly.owner]?.label ?? "la production"} pour le ${frenchDate(inDays(2))} ».`);
      }
    },

    async taskAssigned(anomaly) {
      const { task } = anomaly;
      if (!client || !task.phone) {
        return;
      }
      await send({
        to: task.phone,
        text: `Bonjour${task.person ? ` ${task.person}` : ""}, la direction vous confie la tâche n° ${anomaly.number} (gravité ${anomaly.severity ?? "moyenne"}) : ${anomaly.fact}${task.instruction ? ` — ${task.instruction}` : ""}. À régler avant le ${frenchDate(task.dueDate)}. Répondez « tâche ${anomaly.number} prise en charge », puis « tâche ${anomaly.number} résolue : ce qui a été fait ».`,
        name: task.person, by: "director", kind: "tache"
      }).catch(log);
    },

    async taskResolved(anomaly) {
      await toDirection(`Tâche n° ${anomaly.number} résolue par ${anomaly.task.resolvedBy} : ${anomaly.task.resolution} (${anomaly.fact}). Pour confirmer la clôture, répondez « clôture tâche ${anomaly.number} », ou « rouvrir tâche ${anomaly.number} : pourquoi ».`);
    },

    async taskReopened(anomaly) {
      const { task } = anomaly;
      if (client && task.phone) {
        await send({ to: task.phone, text: `La direction rouvre la tâche n° ${anomaly.number} (${anomaly.fact}) : ${task.reopenReason}. Répondez « tâche ${anomaly.number} résolue : … » une fois réglée.`, name: task.person, by: "director", kind: "tache" }).catch(log);
      }
    },

    // The morning summary for the direction.
    async anomalySummary(board, today) {
      const list = (entries, describe) => entries.slice(0, 6).map((anomaly) => `  · n° ${anomaly.number} ${describe(anomaly)}`);
      const short = (anomaly) => clip(anomaly.fact.replace(/^BC \S+ \([^)]*\) : /, `BC ${anomaly.orderNumber} : `), 90);
      await toDirection([
        `Résumé des anomalies du ${frenchDate(isoDate(today))} : ${board.open.length} ouverte(s)${board.severe.length > 0 ? `, dont ${board.severe.length} grave(s)` : ""}.`,
        ...(board.unassigned.length > 0 ? [`- Sans responsable (${board.unassigned.length}) :`, ...list(board.unassigned, short)] : []),
        ...(board.late.length > 0 ? [`- En retard sur l'échéance (${board.late.length}) :`, ...list(board.late, (anomaly) => `${anomaly.task.person || anomaly.task.agent}, prévue le ${frenchDate(anomaly.task.dueDate)}`)] : []),
        ...(board.toConfirm.length > 0 ? [`- Résolues, à clôturer (${board.toConfirm.length}) :`, ...list(board.toConfirm, (anomaly) => `${clip(anomaly.task.resolution ?? "", 80)} → « clôture tâche ${anomaly.number} »`)] : []),
        board.unassigned.length > 0 ? `Pour confier une tâche : « assigne l'anomalie ${board.unassigned[0].number} à la production pour le ${frenchDate(inDays(2, today))} ».` : ""
      ].filter(Boolean).join("\n"));
    },

    // Each day, to the person whose task is past its deadline.
    async taskReminders(anomalies) {
      for (const anomaly of anomalies) {
        const { task } = anomaly;
        if (client && task.phone) {
          await send({ to: task.phone, text: `Rappel : la tâche n° ${anomaly.number} (${anomaly.fact}) devait être réglée le ${frenchDate(task.dueDate)}. Où en êtes-vous ? Répondez « tâche ${anomaly.number} résolue : … » une fois réglée.`, name: task.person, by: "director", kind: "tache" }).catch(log);
        }
        await teamBook.log({ agent: SPECIALISTS[task.agent] ? task.agent : anomaly.owner, kind: "amelioration", text: `Tâche n° ${anomaly.number} en retard (échéance ${frenchDate(task.dueDate)}) : rappel ${task.phone ? `envoyé à ${task.person || task.phone}` : "impossible, aucun numéro"}.`, by: "director" });
      }
    },

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

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function inDays(days, from = new Date()) {
  return isoDate(new Date(from.getTime() + days * 86400000));
}

function formatDh(amount) {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(amount).replace(/\u202f/g, " ")} DH`;
}

function frenchDate(iso) {
  const [year, month, day] = String(iso ?? "").split("-");
  return day ? `${day}/${month}/${year}` : "";
}

function clip(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
