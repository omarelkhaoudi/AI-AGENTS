import { AUTOMATION_ACTIONS, AUTOMATION_EVENTS, AutomationError } from "./automation.js";
import { SPECIALIST_IDS } from "./agent-team.js";

// The Director writes an automation when the direction says it in words
// (« quand un devis est accepté, préviens la production »), in the cockpit or
// on WhatsApp. The direction only: a team member asking gets a refusal.

const EVENT_LIST = Object.entries(AUTOMATION_EVENTS).map(([id, event]) => `${id} = ${event.label} (champs : ${event.fields.map((field) => `{${field}}`).join(", ")})`).join(" ; ");

export const CREATE_AUTOMATION_TOOL = Object.freeze({
  type: "function",
  name: "creer_automatisation",
  description: `Crée une automatisation « quand … alors … » que la direction demande (« quand un devis est accepté, préviens la production et rappelle-moi le solde dans 30 jours »). Elle se déclenche ensuite seule à chaque fois. Événements : ${EVENT_LIST}. Actions : ${Object.entries(AUTOMATION_ACTIONS).map(([id, label]) => `${id} = ${label}`).join(" ; ")}. Une mission confiée à un agent ne génère rien de définitif et n'écrit à aucun client. Reformule la règle à la direction avant de la créer si un point est flou (quel agent, quel délai).`,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      nom: { type: "string", description: "Nom court de la règle, en français." },
      evenement: { type: "string", enum: Object.keys(AUTOMATION_EVENTS) },
      montant_minimum: { type: "number", description: "Ne se déclenche qu'à partir de ce montant en DH ; 0 pour tous." },
      etape: { type: "string", description: "Pour un événement d'atelier : l'identifiant de l'étape visée (ex. livraison_installation) ; vide pour toutes." },
      contient: { type: "string", description: "Ne se déclenche que si l'événement contient ce mot (client, objet…) ; vide pour tous." },
      actions: {
        type: "array",
        description: "1 à 5 actions. Les textes peuvent citer les champs de l'événement entre accolades, ex. « Devis {numero} accepté par {client} ({montant}) ».",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: Object.keys(AUTOMATION_ACTIONS) },
            agent: { type: "string", enum: ["", ...SPECIALIST_IDS], description: "L'agent visé ; vide pour prevenir_direction." },
            texte: { type: "string", description: "Le message, la mission ou la tâche." },
            delai_jours: { type: "number", description: "0 = tout de suite ; sinon le nombre de jours après l'événement." },
            echeance_jours: { type: "number", description: "Pour une tâche : jours laissés pour la faire (3 par défaut)." }
          },
          required: ["type", "agent", "texte", "delai_jours", "echeance_jours"]
        }
      }
    },
    required: ["nom", "evenement", "montant_minimum", "etape", "contient", "actions"]
  }
});

export const LIST_AUTOMATIONS_TOOL = Object.freeze({
  type: "function",
  name: "automatisations",
  description: "Les automatisations de la direction : chaque règle (événement, filtres, actions, active ou en pause) et les dernières exécutions, réussies ou non. Pour mettre une règle en pause : action « pause » et son numéro ; « activer » pour la relancer.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["lister", "pause", "activer"] },
      numero: { type: "string", description: "Le numéro de la règle pour pause ou activer ; vide pour lister." }
    },
    required: ["action", "numero"]
  }
});

export const AUTOMATION_TOOL_NAMES = Object.freeze([CREATE_AUTOMATION_TOOL.name, LIST_AUTOMATIONS_TOOL.name]);

export async function runAutomationTool(name, args, { automation, confidential = true, books } = {}, by = "director") {
  if (!automation) {
    return { ok: false, erreur: "Les automatisations ne sont pas activées sur ce poste." };
  }
  const writes = name === CREATE_AUTOMATION_TOOL.name || args.action !== "lister";
  if (writes && confidential === false) {
    return { ok: false, erreur: "Seule la direction écrit ou met en pause une automatisation." };
  }
  try {
    if (name === CREATE_AUTOMATION_TOOL.name) {
      const rule = await automation.create({
        name: args.nom,
        event: args.evenement,
        filters: { minAmount: args.montant_minimum, step: args.etape, contains: args.contient },
        actions: (args.actions ?? []).map((action) => ({ kind: action.type, agent: action.agent, text: action.texte, delayDays: action.delai_jours, dueDays: action.echeance_jours }))
      }, { by });
      await books?.team?.log({ agent: "director", kind: "automatisation", text: `Automatisation n° ${rule.number} créée : ${rule.name}.`, by });
      return { ok: true, regle: describe(rule) };
    }
    if (args.action === "pause" || args.action === "activer") {
      const rule = await automation.setActive(args.numero, args.action === "activer", { by });
      await books?.team?.log({ agent: "director", kind: "automatisation", text: `Automatisation n° ${rule.number} ${rule.active ? "activée" : "mise en pause"} : ${rule.name}.`, by });
      return { ok: true, regle: describe(rule) };
    }
    return {
      ok: true,
      regles: (await automation.rules()).map(describe),
      dernieres_executions: (await automation.runs({ limit: 15 })).map((entry) => ({ quand: entry.at, regle: entry.rule, action: entry.action, agent: entry.agent, texte: entry.text, reussie: entry.ok, detail: entry.detail }))
    };
  } catch (error) {
    if (error instanceof AutomationError) {
      return { ok: false, erreur: error.message };
    }
    throw error;
  }
}

function describe(rule) {
  return {
    numero: rule.number,
    nom: rule.name,
    quand: AUTOMATION_EVENTS[rule.event]?.label ?? rule.event,
    filtres: rule.filters,
    actions: rule.actions.map((action) => ({ type: AUTOMATION_ACTIONS[action.kind], agent: action.agent ?? null, texte: action.text, delai_jours: action.delayDays, ...(action.dueDays ? { echeance_jours: action.dueDays } : {}) })),
    active: rule.active,
    dernier_declenchement: rule.lastFiredAt ?? null
  };
}
