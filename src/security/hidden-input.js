// A password typed at a terminal, read key by key with nothing written back.
//
// readline's own prompt cannot be silenced reliably: when it redraws the line
// (a backspace, a line that wraps, a slow ssh -t session) it writes the prompt
// and the typed text together, and the password showed. Here the terminal is
// put in raw mode and only the question and a final new line are written.

const ENTER = new Set(["\r", "\n", "\u0004"]);
const BACKSPACE = new Set(["\u007f", "\b"]);
const INTERRUPT = "\u0003";
const ESCAPE = "\u001b";

// The keys of one chunk applied to what was typed so far. An escape sequence
// (an arrow key) is dropped whole; control characters are ignored.
export function consumeKeys(typed, chunk) {
  let answer = typed;
  for (let index = 0; index < chunk.length; index += 1) {
    const key = chunk[index];
    if (key === INTERRUPT) {
      return { answer: "", done: true, interrupted: true };
    }
    if (ENTER.has(key)) {
      return { answer, done: true, interrupted: false };
    }
    if (BACKSPACE.has(key)) {
      answer = Array.from(answer).slice(0, -1).join("");
    } else if (key === ESCAPE) {
      // ESC [ … letter, or ESC and one key.
      index += chunk[index + 1] === "[" ? 1 + chunk.slice(index + 2).search(/[A-Za-z~]|$/) + 1 : 1;
    } else if (key >= " ") {
      answer += key;
    }
  }
  return { answer, done: false, interrupted: false };
}

// Resolves with the line typed, or null when the person pressed Ctrl+C.
export function readHiddenLine(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    output.write(question);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    let typed = "";
    const onData = (chunk) => {
      const step = consumeKeys(typed, String(chunk));
      typed = step.answer;
      if (!step.done) {
        return;
      }
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      resolve(step.interrupted ? null : typed);
    };
    input.on("data", onData);
  });
}
