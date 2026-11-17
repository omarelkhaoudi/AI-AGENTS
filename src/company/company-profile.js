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

export function loadCompanyProfile(env = process.env) {
  const name = read(env, "COMPANY_NAME");
  if (!name) {
    return PILOT_COMPANY;
  }
  // Another company: nothing of H-KIDS is kept, what is not given stays empty
  // rather than borrowing the pilot's address or legal numbers.
  return Object.freeze({
    name,
    shortName: read(env, "COMPANY_SHORT_NAME") || name,
    addressLines: Object.freeze(list(read(env, "COMPANY_ADDRESS"))),
    email: read(env, "COMPANY_EMAIL"),
    phone: read(env, "COMPANY_PHONE"),
    legalLine: read(env, "COMPANY_LEGAL"),
    footerMention: read(env, "COMPANY_FOOTER") || `Les produits ${name} deviennent la propriété du client uniquement après le règlement intégral de la facture.`,
    activity: read(env, "COMPANY_ACTIVITY") || "entreprise marocaine",
    city: read(env, "COMPANY_CITY"),
    leaders: Object.freeze(list(read(env, "COMPANY_LEADERS"))),
    commercialRules: read(env, "COMPANY_RULES") || `Règles commerciales ${name} à respecter dans toute proposition : seuls les échéanciers de paiement acceptés par le cockpit sont proposés ; toute remise ou promotion est soumise à la validation de la direction.`
  });
}

export const COMPANY = loadCompanyProfile();

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
  return text
    .replaceAll(PILOT_COMPANY.commercialRules, company.commercialRules)
    .replaceAll("H KIDS, fabricant marocain de mobilier et d'aménagement sur mesure pour enfants (Marrakech)", `${company.name}, ${company.activity}${where}`)
    .replaceAll("H KIDS (mobilier et aménagement sur mesure pour enfants, Marrakech)", `${company.name} (${company.activity}${company.city ? `, ${company.city}` : ""})`)
    .replaceAll("la direction (Hiba, Omar)", directionLabel(company))
    .replaceAll("(Hiba, Omar)", company.leaders.length > 0 ? `(${company.leaders.join(", ")})` : "")
    .replaceAll("Hiba", senderName(company))
    .replaceAll("H KIDS", company.name)
    .replaceAll("H-KIDS", company.shortName);
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
