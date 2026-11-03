/** Public module boundary. Consumers receive contract interfaces. */
import { ConversationStore } from './conversations.js';
import { PersonaStore } from './personas.js';
import { SeenStore } from './seen.js';
import { SessionStore } from './sessions.js';
import { ObservationWindow } from './window.js';
import { ObservationWindowStore } from './window.js';
export const createConversationStore: import('@qqbot/contracts').createConversationStoreFactory = (
  ...args
) => new ConversationStore(...args);
export const createPersonaStore: import('@qqbot/contracts').createPersonaStoreFactory = (...args) =>
  new PersonaStore(...args);
export const createSeenStore: import('@qqbot/contracts').createSeenStoreFactory = (...args) =>
  new SeenStore(...args);
export const createSessionStore: import('@qqbot/contracts').createSessionStoreFactory = (...args) =>
  new SessionStore(...args);
export const createObservationWindow: import('@qqbot/contracts').createObservationWindowFactory = (
  ...args
) => new ObservationWindow(...args);
export const createObservationWindowStore: import('@qqbot/contracts').createObservationWindowStoreFactory =
  (...args) => new ObservationWindowStore(...args);
import { renderReplay as renderReplayImplementation } from './conversations.js';
export const renderReplay: import('@qqbot/contracts').renderReplay = renderReplayImplementation;
import {
  conversationHash as conversationHashImplementation,
  resolveStorePaths as resolveStorePathsImplementation,
  ensureStoreDirs as ensureStoreDirsImplementation,
  workspacePathFor as workspacePathForImplementation,
  ensureWorkspace as ensureWorkspaceImplementation,
  conversationFileFor as conversationFileForImplementation,
} from './paths.js';
export const conversationHash: import('@qqbot/contracts').conversationHash =
  conversationHashImplementation;
export const resolveStorePaths: import('@qqbot/contracts').resolveStorePaths =
  resolveStorePathsImplementation;
export const ensureStoreDirs: import('@qqbot/contracts').ensureStoreDirs =
  ensureStoreDirsImplementation;
export const workspacePathFor: import('@qqbot/contracts').workspacePathFor =
  workspacePathForImplementation;
export const ensureWorkspace: import('@qqbot/contracts').ensureWorkspace =
  ensureWorkspaceImplementation;
export const conversationFileFor: import('@qqbot/contracts').conversationFileFor =
  conversationFileForImplementation;
export { PRESET_NAME_RE, MAX_PRESET_BYTES } from './personas.js';
export { SessionPersistenceError } from './sessions.js';
import {
  matchesGroupAllowlist as matchesGroupAllowlistImplementation,
  toObservationEntry as toObservationEntryImplementation,
  collectWindowMedia as collectWindowMediaImplementation,
  latestPendingRecord as latestPendingRecordImplementation,
  renderWindowBlock as renderWindowBlockImplementation,
} from './window.js';
export const matchesGroupAllowlist: import('@qqbot/contracts').matchesGroupAllowlist =
  matchesGroupAllowlistImplementation;
export const toObservationEntry: import('@qqbot/contracts').toObservationEntry =
  toObservationEntryImplementation;
export const collectWindowMedia: import('@qqbot/contracts').collectWindowMedia =
  collectWindowMediaImplementation;
export const latestPendingRecord: import('@qqbot/contracts').latestPendingRecord =
  latestPendingRecordImplementation;
export const renderWindowBlock: import('@qqbot/contracts').renderWindowBlock =
  renderWindowBlockImplementation;
export {
  DEFAULT_OBSERVATION_MAX_MESSAGES,
  DEFAULT_OBSERVATION_MAX_AGE_MS,
  DEFAULT_OBSERVATION_INJECT_IMAGES,
  DEFAULT_OBSERVATION_INJECT_FILES,
  WINDOW_BLOCK_MAX_CHARS,
} from './window.js';
import { createStateWriter as createStateWriterImplementation } from './tasks.js';
export const createStateWriter: import('@qqbot/contracts').createStateWriter =
  createStateWriterImplementation;
