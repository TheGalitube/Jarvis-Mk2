import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../lib/memory.js";

test("memory keeps project context across a reload without recording secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-memory-"));
  const path = join(directory, "memory.json");
  try {
    const memory = await new MemoryStore(path, { now: () => "2026-08-18T20:30:00.000Z" }).load();
    await memory.remember("telegram:42", "Projekt: JARVIS-Mobile, Repo TheGalitube/JARVIS-Mobile", "Ich erstelle die Android- und Wear-OS-App.");
    const restored = await new MemoryStore(path).load();
    const context = restored.context("telegram:42");
    assert.match(context, /JARVIS-Mobile/);
    assert.match(context, /TheGalitube\/JARVIS-Mobile/);
    assert.match(await readFile(path, "utf8"), /Android-/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
