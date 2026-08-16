// Serializes browser audio playback. Each job waits for the previous job to
// settle, including a failed decode, so one bad clip cannot block later speech.
export class AudioQueue {
  #tail = Promise.resolve();

  enqueue(play) {
    const job = this.#tail.then(() => play());
    this.#tail = job.catch(() => {});
    return job;
  }
}
