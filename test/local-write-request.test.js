import test from "node:test";
import assert from "node:assert/strict";
import { parseLocalWriteRequest } from "../lib/execution/local-write-request.js";

test("parses an explicit German local text-file creation request", () => {
  assert.deepEqual(
    parseLocalWriteRequest("Jarvis, erstelle Textdatei /home/jarvis/note.txt mit dem Inhalt Hallo Welt"),
    { path: "/home/jarvis/note.txt", content: "Hallo Welt" },
  );
});

test("does not treat ordinary conversation as a local write request", () => {
  assert.equal(parseLocalWriteRequest("Kannst du bitte eine Datei erstellen?"), null);
});
