import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { AccountError, createAccountService } from "./accounts.js";

// The portal: the one place where a person signs up, signs in and, later,
// chooses the company to enter. It never serves a company's data; each company
// keeps its own cockpit and database (architecture hybride, cadrage du
// 25/11/2026).
//
// The session is an HttpOnly cookie, out of reach of the page's scripts. A
// request that changes something must be JSON (a form posted from another site
// cannot be) and, when the browser says where it comes from, come from here.

const FRONTEND_DIR = join(dirname(fileURLToPath(import.meta.url)), "frontend");
export const SESSION_COOKIE = "portal_session";
const SESSION_MAX_AGE = 30 * 24 * 3600;

const PAGES = Object.freeze({
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/portail.css": { file: "portail.css", type: "text/css; charset=utf-8" },
  "/portail.js": { file: "portail.js", type: "text/javascript; charset=utf-8" }
});

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join("; ");

export function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return "";
}

function sessionCookie(value, { secure, maxAge }) {
  return [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, ...(secure ? ["Secure"] : [])].join("; ");
}

export function buildPlatform({
  store,
  mailer,
  baseUrl,
  clock = () => new Date(),
  secureCookies = baseUrl.startsWith("https://"),
  trustProxy = false,
  logger = false,
  rateLimits = { auth: 10, other: 120 }
}) {
  const accounts = createAccountService({ store, mailer, clock, baseUrl });
  const origin = new URL(baseUrl).origin;
  const app = Fastify({ logger, bodyLimit: 64 * 1024, trustProxy });

  app.register(rateLimit, {
    global: true,
    max: (request) => (request.url.startsWith("/api/auth/") && request.method === "POST" ? rateLimits.auth : rateLimits.other),
    timeWindow: 60_000,
    keyGenerator: (request) => `${request.ip}:${request.url.startsWith("/api/auth/") && request.method === "POST" ? "auth" : "other"}`,
    errorResponseBuilder: () => ({ statusCode: 429, error: "Trop de tentatives. Réessayez dans une minute.", details: { code: "RATE_LIMITED" } })
  });

  app.addHook("onSend", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Robots-Tag", "noindex, nofollow")
      .header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    if (request.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
    }
  });

  // A change requested from another site is refused, whatever it carries.
  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST") {
      return;
    }
    const from = request.headers.origin;
    if (from && from !== origin) {
      return reply.code(403).send({ error: "Requête refusée : elle ne vient pas du portail.", details: { code: "ORIGIN_REFUSED" } });
    }
    if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
      return reply.code(415).send({ error: "Format de requête non accepté.", details: { code: "JSON_REQUIRED" } });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AccountError) {
      return reply.code(error.status).send({ error: error.message, details: { code: error.code } });
    }
    if (error.statusCode === 429) {
      return reply.code(429).send(error);
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: "Requête illisible.", details: { code: "BAD_REQUEST" } });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "Le portail a rencontré une erreur. Réessayez dans un instant.", details: { code: "INTERNAL" } });
  });

  const body = (request) => (request.body && typeof request.body === "object" ? request.body : {});
  const sessionOf = (request) => readCookie(request.headers.cookie, SESSION_COOKIE);

  // After the rate limiter has loaded: its hook attaches to the routes declared
  // from then on, not to those declared before.
  app.after(() => {
    app.get("/health", async () => ({ status: "ok", service: "portail" }));

    for (const [path, page] of Object.entries(PAGES)) {
      app.get(path, async (_request, reply) => reply.type(page.type).header("Cache-Control", "no-cache").send(await readFile(join(FRONTEND_DIR, page.file))));
    }

    app.post("/api/auth/signup", async (request) => accounts.signUp(body(request)));
    app.post("/api/auth/verify-email", async (request) => ({ account: await accounts.verifyEmail(body(request)) }));
    app.post("/api/auth/resend-verification", async (request) => accounts.resendVerification(body(request)));
    app.post("/api/auth/forgot-password", async (request) => accounts.requestPasswordReset(body(request)));
    app.post("/api/auth/reset-password", async (request) => accounts.resetPassword(body(request)));

    app.post("/api/auth/login", async (request, reply) => {
      const { account, session } = await accounts.logIn(body(request));
      reply.header("Set-Cookie", sessionCookie(session.secret, { secure: secureCookies, maxAge: SESSION_MAX_AGE }));
      return { account };
    });

    app.post("/api/auth/logout", async (request, reply) => {
      await accounts.logOut(sessionOf(request));
      reply.header("Set-Cookie", sessionCookie("", { secure: secureCookies, maxAge: 0 }));
      return { ok: true };
    });

    app.get("/api/auth/me", async (request, reply) => {
      const account = await accounts.accountForSession(sessionOf(request));
      if (!account) {
        return reply.code(401).send({ error: "Connectez-vous.", details: { code: "NOT_SIGNED_IN" } });
      }
      return { account, minPasswordLength: accounts.minPasswordLength };
    });

    app.get("/api/config", async () => ({ minPasswordLength: accounts.minPasswordLength, mail: mailer.mode }));
  });

  return app;
}
