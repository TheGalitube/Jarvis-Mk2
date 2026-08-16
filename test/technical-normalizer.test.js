import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTechnicalTranscript } from "../public/stt/technical-normalizer.js";

test("normalizes an explicitly spoken POSIX path and extension without guessing", () => {
  const result = normalizeTechnicalTranscript("Erstelle slash home slash test punkt txt mit Hallo Welt");
  assert.equal(result.text, "Erstelle /home/test.txt mit Hallo Welt");
  assert.equal(result.rawText, "Erstelle slash home slash test punkt txt mit Hallo Welt");
  assert.deepEqual(result.technicalTokens.map(({ value }) => value), ["/home/test", "/home/test.txt"]);
});

test("handles mixed German-English code switching and Windows paths", () => {
  assert.equal(normalizeTechnicalTranscript("Open C colon backslash Users backslash Max backslash app punkt js").text, "Open C:\\Users\\Max\\app.js");
  assert.equal(normalizeTechnicalTranscript("Starte slash opt slash jarvis slash server punkt mjs").text, "Starte /opt/jarvis/server.mjs");
});

test("leaves ordinary prose and ambiguous speech untouched", () => {
  const result = normalizeTechnicalTranscript("Der Punkt ist wichtig, vielleicht dot product und weiter");
  assert.equal(result.text, "Der Punkt ist wichtig, vielleicht dot product und weiter");
  assert.equal(result.changed, false);
  assert.deepEqual(result.technicalTokens, []);
});
