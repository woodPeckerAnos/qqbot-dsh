import type { Result, ContractFailure } from '../errors.js';
import type { TaskClock } from './clock.js';
import type { Logger } from '../logger.js';

export interface SearchConfig {
  baseURL: string;
  model: string;
  apiKeyEnv: string;
  maxTokens: number;
  maxUses: number;
  timeoutMs: number;
}
export interface SearchRequest {
  query: string;
  maxResults?: number;
}
export interface SearchSource {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}
export interface SearchResult {
  sources: SearchSource[];
  truncated: boolean;
}
/** Adapter-owned classification, including the first upstream quota message. */
export interface SearchFailureCause {
  kind: 'quota-exhausted' | 'service-error';
  provider: string;
  httpStatus?: number;
  providerCode?: string;
  message: string;
  resetAt?: string;
}
export interface SearchProvider {
  search(request: SearchRequest, signal: AbortSignal): Promise<Result<SearchResult>>;
}
export interface SearchService extends SearchProvider {
  quotaFailure(): ContractFailure | undefined;
  close(): void;
}
export type createSearchProviderFactory = (options: {
  config: SearchConfig;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  clock?: TaskClock;
  logger: Logger;
}) => SearchProvider;
export type createSearchServiceFactory = (provider: SearchProvider) => SearchService;
export interface WorkerServiceRequest {
  action: 'search' | 'authorize-step' | 'authorize-fetch';
  sessionId: string;
  executionId: string;
  runtimeGeneration: string;
  request?: SearchRequest;
  url?: string;
  step?: number;
  turn?: number;
}
export interface WorkerBudgetUpdate {
  kind: 'finish';
  reason: 'time-budget' | 'step-budget' | 'quota-exhausted';
  sessionId: string;
  executionId: string;
  runtimeGeneration: string;
}
