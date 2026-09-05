const REDACTED = "[REDACTED]";

export class TransientSecret {
  #value: string;

  constructor(value: string) {
    if (!value.trim()) throw new Error("Secret must not be empty");
    this.#value = value;
  }

  use<T>(callback: (value: string) => T): T {
    return callback(this.#value);
  }

  clear(): void {
    this.#value = "";
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }
}

export { REDACTED };
