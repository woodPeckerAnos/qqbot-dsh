/** Public module boundary. Consumers receive contract interfaces. */

import {
  messageParts as messagePartsImplementation,
  flattenParts as flattenPartsImplementation,
  guardUntrustedText as guardUntrustedTextImplementation,
  displayFileName as displayFileNameImplementation,
  partsHaveContent as partsHaveContentImplementation,
  collectImageParts as collectImagePartsImplementation,
  collectMediaParts as collectMediaPartsImplementation,
  messageImageParts as messageImagePartsImplementation,
  messageMediaParts as messageMediaPartsImplementation,
  collectForwardRefIds as collectForwardRefIdsImplementation,
  messageForwardRefIds as messageForwardRefIdsImplementation,
} from '../core/content.js';
export const messageParts: import('@qqbot/contracts').messageParts = messagePartsImplementation;
export const flattenParts: import('@qqbot/contracts').flattenParts = flattenPartsImplementation;
export const guardUntrustedText: import('@qqbot/contracts').guardUntrustedText =
  guardUntrustedTextImplementation;
export const displayFileName: import('@qqbot/contracts').displayFileName =
  displayFileNameImplementation;
export const partsHaveContent: import('@qqbot/contracts').partsHaveContent =
  partsHaveContentImplementation;
export const collectImageParts: import('@qqbot/contracts').collectImageParts =
  collectImagePartsImplementation;
export const collectMediaParts: import('@qqbot/contracts').collectMediaParts =
  collectMediaPartsImplementation;
export const messageImageParts: import('@qqbot/contracts').messageImageParts =
  messageImagePartsImplementation;
export const messageMediaParts: import('@qqbot/contracts').messageMediaParts =
  messageMediaPartsImplementation;
export const collectForwardRefIds: import('@qqbot/contracts').collectForwardRefIds =
  collectForwardRefIdsImplementation;
export const messageForwardRefIds: import('@qqbot/contracts').messageForwardRefIds =
  messageForwardRefIdsImplementation;
export { FORWARD_UNTRUSTED_OPEN, FORWARD_UNTRUSTED_CLOSE } from '../core/content.js';
import { segmentText as segmentTextImplementation } from '../pipeline/egress/chunk.js';
export const segmentText: import('@qqbot/contracts').segmentText = segmentTextImplementation;
import {
  stripControlChars as stripControlCharsImplementation,
  normalizeWhitespace as normalizeWhitespaceImplementation,
  defuseMentions as defuseMentionsImplementation,
  toPlainText as toPlainTextImplementation,
  sanitizeMarkdown as sanitizeMarkdownImplementation,
} from '../pipeline/markdown.js';
export const stripControlChars: import('@qqbot/contracts').stripControlChars =
  stripControlCharsImplementation;
export const normalizeWhitespace: import('@qqbot/contracts').normalizeWhitespace =
  normalizeWhitespaceImplementation;
export const defuseMentions: import('@qqbot/contracts').defuseMentions =
  defuseMentionsImplementation;
export const toPlainText: import('@qqbot/contracts').toPlainText = toPlainTextImplementation;
export const sanitizeMarkdown: import('@qqbot/contracts').sanitizeMarkdown =
  sanitizeMarkdownImplementation;
