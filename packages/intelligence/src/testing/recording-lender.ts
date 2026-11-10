// Records whether anything asked for a key. A deny that still opened a key fails its test (QA-010).
import type { CredentialLender, ProfileKeyRef } from '../types';

export class RecordingLender implements CredentialLender {
  readonly asked: ProfileKeyRef[] = [];
  readonly #key: Buffer;

  /** `key` comes from the test, generated at runtime. */
  constructor(key: Buffer) {
    this.#key = key;
  }

  async withKey<T>(profile: ProfileKeyRef, use: (key: Buffer) => Promise<T>): Promise<T> {
    this.asked.push(profile);
    return use(Buffer.from(this.#key));
  }
}
