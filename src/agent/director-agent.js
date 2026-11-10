import { randomUUID } from "node:crypto";
import { calculateDocumentTotals, roundMoney } from "../documents/document-calculations.js";
import { HKIDS_DOCUMENT_TYPES } from "../documents/document-schema.js";
import { DocumentValidationError } from "../documents/document-validation.js";
import { HKIDS_FIXED_IDENTITY } from "../documents/hkids-template.js";
import { parseReferenceImage } from "../documents/purchase-order.js";
import { ChatAttachmentError, readAttachments } from "./chat-attachments.js";
import { createCatalogueLoader, searchCatalogue } from "./catalogue.js";
import { SPECIALISTS, SPECIALIST_IDS, runSpecialist } from "./agent-team.js";
import { draftWhatsAppMessage } from "./whatsapp.js";
import { STEP_LABELS, createMemoryPlanStore } from "./plan-store.js";
import { createMemoryConversationStore } from "./conversation-store.js";
import { CNC_FILE_STATUS_LABELS, WORKSHOP_STATUSES, WORKSHOP_STATUS_LABELS, WORKSHOP_STEPS, WORKSHOP_STEP_IDS, WorkshopError, createMemoryWorkshopStore, createWorkshop, frenchDay } from "./workshop-book.js";
import { OBJECTIVE_INDICATORS, currentMonth, measureObjective } from "./sales-objective.js";
import { createMemoryCashBook } from "./cash-book.js";
import { createMemoryImprovementBook } from "./improvement-book.js";
import { createMemoryTeamBook } from "./team-book.js";
import { createMemoryFollowUpBook } from "./sales-book.js";
import {
  ANOMALIES_TOOL,
  CASH_BALANCE_TOOL,
  LINK_MEMBER_TOOL,
  REPORT_ANOMALY_TOOL,
  agentBriefing,
  cashBalance,
  cashTools,
  describeAnomaly,
  directorBriefing,
  improvementTools,
  linkMember,
  listAnomalies,
  reportAnomaly,
  ASSIGN_TASK_TOOL,
  FOLLOW_UP_TOOL,
  SALES_REPORT_TOOL,
  TASK_TOOL,
  assignTask,
  recordFollowUp,
  updateTask,
  salesReportFor,
  salesTools
} from "./company-tools.js";

// The Director as a conversational agent, and as a director: it carries the
// strategy, not the execution. Hiba gives it an objective — "je veux 100 000 DH
// de chiffre d'affaires ce mois" — and it measures where the company stands,
// builds the strategy, gives each head of trade their share, has them answer
// with their own plan, and follows the whole over the days. The work itself is
// done by the agents: a quote is the Commercial's, an invoice is Finance's, a
// message is drafted by whoever owns the relationship. Nothing leaves the
// company and nothing is generated for good without Hiba: a document comes back
// as a preview she validates in the cockpit.
//
// The model only ever chooses and fills tools. Every figure is computed here and
// every document is validated by the same rules as a document typed by hand.

export const DEFAULT_AGENT_MODEL = "gpt-5";
const MAX_TOOL_ROUNDS = 6;
const MAX_CONVERSATION_ITEMS = 60;
const MAX_PHOTOS_PER_MESSAGE = 4;
const TVA_RATE = 0.2;

const DOCUMENT_TYPES = Object.freeze({
  devis: HKIDS_DOCUMENT_TYPES.QUOTE,
  bon_de_commande: HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER,
  facture: HKIDS_DOCUMENT_TYPES.INVOICE,
  bon_de_livraison: HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE
});

const PAYMENT_RULES = Object.freeze({
  "60/20/20": "hkids-60-20-20-2026",
  "50/50": "hkids-po-50-50"
});

const PLAN_TOOL = Object.freeze({
  type: "function",
  name: "etablir_plan_action",
  description: "Présente à la direction le plan d'action AVANT de faire travailler l'équipe : l'objectif, les priorités et, pour chaque étape, l'agent et sa tâche. Le plan s'affiche dans le cockpit et son avancement est suivi.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      objectif: { type: "string", description: "Ce que la direction veut obtenir, en une phrase." },
      objectif_chiffre: {
        type: "object",
        additionalProperties: false,
        description: "Le chiffre à atteindre quand l'objectif en a un (chiffre d'affaires, encaissements), comme mesuré par mesurer_objectif ; montant 0 sinon.",
        properties: {
          indicateur: { type: "string", enum: Object.keys(OBJECTIVE_INDICATORS) },
          montant: { type: "number", description: "En dirhams. 0 si l'objectif n'est pas chiffré." },
          du: { type: "string", description: "AAAA-MM-JJ, ou chaîne vide pour le mois en cours." },
          au: { type: "string", description: "AAAA-MM-JJ, ou chaîne vide pour le mois en cours." }
        },
        required: ["indicateur", "montant", "du", "au"]
      },
      strategie: { type: "string", description: "Comment l'atteindre : les leviers et leur poids, en deux ou trois phrases." },
      priorites: { type: "array", items: { type: "string" }, description: "Les priorités, de la plus urgente à la moins urgente (3 au plus)." },
      etapes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            agent: { type: "string", enum: [...SPECIALIST_IDS, "director"] },
            tache: { type: "string" },
            echeance: { type: "string", description: "Date limite AAAA-MM-JJ pour une étape qui ne se fait pas tout de suite, sinon chaîne vide." }
          },
          required: ["agent", "tache", "echeance"]
        }
      }
    },
    required: ["objectif", "objectif_chiffre", "strategie", "priorites", "etapes"]
  }
});

const LIST_PLANS_TOOL = Object.freeze({
  type: "function",
  name: "lister_plans",
  description: "Liste les plans d'action conservés, avec leur avancement, les étapes à faire, en retard ou bloquées. À appeler dès que la direction parle d'un plan existant (« où en est… », « on continue », « suivi ») ou d'un fait qui fait avancer un plan.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      statut: { type: "string", enum: ["active", "done", "all"], description: "active = plans en cours (par défaut)." }
    },
    required: ["statut"]
  }
});

const ADJUST_PLAN_TOOL = Object.freeze({
  type: "function",
  name: "ajuster_plan",
  description: "Met à jour un plan conservé : statut et résultat d'étapes, nouvelles échéances, nouvelles étapes, note au journal, clôture.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      numero: { type: "integer", description: "Le numéro du plan." },
      etapes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            etape: { type: "integer", description: "Numéro de l'étape (1, 2, 3…)." },
            statut: { type: "string", enum: ["todo", "in_progress", "done", "blocked", ""] },
            resultat: { type: "string" },
            echeance: { type: "string", description: "AAAA-MM-JJ, ou chaîne vide." }
          },
          required: ["etape", "statut", "resultat", "echeance"]
        }
      },
      nouvelles_etapes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            agent: { type: "string", enum: [...SPECIALIST_IDS, "director"] },
            tache: { type: "string" },
            echeance: { type: "string" }
          },
          required: ["agent", "tache", "echeance"]
        }
      },
      note: { type: "string", description: "Ce qui s'est passé, pour le journal du plan. Chaîne vide si rien." },
      cloture: { type: "string", enum: ["", "terminer", "abandonner", "reouvrir"] }
    },
    required: ["numero", "etapes", "nouvelles_etapes", "note", "cloture"]
  }
});

const MEASURE_TOOL = Object.freeze({
  type: "function",
  name: "mesurer_objectif",
  description: "Mesure, sur les données de l'entreprise, où en est un objectif chiffré : réalisé dans la période, écart, rythme par jour restant, devis ouverts (montant, à relancer, les plus gros), encaissements reçus et attendus. À appeler AVANT de bâtir la stratégie d'un objectif chiffré, et pour en suivre l'avancement.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      indicateur: { type: "string", enum: Object.keys(OBJECTIVE_INDICATORS), description: "ventes_signees = chiffre d'affaires (devis acceptés) ; encaissements = argent reçu." },
      montant: { type: "number", description: "La cible, en dirhams." },
      du: { type: "string", description: "Début AAAA-MM-JJ, ou chaîne vide pour le mois en cours." },
      au: { type: "string", description: "Fin AAAA-MM-JJ, ou chaîne vide pour le mois en cours." }
    },
    required: ["indicateur", "montant", "du", "au"]
  }
});

const COHERENCE_TOOL = Object.freeze({
  type: "function",
  name: "verifier_coherence",
  description: "Croise les données de tous les métiers (devis, commandes, atelier, paiements, achats) et renvoie les incohérences : production sans acompte, achat pour une commande livrée, commande sans devis accepté, livré mais impayé… À appeler pour tout point de situation, toute question d'urgences et après avoir fait travailler plusieurs agents.",
  parameters: { type: "object", additionalProperties: false, properties: {} }
});

// The documents and the catalogue belong to the trades that produce them: the
// Director hands these tools to the Commercial and Finance agents and keeps none.
const DOCUMENT_TOOL = Object.freeze({
    type: "function",
    name: "preparer_document",
    description: "Prépare un document commercial H-KIDS (devis, bon de commande, facture ou bon de livraison) et renvoie son aperçu. Le document n'est généré qu'après validation par l'utilisatrice dans le cockpit. N'appeler que lorsque le client (nom et adresse) et chaque ligne (désignation, quantité, prix) sont connus.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: Object.keys(DOCUMENT_TYPES), description: "Le document à préparer." },
        client_nom: { type: "string", description: "Nom du client, tel que donné." },
        client_adresse: { type: "string", description: "Adresse du client (au minimum la ville). Ne jamais l'inventer." },
        objet: { type: "string", description: "Objet court, par exemple « Lit nuage » ou « Aménagement chambre enfant ». Chaîne vide si aucun." },
        lignes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              designation: { type: "string" },
              quantite: { type: "number" },
              prix_unitaire: { type: "number", description: "Prix unitaire en dirhams." },
              prix_ttc: { type: "boolean", description: "true si le prix donné est TTC (cas par défaut quand l'utilisatrice ne précise pas), false s'il est HT." }
            },
            required: ["designation", "quantite", "prix_unitaire", "prix_ttc"]
          }
        },
        caracteristiques: { type: "array", items: { type: "string" }, description: "Finitions, coloris, dimensions… (bon de commande surtout). Liste vide si aucune." },
        conditions_paiement: { type: "string", enum: Object.keys(PAYMENT_RULES), description: "60/20/20 par défaut ; 50/50 seulement pour un bon de commande." },
        reference_devis: { type: "string", description: "Numéro du devis lié (bon de commande fait à partir d'un devis, facture, bon de livraison). Chaîne vide si aucun." },
        reference_bl: { type: "string", description: "Numéro du bon de livraison lié (facture). Chaîne vide si aucun." },
        numero: { type: "string", description: "Numéro imposé par l'utilisatrice. Chaîne vide pour prendre le prochain numéro libre." },
        photo: { type: "integer", description: "Bon de commande : numéro de la photo jointe par la direction à mettre comme visuel de référence (« visuel : photo n° 2 » → 2). 0 si aucune." },
        date: { type: "string", description: "Date imprimée sur le document, au format JJ/MM/AAAA, seulement si la direction en impose une (« date : 08/08/2026 »). Chaîne vide = date du jour." },
        remplace: { type: "boolean", description: "true pour corriger ou refaire un document DÉJÀ GÉNÉRÉ sous le même numéro (numero obligatoire) : l'ancienne version est archivée quand la direction valide, jamais effacée. false pour un nouveau document." }
      },
      required: ["type", "client_nom", "client_adresse", "objet", "lignes", "caracteristiques", "conditions_paiement", "reference_devis", "reference_bl", "numero", "photo", "date", "remplace"]
    }
});

const CONSULT_DOCUMENT_TOOL = Object.freeze({
    type: "function",
    name: "consulter_document",
    description: "Relit un document H-KIDS déjà généré (devis, bon de commande, facture ou bon de livraison) par son numéro : client, adresse, date, lignes avec leur prix unitaire HT, caractéristiques, conditions, visuel. À appeler avant de corriger ou de refaire un document existant.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: Object.keys(DOCUMENT_TYPES), description: "Le type du document." },
        numero: { type: "string", description: "Son numéro, par exemple « 170 »." }
      },
      required: ["type", "numero"]
    }
});

const FOLLOW_DOSSIER_TOOL = Object.freeze({
    type: "function",
    name: "suivre_dossier",
    description: "Où en est une vente, à partir d'un de ses documents (devis, bon de commande, bon de livraison ou facture) : le devis et son montant, le bon de commande qui l'a accepté, les bons de livraison, les factures déjà faites, le total facturé, le reste à facturer et les anomalies (facture en double…). À appeler pour « où en est le devis 170 », et AVANT toute facture.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: Object.keys(DOCUMENT_TYPES), description: "Le type du document connu." },
        numero: { type: "string", description: "Son numéro, par exemple « 170 »." }
      },
      required: ["type", "numero"]
    }
});

// The workshop book: each purchase order validated in the cockpit, through the
// seven steps of the manufacturing route.
const WORKSHOP_BOOK_TOOL = Object.freeze({
    type: "function",
    name: "carnet_atelier",
    description: `Le carnet d'atelier : chaque bon de commande validé dans le cockpit et son parcours de fabrication (${WORKSHOP_STEPS.map((step) => step.label).join(", ")}), avec pour chaque étape son statut, son responsable, sa date prévue et sa date réelle, l'avancement calculé sur les étapes terminées, les alertes (étape bloquée, en retard, installée mais pas soldée) et le journal. À appeler pour « où en est la commande de… », « quelles commandes sont en retard », le planning de l'atelier, et pour tout point de situation.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        numero: { type: "string", description: "Numéro du bon de commande pour son détail complet ; chaîne vide pour tout le carnet." }
      },
      required: ["numero"]
    }
});

const ADVANCE_ORDER_TOOL = Object.freeze({
    type: "function",
    name: "avancer_commande",
    description: "Enregistre au carnet d'atelier ce qui s'est passé sur UNE étape d'un bon de commande : commencée, terminée, bloquée (avec ce qui bloque), son responsable, sa date prévue. Seulement pour un fait annoncé par la direction ou l'atelier, jamais supposé. Un appel par étape.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        numero: { type: "string", description: "Numéro du bon de commande." },
        etape: { type: "string", enum: WORKSHOP_STEP_IDS, description: WORKSHOP_STEPS.map((step) => `${step.id} = ${step.label} (${step.detail})`).join(" ; ") },
        statut: { type: "string", enum: ["", ...WORKSHOP_STATUSES], description: "Nouveau statut ; chaîne vide pour ne pas le changer." },
        responsable: { type: "string", description: "Qui s'en charge, tel que nommé ; chaîne vide pour ne pas le changer." },
        date_prevue: { type: "string", description: "Date prévue JJ/MM/AAAA ; chaîne vide pour ne pas la changer." },
        date_reelle: { type: "string", description: "Date de fin JJ/MM/AAAA pour une étape terminée un autre jour qu'aujourd'hui ; chaîne vide sinon." },
        note: { type: "string", description: "Ce qui bloque (obligatoire pour « bloquee »), ou une précision ; chaîne vide sinon." }
      },
      required: ["numero", "etape", "statut", "responsable", "date_prevue", "date_reelle", "note"]
    }
});

// The client's follow-up link and the photos published on it.
const CLIENT_LINK_TOOL = Object.freeze({
    type: "function",
    name: "lien_suivi_client",
    description: "Crée (ou redonne) le lien de suivi sécurisé d'un bon de commande, à envoyer au client : il y voit l'avancement réel, les étapes terminées, la livraison prévue, l'échéancier, les photos publiées et ses documents, jamais les notes internes. « desactiver » coupe le lien pour de bon.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        numero: { type: "string", description: "Numéro du bon de commande." },
        action: { type: "string", enum: ["creer", "desactiver"] }
      },
      required: ["numero", "action"]
    }
});

// Who answers for an order: its chef de charge, the client's architect and
// who deals with them, the draughtsman of the CNC files.
const ORDER_TEAM_TOOL = Object.freeze({
    type: "function",
    name: "equipe_commande",
    description: "Enregistre qui répond d'un bon de commande : le chef de charge qui contrôle la commande de bout en bout (et son numéro WhatsApp : il y reçoit les alertes de retard et de blocage de la commande), l'architecte du client (et son numéro), la personne de l'équipe en lien avec l'architecte, le dessinateur qui fait le G-code de la machine CNC après la fiche technique (et son numéro WhatsApp : il pourra y envoyer ses fichiers). Seulement pour ce que la direction ou l'atelier a dit. Chaîne vide pour ne pas changer un rôle, « - » pour le retirer.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        numero: { type: "string", description: "Numéro du bon de commande." },
        chef_de_charge: { type: "string", description: "Prénom ou nom du chef de charge." },
        telephone_chef_de_charge: { type: "string", description: "Numéro WhatsApp du chef de charge, tel que donné." },
        architecte: { type: "string", description: "Nom de l'architecte du client (cabinet compris s'il est dit)." },
        telephone_architecte: { type: "string", description: "Numéro de l'architecte, tel que donné." },
        lien_architecte: { type: "string", description: "La personne de l'équipe qui échange avec l'architecte." },
        dessinateur: { type: "string", description: "Le dessinateur qui fait le G-code." },
        telephone_dessinateur: { type: "string", description: "Numéro WhatsApp du dessinateur, tel que donné." }
      },
      required: ["numero", "chef_de_charge", "telephone_chef_de_charge", "architecte", "telephone_architecte", "lien_architecte", "dessinateur", "telephone_dessinateur"]
    }
});

const PUBLISH_PHOTO_TOOL = Object.freeze({
    type: "function",
    name: "publier_photo_suivi",
    description: "Publie une photo jointe par la direction sur le suivi client d'un bon de commande (le client la voit sur son lien). Seulement quand la direction le demande.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        numero: { type: "string", description: "Numéro du bon de commande." },
        photo: { type: "integer", description: "Numéro de la photo dans la conversation (« photo n° 2 » → 2)." },
        legende: { type: "string", description: "Légende courte et neutre pour le client, par exemple « Assemblage terminé ». Chaîne vide si aucune." }
      },
      required: ["numero", "photo", "legende"]
    }
});

const CATALOGUE_TOOL = Object.freeze({
    type: "function",
    name: "chercher_catalogue",
    description: "Cherche un ou plusieurs produits dans le catalogue H-KIDS et renvoie leur nom exact, leur description et leur prix TTC de base. À appeler pour chaque produit demandé dont le prix n'a pas été donné.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        recherche: { type: "string", description: "Le produit tel que nommé par l'utilisatrice, par exemple « lit nuage »." }
      },
      required: ["recherche"]
    }
});

const TOOLS = Object.freeze([
  {
    type: "function",
    name: "deleguer_a_un_agent",
    description: "Confie une mission à un responsable de l'équipe, qui lit ses propres données, exécute et répond : sa part d'un objectif avec son plan chiffré, une analyse, un document (devis, bon de commande, bon de livraison → commercial ; facture → finance), des brouillons de messages ou de commandes. Appelle plusieurs responsables en même temps quand la demande touche plusieurs métiers.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agent: {
          type: "string",
          enum: SPECIALIST_IDS,
          description: SPECIALIST_IDS.map((id) => `${id} = ${SPECIALISTS[id].label} (${SPECIALISTS[id].mission})`).join(" ; ")
        },
        mission: { type: "string", description: "Ce que l'agent doit faire, précis et complet (il ne voit pas la conversation)." }
      },
      required: ["agent", "mission"]
    }
  },
  MEASURE_TOOL,
  PLAN_TOOL,
  LIST_PLANS_TOOL,
  ADJUST_PLAN_TOOL,
  COHERENCE_TOOL,
  FOLLOW_DOSSIER_TOOL,
  WORKSHOP_BOOK_TOOL,
  ADVANCE_ORDER_TOOL,
  CLIENT_LINK_TOOL,
  ORDER_TEAM_TOOL,
  PUBLISH_PHOTO_TOOL,
  SALES_REPORT_TOOL,
  FOLLOW_UP_TOOL,
  ASSIGN_TASK_TOOL,
  TASK_TOOL,
  CASH_BALANCE_TOOL,
  ANOMALIES_TOOL,
  REPORT_ANOMALY_TOOL,
  LINK_MEMBER_TOOL,
  {
    type: "function",
    name: "point_entreprise",
    description: "Interroge l'équipe d'agents (commercial, finance, production, achats, RH, marketing, SAV, juridique) et renvoie la situation : ce qui va bien, retards, encaissements, achats, risques, décisions. À utiliser pour toute question sur l'état de l'entreprise.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: { type: "string", description: "La question telle que posée par l'utilisatrice." }
      },
      required: ["question"]
    }
  }
]);

function instructions(today, briefing = []) {
  return [
    "Tu es le Director IA de H KIDS, fabricant marocain de mobilier et d'aménagement sur mesure pour enfants (Marrakech).",
    `Tu parles à la direction (Hiba, Omar). Nous sommes le ${today}. Réponds toujours en français, de façon courte, claire et chaleureuse.`,
    "",
    "Ton rôle est celui d'un directeur général : tu portes la stratégie et la responsabilité des résultats. Tu fixes la direction, tu répartis le travail entre les responsables, tu suis l'avancement et tu alertes. Tu n'exécutes pas toi-même : un devis, un bon de commande ou un bon de livraison est fait par le Directeur commercial (agent commercial), une facture par la Finance, un message par le responsable concerné.",
    "",
    "Objectif chiffré (« je veux 100 000 DH de chiffre d'affaires ce mois », « il faut encaisser 50 000 DH avant le 15 ») — méthode OBLIGATOIRE :",
    "1) mesurer_objectif : réalisé, écart, rythme par jour, devis ouverts, encaissements. Chiffre d'affaires = ventes_signees, sauf si la direction parle d'argent reçu (encaissements). Période non précisée = mois en cours.",
    "2) etablir_plan_action avec objectif_chiffre : la stratégie qui comble l'écart (quelle part viendra des devis ouverts à relancer, quelle part de nouvelles affaires, avec quel panier), les priorités, et une étape par responsable avec SA PART CHIFFRÉE et une échéance : Commercial (ventes à signer, devis à relancer et à produire), Marketing (demandes de devis à générer), Finance (encaissements, trésorerie), Production (capacité de l'atelier à livrer ces ventes), Achats (matières à sécuriser). N'implique que les responsables utiles.",
    "3) deleguer_a_un_agent, en parallèle, à chaque responsable : sa part avec les chiffres (réalisé, écart, sa cible, les devis concernés) — il ne voit pas la conversation — et demande-lui son plan d'action chiffré.",
    "4) Synthèse : où on en est (réalisé / cible / écart / rythme par jour), la stratégie, ce que chaque responsable s'engage à apporter et si le total couvre l'écart, les risques (capacité atelier, trésorerie, matières) et les décisions qui reviennent à la direction (remise, budget, recrutement…). Si la cible est irréaliste au vu des chiffres, dis-le franchement et propose une cible atteignable.",
    "- H KIDS travaille en dirhams. Si la direction donne un objectif en euros, demande en une question s'il s'agit bien d'euros ou de dirhams avant de mesurer.",
    "- Suivi d'un objectif (« où en est l'objectif », « on avance ? ») : lister_plans, puis mesurer_objectif avec la même cible et la même période, puis donne réalisé / cible / écart / rythme, ce qui a bougé et la prochaine action ; relance les responsables en retard.",
    "",
    "Question de situation, d'urgences, de risques ou de décisions — méthode OBLIGATOIRE : 1) etablir_plan_action (objectif, stratégie, priorités, étapes responsable + tâche ; objectif_chiffre avec montant 0) ; 2) deleguer_a_un_agent (les étapes indépendantes en même temps) ou point_entreprise pour un point global ; 3) synthèse qui suit le plan, puis les incohérences signalées, puis ce qui demande une décision.",
    "",
    "Tâche d'exécution demandée directement (un devis, un bon de commande, un bon de livraison, une facture, une relance) : pas de plan ; confie-la tout de suite au bon responsable avec deleguer_a_un_agent en recopiant TOUTES les informations données (client, adresse, téléphone, produits, quantités, prix, conditions, acompte déjà payé, numéros liés, et la date du document si la direction en impose une : écris « date du document : JJ/MM/AAAA »). Un prix donné sans précision est TTC : écris-le « 3000 DH TTC » dans la mission ; n'écris « HT » que si la direction l'a dit. Ne demande rien avant de confier : la ville suffit comme adresse, quantité non précisée = 1, conditions 60/20/20 par défaut (seuls échéanciers approuvés : 60/20/20 ; en exception 50/30/20, 40/40/20, 100 % ; 50/50 sur bon de commande), prix absent = prix catalogue cherché par le Commercial ; dimensions, coloris, livraison ou délai ne sont pas requis. S'il répond qu'il manque une information, pose UNE question courte à la direction qui demande tout ce qui manque, puis redonne la tâche complète au responsable. Annonce ensuite le document en 2 ou 3 lignes (qui l'a préparé, type, numéro, date, client, total TTC), avec les valeurs que le responsable rapporte du document préparé et jamais celles que tu as demandées : si une demande (date, visuel, condition) n'apparaît pas dans le document, dis-le clairement au lieu de l'annoncer comme faite et dis de vérifier l'aperçu et de cliquer « Valider et générer ».",
    "",
    "Correction d'un document déjà généré (« refais le devis 170 », « corrige le BC 165, la date est fausse », « enlève la ligne des chevets du devis 170 ») : confie-la tout de suite au responsable du document (devis, bon de commande, bon de livraison → commercial ; facture → finance) avec son type, son numéro et TOUTES les corrections demandées, en écrivant « correction du document existant n° X, même numéro ». Ne demande pas le contenu du document : le responsable le relit lui-même. Annonce ensuite ce qui a changé et que l'ancienne version sera archivée quand la direction validera.",
    "",
    "Chaîne d'une vente : devis → bon de commande (le client accepte) → bon de livraison → factures (acompte, solde). Chaque document cite le devis : écris toujours son numéro dans la mission. « Le client a accepté le devis 170 », « fais le BC du devis 170 » → commercial : « bon de commande à partir du devis n° 170 », avec les conditions et l'acompte s'ils sont donnés ; il reprend le devis lui-même, rien n'est à ressaisir. « Facture l'acompte du devis 170 », « facture le solde » → finance avec le numéro du devis. « Où en est le devis 170 », « qu'est-ce qui reste à facturer » → suivre_dossier toi-même, puis réponds avec l'étape, le déjà facturé, le reste à facturer et les anomalies. Une facture refusée parce qu'elle facturerait la vente deux fois ne se contourne pas : dis-le à la direction avec les factures déjà faites.",
    "",
    `Atelier, après le bon de commande : chaque bon de commande validé suit ${WORKSHOP_STEPS.length} étapes (${WORKSHOP_STEPS.map((step) => step.label).join(", ")}). « Le BC 166 est en découpe », « l'assemblage du 166 est fini », « la peinture est bloquée, il manque la laque », « Youssef s'occupe de l'étude, prévue pour le 12/11 » → c'est un fait que la direction t'annonce : avancer_commande toi-même, un appel par étape (une étape commencée = en_cours ; les étapes d'avant qu'elle dit finies = terminee), puis confirme en une ligne avec l'avancement. « Où en est la commande de Mme X / le BC 166 », « quelles commandes sont en retard » → carnet_atelier, puis l'étape en cours, l'avancement (calculé sur les étapes terminées, jamais estimé), les dates prévues et les alertes. Planning, priorités ou charge de l'atelier → production. Suite de la chaîne, tout de suite après l'avoir enregistrée : contrôle qualité terminé → commercial : préparer le message au client pour convenir de la date de livraison et d'installation ; livraison et installation terminée → finance : facture du solde du devis (si le dossier n'est pas soldé). Pour tout point de situation ou toute question d'urgences, regarde aussi carnet_atelier et signale les commandes bloquées ou en retard.`,
    "",
    "Tâches et clôture (chaque anomalie est une tâche, même numéro) : le résumé des anomalies t'est donné à chaque message ; dans tout point de situation, dis ce qui est ouvert, grave, sans responsable, en retard, et résolu à confirmer. « Assigne l'anomalie 4 à la production, Samir, pour le 25/11 » → assigner_tache (la personne est prévenue sur WhatsApp). N'assigne jamais de toi-même : propose (à qui, pour quand) et laisse la direction décider. Un fait annoncé (« Samir s'en occupe », « c'est réglé, le chevet est remplacé ») → suivre_tache. Une tâche résolue n'est clôturée que par la direction : dans le cockpit (vue Amélioration) ou en répondant « clôture tâche N » sur WhatsApp ; ne dis jamais qu'elle est close avant.",
    "",
    "Bilan commercial et relances : « fais le bilan commercial du mois », « quels devis relancer ? », « où en sont les ventes » → bilan_commercial (chiffres calculés sur les documents du cockpit : cite les numéros, ne recalcule rien, ne complète jamais avec un chiffre supposé). « J'ai relancé Mme Alami pour le devis 170, elle réfléchit », « le client du devis 172 a refusé, trop cher » → enregistrer_relance toi-même (perdu avec son motif pour un refus). Un devis ouvert sans nouvelles depuis 5 jours est à relancer : le responsable commercial est prévenu sur WhatsApp, et la direction au bout de 10 jours ; pour rédiger les messages de relance, confie-les au commercial.",
    "",
    "Bureau d'études, avant la découpe : chaque bon de commande a un chef de charge qui le contrôle de bout en bout ; avec son numéro, il reçoit sur WhatsApp chaque étape de sa commande qui se bloque ou prend du retard, et sa réponse arrive à la Production comme compte rendu ; quand le client a un architecte, une personne de l'équipe est en lien avec lui ; après la fiche technique (étude technique terminée), le dessinateur fait le fichier de la machine CNC (G-code ou DXF) et le dépose dans le cockpit, ou l'envoie au numéro WhatsApp de l'entreprise avec « BC n° » en légende (son numéro doit être enregistré sur la commande). « Samir est chef de charge du BC 166 », « l'architecte de Mme Alami est M. Bennani, c'est Hiba qui le suit », « Karim fait le G-code » → equipe_commande. Le fichier n'atteint la machine qu'une fois validé par la direction dans le cockpit (vue Atelier) : tu ne le valides jamais, et la découpe CNC ne peut pas commencer avant. Une commande lancée sans chef de charge, un fichier CNC qui attend sa validation : signale-le dans tout point de situation.",
    "",
    "Caisse et bilan du jour : chaque entrée ou sortie d'argent que la direction t'annonce (« j'ai reçu 3 000 DH d'acompte de Mme Alami en espèces pour le devis 170 », « j'ai payé 1 200 DH de laque à Sodipeint par chèque », « j'ai versé les salaires, 18 000 DH par virement », « il y a 5 000 DH en caisse au départ ») → confie-la tout de suite au Directeur financier (finance) avec deleguer_a_un_agent, en recopiant tout : entrée ou sortie, montant, ce que c'est, moyen de paiement, qui a payé ou a été payé, numéro du devis ou du BC, la date si ce n'est pas aujourd'hui, et qui l'annonce. Plusieurs mouvements annoncés ensemble → une seule mission qui les liste tous. Finance l'enregistre au journal de caisse et te rend le bilan du jour : réponds en deux ou trois lignes (mouvement n°, montant, solde du jour, et pour un client ce qui reste à encaisser sur sa vente). « Où en est la caisse », « bilan du jour », « combien j'ai en caisse » → bilan_caisse toi-même. Pour tout point de situation, donne aussi le bilan de caisse du jour. Une erreur de saisie (« ce n'était pas 3 000 mais 2 000 ») → finance : annuler le mouvement et enregistrer le bon. Justificatifs : une dépense annoncée avec la photo d'un reçu, d'un ticket ou d'une facture → écris « justificatif : photo n° X » dans la mission ; une photo envoyée plus tard pour une dépense déjà enregistrée (« voici le reçu du MDF ») → mission à finance : joindre la photo n° X au mouvement n° N. Sans photo, rappelle à la direction d'envoyer le justificatif. Une dépense au-dessus du seuil d'alerte s'approuve dans la vue Caisse du cockpit, par une personne : tu ne l'approuves jamais.",
    "",
    "Amélioration continue : un retard ou un blocage au carnet d'atelier devient une anomalie, analysée automatiquement par son responsable (production pour l'atelier, achats pour l'approvisionnement) qui en trouve la cause et propose une règle pour qu'elle ne se reproduise pas. Un problème que la direction rapporte (client mécontent, fournisseur en retard, erreur de livraison, paiement oublié) → signaler_anomalie, puis deleguer_a_un_agent au responsable : « Analyse l'anomalie n° X : … Trouve la cause dans tes données et enregistre-la avec analyser_anomalie, avec la règle qui l'aurait évitée. » Une anomalie encore « à analyser » que la direction veut voir tout de suite → même délégation. Une règle ne s'applique qu'une fois validée par la direction dans le cockpit (vue Amélioration) : dis toujours qu'elle attend sa validation, jamais qu'elle est en place. Les règles actives sont données à leurs agents à chaque mission ; signale quand une situation en déclenche une.",
    "",
    "Équipe : chaque agent est relié à une vraie personne de l'équipe, qui reçoit ses tâches et rend compte. « Youssef, le chef d'atelier, s'occupe de la production, son numéro est 06… » → relier_responsable. Ce que la personne rapporte (« Youssef dit que la découpe est finie ») est un fait annoncé : enregistre-le comme tel. Chaque agent sait ce que les autres ont fait : le fil d'activité de l'équipe lui est donné à chaque mission.",
    "",
    "Suivi client : « envoie le lien de suivi au client du BC 166 » → lien_suivi_client (creer), puis commercial : message WhatsApp au client avec ce lien, recopié tel quel dans la mission. « Mets cette photo sur le suivi du BC 166 » → publier_photo_suivi avec le numéro de la photo et une légende courte et neutre ; une photo n'est publiée que si la direction le demande. « Coupe le lien du BC 166 » → lien_suivi_client (desactiver). Le client ne voit jamais les notes, les responsables ni la raison d'un blocage.",
    "",
    "Photos : la direction peut joindre des photos (numérotées « photo n° 1 », « photo n° 2 »… dans la conversation). Regarde-les et dis en une phrase ce que tu y vois d'utile (meuble, modèle, coloris, finitions, dimensions apparentes, texte lisible). Les responsables ne voient pas les photos : recopie dans la mission ce qu'elles montrent. Pour un bon de commande, écris aussi « visuel : photo n° X » dans la mission pour que la photo figure sur le document. N'invente rien que la photo ne montre pas.",
    "Documents : la direction peut joindre des documents (PDF, Word, Excel, texte), numérotés « document n° 1 »… Lis-les et sers-t'en : réponds à la question posée dessus, ou résume en quelques lignes ce qui compte pour H KIDS (client, montants, dates, quantités, conditions, échéances). Les responsables ne voient pas les documents : recopie dans leur mission les informations utiles, chiffres compris. Si un document ne contient pas l'information demandée, dis-le.",
    "",
    "Règles :",
    "- Les plans sont CONSERVÉS et suivis dans le temps. Quand la direction parle d'un plan existant ou d'un fait qui le fait avancer (« où en est le plan », « on continue », « l'acompte Atlas est arrivé »), appelle lister_plans puis : relance les étapes encore à faire avec deleguer_a_un_agent (l'étape du responsable se met à jour seule), mets à jour avec ajuster_plan (fait, bloqué, nouvelle échéance, nouvelles étapes, note), et réponds avec l'avancement et la prochaine action. Ne crée pas un nouveau plan pour un sujet qui a déjà un plan en cours : ajuste-le.",
    "- Statut des étapes : après le travail d'un responsable, son étape passe « en cours ». Marque-la « fait » avec ajuster_plan SEULEMENT si la tâche est entièrement accomplie par ce travail (une analyse, un plan chiffré, une liste). Une action réelle (message envoyé, vente signée, paiement reçu, commande passée, livraison) reste « en cours » tant que la direction n'a pas confirmé qu'elle a eu lieu. Un plan est « proposé » à la direction, jamais « validé » par toi.",
    "- Quand la direction t'annonce qu'une action a eu lieu (« l'acompte est arrivé », « Meriem a signé »), c'est une confirmation : marque tout de suite les étapes correspondantes « fait » avec ajuster_plan, sans demander de preuve, et note le fait au journal. Ne fais travailler que les étapes que cette nouvelle débloque.",
    "- N'invente aucun moyen, service ou option dont les données ne parlent pas (lien de paiement, livraison express…). Une information présente dans les données (fournisseur, délai, montant) se cite telle quelle ; elle n'est jamais « à confirmer ».",
    "- N'écris jamais qu'une chose « est lancée », « est faite » ou « a eu lieu » si ni la direction ni une donnée ne l'a confirmé : c'est « prêt à lancer » ou « proposé ».",
    "- Donne une échéance réaliste aux étapes qui ne se font pas tout de suite. Marque toi-même tes étapes « director » avec ajuster_plan quand elles sont faites.",
    "- Signale toujours les incohérences renvoyées par verifier_coherence, avec les responsables concernés et l'action proposée ; ne les invente jamais.",
    "- Tes responsables : Commercial (Directeur commercial), Finance, Production, Achats, Marketing, Community Manager (sous le Marketing), et aussi RH, SAV, Juridique.",
    "- Pour le point complet de l'entreprise (« fais-moi le point »), après le plan, appelle point_entreprise puis résume l'essentiel en 5 lignes maximum, les urgences d'abord.",
    "- Pour une simple salutation ou une question générale, réponds directement sans outil.",
    "- Les messages aux clients ou fournisseurs sont rédigés par les responsables et s'affichent avec un bouton « Envoyer via WhatsApp » : c'est Hiba qui les envoie. Ne recopie pas leur texte : dis pour qui ils sont prêts.",
    "- N'annonce jamais « je lance », « j'appelle », « j'envoie » ou « je commande », et ne propose jamais de le faire. Ce qui reste à faire est une décision pour la direction ou une action d'un responsable.",
    "- Vouvoie toujours la direction. H KIDS est au Maroc : dirhams, droit et organismes marocains uniquement.",
    "- Réponse : d'abord l'essentiel en quelques lignes (chiffres, noms, décisions), ensuite le détail par responsable, chacun sous un titre court.",
    "",
    `Informations société : ${HKIDS_FIXED_IDENTITY.companyName}, ${HKIDS_FIXED_IDENTITY.addressLines.join(" ").replace(/^Adresse : /, "")}, tél. ${HKIDS_FIXED_IDENTITY.phone}, ${HKIDS_FIXED_IDENTITY.email}. TVA 20 %.`,
    ...(briefing.length > 0 ? ["", ...briefing] : [])
  ].join("\n");
}

export class DirectorAgentError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "DirectorAgentError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function createDirectorAgentFromEnv({ env = process.env, documentService, runDirectorRequest, toolRegistry = null, executeTool = null, checkCoherence = null, loadObjectiveRecords = null, planStore = undefined, conversationStore = undefined, workshopStore = undefined, cashBook = undefined, improvementBook = undefined, teamBook = undefined, followUpBook = undefined, autoAnalyse = false, publicBaseUrl = env.PUBLIC_BASE_URL ?? "", client = null } = {}) {
  const apiKey = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  const model = typeof env.OPENAI_MODEL === "string" && env.OPENAI_MODEL.trim() !== "" ? env.OPENAI_MODEL.trim() : DEFAULT_AGENT_MODEL;
  const cataloguePath = typeof env.HKIDS_CATALOGUE_PATH === "string" && env.HKIDS_CATALOGUE_PATH.trim() !== "" ? env.HKIDS_CATALOGUE_PATH.trim() : undefined;
  const loadCatalogue = createCatalogueLoader(cataloguePath ? { path: cataloguePath } : {});
  return createDirectorAgent({ apiKey, model, documentService, runDirectorRequest, toolRegistry, executeTool, checkCoherence, loadObjectiveRecords, planStore, conversationStore, workshopStore, cashBook, improvementBook, teamBook, followUpBook, autoAnalyse, publicBaseUrl, client, loadCatalogue });
}

export function createDirectorAgent({
  apiKey = "",
  model = DEFAULT_AGENT_MODEL,
  client = null,
  documentService,
  runDirectorRequest,
  loadCatalogue = async () => ({ available: false, catalogue: [] }),
  toolRegistry = null,
  executeTool = null,
  checkCoherence = null,
  loadObjectiveRecords = null,
  planStore = createMemoryPlanStore(),
  conversationStore = createMemoryConversationStore(),
  workshopStore = createMemoryWorkshopStore(),
  cashBook = null,
  improvementBook = null,
  teamBook = null,
  followUpBook = null,
  // A new anomaly found in the workshop book is handed to its agent at once,
  // in the background, for its cause and a rule. Off unless the server asks.
  autoAnalyse = false,
  publicBaseUrl = "",
  clock = () => new Date(),
  clientFactory = defaultClientFactory
} = {}) {
  let resolvedClient = client;
  const workshop = createWorkshop({ store: workshopStore, documentService, clock, publicBaseUrl });
  const books = Object.freeze({
    cash: cashBook ?? createMemoryCashBook({ clock }),
    improvement: improvementBook ?? createMemoryImprovementBook({ clock }),
    team: teamBook ?? createMemoryTeamBook({ clock, agents: SPECIALIST_IDS }),
    followUps: followUpBook ?? createMemoryFollowUpBook({ clock })
  });
  const configured = () => Boolean(client) || apiKey !== "";
  // The context every tool runs in; a turn adds its own outcome and user.
  const baseContext = (outcome, userId = null, confidential = true) => ({
    confidential,
    documentService,
    runDirectorRequest,
    loadCatalogue,
    clock,
    userId,
    outcome,
    team: { client: resolvedClient, model, toolRegistry, executeTool },
    checkCoherence,
    loadObjectiveRecords,
    planStore,
    workshop,
    books,
    onNewAnomalies: (found) => queueAnalyses(found)
  });
  const freshOutcome = (photos = []) => ({ documents: [], directorResponse: null, agentRuns: [], messages: [], plan: null, planId: null, alerts: null, photos });

  // One analysis at a time, in the background; a failure is written to the
  // team feed and never reaches whoever read the book.
  let analyses = Promise.resolve();
  function queueAnalyses(found) {
    if (!autoAnalyse || !configured() || found.length === 0) {
      return;
    }
    for (const anomaly of found) {
      analyses = analyses.then(() => analyse(anomaly.number)).catch(async (error) => {
        await books.team.log({ agent: anomaly.owner, kind: "amelioration", text: `Analyse automatique de l'anomalie n° ${anomaly.number} impossible : ${error.message}`, by: "director" }).catch(() => {});
      });
    }
  }

  // The agent in charge of an anomaly gets it as a mission, with the order's
  // full record when it comes from the workshop, and answers with its cause
  // and a rule through analyser_anomalie.
  async function analyse(reference) {
    resolvedClient ??= await clientFactory({ apiKey });
    const { anomalies } = await books.improvement.state();
    const anomaly = anomalies.find((entry) => String(entry.number) === String(reference) || entry.id === reference);
    if (!anomaly) {
      throw new DirectorAgentError(`Aucune anomalie n° ${reference}.`, "AGENT_ANOMALY_NOT_FOUND");
    }
    const context = baseContext(freshOutcome());
    const agentId = SPECIALISTS[anomaly.owner] ? anomaly.owner : "production";
    const record = anomaly.orderNumber ? await readWorkshopBook({ numero: anomaly.orderNumber }, { ...context, onNewAnomalies: () => {} }) : null;
    const mission = [
      `Analyse l'anomalie n° ${anomaly.number} : ${anomaly.fact}.`,
      "Trouve sa cause réelle dans tes données et enregistre-la avec analyser_anomalie, avec la règle concrète qui l'aurait évitée (quand, action, qui) ; si une règle active couvre déjà cette cause, cite-la. Si la cause n'apparaît pas dans les données, dis exactement quoi demander à l'équipe et propose quand même la règle de prévention la plus utile.",
      ...(record?.ok ? [`Dossier du BC ${anomaly.orderNumber} au carnet d'atelier : ${JSON.stringify(record)}`] : [])
    ].join("\n");
    const run = await runAgent(agentId, mission, context);
    return Object.freeze({ anomaly: describeAnomaly((await books.improvement.state()).anomalies.find((entry) => entry.id === anomaly.id)), agent: run.label, answer: run.answer });
  }

  return Object.freeze({
    model,
    isConfigured: configured,
    books,

    analyseAnomaly(reference) {
      if (!configured()) {
        throw new DirectorAgentError("L'agent IA n'est pas configuré : renseignez OPENAI_API_KEY dans .env.", "AGENT_NOT_CONFIGURED");
      }
      return analyse(reference);
    },

    // The workshop book as just read: new anomalies are recorded, and handed
    // to their agents when the automatic analysis is on.
    async syncAnomalies(orders) {
      const found = await books.improvement.sync(orders);
      queueAnalyses(found);
      return found;
    },

    // For tests and for a clean shutdown: resolves once queued analyses ran.
    idle() {
      return analyses;
    },

    // confidential: false when the person asking may not see salaries and
    // confidential expenses; the direction on WhatsApp may.
    async chat({ message, photos = [], files = [], conversationId = null, userId = null, confidential = true } = {}) {
      const stored = conversationId ? await conversationStore.get(conversationId) : null;
      const previous = stored && stored.userId === (userId ?? null) ? stored : null;
      const id = previous ? conversationId : randomUUID();
      const newPhotos = checkPhotos(photos);
      const newFiles = checkFiles(files, (previous?.fileCount ?? 0) + 1);
      const typed = typeof message === "string" ? message.trim() : "";
      if (typed === "" && newPhotos.length === 0 && newFiles.length === 0) {
        throw new DirectorAgentError("Le message est vide.", "AGENT_MESSAGE_EMPTY");
      }
      if (!this.isConfigured()) {
        throw new DirectorAgentError("L'agent IA n'est pas configuré : renseignez OPENAI_API_KEY dans .env.", "AGENT_NOT_CONFIGURED");
      }
      resolvedClient ??= await clientFactory({ apiKey });

      const items = previous?.items ?? [];
      // Photos are numbered across the conversation, so "la photo n° 2" keeps
      // meaning the same picture from one message to the next.
      const conversationPhotos = [...(previous?.photos ?? []), ...newPhotos];
      const numbers = newPhotos.map((_, index) => conversationPhotos.length - newPhotos.length + index + 1);
      const fallback = newPhotos.length > 0 ? "Voici une photo." : "Voici un document.";
      const text = [typed || fallback, ...(numbers.length > 0 ? [`[Photos jointes : ${numbers.map((n) => `n° ${n}`).join(", ")}]`] : [])].join("\n\n");
      const userItem = newPhotos.length === 0 && newFiles.length === 0
        ? { role: "user", content: text }
        : { role: "user", content: [
          { type: "input_text", text },
          ...newFiles.map((file) => file.part),
          ...newPhotos.map((url) => ({ type: "input_image", image_url: url, detail: "auto" }))
        ] };
      items.push(userItem);

      const outcome = freshOutcome(conversationPhotos);
      const context = baseContext(outcome, userId, confidential !== false);
      const briefing = await directorBriefing(context);
      let reply = "";
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        const response = await callModel(resolvedClient, {
          model,
          instructions: instructions(formatDate(clock()), briefing),
          input: items,
          tools: TOOLS
        });
        const output = Array.isArray(response.output) ? response.output : [];
        items.push(...output);
        const calls = output.filter((item) => item.type === "function_call");
        if (calls.length === 0 || round === MAX_TOOL_ROUNDS) {
          reply = outputText(response);
          break;
        }
        const results = await Promise.all(calls.map((call) => runTool(call, context)));
        calls.forEach((call, index) => {
          items.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(results[index]) });
        });
      }

      // The model has seen the pictures and documents in this turn and said
      // what they show. Later turns keep that text, the numbers and the start of
      // each document, not the files: resending them with every message would be
      // slow and costly.
      if (newPhotos.length > 0 || newFiles.length > 0) {
        const remembered = [
          text,
          ...(newPhotos.length > 0 ? ["[Photos vues à ce message ; elles restent disponibles par leur numéro comme visuel d'un bon de commande.]"] : []),
          ...newFiles.map((file) => file.remembered)
        ];
        items[items.indexOf(userItem)] = { role: "user", content: remembered.join("\n") };
      }
      await conversationStore.save(id, {
        userId: userId ?? null,
        updatedAt: clock().toISOString(),
        items: items.slice(-MAX_CONVERSATION_ITEMS),
        photos: conversationPhotos,
        fileCount: (previous?.fileCount ?? 0) + newFiles.length
      });
      return Object.freeze({
        conversationId: id,
        reply: reply || "Je n'ai pas pu formuler de réponse. Pouvez-vous reformuler ?",
        documents: Object.freeze(outcome.documents),
        directorResponse: outcome.directorResponse,
        agentRuns: Object.freeze(outcome.agentRuns),
        messages: Object.freeze(outcome.messages),
        plan: outcome.planId ? await withObjectiveMeasure(await planStore.get(outcome.planId), { loadObjectiveRecords, clock }) : null,
        alerts: outcome.alerts
      });
    }
  });
}

// The cockpit sends each photo as a JPEG or PNG data URL, the two formats a
// purchase order can carry as its visual, so a photo shown to the Director can
// also go on the document.
function checkPhotos(photos) {
  if (photos === undefined || photos === null) {
    return [];
  }
  if (!Array.isArray(photos) || photos.length > MAX_PHOTOS_PER_MESSAGE) {
    throw new DirectorAgentError(`Joignez au plus ${MAX_PHOTOS_PER_MESSAGE} photos par message.`, "AGENT_PHOTO_INVALID");
  }
  return photos.map((photo) => {
    const { image, error } = parseReferenceImage(photo);
    if (!image) {
      throw new DirectorAgentError(
        error === "REFERENCE_IMAGE_TOO_LARGE" ? "Une photo dépasse 3 Mo." : "Une photo n'a pas pu être lue (JPEG ou PNG attendu).",
        "AGENT_PHOTO_INVALID"
      );
    }
    return photo.trim();
  });
}

function checkFiles(files, firstNumber) {
  try {
    return readAttachments(files, { firstNumber });
  } catch (error) {
    if (error instanceof ChatAttachmentError) {
      throw new DirectorAgentError(error.message, "AGENT_FILE_INVALID");
    }
    throw error;
  }
}

async function defaultClientFactory({ apiKey }) {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey });
}

// GPT-5 and the o-series reason before answering; on these tasks a long
// reasoning only makes Hiba wait. OPENAI_REASONING_EFFORT overrides the level.
const REASONING_EFFORT = ["minimal", "low", "medium", "high"].includes(process.env.OPENAI_REASONING_EFFORT)
  ? process.env.OPENAI_REASONING_EFFORT
  : "low";

function withReasoning(payload) {
  return /^(gpt-5|o\d)/.test(String(payload.model)) ? { ...payload, reasoning: { effort: REASONING_EFFORT } } : payload;
}

async function callModel(client, payload) {
  try {
    return await client.responses.create(withReasoning(payload));
  } catch (cause) {
    const status = cause?.status ?? null;
    // No answer at all, as when the internet is down: saying so tells Hiba what
    // to check, where "did not answer" sent her looking at OpenAI.
    const unreachable = status === null && /^APIConnection/.test(cause?.constructor?.name ?? "");
    const message = status === 401
      ? "La clé OpenAI est refusée : vérifiez OPENAI_API_KEY dans .env."
      : status === 429
        ? "Le compte OpenAI n'a plus de crédit ou est limité pour le moment."
        : unreachable
          ? "Impossible de joindre OpenAI : la connexion internet semble coupée. Vérifiez le Wi-Fi ou la box, puis réessayez."
          : "Le service OpenAI n'a pas répondu. Réessayez dans un instant.";
    throw new DirectorAgentError(message, "AGENT_MODEL_UNAVAILABLE", { status, unreachable });
  }
}

function outputText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim() !== "") {
    return response.output_text.trim();
  }
  return (response.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

async function runTool(call, context) {
  let args;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return { ok: false, erreur: "Arguments illisibles." };
  }
  try {
    if (call.name === MEASURE_TOOL.name) {
      return await measure(args, context);
    }
    if (call.name === PLAN_TOOL.name) {
      return await recordPlan(args, context);
    }
    if (call.name === LIST_PLANS_TOOL.name) {
      return await listPlans(args, context);
    }
    if (call.name === ADJUST_PLAN_TOOL.name) {
      return await adjustPlan(args, context);
    }
    if (call.name === COHERENCE_TOOL.name) {
      return await runCoherence(context);
    }
    if (call.name === FOLLOW_DOSSIER_TOOL.name) {
      return await followDossier(args, context);
    }
    if (call.name === WORKSHOP_BOOK_TOOL.name) {
      return await readWorkshopBook(args, context);
    }
    if (call.name === ADVANCE_ORDER_TOOL.name) {
      return await advanceOrder(args, context, "director");
    }
    if (call.name === CLIENT_LINK_TOOL.name) {
      return await clientLink(args, context, "director");
    }
    if (call.name === ASSIGN_TASK_TOOL.name) {
      return await assignTask(args, context, context.userId ?? "direction");
    }
    if (call.name === TASK_TOOL.name) {
      return await updateTask(args, context, "director");
    }
    if (call.name === SALES_REPORT_TOOL.name) {
      return await salesReportFor(args, context);
    }
    if (call.name === FOLLOW_UP_TOOL.name) {
      return await recordFollowUp(args, context, "director");
    }
    if (call.name === ORDER_TEAM_TOOL.name) {
      return await setOrderTeam(args, context, "director");
    }
    if (call.name === PUBLISH_PHOTO_TOOL.name) {
      return await publishPhoto(args, context, "director");
    }
    if (call.name === CASH_BALANCE_TOOL.name) {
      return await cashBalance(args, context);
    }
    if (call.name === ANOMALIES_TOOL.name) {
      return await listAnomalies(args, context);
    }
    if (call.name === REPORT_ANOMALY_TOOL.name) {
      return await reportAnomaly(args, context, "director");
    }
    if (call.name === LINK_MEMBER_TOOL.name) {
      return await linkMember(args, context, "director");
    }
    if (call.name === "deleguer_a_un_agent") {
      return withCoherence(await delegate(args, context), context);
    }
    if (call.name === "point_entreprise") {
      return withCoherence(await companyPoint(args, context), context);
    }
    return { ok: false, erreur: `Outil inconnu : ${call.name}` };
  } catch (error) {
    return { ok: false, erreur: error.message };
  }
}

// Builds the document exactly as the documents panel would send it, then asks
// the document service for the same preview a person would get.
async function prepareDocument(args, { documentService, clock, outcome, books }, preparedBy = null) {
  const documentType = DOCUMENT_TYPES[args.type];
  if (!documentType) {
    return { ok: false, erreur: "Type de document inconnu." };
  }

  const purchaseOrder = documentType === HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER;
  const termsRule = PAYMENT_RULES[args.conditions_paiement] ?? PAYMENT_RULES["60/20/20"];
  if (termsRule === PAYMENT_RULES["50/50"] && !purchaseOrder) {
    return { ok: false, erreur: "Le 50/50 n'est possible que sur un bon de commande. Utiliser 60/20/20." };
  }

  const replaces = args.remplace === true;
  if (replaces && !text(args.numero)) {
    return { ok: false, erreur: "Pour corriger un document existant, donner son numéro (numero)." };
  }
  const number = text(args.numero) || await documentService.nextDocumentNumber(documentType);
  if (!number) {
    return { ok: false, erreur: `Aucun numéro connu pour ce type de document : demander à l'utilisatrice le numéro à utiliser.` };
  }
  // A corrected order keeps its visual unless another photo is given.
  const issued = replaces ? await documentService.readIssued(documentType, number) : null;
  if (replaces && !issued) {
    return { ok: false, erreur: `Aucun ${args.type.replace(/_/g, " ")} n° ${number} n'a été généré : rien à corriger. Vérifier le numéro, ou préparer un nouveau document (remplace = false).` };
  }

  const items = (Array.isArray(args.lignes) ? args.lignes : []).map((line) => {
    const price = Number(line.prix_unitaire);
    const unitPriceHt = line.prix_ttc === false ? roundMoney(price) : roundMoney(price / (1 + TVA_RATE));
    return {
      designation: text(line.designation),
      unit: "U",
      quantity: Number(line.quantite) || 1,
      unitPriceHt
    };
  });
  const calculated = calculateDocumentTotals(items, TVA_RATE);

  const photoNumber = Number(args.photo) || 0;
  const newImage = purchaseOrder && photoNumber > 0 ? outcome.photos?.[photoNumber - 1] : undefined;
  if (purchaseOrder && photoNumber > 0 && !newImage) {
    return { ok: false, erreur: `Il n'y a pas de photo n° ${photoNumber} dans la conversation. Mettre 0 ou le bon numéro.` };
  }
  const keptImage = purchaseOrder && !newImage ? (issued?.input?.referenceImage ?? issued?.referenceImage ?? undefined) : undefined;
  const referenceImage = newImage ?? keptImage;

  const input = {
    documentType,
    documentNumber: number,
    date: text(args.date) || formatDate(clock()),
    object: text(args.objet),
    client: { name: text(args.client_nom), address: text(args.client_adresse) },
    items: calculated.items.map((item) => ({ designation: item.designation, unit: item.unit, quantity: item.quantity, unitPriceHt: item.unitPriceHt, amountHt: item.amountHt })),
    totals: { totalHt: calculated.totals.totalHt, tva: calculated.totals.tva, totalTtc: calculated.totals.totalTtc },
    payment: purchaseOrder ? { termsRule } : { method: "virement bancaire", termsRule },
    ...(purchaseOrder ? { specifications: (args.caracteristiques ?? []).map(text).filter(Boolean) } : {}),
    ...(referenceImage ? { referenceImage } : {}),
    ...(text(args.reference_devis) ? { quoteReference: text(args.reference_devis) } : {}),
    ...(text(args.reference_bl) ? { deliveryNoteReference: text(args.reference_bl) } : {})
  };

  let preview;
  try {
    preview = await documentService.preview(input, { replaceExisting: replaces });
  } catch (error) {
    if (error instanceof DocumentValidationError) {
      return { ok: false, erreurs: error.errors.map((entry) => `${entry.field} : ${entry.message}`) };
    }
    if (error?.code === "PURCHASE_ORDER_NUMBER_USED" || error?.code === "DOCUMENT_NUMBER_USED") {
      return { ok: false, erreur: `Le numéro ${error.details.documentNumber} est déjà pris par un document généré ; prochain libre : ${error.details.nextNumber}. Pour corriger ce document-là, le relire avec consulter_document puis remplace = true.` };
    }
    if (error?.code === "INVOICE_EXCEEDS_SALE") {
      const { ceiling, ceilingFrom, invoicedBefore, remainingBefore, previousInvoices } = error.details;
      return {
        ok: false,
        erreur: `Facture refusée : elle ferait facturer cette vente deux fois. Montant de la vente : ${ceiling} DH TTC (selon le ${ceilingFrom}) ; déjà facturé : ${invoicedBefore} DH (factures n° ${previousInvoices.map((entry) => entry.number).join(", ")}) ; reste à facturer : ${remainingBefore} DH. Ne prépare pas de facture au-delà de ce reste ; dis-le à la direction.`
      };
    }
    throw error;
  }

  outcome.documents.push(Object.freeze({ input, preview, preparedBy, replaces }));
  const document = preview.document;
  await books?.team.log({
    agent: preparedBy ?? "director",
    kind: "document",
    text: `${replaces ? "Correction du" : "Aperçu"} ${args.type.replace(/_/g, " ")} n° ${document.documentNumber} pour ${document.client.name} (${document.totals.totalTtc} DH TTC), à valider par la direction.`,
    ref: `${args.type}:${document.documentNumber}`,
    by: preparedBy ?? "director"
  });
  return {
    ok: true,
    type: args.type,
    numero: document.documentNumber,
    date: document.date,
    client: document.client.name,
    total_ht: document.totals.totalHt,
    tva: document.totals.tva,
    total_ttc: document.totals.totalTtc,
    echeances: (document.payment?.instalments ?? []).map((part) => `${part.percent} % ${part.due} : ${part.amount} DH`),
    conditions: document.payment?.terms ?? null,
    ...(newImage ? { visuel: `photo n° ${photoNumber}` } : keptImage ? { visuel: "celui du document d'origine, conservé" } : {}),
    ...(replaces ? { remplace: `l'ancienne version du n° ${document.documentNumber} sera archivée à la validation` } : {}),
    ...(preview.notices?.length > 0 ? { dossier: preview.notices } : {}),
    statut: "Aperçu prêt : l'utilisatrice doit cliquer « Valider et générer » dans le cockpit."
  };
}

// Where a sale stands, from any one of its documents, in the words the agents
// and the direction use.
async function followDossier(args, { documentService }) {
  const documentType = DOCUMENT_TYPES[args.type];
  const number = text(args.numero);
  if (!documentType || !number) {
    return { ok: false, erreur: "Donner le type et le numéro du document." };
  }
  const dossier = await documentService.dossier(documentType, number);
  if (!dossier) {
    return { ok: false, erreur: `Aucun ${args.type.replace(/_/g, " ")} n° ${number} n'a été généré par le cockpit : je n'ai pas l'information.` };
  }
  const line = (entry) => ({ numero: entry.number, date: entry.date, client: entry.client, total_ttc: entry.totalTtc });
  return {
    ok: true,
    etape: dossier.stage,
    devis: dossier.quoteNumber ? { numero: dossier.quoteNumber, ...(dossier.quote ? { date: dossier.quote.date, client: dossier.quote.client, total_ttc: dossier.quote.totalTtc } : { genere: false }) } : null,
    bons_de_commande: dossier.orders.map(line),
    bons_de_livraison: dossier.deliveryNotes.map(line),
    factures: dossier.invoices.map(line),
    montant_de_la_vente: dossier.ceiling === null ? "inconnu" : `${dossier.ceiling} DH TTC (selon le ${dossier.ceilingFrom})`,
    deja_facture: dossier.invoiced,
    reste_a_facturer: dossier.remaining ?? "inconnu",
    anomalies: dossier.anomalies
  };
}

// The workshop book in the words of the agents: the whole book in short, or one
// order in full.
async function readWorkshopBook(args, context) {
  const { workshop } = context;
  const number = text(args.numero);
  const anomalies = await syncAnomalies(context);
  if (number) {
    const order = await workshop.order(number);
    if (!order) {
      return { ok: false, erreur: `Aucun bon de commande n° ${number} n'a été généré par le cockpit : je n'ai pas l'information.` };
    }
    return {
      ok: true,
      ...orderLine(order),
      total_ttc: order.totalTtc,
      etapes: order.steps.map((step) => ({
        etape: step.id,
        nom: step.label,
        statut: WORKSHOP_STATUS_LABELS[step.status],
        responsable: step.responsible || null,
        date_prevue: step.plannedDate ? frenchDay(step.plannedDate) : null,
        commencee_le: step.startedDate ? frenchDay(step.startedDate) : null,
        terminee_le: step.doneDate ? frenchDay(step.doneDate) : null,
        note: step.note || null,
        en_retard: step.late
      })),
      equipe: orderTeam(order),
      fichiers_cnc: order.cnc.map((entry) => ({
        fichier: entry.name,
        format: entry.format === "gcode" ? "G-code" : "DXF",
        statut: CNC_FILE_STATUS_LABELS[entry.status],
        depose_le: frenchDay(entry.depositedAt.slice(0, 10)),
        ...(entry.note ? { note: entry.note } : {}),
        ...(entry.reason ? { motif_du_refus: entry.reason } : {})
      })),
      bons_de_livraison: order.deliveryNotes,
      factures: order.invoices,
      deja_facture: order.invoiced,
      reste_a_facturer: order.remaining ?? "inconnu",
      journal: order.journal.slice(-10).map((entry) => `${frenchDay(entry.at.slice(0, 10))} ${entry.at.slice(11, 16)} (${entry.by}) ${entry.text}`),
      ...anomalyLines(anomalies.filter((anomaly) => anomaly.orderNumber === order.number))
    };
  }
  const book = await workshop.book();
  if (book.length === 0) {
    return { ok: true, commandes: [], info: "Aucun bon de commande généré par le cockpit : le carnet est vide." };
  }
  return {
    ok: true,
    commandes: book.map(orderLine),
    alertes: book.flatMap((order) => order.alerts.map((alert) => `BC ${order.number} (${order.client}) : ${alert}`)),
    ...anomalyLines(anomalies)
  };
}

// The workshop book read is also where anomalies are found: a step blocked or
// late becomes one, and its agent is asked for the cause when the automatic
// analysis is on. Returns the anomalies still open.
async function syncAnomalies({ workshop, books, onNewAnomalies }) {
  if (!books) {
    return [];
  }
  const found = await books.improvement.sync(await workshop.book());
  onNewAnomalies?.(found);
  return (await books.improvement.state()).anomalies.filter((anomaly) => anomaly.status !== "levee");
}

function anomalyLines(anomalies) {
  return anomalies.length > 0 ? { anomalies_ouvertes: anomalies.map(describeAnomaly) } : {};
}

function orderLine(order) {
  return {
    bc: order.number,
    date: order.date,
    client: order.client,
    objet: order.object || null,
    devis: order.quoteNumber,
    statut: order.status,
    avancement: `${order.progress.done}/${order.progress.total} étapes terminées (${order.progress.percent} %)`,
    etape_en_cours: order.currentStep,
    chef_de_charge: order.team.lead || "à désigner",
    alertes: order.alerts
  };
}

function orderTeam(order) {
  const { lead, leadPhone, architect, architectPhone, liaison, drafter, drafterPhone } = order.team;
  return {
    chef_de_charge: lead ? `${lead}${leadPhone ? ` (${leadPhone})` : " — sans numéro : ne reçoit pas les alertes"}` : "à désigner",
    architecte: architect ? `${architect}${architectPhone ? ` (${architectPhone})` : ""}` : "aucun",
    lien_avec_l_architecte: liaison || (architect ? "à désigner" : null),
    dessinateur: drafter ? `${drafter}${drafterPhone ? ` (${drafterPhone})` : ""}` : "à désigner"
  };
}

async function setOrderTeam(args, { workshop, books }, by) {
  const role = (value) => (text(value) === "" ? undefined : text(value) === "-" ? "" : text(value));
  try {
    const { changed, order } = await workshop.setTeam(text(args.numero), {
      lead: role(args.chef_de_charge),
      leadPhone: role(args.telephone_chef_de_charge),
      architect: role(args.architecte),
      architectPhone: role(args.telephone_architecte),
      liaison: role(args.lien_architecte),
      drafter: role(args.dessinateur),
      drafterPhone: role(args.telephone_dessinateur)
    }, { by });
    if (changed) {
      await books?.team.log({ agent: SPECIALISTS[by] ? by : "production", kind: "atelier", text: `BC ${order.number} (${order.client}) — ${order.journal.at(-1).text}`, ref: `bc:${order.number}`, by });
    }
    return { ok: true, bc: order.number, enregistre: changed ? order.journal.at(-1).text : "rien de nouveau", equipe: orderTeam(order) };
  } catch (error) {
    if (error instanceof WorkshopError) {
      return { ok: false, erreur: error.message };
    }
    throw error;
  }
}

async function advanceOrder(args, { workshop, books }, by) {
  try {
    const { changed, order } = await workshop.advance(text(args.numero), text(args.etape), {
      status: text(args.statut),
      responsible: text(args.responsable),
      plannedDate: text(args.date_prevue),
      doneDate: text(args.date_reelle),
      note: text(args.note),
      by
    });
    if (changed) {
      await books?.team.log({ agent: SPECIALISTS[by] ? by : "production", kind: "atelier", text: `BC ${order.number} (${order.client}) — ${order.journal.at(-1).text}`, ref: `bc:${order.number}`, by });
    }
    return {
      ok: true,
      enregistre: changed ? order.journal.at(-1).text : "rien de nouveau : le carnet disait déjà cela",
      ...orderLine(order)
    };
  } catch (error) {
    if (error instanceof WorkshopError) {
      return { ok: false, erreur: error.message };
    }
    throw error;
  }
}

async function clientLink(args, { workshop }, by) {
  const number = text(args.numero);
  try {
    if (args.action === "desactiver") {
      await workshop.closePortal(number, { by });
      return { ok: true, bc: number, lien: "désactivé : l'ancien lien n'ouvre plus rien" };
    }
    const link = await workshop.openPortal(number, { by });
    return {
      ok: true,
      bc: number,
      lien: link.url ?? link.path,
      ...(link.url ? {} : { attention: "L'adresse du site n'est pas configurée (PUBLIC_BASE_URL) : ce chemin doit être précédé de l'adresse du cockpit." }),
      ce_que_voit_le_client: "l'avancement réel, les étapes terminées, la livraison prévue, l'échéancier, les photos publiées et ses documents ; jamais les notes internes"
    };
  } catch (error) {
    if (error instanceof WorkshopError) {
      return { ok: false, erreur: error.message };
    }
    throw error;
  }
}

async function publishPhoto(args, { workshop, outcome }, by) {
  const number = Number(args.photo) || 0;
  const photo = outcome.photos?.[number - 1];
  if (!photo) {
    return { ok: false, erreur: `Il n'y a pas de photo n° ${number} dans la conversation.` };
  }
  try {
    await workshop.publishPhoto(text(args.numero), photo, { caption: text(args.legende), by });
    const order = await workshop.order(text(args.numero));
    return {
      ok: true,
      bc: text(args.numero),
      publiee: `photo n° ${number}`,
      visible: order?.portal ? "sur le lien de suivi du client" : "dès que le lien de suivi du client sera créé (lien_suivi_client)"
    };
  } catch (error) {
    if (error instanceof WorkshopError) {
      return { ok: false, erreur: error.message };
    }
    throw error;
  }
}

// An issued document as the agent needs it to prepare its correction: the same
// fields preparer_document takes, prices HT so that they come back to the
// cent. The visual itself is not sent, only whether there is one.
async function consultDocument(args, { documentService }) {
  const documentType = DOCUMENT_TYPES[args.type];
  const number = text(args.numero);
  if (!documentType || !number) {
    return { ok: false, erreur: "Donner le type et le numéro du document." };
  }
  const issued = await documentService.readIssued(documentType, number);
  if (!issued) {
    return { ok: false, erreur: `Aucun ${args.type.replace(/_/g, " ")} n° ${number} n'a été généré.` };
  }
  if (issued.source === "word") {
    return {
      ok: true,
      numero: number,
      source: "texte du fichier Word (document généré avant la conservation du contenu) : les prix unitaires y sont HT",
      texte: issued.text,
      visuel: issued.referenceImage ? "oui, il sera conservé" : "non"
    };
  }
  const input = issued.input;
  const conditions = Object.keys(PAYMENT_RULES).find((key) => PAYMENT_RULES[key] === input.payment?.termsRule) ?? input.payment?.termsRule ?? "";
  return {
    ok: true,
    numero: input.documentNumber,
    date: input.date,
    client_nom: input.client?.name ?? "",
    client_adresse: input.client?.address ?? "",
    objet: input.object ?? "",
    lignes: (input.items ?? []).map((item) => ({ designation: item.designation, quantite: item.quantity, prix_unitaire: item.unitPriceHt, prix_ttc: false })),
    total_ttc: input.totals?.totalTtc ?? null,
    caracteristiques: input.specifications ?? [],
    conditions_paiement: conditions,
    reference_devis: input.quoteReference ?? "",
    reference_bl: input.deliveryNoteReference ?? "",
    visuel: input.referenceImage ? "oui, il sera conservé" : "non"
  };
}

async function delegate(args, context) {
  if (!SPECIALISTS[args.agent]) {
    return { ok: false, erreur: "Agent inconnu." };
  }
  if (!context.team.toolRegistry || typeof context.team.executeTool !== "function") {
    return { ok: false, erreur: "L'équipe d'agents n'est pas disponible." };
  }
  const run = await runAgent(args.agent, text(args.mission), context);
  await markAgentStepDone(run, context);
  return { ok: true, agent: run.label, outils_utilises: run.tools, reponse: run.answer };
}

// One agent at work on one mission, with the tools of its trade, told who it
// answers to, what the team did lately and the rules in force. What it was
// asked and what it answered go to the team's feed.
async function runAgent(agentId, mission, context) {
  const { team, clock, outcome, books } = context;
  const run = await runSpecialist({
    agentId,
    mission,
    extraTools: [
      ...(books ? [...(agentId === "finance" ? cashTools(context, agentId) : []), ...(agentId === "commercial" ? salesTools(context, agentId) : []), ...improvementTools(context, agentId)] : []),
      ...(SPECIALISTS[agentId].workshop === "write" ? [{ tool: ORDER_TEAM_TOOL, run: (teamArgs, by) => setOrderTeam(teamArgs, context, by) }] : [])
    ],
    briefing: books ? await agentBriefing(agentId, context) : [],
    callModel: (payload) => callModel(team.client, payload),
    model: team.model,
    today: formatDate(clock()),
    toolRegistry: team.toolRegistry,
    executeTool: team.executeTool,
    prepareDocumentTool: DOCUMENT_TOOL,
    prepareDocument: (documentArgs, agentId) => prepareDocument(documentArgs, context, agentId),
    catalogueTool: CATALOGUE_TOOL,
    lookUpCatalogue: (catalogueArgs) => lookUpCatalogue(catalogueArgs, context),
    consultDocumentTool: CONSULT_DOCUMENT_TOOL,
    consultDocument: (consultArgs) => consultDocument(consultArgs, context),
    followDossierTool: FOLLOW_DOSSIER_TOOL,
    followDossier: (dossierArgs) => followDossier(dossierArgs, context),
    workshopBookTool: WORKSHOP_BOOK_TOOL,
    readWorkshopBook: (bookArgs) => readWorkshopBook(bookArgs, context),
    advanceOrderTool: ADVANCE_ORDER_TOOL,
    advanceOrder: (advanceArgs, agentId) => advanceOrder(advanceArgs, context, agentId),
    clientLinkTool: CLIENT_LINK_TOOL,
    clientLink: (linkArgs, agentId) => clientLink(linkArgs, context, agentId),
    prepareMessage: (messageArgs, agentId) => recordMessage(messageArgs, agentId, outcome)
  });
  outcome.agentRuns.push(run);
  await books?.team.log({ agent: agentId, kind: "mission", text: mission, detail: run.answer, by: "director" });
  return run;
}

function planSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .filter((step) => text(step.tache) !== "")
    .map((step) => ({
      agent: SPECIALISTS[step.agent] || step.agent === "director" ? step.agent : "director",
      task: text(step.tache),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(text(step.echeance)) ? text(step.echeance) : null
    }));
}

async function recordPlan(args, { planStore, outcome, userId, clock }) {
  const steps = planSteps(args.etapes);
  if (steps.length === 0) {
    return { ok: false, erreur: "Un plan doit avoir au moins une étape." };
  }
  const plan = await planStore.create({
    objective: text(args.objectif),
    target: objectiveTarget(args.objectif_chiffre, clock()),
    strategy: text(args.strategie),
    priorities: (Array.isArray(args.priorites) ? args.priorites : []).map(text).filter(Boolean).slice(0, 3),
    steps,
    createdBy: userId
  });
  outcome.planId = plan.id;
  return { ok: true, plan_numero: plan.number, statut: "Plan enregistré et affiché à la direction. Exécute maintenant les étapes." };
}

function describePlan(plan) {
  return {
    numero: plan.number,
    objectif: plan.objective,
    objectif_chiffre: plan.target ? `${plan.target.amount} DH (${OBJECTIVE_INDICATORS[plan.target.indicator]}) du ${plan.target.from} au ${plan.target.to}` : null,
    statut: plan.status,
    avancement: `${plan.progress.done}/${plan.progress.total} étapes (${plan.progress.percent} %)`,
    en_retard: plan.progress.overdue,
    bloquees: plan.progress.blocked,
    cree_le: plan.createdAt.slice(0, 10),
    etapes: plan.steps.map((step) => ({
      etape: step.index,
      agent: step.agent,
      tache: step.task,
      statut: STEP_LABELS[step.status],
      echeance: step.dueDate,
      en_retard: step.overdue,
      resultat: step.result ? step.result.slice(0, 300) : null
    })),
    derniers_evenements: plan.journal.slice(-4).map((entry) => `${entry.at.slice(0, 10)} : ${entry.text}`)
  };
}

async function listPlans(args, { planStore, outcome }) {
  outcome.plansListed = true;
  const status = args.statut === "all" ? null : args.statut === "done" ? "done" : "active";
  const plans = await planStore.list({ status });
  return { ok: true, nombre: plans.length, plans: plans.slice(0, 8).map(describePlan) };
}

async function adjustPlan(args, { planStore, outcome, userId }) {
  let plan = await planStore.get(String(args.numero));
  if (!plan) {
    return { ok: false, erreur: `Aucun plan n° ${args.numero}.` };
  }
  const by = "director";
  for (const change of Array.isArray(args.etapes) ? args.etapes : []) {
    plan = await planStore.updateStep(plan.id, change.etape, {
      status: change.statut || null,
      result: text(change.resultat) || null,
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(text(change.echeance)) ? text(change.echeance) : null,
      by
    });
  }
  const added = planSteps(args.nouvelles_etapes);
  if (added.length > 0) {
    plan = await planStore.addSteps(plan.id, added, { by });
  }
  if (text(args.note)) {
    plan = await planStore.addNote(plan.id, text(args.note), { by });
  }
  const closing = { terminer: "done", abandonner: "abandoned", reouvrir: "active" }[args.cloture];
  if (closing) {
    plan = await planStore.close(plan.id, closing, { by, reason: text(args.note) });
  }
  outcome.planId = plan.id;
  return { ok: true, plan: describePlan(plan), demande_par: userId ?? null };
}

// A figure the plan pursues, with its period resolved: the current month when
// none is given. No figure, no target.
function objectiveTarget(value, today) {
  const amount = Number(value?.montant);
  if (!value || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const month = currentMonth(today);
  const day = (entry) => (/^\d{4}-\d{2}-\d{2}$/.test(text(entry)) ? text(entry) : null);
  return {
    indicator: OBJECTIVE_INDICATORS[value.indicateur] ? value.indicateur : "ventes_signees",
    amount,
    currency: "MAD",
    from: day(value.du) ?? month.from,
    to: day(value.au) ?? month.to
  };
}

async function measure(args, { loadObjectiveRecords, clock }) {
  if (typeof loadObjectiveRecords !== "function") {
    return { ok: false, erreur: "La mesure des objectifs n'est pas disponible." };
  }
  const target = objectiveTarget({ ...args, montant: Number(args.montant) > 0 ? args.montant : 1 }, clock());
  const result = measureObjective(await loadObjectiveRecords(), { ...target, amount: Number(args.montant) || 0, today: clock() });
  return { ok: true, ...describeMeasure(result) };
}

function describeMeasure(result) {
  return {
    indicateur: result.label,
    periode: `du ${result.period.from} au ${result.period.to} (${result.period.daysLeft} jours restants)`,
    cible: result.target,
    realise: result.achieved,
    ecart: result.gap,
    pourcentage: result.percent,
    rythme_par_jour_restant: result.pacePerDay,
    ventes_signees: result.signedSales,
    encaisse: result.collected,
    a_encaisser_dans_la_periode: result.toCollect,
    devis_ouverts: result.openQuotes,
    devise: "MAD",
    donnees_de_demonstration: result.demo
  };
}

// The plan as shown: a plan with a figure carries where that figure stands
// today, measured afresh each time it is read.
export async function withObjectiveMeasure(plan, { loadObjectiveRecords, clock = () => new Date() } = {}) {
  if (!plan?.target || typeof loadObjectiveRecords !== "function") {
    return plan;
  }
  const measured = measureObjective(await loadObjectiveRecords(), { ...plan.target, today: clock() });
  return Object.freeze({ ...plan, measure: measured });
}

// When an agent has worked on a step of the current plan, the step moves to
// "en cours" and keeps what the agent found. It is not "fait": an agent only
// prepares, and a follow-up drafted is not a follow-up sent. The Director marks
// it done when the task was an analysis the agent completed, Hiba when the real
// action happened. A plan picked up from an earlier day is the current one when
// the Director looked at its plans this turn and it is the only one still
// waiting on that agent; a plain task (a quote) touches no plan.
async function markAgentStepDone(run, { planStore, outcome }) {
  if (!outcome.planId && !outcome.plansListed) {
    return;
  }
  if (!outcome.planId) {
    const waiting = (await planStore.list({ status: "active" }))
      .filter((plan) => plan.steps.some((step) => step.agent === run.agent && step.status !== "done"));
    if (waiting.length !== 1) {
      return;
    }
    outcome.planId = waiting[0].id;
  }
  const plan = await planStore.get(outcome.planId);
  const step = plan?.steps.find((candidate) => candidate.agent === run.agent && candidate.status !== "done");
  if (step) {
    await planStore.updateStep(plan.id, step.index, {
      status: step.status === "todo" ? "in_progress" : null,
      result: run.answer.slice(0, 600),
      by: run.agent
    });
  }
}

// The cross-checks run once per turn, as soon as the team works on a plan or a
// company point, and their findings travel with that tool's answer for the
// Director to report. A plain task (a quote, an invoice) carries none: the
// alerts would only bury the document Hiba asked for.
async function withCoherence(result, context) {
  if (!result.ok || context.outcome.alerts !== null || typeof context.checkCoherence !== "function") {
    return result;
  }
  if (!context.outcome.planId && !context.outcome.directorResponse) {
    return result;
  }
  const coherence = await runCoherence(context);
  return { ...result, verification_coherence: coherence };
}

async function runCoherence({ checkCoherence, outcome }) {
  if (typeof checkCoherence !== "function") {
    return { ok: false, erreur: "La vérification de cohérence n'est pas disponible." };
  }
  const findings = await checkCoherence();
  outcome.alerts = findings;
  return {
    ok: true,
    nombre: findings.length,
    incoherences: findings.map((entry) => ({
      gravite: entry.severity,
      constat: entry.fact,
      agents_concernes: entry.agents,
      action_proposee: entry.action
    }))
  };
}

function recordMessage(args, agent, outcome) {
  const result = draftWhatsAppMessage(args, { agent });
  if (!result.ok) {
    return result;
  }
  // One message per recipient and purpose: when the Director rewrites what an
  // agent drafted, the newer text replaces the older one instead of doubling it.
  const key = `${result.draft.recipient.toLowerCase()}|${result.draft.kind}`;
  const existing = outcome.messages.findIndex((draft) => `${draft.recipient.toLowerCase()}|${draft.kind}` === key);
  if (existing >= 0) {
    outcome.messages.splice(existing, 1, result.draft);
  } else {
    outcome.messages.push(result.draft);
  }
  return {
    ok: true,
    destinataire: result.draft.recipient,
    numero_connu: result.draft.phone !== null,
    statut: "Message prêt dans le cockpit : Hiba l'envoie avec le bouton WhatsApp."
  };
}

async function lookUpCatalogue(args, { loadCatalogue }) {
  const { available, catalogue } = await loadCatalogue();
  if (!available || catalogue.length === 0) {
    return { ok: false, erreur: "Le catalogue H-KIDS n'est pas encore renseigné : demander le prix à l'utilisatrice." };
  }
  const matches = searchCatalogue(catalogue, text(args.recherche));
  if (matches.length === 0) {
    return { ok: true, produits: [], remarque: "Aucun produit du catalogue ne correspond : demander le prix." };
  }
  return {
    ok: true,
    produits: matches.map((entry) => ({
      reference: entry.reference || null,
      produit: entry.name,
      description: entry.description || null,
      prix_ttc: entry.priceTtc,
      unite: entry.unit,
      remarque: entry.note || null
    }))
  };
}

async function companyPoint(args, { runDirectorRequest, userId, outcome }) {
  if (typeof runDirectorRequest !== "function") {
    return { ok: false, erreur: "Le point entreprise n'est pas disponible." };
  }
  const response = await runDirectorRequest({ message: text(args.question) || "Fais-moi le point sur mon entreprise aujourd'hui.", userId });
  outcome.directorResponse = response;
  const sections = response.summary?.minimumSections ?? {};
  return {
    ok: true,
    titre: response.summary?.headline ?? null,
    source_des_donnees: [...new Set((response.summary?.domainSources ?? []).map((entry) => entry.dataSource).filter(Boolean))],
    rubriques: Object.fromEntries(Object.entries(sections)
      .filter(([, entries]) => Array.isArray(entries) && entries.length > 0)
      .map(([key, entries]) => [key, entries.slice(0, 5).map((entry) => entry.label ?? entry.reason ?? "")]))
  };
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatDate(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}
