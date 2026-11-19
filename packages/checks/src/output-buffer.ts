/**
 * Keeps the first and last part of a long output, which is where useful information lives
 * (the command and the failure summary), and drops the middle.
 */
export class HeadTailBuffer {
  readonly #limit: number;
  #head = "";
  #tail = "";
  #dropped = 0;

  constructor(limitBytes: number) {
    this.#limit = Math.max(64, limitBytes);
  }

  push(text: string): void {
    const half = Math.floor(this.#limit / 2);
    if (this.#head.length < half) {
      const room = half - this.#head.length;
      this.#head += text.slice(0, room);
      text = text.slice(room);
    }
    if (text === "") return;
    this.#tail += text;
    if (this.#tail.length > half) {
      this.#dropped += this.#tail.length - half;
      this.#tail = this.#tail.slice(this.#tail.length - half);
    }
  }

  get truncated(): boolean {
    return this.#dropped > 0;
  }

  toString(): string {
    return this.#dropped > 0
      ? `${this.#head}\n… ${this.#dropped} characters omitted …\n${this.#tail}`
      : this.#head + this.#tail;
  }
}
