import type {
  DeepReadonly,
  TaskSnapshotV3 as TaskSnapshot,
  QueuedMessage,
  OriginalMessageReference,
} from '@qqbot/contracts';
import type { Harness } from './harness.js';
import type { ProbeAction } from './onebot-probe.js';

export interface OutputDeliveryEvidence {
  version: number;
  inputHash: string;
  externalMessages: number;
  targetMessages: number;
  internalNodes: number;
  actions: ProbeAction[];
  bodyComplete: boolean;
  filesComplete: boolean;
  displayPass: boolean;
  preparationMs: number;
  lastDeliveryMs: number;
}

export type Status = 'pass' | 'fail' | 'inconclusive';
export interface AssertionResult {
  name: string;
  category: 'runtime' | 'semantic';
  status: Status;
  evidence: unknown;
}
export interface DimensionVerdict {
  status: Status;
  severity: 'none' | 'minor' | 'severe';
  reason: string;
  quotes: string[];
}
export interface JudgeVerdict {
  version: string;
  status: Status;
  dimensions: Record<'duplication' | 'contradiction' | 'handoff' | 'trust', DimensionVerdict>;
  error?: string;
}
export interface InputStep {
  text: string;
  messageId?: string;
  at?: number;
  session?: string;
  sender?: string;
  after?: 'fast' | 'running' | 'done';
  media?: 'file' | 'csv' | 'image' | 'quote' | 'forward';
  mediaUrl?: string;
}
export interface BenchmarkCase {
  id: string;
  version: number;
  group: string;
  title: string;
  steps: InputStep[];
  expectation: string;
  reasoning?: boolean;
  knownIssue?: boolean;
  run: (h: Harness) => Promise<void>;
}
export interface AttachmentEvidence {
  fileName: string;
  sizeBytes: number;
  sha256: string;
  text?: string;
}
export interface PlatformAction {
  order: number;
  at: number;
  receivedAt?: number;
  receivedOrder?: number;
  taskId?: string;
  messageId?: string;
  lane?: string;
  session: string;
  anchor?: string;
  seq: number;
  kind: string;
  text: string;
  reference?: OriginalMessageReference;
  attachments: AttachmentEvidence[];
  status: 'attempted' | 'received' | 'failed';
}
export interface ReasoningEvidence {
  taskId: string;
  lane: string;
  appeared: boolean;
  events: number;
  tokens: number;
}
export interface ExecutionEvidence {
  taskId: string;
  lane: string;
  modelFinalText: string;
  toolCalls: number;
  toolErrors: number;
  childrenStarted: number;
  childrenFinished: number;
  childFailures: number;
  lastChildFinishedAt?: number;
  parentEndedAt?: number;
}
export interface RunRecord {
  outputDelivery?: OutputDeliveryEvidence;
  caseId: string;
  caseVersion: number;
  title: string;
  group: string;
  mode: 'offline' | 'live';
  repetition: number;
  seed: number;
  knownIssue: boolean;
  inputs: InputStep[];
  startedAt: number;
  durationMs: number;
  judgingMs: number;
  tasks: DeepReadonly<TaskSnapshot>[];
  messages: readonly DeepReadonly<QueuedMessage>[];
  actions: PlatformAction[];
  reasoning: ReasoningEvidence[];
  executions: ExecutionEvidence[];
  assertions: AssertionResult[];
  judge?: JudgeVerdict;
  resources: Record<string, number>;
  configuration: Record<string, unknown>;
}
export interface BenchmarkOptions {
  mode: 'offline' | 'live';
  cases: string[];
  repeat?: number;
  seed: number;
  full: boolean;
  strict: boolean;
  output: string;
  baseline?: string;
}
export interface BenchmarkReport {
  version: string;
  createdAt: string;
  options: BenchmarkOptions;
  records: RunRecord[];
  calibration?: {
    passed: boolean;
    samples: { id: string; expected: Status; verdict: JudgeVerdict }[];
  };
  judgeConfiguration?: Record<string, unknown>;
  errors: string[];
  passed: boolean;
  metrics: Record<string, unknown>;
  comparison?: Record<string, unknown>;
}
