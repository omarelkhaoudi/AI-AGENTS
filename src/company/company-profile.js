// The company a cockpit works for. Each company of the SaaS has its own
// instance (deploy/tenants/), so its identity is read once, from that
// instance's settings: the name and legal mentions printed on its documents,
// what the agents are told it does, the people who run it.
//
// Every value defaults to H-KIDS, the pilot company: an instance with no
// COMPANY_* setting behaves exactly as before.

export const PILOT_COMPANY = Object.freeze({
  name: "H KIDS",
  shortName: "H-KIDS",
  addressLines: Object.freeze(["Adresse : DOUAR HARAKAT N 2153", "TASSELTANT SAADA MARRAKECH"]),
  email: "hkidsmaroc@gmail.com",
  phone: "0524018420",
  legalLine: "ICE:002635757000066 - IF 47322069 - RC 109155 - PATENTE 47952443 - CNSS 2305083 - www.hkids.store",
  footerMention: "Les produits H KIDS deviennent la propriété du client uniquement après le règlement intégral de la facture.",
  activity: "fabricant marocain de mobilier et d'aménagement sur mesure pour enfants",
  city: "Marrakech",
  // The line above the signatures of a quote, an order, a delivery note.
  tagline: "H-KIDS – Mobilier et aménagement sur mesure pour enfants.",
  leaders: Object.freeze(["Hiba", "Omar"]),
  // What every commercial proposal must respect. The payment schedules here
  // are also the ones the documents accept.
  commercialRules: "Règles commerciales H KIDS à respecter dans toute proposition : échéanciers approuvés uniquement — 60 % à la commande / 20 % avant livraison / 20 % après installation (standard) ; en exception 50/30/20, 40/40/20 ou 100 % à la commande ; 50/50 seulement sur un bon de commande. Aucun autre échéancier. Toute remise ou promotion est soumise à la validation de la direction."
});

const MAX_FIELD = 400;

function read(env, key) {
  const value = typeof env[key] === "string" ? env[key].trim() : "";
  return value.slice(0, key === "COMPANY_RULES" ? 2000 : MAX_FIELD);
}

function list(value) {
  return value.split("|").map((part) => part.trim()).filter(Boolean);
}

// What may release an instalment, in the words printed on the documents.
export const PAYMENT_CONDITION_WORDS = Object.freeze(["à la commande", "avant livraison", "à la livraison", "après installation"]);

const fold = (value) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// A company's own payment plans, from COMPANY_PAYMENT_PLANS: plans separated
// by « | », instalments by « ; », the first plan being the standard one:
//   « 50 % à la commande ; 50 % à la livraison | 100 % à la commande »
// Each instalment says what releases it, in the words above, and a plan adds
// up to 100 %. A setting that cannot be read stops the cockpit at start, with
// the reason, rather than printing an unagreed schedule on a document.
export function parsePaymentPlans(value) {
  const plans = String(value ?? "").split("|").map((plan) => plan.trim()).filter(Boolean);
  if (plans.length === 0) {
    return null;
  }
  return Object.freeze(plans.map((plan, index) => {
    const parts = plan.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const match = /^(\d{1,3})\s*%\s*(.+?)\.?$/.exec(part);
      const condition = match ? PAYMENT_CONDITION_WORDS.find((word) => fold(word) === fold(match[2])) : null;
      if (!match || !condition) {
        throw new Error(`COMPANY_PAYMENT_PLANS : « ${part} » n'est pas lisible. Écrire « 50 % à la commande », avec : ${PAYMENT_CONDITION_WORDS.join(", ")}.`);
      }
      return Object.freeze({ percent: Number(match[1]), condition });
    });
    const total = parts.reduce((sum, part) => sum + part.percent, 0);
    if (total !== 100) {
      throw new Error(`COMPANY_PAYMENT_PLANS : « ${plan} » fait ${total} % au lieu de 100 %.`);
    }
    const key = parts.map((part) => part.percent).join("/");
    return Object.freeze({
      id: `plan-${index + 1}-${key.replace(/\//g, "-")}`,
      key,
      label: `${parts.map((part) => `${part.percent} % ${part.condition}`).join(" ; ")}.`,
      standard: index === 0,
      parts: Object.freeze(parts)
    });
  }));
}

export function loadCompanyProfile(env = process.env) {
  const name = read(env, "COMPANY_NAME");
  if (!name) {
    return PILOT_COMPANY;
  }
  // Another company: nothing of H-KIDS is kept, what is not given stays empty
  // rather than borrowing the pilot's address or legal numbers.
  const plans = parsePaymentPlans(read(env, "COMPANY_PAYMENT_PLANS"));
  return Object.freeze({
    name,
    shortName: read(env, "COMPANY_SHORT_NAME") || name,
    addressLines: Object.freeze(list(read(env, "COMPANY_ADDRESS"))),
    email: read(env, "COMPANY_EMAIL"),
    phone: read(env, "COMPANY_PHONE"),
    legalLine: read(env, "COMPANY_LEGAL"),
    footerMention: read(env, "COMPANY_FOOTER") || `Les produits ${name} deviennent la propriété du client uniquement après le règlement intégral de la facture.`,
    activity: read(env, "COMPANY_ACTIVITY") || "entreprise marocaine",
    tagline: read(env, "COMPANY_TAGLINE") || tagline(read(env, "COMPANY_SHORT_NAME") || name, read(env, "COMPANY_ACTIVITY")),
    city: read(env, "COMPANY_CITY"),
    leaders: Object.freeze(list(read(env, "COMPANY_LEADERS"))),
    // Null: the pilot's plans (60/20/20 and its exceptions).
    paymentPlans: plans,
    commercialRules: read(env, "COMPANY_RULES") || `Règles commerciales ${name} à respecter dans toute proposition : ${plans ? `échéanciers approuvés uniquement — ${plans.map((plan) => `${plan.label.replace(/\.$/, "")}${plan.standard ? " (standard)" : ""}`).join(" ; ou ")}. Aucun autre échéancier` : "seuls les échéanciers de paiement acceptés par le cockpit sont proposés"} ; toute remise ou promotion est soumise à la validation de la direction.`
  });
}

function tagline(shortName, activity) {
  return activity ? `${shortName} – ${activity.charAt(0).toUpperCase()}${activity.slice(1)}.` : "";
}

export const COMPANY = loadCompanyProfile();

// H-KIDS, the pilot, carries what it did before the cockpit (the numbers it
// issued by hand); another company starts with nothing of it.
export function isPilotCompany(company = COMPANY) {
  return company === PILOT_COMPANY;
}

// The notice the law 09-08 asks for wherever personal data is collected: who
// processes it, what for, and where to exercise one's rights. The CNDP number
// is printed only once the company has one (CNDP_NUMBER), never a blank to fill;
// the hosting country (DATA_HOSTING_COUNTRY) only when the instance states it.
export function privacyMention(company = COMPANY, env = process.env) {
  const setting = (key) => (typeof env[key] === "string" ? env[key].trim().slice(0, 60) : "");
  const cndp = setting("CNDP_NUMBER");
  const hosting = setting("DATA_HOSTING_COUNTRY");
  const contact = company.email ? ` : ${company.email}` : ` auprès de ${company.name}`;
  return `Loi 09-08 : ${company.name} traite vos données pour votre commande${hosting ? ` (hébergement : ${hosting})` : ""} ; droits d'accès, de rectification et d'opposition${contact}.${cndp ? ` Notifié à la CNDP, n° ${cndp}.` : ""}`;
}

export const PRIVACY_MENTION = privacyMention();

// The company's tag in the names of its document files (« devis_HKIDS_170_… »).
// The pilot keeps HKIDS, so every file it already issued is still found;
// another company gets its short name, in capitals and letters only.
export function companyFileTag(company = COMPANY) {
  if (company === PILOT_COMPANY) {
    return "HKIDS";
  }
  const tag = company.shortName.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 16);
  return tag || "DOC";
}

export const FILE_TAG = companyFileTag();

// « la direction (Hiba, Omar) », or « la direction » when no name is given.
export function directionLabel(company = COMPANY) {
  return company.leaders.length > 0 ? `la direction (${company.leaders.join(", ")})` : "la direction";
}

// Who sends the messages the agents prepare.
export function senderName(company = COMPANY) {
  return company.leaders[0] ?? "la direction";
}

// The agents' instructions and tools are written for the pilot. Another
// company's instance has them told about itself: its name, what it does, who
// runs it and its commercial rules. Applied to every call to the model.
export function brandText(text, company = COMPANY) {
  if (company === PILOT_COMPANY || typeof text !== "string") {
    return text;
  }
  const where = company.city ? ` (${company.city})` : "";
  return brandPlans(text, company)
    .replaceAll(PILOT_COMPANY.commercialRules, company.commercialRules)
    .replaceAll("H KIDS, fabricant marocain de mobilier et d'aménagement sur mesure pour enfants (Marrakech)", `${company.name}, ${company.activity}${where}`)
    .replaceAll("H KIDS (mobilier et aménagement sur mesure pour enfants, Marrakech)", `${company.name} (${company.activity}${company.city ? `, ${company.city}` : ""})`)
    .replaceAll("la direction (Hiba, Omar)", directionLabel(company))
    .replaceAll("(Hiba, Omar)", company.leaders.length > 0 ? `(${company.leaders.join(", ")})` : "")
    .replaceAll("Hiba", senderName(company))
    .replaceAll("H KIDS", company.name)
    .replaceAll("H-KIDS", company.shortName);
}

// The pilot's schedules, as its instructions name them, told in the
// company's own plans.
function brandPlans(text, company) {
  const plans = company.paymentPlans;
  if (!plans) {
    return text;
  }
  const standard = plans[0].key;
  const all = plans.map((plan) => `${plan.key} (${plan.label.replace(/\.$/, "")})`).join(" ; ");
  return text
    .replaceAll("conditions 60/20/20 par défaut (seuls échéanciers approuvés : 60/20/20 ; en exception 50/30/20, 40/40/20, 100 % ; 50/50 sur bon de commande)", `conditions ${standard} par défaut (seuls échéanciers approuvés : ${all})`)
    .replaceAll("60/20/20 par défaut, 50/50 seulement sur un bon de commande si c'est demandé.", `${standard} par défaut ; un autre échéancier approuvé seulement si c'est demandé (${all}).`)
    .replaceAll(" (20 % après installation en 60/20/20)", "")
    .replaceAll("60/20/20", standard);
}

export function brandPayload(payload, company = COMPANY) {
  if (company === PILOT_COMPANY) {
    return payload;
  }
  return {
    ...payload,
    instructions: brandText(payload.instructions, company),
    ...(Array.isArray(payload.tools) ? { tools: payload.tools.map((tool) => ({ ...tool, description: brandText(tool.description, company) })) } : {})
  };
}

// The cockpit pages carry the pilot's name; another company's instance serves
// them with its own.
export function brandPage(text, company = COMPANY) {
  if (company === PILOT_COMPANY) {
    return text;
  }
  return text
    .replaceAll("H-KIDS · Marrakech", company.city ? `${company.shortName} · ${company.city}` : company.shortName)
    .replaceAll("H-KIDS", company.shortName);
}
