/** Public module boundary. Consumers receive contract interfaces. */
import { OffpeakCommandRouter } from '../pipeline/ingress/offpeak-command.js';
import { PersonaCommandRouter } from '../pipeline/ingress/persona-command.js';
import { SessionCommandRouter } from '../pipeline/ingress/session-command.js';
import { Orchestrator } from '../pipeline/orchestrator.js';
export const createOffpeakCommandRouter: import('@qqbot/contracts').createOffpeakCommandRouterFactory =
  (...args) => new OffpeakCommandRouter(...args);
export const createPersonaCommandRouter: import('@qqbot/contracts').createPersonaCommandRouterFactory =
  (...args) => new PersonaCommandRouter(...args);
export const createSessionCommandRouter: import('@qqbot/contracts').createSessionCommandRouterFactory =
  (...args) => new SessionCommandRouter(...args);
export const createOrchestrator: import('@qqbot/contracts').createOrchestratorFactory = (...args) =>
  new Orchestrator(...args);
import { matchLongTaskHint as matchLongTaskHintImplementation } from '../pipeline/hints.js';
export const matchLongTaskHint: import('@qqbot/contracts').matchLongTaskHint =
  matchLongTaskHintImplementation;
export { DEFAULT_LONG_TASK_PATTERNS, DEFAULT_LONG_TASK_HINT_TEXT } from '../pipeline/hints.js';
import { createDedupeStage as createDedupeStageImplementation } from '../pipeline/ingress/dedupe.js';
export const createDedupeStage: import('@qqbot/contracts').createDedupeStage =
  createDedupeStageImplementation;
import { createOffpeakGateStage as createOffpeakGateStageImplementation } from '../pipeline/ingress/offpeak-gate.js';
export const createOffpeakGateStage: import('@qqbot/contracts').createOffpeakGateStage =
  createOffpeakGateStageImplementation;
import { parsePersonaCommand as parsePersonaCommandImplementation } from '../pipeline/ingress/persona-command.js';
export const parsePersonaCommand: import('@qqbot/contracts').parsePersonaCommand =
  parsePersonaCommandImplementation;
import { createRecordStage as createRecordStageImplementation } from '../pipeline/ingress/record.js';
export const createRecordStage: import('@qqbot/contracts').createRecordStage =
  createRecordStageImplementation;
import { parseSessionCommand as parseSessionCommandImplementation } from '../pipeline/ingress/session-command.js';
export const parseSessionCommand: import('@qqbot/contracts').parseSessionCommand =
  parseSessionCommandImplementation;
import {
  logInputShortcut as logInputShortcutImplementation,
  runStages as runStagesImplementation,
} from '../pipeline/ingress/types.js';
export const logInputShortcut: import('@qqbot/contracts').logInputShortcut =
  logInputShortcutImplementation;
export const runStages: import('@qqbot/contracts').runStages = runStagesImplementation;
import { handleWelcomeEvent as handleWelcomeEventImplementation } from '../pipeline/ingress/welcome.js';
export const handleWelcomeEvent: import('@qqbot/contracts').handleWelcomeEvent =
  handleWelcomeEventImplementation;
import {
  renderJudgePrompt as renderJudgePromptImplementation,
  parseJudgeOutput as parseJudgeOutputImplementation,
  createTopicJudge as createTopicJudgeImplementation,
} from '../pipeline/topic-judge.js';
export const renderJudgePrompt: import('@qqbot/contracts').renderJudgePrompt =
  renderJudgePromptImplementation;
export const parseJudgeOutput: import('@qqbot/contracts').parseJudgeOutput =
  parseJudgeOutputImplementation;
export const createTopicJudge: import('@qqbot/contracts').createTopicJudge =
  createTopicJudgeImplementation;
export { VERDICT_FALLBACK } from '../pipeline/topic-judge.js';

import {
  createTopicJudgeResult as createTopicJudgeResultImplementation,
  parseJudgeResult as parseJudgeResultImplementation,
} from '../pipeline/topic-judge.js';
export const createTopicJudgeResult: import('@qqbot/contracts').createTopicJudgeResult =
  createTopicJudgeResultImplementation;
export const parseJudgeResult: import('@qqbot/contracts').parseJudgeResult =
  parseJudgeResultImplementation;
