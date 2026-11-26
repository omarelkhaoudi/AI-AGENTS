import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

// The ticket the portal hands a person to enter one company's cockpit.
//
// The portal signs it with its private key (Ed25519); a cockpit holds only the
// public key, so it can check a ticket but never make one. A ticket names the
// one company it opens (aud), lasts 60 seconds, and carries a number used once
// (jti) that the cockpit remembers: copied, replayed or sent to another
// company's cockpit, it is refused.
//
// Written as header.payload.signature in base64url, like a JWT signed EdDSA.

export const PORTAL_TICKET_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 30;
const ISSUER = "portail";
const HEADER = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");

export class PortalTokenError extends Error {
  constructor(message, code = "PORTAL_TOKEN_INVALID") {
    super(message);
    this.name = "PortalTokenError";
    this.code = code;
  }
}

// A key from the environment: PEM (its line breaks may be written \n) or the
// base64 of its DER form (PKCS#8 for the private key, SPKI for the public one).
function keyFrom(value, kind) {
  const text = String(value ?? "").trim().replace(/\\n/g, "\n");
  if (!text) {
    return null;
  }
  const make = kind === "private" ? createPrivateKey : createPublicKey;
  const key = text.startsWith("-----BEGIN")
    ? make(text)
    : make({ key: Buffer.from(text, "base64"), format: "der", type: kind === "private" ? "pkcs8" : "spki" });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new PortalTokenError("La clé du portail doit être une clé Ed25519.", "PORTAL_KEY_INVALID");
  }
  return key;
}

export const privateKeyFrom = (value) => keyFrom(value, "private");
export const publicKeyFrom = (value) => keyFrom(value, "public");

// A new pair, the public half in the base64 form a cockpit's PORTAL_PUBLIC_KEY takes.
export function generatePortalKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey,
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64")
  };
}

export function publicBase64Of(privateKey) {
  return createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
}

export function signPortalTicket({ account, company, role, now = new Date() }, privateKey) {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER,
    aud: company,
    sub: account.id,
    email: account.email,
    name: account.name,
    role,
    iat: issuedAt,
    exp: issuedAt + PORTAL_TICKET_SECONDS,
    jti: randomBytes(16).toString("base64url")
  })).toString("base64url");
  const signature = sign(null, Buffer.from(`${HEADER}.${payload}`), privateKey).toString("base64url");
  return `${HEADER}.${payload}.${signature}`;
}

// The claims of a valid ticket for this company, or a PortalTokenError. The
// once-only check (jti) is the caller's: it alone knows which were used.
export function verifyPortalTicket(token, { publicKey, audience, now = new Date() }) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts[0] !== HEADER || token.length > 4096) {
    throw new PortalTokenError("Ce lien d'entrée n'est pas valable. Repassez par le portail.");
  }
  let signed = false;
  try {
    signed = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"));
  } catch {
    signed = false;
  }
  if (!signed) {
    throw new PortalTokenError("Ce lien d'entrée n'est pas valable. Repassez par le portail.");
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new PortalTokenError("Ce lien d'entrée n'est pas valable. Repassez par le portail.");
  }
  const seconds = Math.floor(now.getTime() / 1000);
  if (claims.iss !== ISSUER || typeof claims.jti !== "string" || typeof claims.sub !== "string" || typeof claims.email !== "string") {
    throw new PortalTokenError("Ce lien d'entrée n'est pas valable. Repassez par le portail.");
  }
  if (claims.aud !== audience) {
    throw new PortalTokenError("Ce lien d'entrée ouvre une autre entreprise. Repassez par le portail.", "PORTAL_TOKEN_OTHER_COMPANY");
  }
  if (!(claims.exp > seconds) || !(claims.iat <= seconds + CLOCK_SKEW_SECONDS) || claims.exp - claims.iat > PORTAL_TICKET_SECONDS) {
    throw new PortalTokenError("Ce lien d'entrée a expiré. Repassez par le portail.", "PORTAL_TOKEN_EXPIRED");
  }
  return claims;
}

// The numbers already used, kept until their ticket would have expired anyway.
// In memory: a ticket lasts a minute, a cockpit restarting within that minute
// at worst lets the person enter once more with the same ticket.
export function createUsedTicketBook({ clock = () => new Date() } = {}) {
  const used = new Map();
  return Object.freeze({
    // True the first time a number is seen, false after.
    consume(jti, expiresAtSeconds) {
      const now = Math.floor(clock().getTime() / 1000);
      for (const [key, until] of used) {
        if (until <= now) {
          used.delete(key);
        }
      }
      if (used.has(jti)) {
        return false;
      }
      used.set(jti, expiresAtSeconds);
      return true;
    }
  });
}

// The cockpit has four roles until the rights matrix (étape 5): a company's
// role is read with the nearest one that never gives more.
export const COCKPIT_ROLE_OF = Object.freeze({
  owner: "leader",
  admin: "approver",
  finance: "approver",
  sales: "operator",
  production: "operator",
  marketing: "operator",
  viewer: "viewer"
});
