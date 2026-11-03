export class ConfigError extends Error {
  constructor(
    message: string,
    readonly hints: string[] = []
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}
export type createConfigErrorFactory = (message: string, hints?: string[]) => ConfigError;
