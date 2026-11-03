/** Public module boundary. Consumers receive contract interfaces. */
import { ProactiveSpeaker } from '../pipeline/proactive/deliver/speaker.js';
import { InterestPool } from '../pipeline/proactive/interests/pool.js';
import { ConversationState } from '../pipeline/proactive/scene/state.js';
import { ConversationStateStore } from '../pipeline/proactive/scene/state.js';
import { ProactiveWatcher } from '../pipeline/proactive/scene/watcher.js';
export const createProactiveSpeaker: import('@qqbot/contracts').createProactiveSpeakerFactory = (
  ...args
) => new ProactiveSpeaker(...args);
export const createInterestPool: import('@qqbot/contracts').createInterestPoolFactory = (...args) =>
  new InterestPool(...args);
export const createConversationState: import('@qqbot/contracts').createConversationStateFactory = (
  ...args
) => new ConversationState(...args);
export const createConversationStateStore: import('@qqbot/contracts').createConversationStateStoreFactory =
  (...args) => new ConversationStateStore(...args);
export const createProactiveWatcher: import('@qqbot/contracts').createProactiveWatcherFactory = (
  ...args
) => new ProactiveWatcher(...args);
export {
  SCENE_ORDER,
  sceneOrder,
  sortSceneIds,
  SESSION_CLOSE_CAUSES,
  SESSION_DIRECTIVES,
  isSessionDirective,
  aggregateSessionDirective,
  MAX_SESSION_BUDGET_CAP,
  DEFAULT_SESSION_BUDGET,
  SESSION_IDLE_MS_MIN,
  SESSION_IDLE_MS_MAX,
  DEFAULT_SESSION_IDLE_MS,
  SESSION_MIN_GAP_MS_MIN,
  SESSION_MIN_GAP_MS_MAX,
  DEFAULT_SESSION_MIN_GAP_MS,
  effectiveSessionBudget,
  effectiveSessionIdleMs,
  effectiveSessionMinGapMs,
  WAIT_REASONS,
  isWaitReason,
  VETO_REASON_ORDER,
  DEFAULT_VETO_POLICY,
  MAX_WAIT_PER_ITEM_CAP,
  DEFAULT_MAX_WAIT_PER_ITEM,
  WAIT_YIELD_MS_MIN,
  WAIT_YIELD_MS_MAX,
  DEFAULT_WAIT_YIELD_MS,
  effectiveMaxWaitPerItem,
  effectiveWaitYieldMs,
  isSpeak,
} from '../pipeline/proactive/contract.js';
import {
  isSent as isSentImplementation,
  isWouldSend as isWouldSendImplementation,
} from '../pipeline/proactive/deliver/speaker.js';
export const isSent: import('@qqbot/contracts').isSent = isSentImplementation;
export const isWouldSend: import('@qqbot/contracts').isWouldSend = isWouldSendImplementation;
export {
  PROACTIVE_DEGRADE_ORDER,
  NULL_PROACTIVE_METRICS,
} from '../pipeline/proactive/deliver/speaker.js';
import {
  parseInterestPool as parseInterestPoolImplementation,
  loadInterestPool as loadInterestPoolImplementation,
} from '../pipeline/proactive/interests/pool.js';
export const parseInterestPool: import('@qqbot/contracts').parseInterestPool =
  parseInterestPoolImplementation;
export const loadInterestPool: import('@qqbot/contracts').loadInterestPool =
  loadInterestPoolImplementation;
export {
  MAX_INTEREST_ENTRIES,
  MAX_BOT_ALIASES,
  EMPTY_INTEREST_POOL,
} from '../pipeline/proactive/interests/pool.js';
import { createChatClient as createChatClientImplementation } from '../pipeline/proactive/judge/chat-client.js';
export const createChatClient: import('@qqbot/contracts').createChatClient =
  createChatClientImplementation;
import {
  createProactiveJudge as createProactiveJudgeImplementation,
  createDefaultProactiveJudge as createDefaultProactiveJudgeImplementation,
} from '../pipeline/proactive/judge/client.js';
export const createProactiveJudge: import('@qqbot/contracts').createProactiveJudge =
  createProactiveJudgeImplementation;
export const createDefaultProactiveJudge: import('@qqbot/contracts').createDefaultProactiveJudge =
  createDefaultProactiveJudgeImplementation;
import {
  extractWaitTargetId as extractWaitTargetIdImplementation,
  renderJudgeCriteria as renderJudgeCriteriaImplementation,
  parseSceneVerdicts as parseSceneVerdictsImplementation,
} from '../pipeline/proactive/judge/judge.js';
export const extractWaitTargetId: import('@qqbot/contracts').extractWaitTargetId =
  extractWaitTargetIdImplementation;
export const renderJudgeCriteria: import('@qqbot/contracts').renderJudgeCriteria =
  renderJudgeCriteriaImplementation;
export const parseSceneVerdicts: import('@qqbot/contracts').parseSceneVerdicts =
  parseSceneVerdictsImplementation;
export {
  SCENE_CRITERIA,
  WAIT_TARGET_PREFIX,
  JUDGE_OUTPUT_CONTRACT,
  SCENE_IDS,
} from '../pipeline/proactive/judge/judge.js';
import {
  detectBotReference as detectBotReferenceImplementation,
  getScene as getSceneImplementation,
  scenesForTrigger as scenesForTriggerImplementation,
  buildSceneEvidence as buildSceneEvidenceImplementation,
  collectCandidates as collectCandidatesImplementation,
} from '../pipeline/proactive/scene/collect.js';
export const detectBotReference: import('@qqbot/contracts').detectBotReference =
  detectBotReferenceImplementation;
export const getScene: import('@qqbot/contracts').getScene = getSceneImplementation;
export const scenesForTrigger: import('@qqbot/contracts').scenesForTrigger =
  scenesForTriggerImplementation;
export const buildSceneEvidence: import('@qqbot/contracts').buildSceneEvidence =
  buildSceneEvidenceImplementation;
export const collectCandidates: import('@qqbot/contracts').collectCandidates =
  collectCandidatesImplementation;
export { SCENE_DEFINITIONS, SCENE_REGISTRY } from '../pipeline/proactive/scene/collect.js';
import { looksLikeQuestion as looksLikeQuestionImplementation } from '../pipeline/proactive/scene/state.js';
export const looksLikeQuestion: import('@qqbot/contracts').looksLikeQuestion =
  looksLikeQuestionImplementation;
export {
  MIN_QUESTION_CHARS,
  DEFAULT_ACTIVITY_WINDOW_MS,
  DEFAULT_STATE_OPTIONS,
} from '../pipeline/proactive/scene/state.js';
import {
  renderTranscript as renderTranscriptImplementation,
  renderFacts as renderFactsImplementation,
} from '../pipeline/proactive/scene/transcript.js';
export const renderTranscript: import('@qqbot/contracts').renderTranscript =
  renderTranscriptImplementation;
export const renderFacts: import('@qqbot/contracts').renderFacts = renderFactsImplementation;
export { TRANSCRIPT_MAX_CHARS } from '../pipeline/proactive/scene/transcript.js';
import { sceneTriggerName as sceneTriggerNameImplementation } from '../pipeline/proactive/scene/watcher.js';
export const sceneTriggerName: import('@qqbot/contracts').sceneTriggerName =
  sceneTriggerNameImplementation;
export {
  DEFAULT_WATCHER_CONFIG,
  NULL_WATCHER_METRICS,
} from '../pipeline/proactive/scene/watcher.js';
import {
  selectByQuantileBudget as selectByQuantileBudgetImplementation,
  evaluateVeto as evaluateVetoImplementation,
} from '../pipeline/proactive/veto/veto.js';
export const selectByQuantileBudget: import('@qqbot/contracts').selectByQuantileBudget =
  selectByQuantileBudgetImplementation;
export const evaluateVeto: import('@qqbot/contracts').evaluateVeto = evaluateVetoImplementation;
