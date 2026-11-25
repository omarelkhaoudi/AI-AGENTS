import { DEFAULT_TEST_INBOX_PATH, createTestInbox } from "../src/platform/mailer.js";

// The last e-mails of the portal's test inbox, newest first, while no mail
// server is configured:  npm run platform:emails [-- --nombre=5]
const option = process.argv.find((argument) => argument.startsWith("--nombre="));
const limit = Math.min(Math.max(Number.parseInt(option?.slice("--nombre=".length) ?? "5", 10) || 5, 1), 50);
const messages = await createTestInbox({ path: DEFAULT_TEST_INBOX_PATH }).messages({ limit });

if (messages.length === 0) {
  console.log("La boîte de test du portail est vide.");
}
for (const message of messages) {
  console.log(`— ${message.at} · ${message.to} · ${message.subject}`);
  if (message.text) {
    console.log(message.text);
  }
  console.log("");
}
