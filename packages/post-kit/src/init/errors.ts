/** A refusal or failure of `porch-next init`, with the exit code it maps to. */
export class InitError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'InitError';
    this.exitCode = exitCode;
  }
}
