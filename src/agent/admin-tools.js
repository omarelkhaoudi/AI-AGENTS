import { COMPANY } from "../company/company-profile.js";
import { AdminBookError, COMPANY_CONTRACT_KINDS, DEADLINE_KINDS, MAIL_STATUSES, RECURRENCES, RENEWALS } from "./admin-book.js";
import { frenchDay } from "./hr-book.js";

// The Administratif's tools and the Director's, on the administrative
// register (admin-book.js). Each answers in the agents' words and never
// throws the book's own error.

const OVERVIEW_TOOL = Object.freeze({
  type: "function",
  name: "registre_administratif",
  description: "Le registre administratif réel : fournisseurs (activité, contact, conditions), contrats de l'entreprise (bail, assurance, leasing… avec leur échéance et la date limite de préavis), échéances à venir (fiscales, CNSS, assurance, loyer…), courriers reçus à traiter et courriers préparés, et les alertes. À lire avant toute réponse administrative.",
  parameters: { type: "object", additionalProperties: false, properties: {}, required: [] }
});

const SUPPLIER_TOOL = Object.freeze({
  type: "function",
  name: "fournisseur",
  description: "Le registre des fournisseurs, sur ce que dit la direction : en ajouter un (« notre fournisseur de MDF c'est Bois Exemple, contact Ahmed, 06… »), modifier ses coordonnées ou ses conditions, ou le retirer. Ne jamais inventer un téléphone, un e-mail ou un ICE : chaîne vide s'il n'est pas dit.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["ajouter", "modifier", "retirer"] },
      nom: { type: "string", description: "Le nom du fournisseur (ou son numéro pour modifier ou retirer)." },
      activite: { type: "string", description: "Ce qu'il fournit (panneaux, quincaillerie, peinture, transport…) ; chaîne vide sinon." },
      contact: { type: "string", description: "La personne à joindre ; chaîne vide sinon." },
      telephone: { type: "string", description: "Chaîne vide si non dit." },
      email: { type: "string", description: "Chaîne vide si non dit." },
      ice: { type: "string", description: "ICE à 15 chiffres s'il est donné ; chaîne vide sinon." },
      conditions: { type: "string", description: "Conditions de paiement ou de livraison dites (« 30 jours fin de mois », « livre sous 5 jours ») ; chaîne vide sinon." },
      note: { type: "string", description: "Chaîne vide sinon. Pour modifier, « - » efface un champ." }
    },
    required: ["action", "nom", "activite", "contact", "telephone", "email", "ice", "conditions", "note"]
  }
});

const CONTRACT_TOOL = Object.freeze({
  type: "function",
  name: "contrat_entreprise",
  description: "Les contrats de l'entreprise (pas ceux des salariés : contrat_salarie), sur ce que dit la direction : bail, assurance, leasing, maintenance, abonnement, contrat fournisseur ou client. Enregistrer avec ses dates, sa durée, son renouvellement (tacite, à décider, aucun) et son préavis : le registre prévient avant la date limite de résiliation et avant la fin. Ou le dire résilié. Réservé à la direction.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["enregistrer", "resilier"] },
      numero: { type: "integer", description: "resilier : numéro du contrat ; 0 sinon." },
      intitule: { type: "string", description: "« Bail de l'atelier », « Assurance multirisque »… ; chaîne vide pour resilier." },
      type: { type: "string", enum: Object.keys(COMPANY_CONTRACT_KINDS) },
      partie: { type: "string", description: "Le bailleur, l'assureur, le prestataire… ; chaîne vide si non dit." },
      debut: { type: "string", description: "JJ/MM/AAAA ; chaîne vide si non dit." },
      fin: { type: "string", description: "JJ/MM/AAAA ; resilier : date d'effet ; chaîne vide si non dite." },
      duree_mois: { type: "integer", description: "Durée d'une période en mois (12 pour un an) ; 0 si non dite." },
      renouvellement: { type: "string", enum: Object.keys(RENEWALS), description: "tacite (reconduit sauf résiliation), expresse (à décider), aucune." },
      preavis_jours: { type: "integer", description: "Préavis de résiliation en jours (3 mois = 90) ; -1 si non dit." },
      montant: { type: "string", description: "Montant en DH s'il est dit ; chaîne vide sinon." },
      periodicite: { type: "string", description: "Pour le montant : par mois, par an… ; chaîne vide sinon." },
      note: { type: "string", description: "resilier : la raison ; sinon ce qui est précisé ; chaîne vide sinon." }
    },
    required: ["action", "numero", "intitule", "type", "partie", "debut", "fin", "duree_mois", "renouvellement", "preavis_jours", "montant", "periodicite", "note"]
  }
});

const DEADLINE_TOOL = Object.freeze({
  type: "function",
  name: "echeance",
  description: "Les échéances administratives, sur ce que dit la direction : ajouter (« la TVA chaque mois avant le 20 », « l'assurance le 15/01 chaque année »), dire faite (une échéance récurrente passe à sa date suivante), ou supprimer. Les échéances fiscales et sociales se confirment avec le comptable : ne jamais en ajouter une que la direction n'a pas dite.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["ajouter", "faite", "supprimer"] },
      numero: { type: "integer", description: "faite, supprimer : numéro de l'échéance ; 0 pour ajouter." },
      intitule: { type: "string", description: "ajouter : l'échéance ; chaîne vide sinon." },
      type: { type: "string", enum: Object.keys(DEADLINE_KINDS) },
      date: { type: "string", description: "ajouter : la prochaine date, JJ/MM/AAAA ; chaîne vide sinon." },
      recurrence: { type: "string", enum: Object.keys(RECURRENCES) },
      rappel_jours: { type: "integer", description: "Prévenir combien de jours avant (7 par défaut)." },
      note: { type: "string", description: "Chaîne vide sinon." }
    },
    required: ["action", "numero", "intitule", "type", "date", "recurrence", "rappel_jours", "note"]
  }
});

const MAIL_TOOL = Object.freeze({
  type: "function",
  name: "courrier",
  description: "Le registre des courriers. enregistrer_recu : un courrier reçu (de qui, objet, date de réponse attendue) prend son numéro chrono. preparer : rédige un courrier à envoyer (résiliation, réclamation, relance, attestation…) ; il est gardé en brouillon que la direction relit avant envoi. envoye : la direction l'a envoyé. traite : un courrier reçu est réglé. Pour preparer, écris le texte complet et sobre : lieu et date, destinataire, objet, corps, formule de politesse, signature de la direction ; l'en-tête de l'entreprise est ajouté par le cockpit.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["enregistrer_recu", "preparer", "envoye", "traite"] },
      numero: { type: "integer", description: "envoye, traite : numéro du courrier ; preparer : numéro du courrier reçu auquel il répond, 0 sinon ; 0 pour enregistrer_recu." },
      partie: { type: "string", description: "Expéditeur ou destinataire ; chaîne vide pour envoye et traite." },
      objet: { type: "string", description: "Chaîne vide pour envoye et traite." },
      date: { type: "string", description: "enregistrer_recu : date de réception, JJ/MM/AAAA, chaîne vide pour aujourd'hui ; chaîne vide sinon." },
      reference: { type: "string", description: "Référence du courrier ou du dossier (n° de police, de contrat…) ; chaîne vide sinon." },
      repondre_avant: { type: "string", description: "enregistrer_recu : date limite de réponse, JJ/MM/AAAA, si elle est dite ou écrite ; chaîne vide sinon." },
      texte: { type: "string", description: "preparer : le texte complet du courrier ; chaîne vide sinon." }
    },
    required: ["action", "numero", "partie", "objet", "date", "reference", "repondre_avant", "texte"]
  }
});

export const ADMIN_TOOLS = Object.freeze([OVERVIEW_TOOL, SUPPLIER_TOOL, CONTRACT_TOOL, DEADLINE_TOOL, MAIL_TOOL]);
export const ADMIN_TOOL_NAMES = Object.freeze(ADMIN_TOOLS.map((tool) => tool.name));

export function adminTools(context, agentId) {
  return ADMIN_TOOLS.map((tool) => ({ tool, run: (args) => runAdminTool(tool.name, args, context, agentId) }));
}

const dh = (value) => `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value).replace(/ | /g, " ")} DH`;

// The letterhead the cockpit puts on a prepared letter.
export function letterhead(company = COMPANY) {
  return [company.name, ...company.addressLines, [company.phone ? `Tél. ${company.phone}` : "", company.email].filter(Boolean).join(" · "), company.legalLine].filter(Boolean);
}

export async function runAdminTool(name, args, { books, confidential = true }, by) {
  const admin = books?.admin;
  if (!admin) {
    return { ok: false, erreur: "Le registre administratif n'est pas disponible : je n'ai pas l'information." };
  }
  const log = (text, ref) => books.team?.log({ agent: "administration", kind: "administratif", text, ref, by }).catch(() => {});
  try {
    switch (name) {
      case OVERVIEW_TOOL.name:
        return describeOverview(await admin.overview({ confidential }));
      case SUPPLIER_TOOL.name: {
        const fields = { trade: args.activite, contact: args.contact, phone: args.telephone, email: args.email, ice: args.ice, terms: args.conditions, note: args.note, by };
        if (args.action === "ajouter") {
          const supplier = await admin.addSupplier({ name: args.nom, ...fields });
          await log(`Fournisseur ajouté : ${supplier.name}.`, `fournisseur:${supplier.number}`);
          return { ok: true, fournisseur: describeSupplier(supplier) };
        }
        if (args.action === "modifier") {
          return { ok: true, fournisseur: describeSupplier(await admin.updateSupplier(args.nom, fields)) };
        }
        const removed = await admin.removeSupplier(args.nom, { by });
        return { ok: true, retire: removed.name };
      }
      case CONTRACT_TOOL.name: {
        if (confidential === false) {
          return { ok: false, erreur: "Les contrats de l'entreprise sont réservés à la direction." };
        }
        if (args.action === "resilier") {
          const contract = await admin.endContract(args.numero, { date: args.fin, reason: args.note, by });
          await log(`Contrat n° ${contract.number} (${contract.title}) résilié.`, `contrat-entreprise:${contract.number}`);
          return { ok: true, resilie: `n° ${contract.number} : ${contract.title}, à compter du ${frenchDay(contract.endedOn)}`, rappel: "La résiliation se fait par courrier (recommandé ou remis contre décharge) dans le délai de préavis : courrier, preparer." };
        }
        const contract = await admin.addContract({ title: args.intitule, kind: args.type, party: args.partie, start: args.debut, end: args.fin, termMonths: args.duree_mois || null, renewal: args.renouvellement, noticeDays: Number.isInteger(args.preavis_jours) && args.preavis_jours >= 0 ? args.preavis_jours : null, amount: args.montant, period: args.periodicite, note: args.note, by });
        await log(`Contrat enregistré : ${contract.title}.`, `contrat-entreprise:${contract.number}`);
        return {
          ok: true,
          contrat: describeContract(contract, true),
          ...(contract.renewal === "tacite" && contract.noticeDays === null ? { attention: "Préavis non dit : le registre ne peut pas prévenir avant la date limite de résiliation. Le demander à la direction (il est écrit au contrat)." } : {})
        };
      }
      case DEADLINE_TOOL.name: {
        if (args.action === "ajouter") {
          const deadline = await admin.addDeadline({ title: args.intitule, kind: args.type, due: args.date, recurrence: args.recurrence, warnDays: args.rappel_jours || 7, note: args.note, by });
          return { ok: true, echeance: describeDeadline(deadline) };
        }
        if (args.action === "faite") {
          const deadline = await admin.completeDeadline(args.numero, { note: args.note, by });
          await log(`Échéance faite : ${deadline.title}.`, `echeance:${deadline.number}`);
          return { ok: true, faite: deadline.title, ...(deadline.closed ? {} : { prochaine: `le ${frenchDay(deadline.due)}` }) };
        }
        const removed = await admin.removeDeadline(args.numero, { by });
        return { ok: true, supprimee: removed.title };
      }
      case MAIL_TOOL.name: {
        if (args.action === "enregistrer_recu") {
          const mail = await admin.receiveMail({ party: args.partie, subject: args.objet, date: args.date, reference: args.reference, replyBy: args.repondre_avant, by });
          await log(`Courrier reçu ${mail.chrono} de ${mail.party}.`, `courrier:${mail.number}`);
          return { ok: true, courrier: `${mail.chrono} (n° ${mail.number}) reçu le ${frenchDay(mail.date)} de ${mail.party} : ${mail.subject}${mail.replyBy ? `, réponse avant le ${frenchDay(mail.replyBy)}` : ""}` };
        }
        if (args.action === "preparer") {
          const mail = await admin.prepareMail({ party: args.partie, subject: args.objet, body: args.texte, reference: args.reference, answers: args.numero || "", by });
          await log(`Courrier ${mail.chrono} préparé pour ${mail.party}, à valider.`, `courrier:${mail.number}`);
          return { ok: true, courrier: `${mail.chrono} (n° ${mail.number}) pour ${mail.party} : ${mail.subject}`, statut: "brouillon : la direction le relit dans le cockpit (vue Administratif, avec l'en-tête), puis l'envoie elle-même", en_tete: letterhead() };
        }
        const mail = await admin.closeMail(args.numero, { by });
        return { ok: true, courrier: `${mail.chrono} : ${MAIL_STATUSES[mail.status]}` };
      }
      default:
        return { ok: false, erreur: `Outil administratif inconnu : ${name}.` };
    }
  } catch (error) {
    if (error instanceof AdminBookError) {
      return { ok: false, erreur: error.message };
    }
    throw error;
  }
}

function describeSupplier(supplier) {
  return [`n° ${supplier.number} ${supplier.name}`, supplier.trade, supplier.contact && `contact ${supplier.contact}`, supplier.phone, supplier.email, supplier.ice && `ICE ${supplier.ice}`, supplier.terms, supplier.note].filter(Boolean).join(" · ");
}

function describeContract(contract, withAmount) {
  return [
    `n° ${contract.number} ${contract.title}`,
    contract.party,
    contract.start && `depuis le ${frenchDay(contract.start)}`,
    contract.currentEnd && `échéance le ${frenchDay(contract.currentEnd)}`,
    RENEWALS[contract.renewal],
    contract.noticeBy && `résiliation au plus tard le ${frenchDay(contract.noticeBy)}`,
    withAmount && contract.amount !== null && contract.amount !== undefined && `${dh(contract.amount)}${contract.period ? ` ${contract.period}` : ""}`
  ].filter(Boolean).join(" · ");
}

function describeDeadline(deadline) {
  return `n° ${deadline.number} ${deadline.title} (${DEADLINE_KINDS[deadline.kind]}) le ${frenchDay(deadline.due)}, ${RECURRENCES[deadline.recurrence]}`;
}

function describeOverview(overview) {
  const empty = overview.suppliers.length + overview.contracts.length + overview.deadlines.length + overview.mail.length === 0;
  if (empty) {
    return { ok: true, info: "Le registre administratif est vide. Demande à la direction ses fournisseurs, ses contrats (bail, assurance, leasing…) et ses échéances régulières (à confirmer avec le comptable pour la TVA, l'IS et la CNSS)." };
  }
  return {
    ok: true,
    source: "registre administratif du cockpit (données réelles)",
    alertes: overview.alerts.map((alert) => alert.text),
    echeances: overview.deadlines.slice(0, 15).map((deadline) => `${describeDeadline(deadline)} (${deadline.days < 0 ? `en retard de ${-deadline.days} j` : `dans ${deadline.days} j`})`),
    contrats: overview.contracts.map((contract) => describeContract(contract, contract.amount !== null)),
    courriers: overview.mail.map((mail) => `${mail.chrono} n° ${mail.number} ${mail.way === "entrant" ? "reçu de" : "pour"} ${mail.party} le ${frenchDay(mail.date)} : ${mail.subject} — ${mail.label}${mail.replyBy && mail.status === "a_traiter" ? `, réponse avant le ${frenchDay(mail.replyBy)}` : ""}`),
    fournisseurs: overview.suppliers.map(describeSupplier)
  };
}
