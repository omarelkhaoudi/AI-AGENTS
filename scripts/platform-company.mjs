import { loadDotEnvIfPresent } from "../src/load-dotenv.js";
import { createPostgresPlatformStore } from "../src/platform/postgres-store.js";
import { COMPANY_ROLES, COUNTRIES, SECTORS, createCompanyService } from "../src/platform/companies.js";

// The companies of the portal, by hand, on the server that runs it:
//
//   npm run platform:company -- link --slug=hkids --name="H KIDS" --trade=H-KIDS \
//        --country=MA --sector=fabrication --contact=<e-mail de l'entreprise> \
//        --url=https://hkids-cockpit.duckdns.org --owner=<e-mail du propriétaire> [--status=active]
//   npm run platform:company -- role --company=hkids --email=<e-mail> --role=admin
//
// link attaches a company whose cockpit already exists (H-KIDS, the test
// company); its owner must have signed up on the portal first. role gives a
// person a role in a company; the last owner keeps theirs.
loadDotEnvIfPresent();

const [command] = process.argv.slice(2);
function option(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const usage = () => {
  console.error("Usage :");
  console.error("  npm run platform:company -- link --slug=<id> --name=<raison sociale> [--trade=<nom commercial>] --country=<pays> --sector=<secteur> --contact=<e-mail> --url=<adresse du cockpit> --owner=<e-mail> [--status=active] [--language=fr]");
  console.error("  npm run platform:company -- role --company=<id> --email=<e-mail> --role=<rôle>");
  console.error(`Pays : ${Object.keys(COUNTRIES).join(", ")} · Secteurs : ${Object.keys(SECTORS).join(", ")} · Rôles : ${Object.keys(COMPANY_ROLES).join(", ")}`);
  process.exit(1);
};

if (!["link", "role"].includes(command)) {
  usage();
}
const databaseUrl = process.env.PLATFORM_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("PLATFORM_DATABASE_URL manque : cette commande écrit dans la base du portail.");
  process.exit(1);
}

const store = await createPostgresPlatformStore({ connectionString: databaseUrl });
const companies = createCompanyService({ store });
try {
  if (command === "link") {
    const company = await companies.link({
      slug: option("slug"),
      legalName: option("name"),
      tradeName: option("trade"),
      country: option("country"),
      sector: option("sector"),
      contactEmail: option("contact"),
      cockpitUrl: option("url"),
      ownerEmail: option("owner"),
      status: option("status") ?? "active",
      language: option("language")
    });
    console.log(`Entreprise rattachée : ${company.tradeName} (${company.slug}), ${company.cockpitUrl}, état ${company.status}.`);
  } else {
    const membership = await companies.setRole({ slug: option("company"), email: option("email"), role: option("role") });
    console.log(`Rôle enregistré : ${COMPANY_ROLES[membership.role]} dans ${option("company")}.`);
  }
} catch (error) {
  console.error(error.code ? `Refusé : ${error.message}` : error);
  process.exitCode = 1;
} finally {
  await store.close();
}
