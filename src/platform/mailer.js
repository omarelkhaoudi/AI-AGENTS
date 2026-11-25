import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "../agent/json-book.js";
import { createSmtpMailer, emailSettingsFromEnv } from "../integrations/email-smtp.js";

// The portal's e-mails: account confirmation, new password, and later the
// invitations. With SMTP_* set (the portal's own environment), they leave by
// that mail server. Without, until the sending address is chosen, they go to a
// test inbox (data/portail-emails.json, never committed), read with
//   npm run platform:emails
// The test inbox keeps the whole message, its link included, so that a person
// testing can follow it; a real send keeps only to whom, what and when, never
// the link, which is a key.

export const DEFAULT_TEST_INBOX_PATH = join(DATA_DIR, "portail-emails.json");
const MAX_MESSAGES = 500;
const EMPTY = Object.freeze({ messages: [] });

function createInbox(book, clock) {
  return Object.freeze({
    async add(entry) {
      return book.change((state) => {
        state.messages.push({ ...entry, at: clock().toISOString() });
        if (state.messages.length > MAX_MESSAGES) {
          state.messages.splice(0, state.messages.length - MAX_MESSAGES);
        }
      });
    },
    async messages({ limit = 20 } = {}) {
      return (await book.load()).messages.slice(-limit).reverse();
    }
  });
}

export function createTestInbox({ path = null, clock = () => new Date() } = {}) {
  return createInbox(path ? createFileJsonBook(path, EMPTY) : createMemoryJsonBook(EMPTY), clock);
}

export function createPlatformMailer({ env = process.env, inbox = createTestInbox({ path: DEFAULT_TEST_INBOX_PATH }), smtp = null, log = () => {} } = {}) {
  const settings = emailSettingsFromEnv(env, { companyName: env.PLATFORM_NAME || "" });
  const server = smtp ?? (settings.configured ? createSmtpMailer(settings) : null);

  return Object.freeze({
    mode: server ? "smtp" : "test",
    inbox,
    async send({ to, subject, text, kind }) {
      if (!server) {
        await inbox.add({ to, kind, subject, text, mode: "test" });
        log(`E-mail « ${kind} » pour ${to} placé dans la boîte de test (SMTP non configuré).`);
        return;
      }
      const { messageId } = await server.send({ to, subject, text });
      await inbox.add({ to, kind, subject, mode: "smtp", messageId });
    }
  });
}
