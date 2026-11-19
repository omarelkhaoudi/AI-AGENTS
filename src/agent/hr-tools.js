import { ABSENCE_KINDS, HrBookError, LEAVE_KINDS, LEAVE_STATUSES, frenchDay } from "./hr-book.js";

// The RH agent's tools and the Director's, on the team's book. Each answers in
// the agents' words and never throws the book's own error.

const OVERVIEW_TOOL = Object.freeze({
  type: "function",
  name: "equipe_rh",
  description: "Le carnet RH réel : salariés (poste, date d'entrée, solde de congés payés selon le Code du travail), absents aujourd'hui, demandes de congé en attente, congés des 30 prochains jours, absences, retards et heures supplémentaires des 14 derniers jours. À lire avant toute réponse RH.",
  parameters: { type: "object", additionalProperties: false, properties: {}, required: [] }
});

const ADD_EMPLOYEE_TOOL = Object.freeze({
  type: "function",
  name: "ajouter_salarie",
  description: "Ajoute un salarié au carnet RH, sur un fait annoncé par la direction (« Samir, menuisier, a commencé le 03/03/2025 »). Seulement nom, poste, date d'entrée et numéro WhatsApp : jamais de salaire, de CIN ni de donnée de santé.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      nom: { type: "string" },
      poste: { type: "string", description: "Sa fonction ; chaîne vide si non dite." },
      date_entree: { type: "string", description: "JJ/MM/AAAA. Obligatoire : la demander si elle manque, ne jamais la supposer." },
      telephone: { type: "string", description: "Numéro WhatsApp s'il est donné ; chaîne vide sinon." }
    },
    required: ["nom", "poste", "date_entree", "telephone"]
  }
});

const PRESENCE_TOOL = Object.freeze({
  type: "function",
  name: "noter_presence",
  description: "Note UNE absence, UN retard ou des heures supplémentaires d'un salarié, pour un fait annoncé (« Samir est absent aujourd'hui, malade », « Youssef est arrivé avec 1 h de retard », « Karim a fait 3 h de plus hier »). Un jour sans rien de noté est un jour travaillé. Un congé à venir n'est pas une absence : demander_conge.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      salarie: { type: "string", description: "Nom du salarié." },
      type: { type: "string", enum: Object.keys(ABSENCE_KINDS) },
      date: { type: "string", description: "JJ/MM/AAAA, ou chaîne vide pour aujourd'hui." },
      heures: { type: "number", description: "Durée du retard ou des heures supplémentaires (0,5 = 30 min) ; 0 pour une absence." },
      justifiee: { type: "boolean", description: "Absence justifiée (certificat, motif accepté par la direction) ; false si non dit." },
      motif: { type: "string", description: "Le motif dit, en un mot (« maladie », « familial ») ; jamais de détail médical ; chaîne vide sinon." }
    },
    required: ["salarie", "type", "date", "heures", "justifiee", "motif"]
  }
});

const LEAVE_REQUEST_TOOL = Object.freeze({
  type: "function",
  name: "demander_conge",
  description: "Enregistre une demande de congé (« Samir veut prendre du 01/12 au 05/12 »). Elle reste « demandée » jusqu'à la décision de la direction. Renvoie le nombre de jours ouvrables (lundi au samedi, hors jours fériés) et le solde de congés payés.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      salarie: { type: "string" },
      type: { type: "string", enum: Object.keys(LEAVE_KINDS) },
      du: { type: "string", description: "JJ/MM/AAAA." },
      au: { type: "string", description: "JJ/MM/AAAA ; même jour si une seule journée." },
      note: { type: "string", description: "Ce que le salarié ou la direction a précisé ; chaîne vide sinon." }
    },
    required: ["salarie", "type", "du", "au", "note"]
  }
});

const LEAVE_DECISION_TOOL = Object.freeze({
  type: "function",
  name: "decider_conge",
  description: "Enregistre la décision de la DIRECTION sur une demande de congé (« j'accepte le congé de Samir », « refuse, c'est la semaine de livraison »). Seulement quand la direction l'a dit, jamais de ta propre initiative.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      numero: { type: "integer", description: "Numéro de la demande (equipe_rh)." },
      decision: { type: "string", enum: ["approuve", "refuse", "annule"] },
      raison: { type: "string", description: "Pourquoi, si la direction le dit ; chaîne vide sinon." }
    },
    required: ["numero", "decision", "raison"]
  }
});

const PAYROLL_TOOL = Object.freeze({
  type: "function",
  name: "variables_paie",
  description: "Les variables de paie d'un mois, sans aucun montant : jours ouvrables, jours travaillés, absences justifiées et non justifiées, jours de congé par type, heures de retard et heures supplémentaires, par salarié. Pour le comptable qui calcule la paie (CNSS, IR) : ce n'est pas un bulletin de paie.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      mois: { type: "string", description: "AAAA-MM, ou chaîne vide pour le mois en cours." }
    },
    required: ["mois"]
  }
});

const HR_CORRECTION_TOOL = Object.freeze({
  type: "function",
  name: "corriger_rh",
  description: "Corrige le carnet RH : annuler une absence, un retard ou des heures notés par erreur (numéro de ligne), ajouter un jour férié religieux de l'année (Aïd, Achoura, Mawlid… les fériés à date fixe sont déjà connus), ou noter le départ d'un salarié.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["annuler_ligne", "jour_ferie", "depart"] },
      numero: { type: "integer", description: "annuler_ligne : numéro de la ligne ; 0 sinon." },
      date: { type: "string", description: "jour_ferie : la date ; depart : le dernier jour ; JJ/MM/AAAA, chaîne vide sinon." },
      texte: { type: "string", description: "annuler_ligne : la raison ; jour_ferie : son nom ; depart : le nom du salarié." }
    },
    required: ["action", "numero", "date", "texte"]
  }
});

const RH_AGENT = [OVERVIEW_TOOL, ADD_EMPLOYEE_TOOL, PRESENCE_TOOL, LEAVE_REQUEST_TOOL, PAYROLL_TOOL, HR_CORRECTION_TOOL];
export const DIRECTOR_HR_TOOLS = Object.freeze([OVERVIEW_TOOL, ADD_EMPLOYEE_TOOL, PRESENCE_TOOL, LEAVE_REQUEST_TOOL, LEAVE_DECISION_TOOL, PAYROLL_TOOL, HR_CORRECTION_TOOL]);
export const HR_TOOL_NAMES = Object.freeze(DIRECTOR_HR_TOOLS.map((tool) => tool.name));

// The RH agent prepares, the direction decides: no leave decision for it.
export function hrTools(context, agentId) {
  return RH_AGENT.map((tool) => ({ tool, run: (args) => runHrTool(tool.name, args, context, agentId) }));
}

export async function runHrTool(name, args, { books, confidential = true }, by) {
  const hr = books?.hr;
  if (!hr) {
    return { ok: false, erreur: "Le carnet RH n'est pas disponible : je n'ai pas l'information." };
  }
  try {
    switch (name) {
      case OVERVIEW_TOOL.name:
        return describeOverview(await hr.overview({ confidential }));
      case ADD_EMPLOYEE_TOOL.name: {
        const employee = await hr.addEmployee({ name: args.nom, role: args.poste, startDate: args.date_entree, phone: args.telephone, by });
        return { ok: true, ajoute: `${employee.name}${employee.role ? `, ${employee.role}` : ""}, entré(e) le ${frenchDay(employee.startDate)}` };
      }
      case PRESENCE_TOOL.name: {
        const event = await hr.record({ who: args.salarie, kind: args.type, date: args.date, hours: args.heures, reason: args.motif, justified: args.justifiee === true, by });
        await books.team?.log({ agent: "hr", kind: "rh", text: `${ABSENCE_KINDS[event.kind]} notée pour ${event.employee} le ${frenchDay(event.day)}${event.hours ? ` (${event.hours} h)` : ""}.`, ref: `rh:${event.number}`, by }).catch(() => {});
        return { ok: true, note: `ligne n° ${event.number} : ${ABSENCE_KINDS[event.kind]}, ${event.employee}, ${frenchDay(event.day)}${event.hours ? `, ${event.hours} h` : ""}${event.kind === "absence" ? (event.justified ? ", justifiée" : ", non justifiée (à régulariser si un justificatif arrive)") : ""}` };
      }
      case LEAVE_REQUEST_TOOL.name: {
        const leave = await hr.requestLeave({ who: args.salarie, kind: args.type, from: args.du, to: args.au, note: args.note, by });
        return {
          ok: true,
          demande: `n° ${leave.number} : ${LEAVE_KINDS[leave.kind]} de ${leave.employee} du ${frenchDay(leave.from)} au ${frenchDay(leave.to)}, ${leave.days} jour(s) ouvrable(s)`,
          solde_conges_payes: describeBalance(leave.balance),
          ...(leave.kind === "annuel" && leave.days > leave.balance.remaining ? { alerte: `La demande dépasse le solde acquis (${leave.balance.remaining} jours).` } : {}),
          ...(leave.kind === "annuel" && !leave.balance.eligible ? { alerte_anciennete: "Moins de six mois de service : le congé payé n'est pas encore dû (art. 231 du Code du travail)." } : {}),
          suite: "La direction décide : dans le cockpit (vue Équipe RH) ou en le disant au Director."
        };
      }
      case LEAVE_DECISION_TOOL.name: {
        const leave = await hr.decideLeave(args.numero, { decision: args.decision, reason: args.raison, by });
        await books.team?.log({ agent: "hr", kind: "rh", text: `Congé n° ${leave.number} de ${leave.employee} ${LEAVE_STATUSES[leave.status]} par la direction.`, ref: `conge:${leave.number}`, by }).catch(() => {});
        return { ok: true, conge: `n° ${leave.number} de ${leave.employee}, du ${frenchDay(leave.from)} au ${frenchDay(leave.to)} : ${LEAVE_STATUSES[leave.status]}`, ...(leave.balance ? { solde_conges_payes: describeBalance(leave.balance) } : {}) };
      }
      case PAYROLL_TOOL.name: {
        const month = typeof args.mois === "string" ? args.mois.trim() : "";
        const payroll = await hr.payroll(month);
        return {
          ok: true,
          mois: payroll.month,
          jours_ouvrables_du_mois: payroll.workingDays,
          salaries: payroll.rows.map((row) => ({
            nom: row.name,
            poste: row.role || null,
            jours_ouvrables: row.workingDays,
            jours_travailles: row.daysWorked,
            absences_justifiees: row.absencesJustified,
            absences_non_justifiees: row.absencesUnjustified,
            conges: Object.entries(row.leave).map(([kind, days]) => `${LEAVE_KINDS[kind]} : ${days} j`),
            heures_de_retard: row.hoursLate,
            heures_supplementaires: row.overtimeHours
          })),
          rappel: "Variables sans montant, pour le comptable : la paie, la CNSS et l'IR sont calculés par lui. Les jours fériés religieux de l'année doivent être ajoutés (corriger_rh, jour_ferie) pour que les jours ouvrables soient justes."
        };
      }
      case HR_CORRECTION_TOOL.name: {
        if (args.action === "annuler_ligne") {
          const event = await hr.cancelRecord(args.numero, { reason: args.texte, by });
          return { ok: true, annule: `ligne n° ${event.number} (${ABSENCE_KINDS[event.kind]} du ${frenchDay(event.day)})` };
        }
        if (args.action === "jour_ferie") {
          const holiday = await hr.addHoliday(args.date, args.texte);
          return { ok: true, jour_ferie: `${holiday.label}, le ${frenchDay(holiday.day)}` };
        }
        const employee = await hr.leaveCompany(args.texte, { endDate: args.date, by });
        return { ok: true, depart: `${employee.name}, dernier jour le ${frenchDay(employee.endDate)}` };
      }
      default:
        return { ok: false, erreur: `Outil RH inconnu : ${name}.` };
    }
  } catch (error) {
    if (error instanceof HrBookError) {
      return { ok: false, erreur: error.message };
    }
    throw error;
  }
}

function describeBalance(balance) {
  return `${balance.remaining} jour(s) restant(s) : ${balance.earned} acquis depuis le ${frenchDay(balance.yearOfServiceFrom)} (${balance.perYear} par an), ${balance.taken} pris`;
}

function describeOverview(overview) {
  if (overview.headcount === 0) {
    return { ok: true, info: "Le carnet RH est vide : aucun salarié n'est encore enregistré. Demande à la direction les noms, postes et dates d'entrée de l'équipe." };
  }
  return {
    ok: true,
    source: "carnet RH du cockpit (données réelles)",
    effectif: overview.headcount,
    salaries: overview.employees.map((employee) => `${employee.name}${employee.role ? ` (${employee.role})` : ""}, entré(e) le ${frenchDay(employee.startDate)} — congés payés : ${describeBalance(employee.leave)}`),
    absents_aujourdhui: overview.absentToday.length > 0 ? overview.absentToday.map((entry) => `${entry.name} : ${entry.why}`) : "personne",
    demandes_de_conge_en_attente: overview.pendingLeaves.map((leave) => `n° ${leave.number} : ${leave.name}, ${leave.kind}, du ${frenchDay(leave.from)} au ${frenchDay(leave.to)} (${leave.days} j)${leave.note ? ` — ${leave.note}` : ""}`),
    conges_a_venir: overview.upcomingLeaves.map((leave) => `${leave.name} : du ${frenchDay(leave.from)} au ${frenchDay(leave.to)} (${leave.days} j)`),
    derniers_14_jours: overview.recent.map((event) => `n° ${event.number} ${frenchDay(event.day)} ${event.name} : ${event.label}${event.hours ? ` ${event.hours} h` : ""}${event.kind === "absence" ? (event.justified ? " justifiée" : " non justifiée") : ""}${event.reason ? ` (${event.reason})` : ""}`),
    jours_feries_a_venir_ajoutes: overview.holidays.map((holiday) => `${frenchDay(holiday.day)} ${holiday.label}`)
  };
}
