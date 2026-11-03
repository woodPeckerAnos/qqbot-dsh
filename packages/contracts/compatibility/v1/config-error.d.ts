export declare class ConfigError extends Error {
    readonly hints: string[];
    constructor(message: string, hints?: string[]);
}
export type createConfigErrorFactory = (message: string, hints?: string[]) => ConfigError;
