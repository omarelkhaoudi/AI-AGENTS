import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

// The company's e-mail channel (CDC section 11: « connecteurs Meta et
// e-mail »): a message and its documents leave from the company's address,
// through its own mail server (SMTP), once someone clicked « Envoyer » in the
// cockpit. No library: the conversation with the server is a dozen lines.
//
// The connection is encrypted: TLS from the start (port 465) or STARTTLS
// (port 587); a server that offers neither is refused, unless SMTP_SECURE=none
// says it is a server on the same machine.

export class EmailError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "EmailError";
    this.code = code;
  }
}

const ADDRESS = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[a-z]{2,}$/i;
export const MAX_ATTACHMENTS = 5;
const TIMEOUT_MS = 20_000;

export function isEmailAddress(value) {
  return typeof value === "string" && value.length <= 254 && ADDRESS.test(value.trim());
}

// SMTP_HOST, SMTP_PORT, SMTP_SECURE (tls | starttls | none), SMTP_USER,
// SMTP_PASSWORD, SMTP_FROM (the company's address) and SMTP_FROM_NAME.
export function emailSettingsFromEnv(env = process.env, { companyEmail = "", companyName = "" } = {}) {
  const value = (name) => String(env[name] ?? "").trim();
  const port = Number.parseInt(value("SMTP_PORT") || "587", 10);
  const secure = ["tls", "starttls", "none"].includes(value("SMTP_SECURE").toLowerCase()) ? value("SMTP_SECURE").toLowerCase() : port === 465 ? "tls" : "starttls";
  const from = value("SMTP_FROM") || companyEmail;
  const missing = [
    ...(value("SMTP_HOST") ? [] : ["SMTP_HOST"]),
    ...(isEmailAddress(from) ? [] : ["SMTP_FROM"]),
    ...(value("SMTP_USER") && !value("SMTP_PASSWORD") ? ["SMTP_PASSWORD"] : [])
  ];
  return Object.freeze({
    configured: missing.length === 0,
    missing,
    host: value("SMTP_HOST"),
    port: Number.isInteger(port) && port > 0 ? port : 587,
    secure,
    user: value("SMTP_USER"),
    password: value("SMTP_PASSWORD"),
    from,
    fromName: value("SMTP_FROM_NAME") || companyName
  });
}

// connect(options) -> socket: a seam for the tests, which talk to a server of
// their own.
export function createSmtpMailer(settings, { connect = null, clock = () => new Date() } = {}) {
  return Object.freeze({
    configured: settings.configured,
    from: settings.from,
    async send({ to, subject, text, attachments = [] }) {
      if (!settings.configured) {
        throw new EmailError(`L'e-mail n'est pas configuré : renseignez ${settings.missing.join(", ")} dans .env.`, "EMAIL_NOT_CONFIGURED");
      }
      if (!isEmailAddress(to)) {
        throw new EmailError(`Adresse e-mail illisible « ${String(to ?? "").slice(0, 80)} ».`, "EMAIL_ADDRESS_INVALID");
      }
      if (attachments.length > MAX_ATTACHMENTS) {
        throw new EmailError(`${MAX_ATTACHMENTS} pièces jointes au plus.`, "EMAIL_TOO_MANY_ATTACHMENTS");
      }
      const messageId = `<${randomUUID()}@${settings.from.split("@")[1]}>`;
      const message = mimeMessage({ from: settings.from, fromName: settings.fromName, to: to.trim(), subject, text, attachments, messageId, date: clock() });
      await deliver(settings, { from: settings.from, to: to.trim(), message }, connect);
      return Object.freeze({ messageId });
    }
  });
}

async function deliver(settings, { from, to, message }, connect) {
  const open = connect ?? ((options) => (options.tls ? tls.connect({ host: options.host, port: options.port, servername: options.host }) : net.connect({ host: options.host, port: options.port })));
  let socket = open({ host: settings.host, port: settings.port, tls: settings.secure === "tls" });
  let reader = replies(socket);
  const say = async (line, expected, code) => {
    if (line !== null) {
      socket.write(`${line}\r\n`);
    }
    const reply = await reader.next();
    if (!expected.includes(reply.code)) {
      const text = reply.lines.join(" ").slice(0, 300);
      throw new EmailError(code === "EMAIL_AUTH_FAILED" ? "Le serveur d'e-mail refuse l'identifiant ou le mot de passe (SMTP_USER, SMTP_PASSWORD)." : code === "EMAIL_RECIPIENT_REFUSED" ? `Le serveur d'e-mail refuse le destinataire : ${text}` : `Le serveur d'e-mail a répondu : ${text}`, code);
    }
    return reply;
  };
  try {
    await say(null, [220], "EMAIL_REFUSED");
    let hello = await say(`EHLO ${helloName(settings.from)}`, [250], "EMAIL_REFUSED");
    if (settings.secure === "starttls") {
      if (!hello.lines.some((line) => /^STARTTLS\b/i.test(line))) {
        throw new EmailError("Le serveur d'e-mail ne propose pas de connexion chiffrée (STARTTLS) : rien n'est envoyé.", "EMAIL_TLS_UNAVAILABLE");
      }
      await say("STARTTLS", [220], "EMAIL_REFUSED");
      reader.stop();
      socket = await upgrade(socket, settings.host, connect);
      reader = replies(socket);
      hello = await say(`EHLO ${helloName(settings.from)}`, [250], "EMAIL_REFUSED");
    }
    if (settings.user) {
      const auth = hello.lines.find((line) => /^AUTH\b/i.test(line)) ?? "";
      if (/\bPLAIN\b/i.test(auth)) {
        await say(`AUTH PLAIN ${Buffer.from(`\u0000${settings.user}\u0000${settings.password}`).toString("base64")}`, [235], "EMAIL_AUTH_FAILED");
      } else {
        await say("AUTH LOGIN", [334], "EMAIL_AUTH_FAILED");
        await say(Buffer.from(settings.user).toString("base64"), [334], "EMAIL_AUTH_FAILED");
        await say(Buffer.from(settings.password).toString("base64"), [235], "EMAIL_AUTH_FAILED");
      }
    }
    await say(`MAIL FROM:<${from}>`, [250], "EMAIL_REFUSED");
    await say(`RCPT TO:<${to}>`, [250, 251], "EMAIL_RECIPIENT_REFUSED");
    await say("DATA", [354], "EMAIL_REFUSED");
    // A line starting with a dot gets a second one (RFC 5321, 4.5.2).
    await say(`${message.replace(/\r\n\./g, "\r\n..")}\r\n.`, [250], "EMAIL_REFUSED");
    socket.write("QUIT\r\n");
  } catch (error) {
    if (error instanceof EmailError) {
      throw error;
    }
    throw new EmailError(`Le serveur d'e-mail ${settings.host} est injoignable (${error.code ?? error.message}).`, "EMAIL_UNREACHABLE");
  } finally {
    reader.stop();
    socket.end();
  }
}

function upgrade(socket, host, connect) {
  if (connect) {
    return Promise.resolve(connect({ upgrade: socket, host }));
  }
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: host }, () => resolve(secured));
    secured.once("error", reject);
  });
}

// The server's replies, one at a time: « 250-… » lines go on, « 250 … » ends.
function replies(socket) {
  let buffer = "";
  let lines = [];
  const ready = [];
  const waiting = [];
  let failure = null;
  const settle = () => {
    while (ready.length > 0 && waiting.length > 0) {
      waiting.shift().resolve(ready.shift());
    }
    if (failure) {
      while (waiting.length > 0) {
        waiting.shift().reject(failure);
      }
    }
  };
  const onData = (chunk) => {
    buffer += chunk.toString("utf8");
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match) {
        continue;
      }
      lines.push(match[3]);
      if (match[2] === " ") {
        ready.push({ code: Number(match[1]), lines });
        lines = [];
      }
    }
    settle();
  };
  const onError = (error) => {
    failure = error;
    settle();
  };
  const onClose = () => onError(Object.assign(new Error("connexion fermée"), { code: "ECONNRESET" }));
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  socket.setTimeout?.(TIMEOUT_MS, () => onError(Object.assign(new Error("délai dépassé"), { code: "ETIMEDOUT" })));
  return {
    next: () => new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      settle();
    }),
    stop() {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.setTimeout?.(0);
    }
  };
}

function helloName(from) {
  return from.split("@")[1] || "localhost";
}

// A header word in UTF-8 (RFC 2047), so accents and Arabic pass.
function encodedWord(value) {
  const clean = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function base64Lines(buffer) {
  return buffer.toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

export function mimeMessage({ from, fromName, to, subject, text, attachments = [], messageId, date }) {
  const boundary = `hkids-${randomUUID()}`;
  const body = Buffer.from(String(text ?? "").replace(/\r?\n/g, "\r\n"), "utf8");
  const parts = [
    [`--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", base64Lines(body)].join("\r\n"),
    ...attachments.map((file) => {
      const name = String(file.name).replace(/[\r\n"\\]+/g, "_");
      const ascii = name.replace(/[^\x20-\x7e]/g, "_");
      return [
        `--${boundary}`,
        `Content-Type: ${file.contentType ?? "application/pdf"}; name="${ascii}"`,
        `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(Buffer.from(file.content))
      ].join("\r\n");
    })
  ];
  return [
    `From: ${fromName ? `${encodedWord(fromName)} ` : ""}<${from}>`,
    `To: <${to}>`,
    `Subject: ${encodedWord(subject)}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts,
    `--${boundary}--`
  ].join("\r\n");
}
