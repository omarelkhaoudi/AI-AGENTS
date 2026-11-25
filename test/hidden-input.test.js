import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { consumeKeys, readHiddenLine } from "../src/security/hidden-input.js";

test("the keys typed build the password; Enter ends it", () => {
  assert.deepEqual(consumeKeys("", "s3cr"), { answer: "s3cr", done: false, interrupted: false });
  assert.deepEqual(consumeKeys("s3cr", "et\r"), { answer: "s3cret", done: true, interrupted: false });
  // A pasted password arrives in one chunk, with its new line.
  assert.deepEqual(consumeKeys("", "Collé-é!\n"), { answer: "Collé-é!", done: true, interrupted: false });
});

test("a backspace removes the last character, an arrow key nothing, Ctrl+C stops", () => {
  assert.equal(consumeKeys("abc", "\u007f").answer, "ab");
  assert.equal(consumeKeys("abé", "\b").answer, "ab");
  assert.equal(consumeKeys("", "\u007f").answer, "");
  assert.equal(consumeKeys("ab", "\u001b[Dc\u001b[3~d").answer, "abcd");
  assert.equal(consumeKeys("ab", "\tc").answer, "abc");
  assert.deepEqual(consumeKeys("abc", "\u0003"), { answer: "", done: true, interrupted: true });
});

function fakeTerminal() {
  const input = new EventEmitter();
  input.modes = [];
  input.setRawMode = (on) => input.modes.push(on);
  input.setEncoding = () => {};
  input.resume = () => {};
  input.pause = () => {};
  const written = [];
  return { input, output: { write: (text) => written.push(text) }, written };
}

test("nothing typed is written back: only the question and the new line", async () => {
  const { input, output, written } = fakeTerminal();
  const answer = readHiddenLine("Mot de passe : ", { input, output });
  input.emit("data", "Hic");
  input.emit("data", "x\u007fham-2026");
  input.emit("data", "\r");
  assert.equal(await answer, "Hicham-2026");
  assert.deepEqual(written, ["Mot de passe : ", "\n"]);
  assert.deepEqual(input.modes, [true, false]);
  assert.equal(input.listenerCount("data"), 0);
});

test("Ctrl+C gives null and leaves the terminal as it was", async () => {
  const { input, output } = fakeTerminal();
  const answer = readHiddenLine("Mot de passe : ", { input, output });
  input.emit("data", "abc\u0003");
  assert.equal(await answer, null);
  assert.deepEqual(input.modes, [true, false]);
});
