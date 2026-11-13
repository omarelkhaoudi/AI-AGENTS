import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// Two-step sign-in for the hosted cockpit: after the password, a six-digit code
// from an authenticator app on the phone (Google Authenticator, Microsoft
// Authenticator…), as RFC 6238 defines it: HMAC-SHA1, 30-second steps. A code
// is accepted once, and one step either side of now is allowed for a phone
// whose clock drifts a little.
//
// Ten recovery codes are given when the app is set up, for the day the phone is
// lost. Only their hashes are kept, and each one works once.

const STEP_SECONDS = 30;
const DIGITS = 6;
const DRIFT_STEPS = 1;
export const RECOVERY_CODE_COUNT = 10;
const ISSUER = "H-KIDS Cockpit";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// 20 random bytes, the length RFC 4226 recommends, written in base32 as the
// apps expect.
export function createTotpSecret() {
  return base32Encode(randomBytes(20));
}

// The address the app reads from the QR code.
export function otpauthUri(secret, accountName) {
  const label = encodeURIComponent(`${ISSUER}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

export function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function currentStep(now = new Date()) {
  return Math.floor(now.getTime() / 1000 / STEP_SECONDS);
}

// The step the code belongs to, or null. A step at or before lastStep was
// already used: the same code typed twice is refused.
export function verifyTotp(secret, code, { now = new Date(), lastStep = null } = {}) {
  const typed = String(code ?? "").replace(/\s+/g, "");
  if (!secret || !/^\d{6}$/.test(typed)) {
    return null;
  }
  const step = currentStep(now);
  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset += 1) {
    const candidate = step + offset;
    if (lastStep !== null && candidate <= lastStep) {
      continue;
    }
    if (sameText(totpCode(secret, candidate), typed)) {
      return candidate;
    }
  }
  return null;
}

// Codes such as « K7QM-4XPA »: no 0/O or 1/I to confuse when typed from paper.
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  return Array.from({ length: count }, () => {
    const characters = Array.from({ length: 8 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join("");
    return `${characters.slice(0, 4)}-${characters.slice(4)}`;
  });
}

export function hashRecoveryCode(code) {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

// The hashes left once the code is used, or null when it is not one of them.
export function useRecoveryCode(hashes, code) {
  const typed = normalizeRecoveryCode(code);
  if (typed.length !== 8) {
    return null;
  }
  const hash = hashRecoveryCode(typed);
  const list = Array.isArray(hashes) ? hashes : [];
  const index = list.findIndex((entry) => sameText(entry, hash));
  return index === -1 ? null : list.filter((_, position) => position !== index);
}

export function looksLikeRecoveryCode(code) {
  return /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(String(code ?? "").trim()) && !/^\d+$/.test(String(code).replace("-", ""));
}

function normalizeRecoveryCode(code) {
  return String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function sameText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of clean) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
