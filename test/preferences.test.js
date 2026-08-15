import test from "node:test";
import assert from "node:assert/strict";
import { loadPreferences, PREFERENCES_KEY, savePreferences } from "../public/preferences.js";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}

test("restores only known boolean UI preferences", () => {
  const store = storage({ [PREFERENCES_KEY]: JSON.stringify({ captionVisible: false, activityVisible: false, injected: true }) });
  assert.deepEqual(loadPreferences(store), { captionVisible: false, interfaceVisible: true, diagnosticsVisible: false, activityVisible: false, consoleOpen: false });
});

test("invalid or unavailable storage safely falls back to defaults", () => {
  assert.equal(loadPreferences({ getItem: () => "not json" }).captionVisible, true);
  assert.equal(savePreferences({ captionVisible: false }, { setItem: () => { throw new Error("blocked"); } }), false);
});

test("writes a complete versioned preference record", () => {
  const store = storage();
  assert.equal(savePreferences({ captionVisible: false, consoleOpen: true }, store), true);
  assert.deepEqual(JSON.parse(store.values.get(PREFERENCES_KEY)), { captionVisible: false, interfaceVisible: true, diagnosticsVisible: false, activityVisible: true, consoleOpen: true });
});
