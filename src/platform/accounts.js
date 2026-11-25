import { createHash, randomBytes } from "node:crypto";
import { burnPasswordCheck, hashPassword, MIN_PASSWORD_LENGTH, PasswordError, verifyPassword } from "../security/password.js";
import { isEmailAddress } from "../integrations/email-smtp.js";

// The people of the platform: one account per person, one password, whatever
// the number of companies they belong to (cahier des charges, sections 2 and 3).
//
// What is never told: whether an e-mail has an account. Signing up with a known
// address, asking for a new password for an unknown one, or a wrong password
// all get the same answer, in the same time; the owner of a known address is
// told by e-mail instead.

export const VERIFY_EMAIL = "verify_email";
export const RESET_PASSWORD = "reset_password";
const VERIFY_HOURS = 48;
const RESET_HOURS = 1;
const SESSION_DAYS = 30;
const MAX_NAME = 120;

export class AccountError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = "AccountError";
    this.code = code;
    this.status = status;
  }
}

export const hashSecret = (secret) => createHash("sha256").update(String(secret)).digest("hex");
const newSecret = () => randomBytes(32).toString("base64url");
const later = (now, hours) => new Date(now.getTime() + hours * 3600 * 1000).toISOString();

export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function cleanName(value) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name) {
    throw new AccountError("Indiquez votre nom.", "NAME_REQUIRED");
  }
  if (name.length > MAX_NAME) {
    throw new AccountError(`Le nom ne doit pas dépasser ${MAX_NAME} caractères.`, "NAME_TOO_LONG");
  }
  return name;
}

function cleanEmail(value) {
  const email = normalizeEmail(value);
  if (!isEmailAddress(email)) {
    throw new AccountError("Cette adresse e-mail n'est pas valide.", "EMAIL_INVALID");
  }
  return email;
}

async function newHash(password) {
  try {
    return await hashPassword(password);
  } catch (error) {
    if (error instanceof PasswordError) {
      throw new AccountError(error.message, error.code);
    }
    throw error;
  }
}

// What the browser may see of an account: never the hash.
export function publicAccount(account) {
  return { id: account.id, email: account.email, name: account.name, emailVerified: Boolean(account.emailVerifiedAt) };
}

export function createAccountService({ store, mailer, clock = () => new Date(), baseUrl }) {
  const link = (path, secret) => `${baseUrl.replace(/\/+$/, "")}/#/${path}?jeton=${encodeURIComponent(secret)}`;

  async function issueToken(account, kind, hours) {
    await store.deleteTokens({ accountId: account.id, kind });
    const secret = newSecret();
    await store.createToken({ accountId: account.id, kind, hash: hashSecret(secret), expiresAt: later(clock(), hours) });
    return secret;
  }

  async function sendVerification(account) {
    const secret = await issueToken(account, VERIFY_EMAIL, VERIFY_HOURS);
    await mailer.send({
      to: account.email,
      kind: VERIFY_EMAIL,
      subject: "Confirmez votre adresse e-mail",
      text: [
        `Bonjour ${account.name},`,
        "",
        "Pour activer votre compte, confirmez votre adresse e-mail en ouvrant ce lien :",
        link("verifier", secret),
        "",
        `Le lien est valable ${VERIFY_HOURS} heures et ne sert qu'une fois.`,
        "Si vous n'avez rien demandé, ignorez ce message : aucun compte ne sera activé."
      ].join("\n")
    });
  }

  async function openSession(account) {
    const secret = newSecret();
    const expiresAt = later(clock(), SESSION_DAYS * 24);
    await store.createSession({ accountId: account.id, hash: hashSecret(secret), expiresAt });
    return { secret, expiresAt };
  }

  return Object.freeze({
    minPasswordLength: MIN_PASSWORD_LENGTH,

    async signUp({ name, email, password }) {
      const cleanedName = cleanName(name);
      const cleanedEmail = cleanEmail(email);
      const passwordHash = await newHash(password);
      const account = await store.createAccount({ email: cleanedEmail, name: cleanedName, passwordHash });
      if (!account) {
        // Already known: same answer as a new account, and its owner is told.
        const existing = await store.findAccountByEmail(cleanedEmail);
        await mailer.send({
          to: cleanedEmail,
          kind: "signup_existing",
          subject: "Une inscription avec votre adresse",
          text: [
            `Bonjour ${existing?.name ?? ""},`.trim(),
            "",
            "Quelqu'un vient d'essayer de créer un compte avec votre adresse e-mail, qui en a déjà un.",
            "Si c'était vous, connectez-vous, ou demandez un nouveau mot de passe si vous l'avez oublié :",
            `${baseUrl.replace(/\/+$/, "")}/#/oubli`,
            "Sinon, vous n'avez rien à faire : votre compte n'a pas changé."
          ].join("\n")
        });
        await store.record({ type: "signup_existing_email", accountId: existing?.id ?? null });
        return { ok: true };
      }
      await store.record({ type: "account_created", accountId: account.id });
      await sendVerification(account);
      return { ok: true };
    },

    async verifyEmail({ token }) {
      const accountId = typeof token === "string" && token ? await store.consumeToken({ kind: VERIFY_EMAIL, hash: hashSecret(token) }) : null;
      if (!accountId) {
        throw new AccountError("Ce lien n'est plus valable. Connectez-vous pour en recevoir un nouveau.", "TOKEN_INVALID");
      }
      const account = await store.markEmailVerified(accountId);
      await store.record({ type: "email_verified", accountId });
      return publicAccount(account);
    },

    // Only after the password is right: a wrong one says nothing of the account.
    async resendVerification({ email, password }) {
      const account = await store.findAccountByEmail(normalizeEmail(email));
      if (!account || !(await verifyPassword(password, account.passwordHash))) {
        if (!account) {
          await burnPasswordCheck(password);
        }
        throw new AccountError("E-mail ou mot de passe incorrect.", "LOGIN_FAILED", 401);
      }
      if (!account.emailVerifiedAt) {
        await sendVerification(account);
      }
      return { ok: true };
    },

    async logIn({ email, password }) {
      const account = await store.findAccountByEmail(normalizeEmail(email));
      const passwordOk = account ? await verifyPassword(password, account.passwordHash) : await burnPasswordCheck(password);
      if (!account || !passwordOk) {
        await store.record({ type: "login_failed", accountId: account?.id ?? null });
        throw new AccountError("E-mail ou mot de passe incorrect.", "LOGIN_FAILED", 401);
      }
      if (account.status !== "active") {
        await store.record({ type: "login_refused_suspended", accountId: account.id });
        throw new AccountError("Ce compte est suspendu. Contactez le responsable de votre entreprise.", "ACCOUNT_SUSPENDED", 403);
      }
      if (!account.emailVerifiedAt) {
        throw new AccountError("Confirmez d'abord votre adresse e-mail avec le lien reçu.", "EMAIL_NOT_VERIFIED", 403);
      }
      const session = await openSession(account);
      await store.record({ type: "login_succeeded", accountId: account.id });
      return { account: publicAccount(account), session };
    },

    async accountForSession(secret) {
      if (typeof secret !== "string" || !secret) {
        return null;
      }
      const session = await store.findSession(hashSecret(secret));
      if (!session) {
        return null;
      }
      const account = await store.findAccountById(session.accountId);
      return account && account.status === "active" ? publicAccount(account) : null;
    },

    async logOut(secret) {
      if (typeof secret === "string" && secret) {
        const session = await store.findSession(hashSecret(secret));
        await store.deleteSession(hashSecret(secret));
        if (session) {
          await store.record({ type: "logout", accountId: session.accountId });
        }
      }
    },

    // Same answer whether or not the address has an account.
    async requestPasswordReset({ email }) {
      const account = await store.findAccountByEmail(normalizeEmail(email));
      if (account && account.status === "active") {
        const secret = await issueToken(account, RESET_PASSWORD, RESET_HOURS);
        await mailer.send({
          to: account.email,
          kind: RESET_PASSWORD,
          subject: "Choisir un nouveau mot de passe",
          text: [
            `Bonjour ${account.name},`,
            "",
            "Pour choisir un nouveau mot de passe, ouvrez ce lien :",
            link("nouveau-mot-de-passe", secret),
            "",
            `Le lien est valable ${RESET_HOURS} heure et ne sert qu'une fois.`,
            "Si vous n'avez rien demandé, ignorez ce message : votre mot de passe ne change pas."
          ].join("\n")
        });
        await store.record({ type: "password_reset_requested", accountId: account.id });
      }
      return { ok: true };
    },

    // A new password closes every open session: whoever knew the old one is out.
    async resetPassword({ token, password }) {
      const passwordHash = await newHash(password);
      const accountId = typeof token === "string" && token ? await store.consumeToken({ kind: RESET_PASSWORD, hash: hashSecret(token) }) : null;
      if (!accountId) {
        throw new AccountError("Ce lien n'est plus valable. Demandez-en un nouveau.", "TOKEN_INVALID");
      }
      await store.setPasswordHash(accountId, passwordHash);
      await store.deleteSessions(accountId);
      // The link came to the address: following it proves the address too.
      await store.markEmailVerified(accountId);
      await store.record({ type: "password_reset", accountId });
      return { ok: true };
    }
  });
}
