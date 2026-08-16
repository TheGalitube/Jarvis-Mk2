import assert from "node:assert/strict";
import test from "node:test";
import { AudioQueue } from "../public/audio-queue.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("plays queued audio jobs strictly one at a time", async () => {
  const queue = new AudioQueue();
  const first = deferred();
  const second = deferred();
  const started = [];

  const firstJob = queue.enqueue(async () => { started.push("first"); await first.promise; });
  const secondJob = queue.enqueue(async () => { started.push("second"); await second.promise; });

  await Promise.resolve();
  assert.deepEqual(started, ["first"]);
  first.resolve();
  await firstJob;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "second"]);
  second.resolve();
  await Promise.all([firstJob, secondJob]);
});

test("continues with the next audio job after a playback failure", async () => {
  const queue = new AudioQueue();
  const started = [];

  const failed = queue.enqueue(async () => { throw new Error("decode failed"); });
  const next = queue.enqueue(async () => { started.push("next"); });

  await assert.rejects(failed, /decode failed/);
  await next;
  assert.deepEqual(started, ["next"]);
});
