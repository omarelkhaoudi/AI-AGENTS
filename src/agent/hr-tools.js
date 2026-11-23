import { ABSENCE_KINDS, CANDIDATE_STATUSES, CONTRACT_KINDS, HrBookError, JOB_CATEGORIES, LEAVE_KINDS, LEAVE_STATUSES, POSITION_STATUSES, TRAINING_STATUSES, frenchDay } from "./hr-book.js";

// The RH agent's tools and the Director's, on the team's book. Each answers in
// the agents' words and never throws the book's own error.

const OVERVIEW_TOOL = Object.freeze({
  type: "function",
  name: "equipe_rh",
  description: "Le carnet RH réel : salariés (poste, date d'entrée, solde de congés payés selon le Code du travail), absents aujourd'hui, demandes de congé en attente, congés des 30 prochains jours, absences, retards et heures supplémentaires des 14 derniers jours, contrats et candidats (pour la direction), postes ouverts, formations et alertes RH (fins de contrat, fins d'essai, formations à renouveler). À lire avant toute réponse RH.",
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

const CONTRACT_TOOL = Object.freeze({
  type: "function",
  name: "contrat_salarie",
  description: "Enregistre le contrat d'un salarié sur ce que dit la direction (« Samir est en CDD du 01/12/2026 au 31/05/2027 », « on passe Karim en CDI au 01/01 »). Le nouveau contrat remplace celui en cours (renouvellement, passage en CDI). La période d'essai est celle dite, sinon celle de l'art. 14 du Code du travail selon le contrat et la catégorie. Les fins de contrat et de période d'essai remontent ensuite en alerte dans Amélioration. Réservé à la direction.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      salarie: { type: "string" },
      type: { type: "string", enum: Object.keys(CONTRACT_KINDS) },
      debut: { type: "string", description: "JJ/MM/AAAA." },
      fin: { type: "string", description: "JJ/MM/AAAA ; chaîne vide pour un CDI. Obligatoire pour un CDD, un contrat ANAPEC ou un stage : la demander, ne jamais la supposer." },
      categorie: { type: "string", enum: ["", ...Object.keys(JOB_CATEGORIES)], description: "cadre, employe ou ouvrier, si dit : fixe la période d'essai d'un CDI ; chaîne vide sinon." },
      fin_essai: { type: "string", description: "JJ/MM/AAAA si la direction donne une autre fin d'essai ; chaîne vide sinon." },
      note: { type: "string", description: "Ce que la direction précise ; jamais de salaire ; chaîne vide sinon." }
    },
    required: ["salarie", "type", "debut", "fin", "categorie", "fin_essai", "note"]
  }
});

const RECRUITMENT_TOOL = Object.freeze({
  type: "function",
  name: "recrutement",
  description: "Le recrutement, sur ce que dit la direction : ouvrir un poste (« on cherche un menuisier »), noter une candidature, en donner la suite (entretien avec sa date, retenu, non retenu, embauché avec sa date d'entrée : le salarié rejoint alors l'équipe), clore un poste, effacer une candidature sur demande ou celles des postes clos depuis plus de 12 mois. Du candidat, seulement nom, numéro WhatsApp, provenance et une courte note : jamais de CIN, d'âge, de photo, de situation familiale ni de santé (loi 09-08). Réservé à la direction.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["ouvrir_poste", "candidature", "suite_candidature", "clore_poste", "effacer_candidature", "effacer_anciennes"] },
      poste: { type: "string", description: "ouvrir_poste : l'intitulé ; candidature : le numéro du poste ; clore_poste : le numéro du poste ; chaîne vide sinon." },
      numero: { type: "integer", description: "suite_candidature, effacer_candidature : numéro de la candidature ; 0 sinon." },
      nom: { type: "string", description: "candidature : nom du candidat ; chaîne vide sinon." },
      telephone: { type: "string", description: "candidature : numéro WhatsApp s'il est donné ; chaîne vide sinon." },
      provenance: { type: "string", description: "candidature : d'où elle vient (ANAPEC, bouche-à-oreille, Instagram…) ; ouvrir_poste : le besoin en une phrase ; chaîne vide sinon." },
      statut: { type: "string", enum: ["", "entretien", "retenu", "refuse", "embauche", "pourvu", "annule"], description: "suite_candidature : entretien, retenu, refuse ou embauche ; clore_poste : pourvu ou annule ; chaîne vide sinon." },
      date: { type: "string", description: "JJ/MM/AAAA : date de l'entretien, ou date d'entrée pour une embauche ; chaîne vide sinon." },
      contrat: { type: "string", enum: ["", ...Object.keys(CONTRACT_KINDS)], description: "ouvrir_poste : contrat prévu s'il est dit ; chaîne vide sinon." },
      categorie: { type: "string", enum: ["", ...Object.keys(JOB_CATEGORIES)], description: "ouvrir_poste : catégorie si dite ; chaîne vide sinon." },
      note: { type: "string", description: "Une courte note professionnelle (expérience, impression d'entretien) ; chaîne vide sinon." }
    },
    required: ["action", "poste", "numero", "nom", "telephone", "provenance", "statut", "date", "contrat", "categorie", "note"]
  }
});

const TRAINING_TOOL = Object.freeze({
  type: "function",
  name: "formation",
  description: "Les formations de l'équipe : en planifier une (« Samir et Karim font la formation sécurité machines le 10/12 »), la dire réalisée ou annulée. Une formation à durée de validité (habilitation, secourisme) remonte en alerte 30 jours avant son échéance.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["planifier", "realisee", "annulee"] },
      numero: { type: "integer", description: "realisee, annulee : numéro de la formation ; 0 pour planifier." },
      intitule: { type: "string", description: "planifier : la formation ; chaîne vide sinon." },
      salaries: { type: "array", items: { type: "string" }, description: "planifier : les noms des salariés ; liste vide sinon." },
      du: { type: "string", description: "planifier : JJ/MM/AAAA ; chaîne vide sinon." },
      au: { type: "string", description: "planifier : JJ/MM/AAAA, même jour si une journée ; chaîne vide sinon." },
      organisme: { type: "string", description: "Qui la donne, si dit ; chaîne vide sinon." },
      valable_jusqu_au: { type: "string", description: "JJ/MM/AAAA si la formation a une échéance ; chaîne vide sinon." }
    },
    required: ["action", "numero", "intitule", "salaries", "du", "au", "organisme", "valable_jusqu_au"]
  }
});

const RH_AGENT = [OVERVIEW_TOOL, ADD_EMPLOYEE_TOOL, PRESENCE_TOOL, LEAVE_REQUEST_TOOL, PAYROLL_TOOL, HR_CORRECTION_TOOL, CONTRACT_TOOL, RECRUITMENT_TOOL, TRAINING_TOOL];
export const DIRECTOR_HR_TOOLS = Object.freeze([OVERVIEW_TOOL, ADD_EMPLOYEE_TOOL, PRESENCE_TOOL, LEAVE_REQUEST_TOOL, LEAVE_DECISION_TOOL, PAYROLL_TOOL, HR_CORRECTION_TOOL, CONTRACT_TOOL, RECRUITMENT_TOOL, TRAINING_TOOL]);
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
      case CONTRACT_TOOL.name: {
        if (confidential === false) {
          return { ok: false, erreur: "Les contrats sont réservés à la direction." };
        }
        const contract = await hr.setContract({ who: args.salarie, kind: args.type, start: args.debut, end: args.fin, category: args.categorie, trial: args.fin_essai, note: args.note, by });
        await books.team?.log({ agent: "hr", kind: "rh", text: `Contrat n° ${contract.number} (${CONTRACT_KINDS[contract.kind]}) enregistré pour ${contract.employee}.`, ref: `contrat:${contract.number}`, by }).catch(() => {});
        return {
          ok: true,
          contrat: `n° ${contract.number} : ${CONTRACT_KINDS[contract.kind]} de ${contract.employee}, du ${frenchDay(contract.start)}${contract.end ? ` au ${frenchDay(contract.end)}` : ""}`,
          periode_d_essai: contract.trialEnd ? `jusqu'au ${frenchDay(contract.trialEnd)}` : "aucune notée (la donner si le contrat en prévoit une)",
          ...(contract.replaced.length > 0 ? { remplace: `contrat n° ${contract.replaced.join(", ")}` } : {}),
          ...(contract.kind === "cdd" && contract.fixedTermCount > 2 ? { attention: `${contract.fixedTermCount}e CDD pour ${contract.employee} : vérifier avec le comptable ou le conseil juridique que le cas de recours et le renouvellement restent permis (art. 16 et 17 du Code du travail).` } : {}),
          rappel: "Le contrat signé reste le document qui fait foi : ce carnet n'en garde que les dates."
        };
      }
      case RECRUITMENT_TOOL.name:
        if (confidential === false) {
          return { ok: false, erreur: "Le recrutement est réservé à la direction." };
        }
        return await runRecruitment(args, hr, books, by);
      case TRAINING_TOOL.name: {
        if (args.action === "planifier") {
          const training = await hr.planTraining({ title: args.intitule, who: args.salaries, from: args.du, to: args.au, provider: args.organisme, validUntil: args.valable_jusqu_au, by });
          await books.team?.log({ agent: "hr", kind: "rh", text: `Formation « ${training.title} » planifiée pour ${training.names.join(", ")}.`, ref: `formation:${training.number}`, by }).catch(() => {});
          return { ok: true, formation: describeTraining(training) };
        }
        const training = await hr.updateTraining(args.numero, { status: args.action, validUntil: args.valable_jusqu_au, by });
        return { ok: true, formation: describeTraining(training) };
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

async function runRecruitment(args, hr, books, by) {
  switch (args.action) {
    case "ouvrir_poste": {
      const position = await hr.openPosition({ title: args.poste, category: args.categorie, kind: args.contrat, need: args.provenance || args.note, by });
      await books.team?.log({ agent: "hr", kind: "rh", text: `Poste n° ${position.number} ouvert : ${position.title}.`, ref: `poste:${position.number}`, by }).catch(() => {});
      return { ok: true, poste: `n° ${position.number} : ${position.title}${position.kind ? `, ${CONTRACT_KINDS[position.kind]}` : ""}`, suite: "Les candidatures se notent sur ce numéro de poste." };
    }
    case "candidature": {
      const candidate = await hr.addCandidate({ position: args.poste, name: args.nom, phone: args.telephone, source: args.provenance, note: args.note, by });
      return { ok: true, candidature: `n° ${candidate.number} : ${candidate.name}, poste ${candidate.position}${candidate.source ? `, via ${candidate.source}` : ""}` };
    }
    case "suite_candidature": {
      const candidate = await hr.updateCandidate(args.numero, { status: args.statut, interview: args.date, note: args.note, startDate: args.date, by });
      return {
        ok: true,
        candidature: `n° ${candidate.number} : ${candidate.name}, ${CANDIDATE_STATUSES[candidate.status]}${candidate.status === "entretien" ? ` le ${frenchDay(candidate.interview)}` : ""}`,
        ...(candidate.employee ? { equipe: `${candidate.employee.name} ajouté(e) à l'équipe, ${candidate.employee.role}, entrée le ${frenchDay(candidate.employee.startDate)}`, suite: "Enregistrer son contrat (contrat_salarie) dès qu'il est signé." } : {})
      };
    }
    case "clore_poste": {
      const position = await hr.closePosition(args.poste, { status: args.statut, by });
      return { ok: true, poste: `n° ${position.number} (${position.title}) ${POSITION_STATUSES[position.status]}`, rappel: "Les données des candidats non embauchés s'effacent 12 mois après la clôture (Amélioration le rappelle)." };
    }
    case "effacer_candidature": {
      await hr.eraseCandidates(args.numero);
      return { ok: true, efface: `candidature n° ${args.numero} et ses données` };
    }
    case "effacer_anciennes": {
      const { erased } = await hr.eraseCandidates();
      return { ok: true, efface: erased > 0 ? `${erased} candidature(s) de postes clos depuis plus de 12 mois` : "aucune candidature à effacer" };
    }
    default:
      return { ok: false, erreur: "Action de recrutement inconnue." };
  }
}

function describeTraining(training) {
  return `n° ${training.number} : « ${training.title} » pour ${training.names.join(", ")}, ${training.from === training.to ? `le ${frenchDay(training.from)}` : `du ${frenchDay(training.from)} au ${frenchDay(training.to)}`}${training.provider ? `, par ${training.provider}` : ""}, ${TRAINING_STATUSES[training.status]}${training.validUntil ? `, valable jusqu'au ${frenchDay(training.validUntil)}` : ""}`;
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
    jours_feries_a_venir_ajoutes: overview.holidays.map((holiday) => `${frenchDay(holiday.day)} ${holiday.label}`),
    ...(overview.contracts.length > 0 ? { contrats: overview.contracts.map((entry) => entry.number ? `${entry.name} : ${entry.label} n° ${entry.number} depuis le ${frenchDay(entry.start)}${entry.end ? `, fin le ${frenchDay(entry.end)}` : ""}${entry.trialEnd ? `, essai jusqu'au ${frenchDay(entry.trialEnd)}` : ""}` : `${entry.name} : aucun contrat noté`) } : {}),
    postes_ouverts: overview.positions.map((position) => ({
      poste: `n° ${position.number} : ${position.title}, ouvert le ${frenchDay(position.openedOn)}, ${position.applications} candidature(s)`,
      ...(position.candidates.length > 0 ? { candidats: position.candidates.map((candidate) => `n° ${candidate.number} ${candidate.name} : ${candidate.label}${candidate.interview && candidate.status === "entretien" ? ` le ${frenchDay(candidate.interview)}` : ""}${candidate.source ? `, via ${candidate.source}` : ""}${candidate.note ? ` — ${candidate.note}` : ""}`) } : {})
    })),
    formations: overview.trainings.map(describeTraining),
    alertes_rh: overview.alerts.map((alert) => alert.text)
  };
}
