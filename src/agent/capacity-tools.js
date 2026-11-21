import { CapacityError, STEP_LABELS, french, workshopSchedule } from "./workshop-capacity.js";
import { isoDay } from "./sales-book.js";

// The workshop's capacity for the agents (workshop-capacity.js): Production
// and Commercial read it and try a date (« can we deliver before the 20th? »);
// the Director also sets the durations when the direction says them.

const SCHEDULE_TOOL = Object.freeze({
  type: "function",
  name: "capacite_atelier",
  description: "La charge réelle de l'atelier : pour chaque commande en cours, la fin estimée d'après les durées d'étape fixées par la direction, et si la date de livraison promise est tenable. Avec date_souhaitee : la fin estimée d'une NOUVELLE commande et les commandes qu'elle retarderait au-delà de leur promesse. Une estimation, jamais un engagement : l'atelier confirme.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      date_souhaitee: { type: "string", description: "JJ/MM/AAAA : la date de livraison que l'on voudrait promettre à une nouvelle commande ; chaîne vide pour la plus proche possible." }
    },
    required: ["date_souhaitee"]
  }
});

const SET_TOOL = Object.freeze({
  type: "function",
  name: "fixer_capacite_atelier",
  description: `Fixe, seulement quand la DIRECTION ou l'atelier le dit, la durée en jours ouvrables d'une étape pour une commande et combien de commandes l'équipe y mène en même temps (« l'assemblage prend 3 jours, deux commandes à la fois »). Étapes : ${Object.entries(STEP_LABELS).map(([id, label]) => `${id} (${label})`).join(", ")}.`,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      etape: { type: "string", enum: Object.keys(STEP_LABELS) },
      jours: { type: "string", description: "Jours ouvrables pour une commande ; chaîne vide pour enlever la durée." },
      en_meme_temps: { type: "string", description: "Commandes menées en même temps dans cette étape ; chaîne vide si non dit (une à la fois)." }
    },
    required: ["etape", "jours", "en_meme_temps"]
  }
});

export const DIRECTOR_CAPACITY_TOOLS = Object.freeze([SCHEDULE_TOOL, SET_TOOL]);
export const CAPACITY_TOOL_NAMES = Object.freeze(DIRECTOR_CAPACITY_TOOLS.map((tool) => tool.name));

export function capacityTools(context, agentId) {
  return ["production", "commercial"].includes(agentId) ? [{ tool: SCHEDULE_TOOL, run: (args) => runCapacityTool(SCHEDULE_TOOL.name, args, context, agentId) }] : [];
}

const text = (value) => (typeof value === "string" ? value.trim() : "");

export async function runCapacityTool(name, args, { books, workshop, clock = () => new Date() }, by) {
  if (!books?.capacity || !workshop) {
    return { ok: false, erreur: "La capacité de l'atelier n'est pas disponible : je n'ai pas l'information." };
  }
  try {
    if (name === SET_TOOL.name) {
      await books.capacity.set({ [args.etape]: { days: text(args.jours), parallel: text(args.en_meme_temps) } }, { by });
      await books.team?.log({ agent: "production", kind: "equipe", text: `Capacité de l'atelier : ${STEP_LABELS[args.etape]} → ${text(args.jours) || "durée retirée"}${text(args.jours) ? ` jour(s), ${text(args.en_meme_temps) || "1"} commande(s) à la fois` : ""}.`, by }).catch(() => {});
    } else if (name !== SCHEDULE_TOOL.name) {
      return { ok: false, erreur: `Outil de capacité inconnu : ${name}.` };
    }
    const wanted = text(args.date_souhaitee);
    const promised = wanted ? isoDay(wanted) : null;
    if (wanted && !promised) {
      return { ok: false, erreur: `Date illisible « ${wanted} » : écrire JJ/MM/AAAA.` };
    }
    const [capacity, orders, hr] = await Promise.all([books.capacity.state(), workshop.book(), books.hr?.state().catch(() => null) ?? null]);
    const holidays = hr?.holidays ?? [];
    const now = clock();
    const today = workshopSchedule(orders, capacity, { today: now, holidays });
    const answer = { ok: true, ...(name === SET_TOOL.name ? { enregistre: true } : {}), ...describe(today, capacity) };
    if (name === SCHEDULE_TOOL.name && (wanted || args.date_souhaitee === "")) {
      const tried = workshopSchedule(orders, capacity, { today: now, holidays, extra: { promised } });
      const added = tried.orders.find((entry) => entry.extra);
      const slipped = tried.orders.filter((entry) => !entry.extra && entry.verdict === "intenable" && today.orders.find((before) => before.number === entry.number)?.verdict === "tenable");
      answer.nouvelle_commande = added.verdict === "inconnu"
        ? `estimation impossible : durée non fixée pour ${added.missing.join(", ")}`
        : [
            `fin estimée le ${french(added.end)} si elle était commandée aujourd'hui`,
            promised ? (added.verdict === "tenable" ? `la date du ${french(promised)} est tenable` : `la date du ${french(promised)} n'est PAS tenable (${added.lateBy} jour(s) ouvrable(s) de trop)`) : "",
            slipped.length > 0 ? `elle ferait manquer leur date promise à : ${slipped.map((entry) => `BC n° ${entry.number}${entry.client ? ` (${entry.client})` : ""}, promis le ${french(entry.promised)}, fin estimée le ${french(entry.end)}`).join(" ; ")}` : promised ? "elle ne retarde aucune commande au-delà de sa date promise" : ""
          ].filter(Boolean).join(" ; ");
      answer.rappel = "Estimation sur les durées fixées par la direction : la faire confirmer par l'atelier avant de promettre la date au client.";
    }
    return answer;
  } catch (error) {
    if (error instanceof CapacityError) {
      return { ok: false, erreur: error.message };
    }
    throw error;
  }
}

function describe(schedule, capacity) {
  const set = Object.entries(capacity.steps ?? {});
  return {
    source: "carnet d'atelier et durées d'étape fixées par la direction",
    durees_des_etapes: set.length > 0 ? set.map(([id, value]) => `${STEP_LABELS[id]} : ${value.days} j, ${value.parallel} commande(s) à la fois`) : "aucune durée fixée : demander à la direction combien de jours prend chaque étape",
    commandes: schedule.orders.map((entry) => entry.verdict === "inconnu"
      ? `BC n° ${entry.number}${entry.client ? ` (${entry.client})` : ""} : fin non estimable, durée non fixée pour ${entry.missing.join(", ")}`
      : `BC n° ${entry.number}${entry.client ? ` (${entry.client})` : ""} : fin estimée le ${french(entry.end)}${entry.promised ? `, promise le ${french(entry.promised)} — ${entry.verdict === "tenable" ? "tenable" : `INTENABLE (${entry.lateBy} j de trop)`}` : ", pas de date promise"}${entry.blocked ? " (étape bloquée supposée relancée aujourd'hui)" : ""}`)
  };
}
