import { spawn } from "node:child_process";
import { loadDotEnvIfPresent } from "../src/load-dotenv.js";

// Opens the cockpit in the browser as soon as it answers, for the desktop
// shortcut: started beside npm start, it waits for the server instead of
// opening a page that is not there yet. If a cockpit is already running, it
// answers at once and the page simply opens.
loadDotEnvIfPresent();

const port = Number.parseInt(process.env.PORT ?? "3000", 10) || 3000;
// 127.0.0.1, not localhost: on some PCs another program answers localhost.
const address = `http://127.0.0.1:${port}/app/`;
const deadline = Date.now() + 90_000;

async function ready() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

while (Date.now() < deadline) {
  if (await ready()) {
    // « start » is the Windows way to open an address in the default browser.
    const opener = process.platform === "win32" ? spawn("cmd", ["/c", "start", "", address], { detached: true, stdio: "ignore" })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [address], { detached: true, stdio: "ignore" });
    opener.unref();
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.error(`Le cockpit ne répond pas sur ${address}. Regardez les messages au-dessus.`);
process.exit(1);
