// Messages are fixed codes: never include upstream bodies, URLs or credentials.
export class OneCError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}
