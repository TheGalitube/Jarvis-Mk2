export const PREFERENCES_KEY = "jarvis.ui-preferences.v1";

const DEFAULTS = Object.freeze({
  captionVisible: true,
  interfaceVisible: true,
  diagnosticsVisible: false,
  activityVisible: true,
  consoleOpen: false,
});

export function loadPreferences(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(PREFERENCES_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return { ...DEFAULTS };
    return Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, typeof saved[key] === "boolean" ? saved[key] : DEFAULTS[key]]));
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePreferences(preferences, storage = globalThis.localStorage) {
  const safe = Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, typeof preferences?.[key] === "boolean" ? preferences[key] : DEFAULTS[key]]));
  try {
    storage?.setItem(PREFERENCES_KEY, JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
}
