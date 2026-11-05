import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// Passwords for the cockpit's sign-in. Only a salted scrypt hash is stored, in
// its own table, so a database dump or a user record sent to the browser never
// carries anything a person could sign in with.
const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
export const MIN_PASSWORD_LENGTH = 10;

export class PasswordError extends Error {
  constructor(message, code = "PASSWORD_INVALID") {
    super(message);
    this.name = "PasswordError";
    this.code = code;
  }
}

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordError(`Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`, "PASSWORD_TOO_SHORT");
  }
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return `scrypt$${COST}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") {
    return false;
  }
  const [scheme, cost, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !key) {
    return false;
  }
  const expected = Buffer.from(key, "base64url");
  const actual = await derive(password, Buffer.from(salt, "base64url"), Number.parseInt(cost, 10));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Spent when the email is unknown, so an answer takes as long whether or not
// the account exists, and the timing does not tell which emails are real.
export async function burnPasswordCheck(password) {
  await derive(typeof password === "string" ? password : "", Buffer.alloc(16), COST);
  return false;
}

function derive(password, salt, cost) {
  return scryptAsync(password.normalize("NFC"), salt, KEY_LENGTH, { N: cost, r: BLOCK_SIZE, p: PARALLELISM, maxmem: 64 * 1024 * 1024 });
}
