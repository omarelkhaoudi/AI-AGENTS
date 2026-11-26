import { isEmailAddress } from "../integrations/email-smtp.js";
import { AccountError, normalizeEmail } from "./accounts.js";

// The companies of the platform and who belongs to each (cahier des charges,
// sections 2 and 3). The portal keeps only what opens a company's space: its
// names, country, sector, contact address and language, the seven answers asked
// at its creation. Everything else of the company lives in its own cockpit.

export const COMPANY_ROLES = Object.freeze({
  owner: "Propriétaire",
  admin: "Administrateur entreprise",
  sales: "Commercial",
  production: "Production",
  finance: "Finance",
  marketing: "Marketing",
  viewer: "Consultation"
});

// provisioning until its cockpit exists (étape 3 makes it by itself).
export const COMPANY_STATUSES = Object.freeze({
  provisioning: "En création",
  trial: "Essai",
  active: "Active",
  payment_pending: "Paiement en attente",
  suspended: "Suspendue",
  terminated: "Résiliée"
});

const ENTERABLE = new Set(["trial", "active", "payment_pending"]);

// The list of the launch is Hiba's and Hicham's to decide (cadrage, questions à
// trancher); these are the three of the questionnaire and a way out.
export const SECTORS = Object.freeze({
  fabrication: "Fabrication sur mesure",
  services: "Services",
  negoce: "Négoce et distribution",
  autre: "Autre activité"
});

export const COUNTRIES = Object.freeze({
  MA: "Maroc",
  FR: "France",
  BE: "Belgique",
  TN: "Tunisie",
  SN: "Sénégal",
  CI: "Côte d'Ivoire"
});

export const LANGUAGES = Object.freeze({ fr: "Français", ar: "العربية", en: "English" });

// A person creates a few companies on their own; more is a conversation.
export const MAX_COMPANIES_CREATED = 5;
const MAX_NAME = 160;

function text(value, { label, required = true }) {
  const cleaned = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (required && !cleaned) {
    throw new AccountError(`Indiquez ${label}.`, "FIELD_REQUIRED");
  }
  if (cleaned.length > MAX_NAME) {
    throw new AccountError(`${label.charAt(0).toUpperCase()}${label.slice(1)} ne doit pas dépasser ${MAX_NAME} caractères.`, "FIELD_TOO_LONG");
  }
  return cleaned;
}

function oneOf(value, choices, message, code) {
  if (typeof value !== "string" || !Object.hasOwn(choices, value)) {
    throw new AccountError(message, code);
  }
  return value;
}

// « Atelier Élan & Fils » → « atelier-elan-fils »: the company's address on the
// platform, letters, digits and hyphens only.
export function slugFrom(name) {
  const slug = String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length >= 2 ? slug : `entreprise${slug ? `-${slug}` : ""}`;
}

export function isSlug(value) {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(value);
}

// What a member sees of a company in the portal.
export function publicMembership({ company, role, status }) {
  return {
    slug: company.slug,
    tradeName: company.tradeName,
    legalName: company.legalName,
    country: company.country,
    sector: company.sector,
    role,
    roleLabel: COMPANY_ROLES[role] ?? role,
    status: company.status,
    statusLabel: COMPANY_STATUSES[company.status] ?? company.status,
    cockpitUrl: ENTERABLE.has(company.status) && status === "active" ? company.cockpitUrl : null
  };
}

function companyFields(input) {
  const legalName = text(input.legalName, { label: "la raison sociale" });
  return {
    legalName,
    tradeName: text(input.tradeName, { label: "le nom commercial", required: false }) || legalName,
    country: oneOf(input.country, COUNTRIES, "Choisissez le pays de l'entreprise.", "COUNTRY_INVALID"),
    sector: oneOf(input.sector, SECTORS, "Choisissez le secteur de l'entreprise.", "SECTOR_INVALID"),
    contactEmail: (() => {
      const email = normalizeEmail(input.contactEmail);
      if (!isEmailAddress(email)) {
        throw new AccountError("L'e-mail de contact de l'entreprise n'est pas valide.", "EMAIL_INVALID");
      }
      return email;
    })(),
    language: input.language === undefined || input.language === "" ? "fr" : oneOf(input.language, LANGUAGES, "Choisissez la langue de l'interface.", "LANGUAGE_INVALID")
  };
}

export function createCompanyService({ store }) {
  return Object.freeze({
    async listForAccount(account) {
      return (await store.listMemberships(account.id)).map(publicMembership);
    },

    // The person signed in becomes its owner; the space waits for its cockpit.
    async create(account, input = {}) {
      const fields = companyFields(input);
      if ((await store.countCompaniesCreatedBy(account.id)) >= MAX_COMPANIES_CREATED) {
        throw new AccountError(`Vous avez déjà créé ${MAX_COMPANIES_CREATED} entreprises. Écrivez-nous pour en ouvrir davantage.`, "COMPANY_LIMIT", 409);
      }
      const company = await store.createCompany({ ...fields, slug: slugFrom(fields.tradeName), status: "provisioning", ownerAccountId: account.id });
      if (!company) {
        throw new AccountError("Aucune adresse libre pour ce nom. Choisissez un autre nom commercial.", "SLUG_UNAVAILABLE", 409);
      }
      await store.record({ type: "company_created", accountId: account.id, metadata: { slug: company.slug } });
      return publicMembership({ company, role: "owner", status: "active" });
    },

    // A company that already has its cockpit (H-KIDS, the test company),
    // linked by hand: its slug is kept as it is, its owner must have an account.
    async link({ slug, ownerEmail, cockpitUrl, status = "active", ...input }) {
      if (!isSlug(slug)) {
        throw new AccountError("Identifiant d'entreprise invalide : lettres minuscules, chiffres et tirets.", "SLUG_INVALID");
      }
      if (!Object.hasOwn(COMPANY_STATUSES, status)) {
        throw new AccountError(`État inconnu : ${status}.`, "STATUS_INVALID");
      }
      let url;
      try {
        url = new URL(cockpitUrl);
      } catch {
        throw new AccountError("Adresse du cockpit invalide.", "URL_INVALID");
      }
      if (url.protocol !== "https:" && url.hostname !== "localhost") {
        throw new AccountError("L'adresse du cockpit doit être en https.", "URL_INVALID");
      }
      const owner = await store.findAccountByEmail(normalizeEmail(ownerEmail));
      if (!owner) {
        throw new AccountError("Aucun compte du portail pour cet e-mail : la personne doit d'abord s'inscrire.", "OWNER_UNKNOWN", 404);
      }
      const fields = companyFields(input);
      const company = await store.createCompany({ ...fields, slug, exact: true, status, cockpitUrl: url.origin, ownerAccountId: owner.id });
      if (!company) {
        throw new AccountError(`L'identifiant ${slug} est déjà pris.`, "SLUG_TAKEN", 409);
      }
      await store.record({ type: "company_linked", accountId: owner.id, metadata: { slug } });
      return company;
    },

    async setRole({ slug, email, role }) {
      oneOf(role, COMPANY_ROLES, `Rôle inconnu. Rôles : ${Object.keys(COMPANY_ROLES).join(", ")}.`, "ROLE_INVALID");
      const company = await store.findCompanyBySlug(slug);
      if (!company) {
        throw new AccountError(`Aucune entreprise ${slug}.`, "COMPANY_UNKNOWN", 404);
      }
      const account = await store.findAccountByEmail(normalizeEmail(email));
      if (!account) {
        throw new AccountError("Aucun compte du portail pour cet e-mail : la personne doit d'abord s'inscrire.", "ACCOUNT_UNKNOWN", 404);
      }
      const result = await store.setMembership({ accountId: account.id, companyId: company.id, role });
      if (result.refused === "LAST_OWNER") {
        throw new AccountError("C'est le dernier propriétaire de l'entreprise : nommez d'abord un autre propriétaire.", "LAST_OWNER", 409);
      }
      await store.record({ type: "membership_set", accountId: account.id, metadata: { slug, role } });
      return result.membership;
    },

    choices() {
      return { sectors: SECTORS, countries: COUNTRIES, languages: LANGUAGES, roles: COMPANY_ROLES };
    }
  });
}
