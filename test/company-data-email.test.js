import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createMemoryEmailOutbox } from "../src/agent/email-outbox.js";
import { EmailError, createSmtpMailer, emailSettingsFromEnv, isEmailAddress } from "../src/integrations/email-smtp.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// CDC section 11: « export des données et suppression encadrée » and
// « connecteurs Meta et e-mail ». Invented company, client and addresses.

const clock = () => new Date("2026-11-23T10:00:00Z");
const quote = {
  documentType: "quote", documentNumber: "170", date: "02/11/2026", object: "Lit cabane", client: { name: "Client Exemple", address: "Marrakech" },
  items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: 3750, amountHt: 3750 }],
  totals: { totalHt: 3750, tva: 750, totalTtc: 4500 },
  payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
};

async function folders(t) {
  const root = await mkdtemp(join(tmpdir(), "hkids-company-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  await mkdir(join(dataDir, "atelier-photos"), { recursive: true });
  await writeFile(join(dataDir, "caisse.json"), JSON.stringify({ entries: [{ montant: 2700 }] }));
  await writeFile(join(dataDir, "atelier-photos", "171_photo.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  // Never in an export, even if someone left them there.
  await writeFile(join(dataDir, ".env"), "SMTP_PASSWORD=x");
  await writeFile(join(dataDir, "serveur.key"), "clé");
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: join(root, "documents") });
  const preview = await documents.preview(quote);
  await documents.generate({ ...quote, previewToken: preview.previewToken, userConfirmation: true });
  return { dataDir, documents };
}

test("the direction exports all the company's data in one ZIP, keys left out; nobody else can", async (t) => {
  const { dataDir, documents } = await folders(t);
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository, documentService: documents, dataDir, clock });
  t.after(() => app.close());

  const response = await inject({ method: "GET", url: "/api/company/export" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["content-type"], "application/zip");
  assert.match(response.headers["content-disposition"], /export-hkids-2026-11-23\.zip/);
  const zip = response.rawPayload;
  assert.equal(zip.subarray(0, 2).toString("latin1"), "PK");
  // A ZIP keeps each name in clear in its directory.
  for (const name of ["donnees/caisse.json", "donnees/atelier-photos/171_photo.jpg", "LISEZ-MOI.txt", "journal-d-audit.json"]) {
    assert.ok(zip.includes(Buffer.from(name)), `${name} is in the export`);
  }
  assert.ok(zip.includes(Buffer.from("documents/")) && zip.includes(Buffer.from(".pdf")), "the documents issued, with their PDF");
  assert.ok(!zip.includes(Buffer.from("donnees/.env")) && !zip.includes(Buffer.from("serveur.key")), "no keys");
  assert.ok(Number(response.headers["x-export-files"]) >= 6);
  assert.ok((await repository.listAuditEvents({})).some((event) => event.type === "data_exported"), "the export is in the audit log");

  const operator = await buildAuthenticatedApi({ repository: new InMemoryRepository(), documentService: documents, dataDir, clock, role: "operator" });
  t.after(() => operator.app.close());
  const refused = await operator.inject({ method: "GET", url: "/api/company/export" });
  assert.equal(refused.statusCode, 403);
  assert.equal(JSON.parse(refused.body).details.code, "EXPORT_DIRECTION_ONLY");
  assert.equal((await app.inject({ method: "GET", url: "/api/company/export" })).statusCode, 401);
});

// A mail server of the test's own, on this machine: it speaks enough SMTP to
// take a message, and keeps what it was told.
async function fakeSmtp(t, { startTls = false, authOk = true, refuseRecipient = false } = {}) {
  const seen = { commands: [], data: "" };
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let awaitingLogin = 0;
    socket.write("220 mail.exemple.ma ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 2.0.0 Ok: queued\r\n");
          } else {
            seen.data += `${line}\r\n`;
          }
          continue;
        }
        seen.commands.push(line);
        if (awaitingLogin > 0) {
          awaitingLogin -= 1;
          socket.write(awaitingLogin > 0 ? "334 UGFzc3dvcmQ6\r\n" : authOk ? "235 2.7.0 Authentication successful\r\n" : "535 5.7.8 Error: authentication failed\r\n");
        } else if (/^EHLO /.test(line)) {
          socket.write(`250-mail.exemple.ma\r\n${startTls ? "250-STARTTLS\r\n" : ""}250-AUTH LOGIN\r\n250 8BITMIME\r\n`);
        } else if (line === "AUTH LOGIN") {
          awaitingLogin = 2;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (/^MAIL FROM:/.test(line)) {
          socket.write("250 2.1.0 Ok\r\n");
        } else if (/^RCPT TO:/.test(line)) {
          socket.write(refuseRecipient ? "550 5.1.1 Recipient address rejected\r\n" : "250 2.1.5 Ok\r\n");
        } else if (line === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (line === "QUIT") {
          socket.end("221 2.0.0 Bye\r\n");
        } else {
          socket.write("502 5.5.2 Error: command not recognized\r\n");
        }
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, seen };
}

const settingsFor = (port, extra = {}) => emailSettingsFromEnv({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_SECURE: "none", SMTP_USER: "contact@exemple.ma", SMTP_PASSWORD: "mot-de-passe-exemple", ...extra }, { companyEmail: "contact@exemple.ma", companyName: "Atelier Exemple" });

test("a message and its PDF leave through the company's mail server, encrypted unless said otherwise", async (t) => {
  assert.deepEqual(emailSettingsFromEnv({}, {}).missing, ["SMTP_HOST", "SMTP_FROM"]);
  assert.equal(emailSettingsFromEnv({ SMTP_HOST: "smtp.exemple.ma", SMTP_PORT: "465" }, { companyEmail: "contact@exemple.ma" }).secure, "tls");
  assert.equal(emailSettingsFromEnv({ SMTP_HOST: "smtp.exemple.ma" }, { companyEmail: "contact@exemple.ma" }).secure, "starttls");
  assert.deepEqual(emailSettingsFromEnv({ SMTP_HOST: "smtp.exemple.ma", SMTP_USER: "x" }, { companyEmail: "contact@exemple.ma" }).missing, ["SMTP_PASSWORD"]);
  assert.equal(isEmailAddress("client@exemple.ma"), true);
  assert.equal(isEmailAddress("client@exemple.ma\r\nBcc: x@y.ma"), false, "no header injection");

  const { port, seen } = await fakeSmtp(t);
  const mailer = createSmtpMailer(settingsFor(port), { clock });
  const sent = await mailer.send({ to: "client@exemple.ma", subject: "Devis n° 170 — Atelier Exemple", text: "Bonjour,\n.\nVeuillez trouver notre devis.", attachments: [{ name: "Devis 170.pdf", content: Buffer.from("%PDF-1.7 exemple") }] });
  assert.match(sent.messageId, /^<[0-9a-f-]+@exemple\.ma>$/);
  assert.deepEqual(seen.commands.slice(0, 2), ["EHLO exemple.ma", "AUTH LOGIN"]);
  assert.equal(Buffer.from(seen.commands[2], "base64").toString(), "contact@exemple.ma");
  assert.ok(seen.commands.includes("MAIL FROM:<contact@exemple.ma>") && seen.commands.includes("RCPT TO:<client@exemple.ma>"));
  assert.match(seen.data, /^From: Atelier Exemple <contact@exemple\.ma>\r\n/);
  assert.match(seen.data, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/, "accents encoded");
  assert.match(seen.data, /Content-Disposition: attachment; filename="Devis 170.pdf"/);
  assert.ok(seen.data.includes(Buffer.from("%PDF-1.7 exemple").toString("base64")), "the PDF is joined");
  const body = /charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(seen.data)[1];
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "Bonjour,\r\n.\r\nVeuillez trouver notre devis.");

  await assert.rejects(mailer.send({ to: "pas une adresse", subject: "x", text: "x" }), { code: "EMAIL_ADDRESS_INVALID" });
  const refusing = await fakeSmtp(t, { authOk: false });
  await assert.rejects(createSmtpMailer(settingsFor(refusing.port)).send({ to: "client@exemple.ma", subject: "x", text: "x" }), { code: "EMAIL_AUTH_FAILED" });
  const rejecting = await fakeSmtp(t, { refuseRecipient: true });
  await assert.rejects(createSmtpMailer(settingsFor(rejecting.port)).send({ to: "client@exemple.ma", subject: "x", text: "x" }), { code: "EMAIL_RECIPIENT_REFUSED" });
  // A server that offers no encryption is not used without SMTP_SECURE=none.
  const plain = await fakeSmtp(t);
  await assert.rejects(createSmtpMailer(settingsFor(plain.port, { SMTP_SECURE: "starttls" })).send({ to: "client@exemple.ma", subject: "x", text: "x" }), { code: "EMAIL_TLS_UNAVAILABLE" });
  assert.ok(!plain.seen.commands.some((line) => /^AUTH|^MAIL/.test(line)), "nothing said in clear");
  await assert.rejects(createSmtpMailer(settingsFor(1)).send({ to: "client@exemple.ma", subject: "x", text: "x" }), { code: "EMAIL_UNREACHABLE" });
  await assert.rejects(createSmtpMailer(emailSettingsFromEnv({}, {})).send({ to: "client@exemple.ma", subject: "x", text: "x" }), { code: "EMAIL_NOT_CONFIGURED" });
});

test("the cockpit sends a document of the register by e-mail, keeps what left, and says why one failed", async (t) => {
  const { dataDir, documents } = await folders(t);
  const sent = [];
  let failNext = false;
  const emailMailer = { configured: true, from: "contact@exemple.ma", async send(message) {
    if (failNext) {
      throw new EmailError("Le serveur d'e-mail refuse le destinataire : 550", "EMAIL_RECIPIENT_REFUSED");
    }
    sent.push(message);
    return { messageId: "<1@exemple.ma>" };
  } };
  const emailOutbox = createMemoryEmailOutbox({ clock });
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository, documentService: documents, dataDir, emailMailer, emailOutbox, clock });
  t.after(() => app.close());

  const status = JSON.parse((await inject({ method: "GET", url: "/api/email" })).body);
  assert.deepEqual([status.configured, status.from], [true, "contact@exemple.ma"]);
  const [entry] = JSON.parse((await inject({ method: "GET", url: "/api/documents/register" })).body).documents;
  const payload = { to: "client@exemple.ma", recipient: "Client Exemple", subject: "Devis n° 170", message: "Bonjour, voici notre devis.", documents: [entry.stem], kind: "document" };

  assert.equal((await inject({ method: "POST", url: "/api/email/send", payload: { ...payload, to: "client" } })).statusCode, 400);
  assert.equal((await inject({ method: "POST", url: "/api/email/send", payload: { ...payload, message: "" } })).statusCode, 400);
  assert.equal((await inject({ method: "POST", url: "/api/email/send", payload: { ...payload, documents: ["inconnu"] } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/email/send", payload })).statusCode, 401);

  const response = await inject({ method: "POST", url: "/api/email/send", payload });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].attachments[0].content.subarray(0, 5).toString("latin1"), "%PDF-", "the PDF of the register is joined");
  assert.deepEqual(JSON.parse(response.body).message.documents, ["Devis n° 170"]);
  assert.ok((await repository.listAuditEvents({})).some((event) => event.type === "email_sent"));

  failNext = true;
  const failed = await inject({ method: "POST", url: "/api/email/send", payload });
  assert.equal(failed.statusCode, 502);
  assert.equal(JSON.parse(failed.body).details.code, "EMAIL_RECIPIENT_REFUSED");
  const kept = JSON.parse((await inject({ method: "GET", url: "/api/email" })).body).messages;
  assert.deepEqual(kept.map((message) => message.status), ["echec", "envoye"]);

  // Without a mail server, nothing leaves and the cockpit says what to fill in.
  const bare = await buildAuthenticatedApi({ repository: new InMemoryRepository(), documentService: documents, dataDir, clock });
  t.after(() => bare.app.close());
  const unset = await bare.inject({ method: "POST", url: "/api/email/send", payload });
  assert.equal(unset.statusCode, 503);
  assert.match(JSON.parse(unset.body).error, /SMTP_HOST/);
});
