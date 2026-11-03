import {
  onebotGroupTarget as onebotGroupTargetImplementation,
  onebotC2cTarget as onebotC2cTargetImplementation,
  parseCqCodes as parseCqCodesImplementation,
  extractMessageContent as extractMessageContentImplementation,
  quotedContentFromGetMsg as quotedContentFromGetMsgImplementation,
  quotedAuthorFromGetMsg as quotedAuthorFromGetMsgImplementation,
  parseForwardNodes as parseForwardNodesImplementation,
  normalizeOneBotEvent as normalizeOneBotEventImplementation,
} from '../adapters/onebot/normalize.js';
/** Public module boundary. Consumers receive contract interfaces. */
import { OnebotConnector } from '../adapters/onebot/connector.js';
import { QqApi } from '../adapters/qq-official/api.js';
import { QqOfficialConnector } from '../adapters/qq-official/connector.js';
import { QqGateway } from '../adapters/qq-official/gateway.js';
import { TokenManager } from '../adapters/qq-official/token.js';
export const createOnebotConnector: import('@qqbot/contracts').createOnebotConnectorFactory = (
  ...args
) => new OnebotConnector(...args);
export const createQqApi: import('@qqbot/contracts').createQqApiFactory = (...args) =>
  new QqApi(...args);
export const createQqOfficialConnector: import('@qqbot/contracts').createQqOfficialConnectorFactory =
  (...args) => new QqOfficialConnector(...args);
export const createQqGateway: import('@qqbot/contracts').createQqGatewayFactory = (...args) =>
  new QqGateway(...args);
export const createTokenManager: import('@qqbot/contracts').createTokenManagerFactory = (...args) =>
  new TokenManager(...args);
export const onebotGroupTarget: import('@qqbot/contracts').onebotGroupTarget =
  onebotGroupTargetImplementation;
export const onebotC2cTarget: import('@qqbot/contracts').onebotC2cTarget =
  onebotC2cTargetImplementation;
export const parseCqCodes: import('@qqbot/contracts').parseCqCodes = parseCqCodesImplementation;
export const extractMessageContent: import('@qqbot/contracts').extractMessageContent =
  extractMessageContentImplementation;
export const quotedContentFromGetMsg: import('@qqbot/contracts').quotedContentFromGetMsg =
  quotedContentFromGetMsgImplementation;
export const quotedAuthorFromGetMsg: import('@qqbot/contracts').quotedAuthorFromGetMsg =
  quotedAuthorFromGetMsgImplementation;
export const parseForwardNodes: import('@qqbot/contracts').parseForwardNodes =
  parseForwardNodesImplementation;
export const normalizeOneBotEvent: import('@qqbot/contracts').normalizeOneBotEvent =
  normalizeOneBotEventImplementation;
export { ONEBOT_PLATFORM } from '../adapters/onebot/normalize.js';
export { QqApiError_ } from '../adapters/qq-official/api.js';
import {
  sceneExtValue as sceneExtValueImplementation,
  imageMimeTypeOf as imageMimeTypeOfImplementation,
  partsFromAttachments as partsFromAttachmentsImplementation,
  partFromArk as partFromArkImplementation,
  partsFromElements as partsFromElementsImplementation,
  quotedPartOf as quotedPartOfImplementation,
  forwardPartFromElements as forwardPartFromElementsImplementation,
  buildMessageParts as buildMessagePartsImplementation,
} from '../adapters/qq-official/content.js';
export const sceneExtValue: import('@qqbot/contracts').sceneExtValue = sceneExtValueImplementation;
export const imageMimeTypeOf: import('@qqbot/contracts').imageMimeTypeOf =
  imageMimeTypeOfImplementation;
export const partsFromAttachments: import('@qqbot/contracts').partsFromAttachments =
  partsFromAttachmentsImplementation;
export const partFromArk: import('@qqbot/contracts').partFromArk = partFromArkImplementation;
export const partsFromElements: import('@qqbot/contracts').partsFromElements =
  partsFromElementsImplementation;
export const quotedPartOf: import('@qqbot/contracts').quotedPartOf = quotedPartOfImplementation;
export const forwardPartFromElements: import('@qqbot/contracts').forwardPartFromElements =
  forwardPartFromElementsImplementation;
export const buildMessageParts: import('@qqbot/contracts').buildMessageParts =
  buildMessagePartsImplementation;
import {
  groupTarget as groupTargetImplementation,
  c2cTarget as c2cTargetImplementation,
  parseTimestamp as parseTimestampImplementation,
} from '../adapters/qq-official/gateway.js';
export const groupTarget: import('@qqbot/contracts').groupTarget = groupTargetImplementation;
export const c2cTarget: import('@qqbot/contracts').c2cTarget = c2cTargetImplementation;
export const parseTimestamp: import('@qqbot/contracts').parseTimestamp =
  parseTimestampImplementation;
export { QQ_OFFICIAL_PLATFORM, C2C_KEY_PREFIX } from '../adapters/qq-official/gateway.js';
import {
  renderMessage as renderMessageImplementation,
  messageTextLength as messageTextLengthImplementation,
  renderMediaMessage as renderMediaMessageImplementation,
} from '../adapters/qq-official/render.js';
export const renderMessage: import('@qqbot/contracts').renderMessage = renderMessageImplementation;
export const messageTextLength: import('@qqbot/contracts').messageTextLength =
  messageTextLengthImplementation;
export const renderMediaMessage: import('@qqbot/contracts').renderMediaMessage =
  renderMediaMessageImplementation;
import { describeTokenError as describeTokenErrorImplementation } from '../adapters/qq-official/token.js';
export const describeTokenError: import('@qqbot/contracts').describeTokenError =
  describeTokenErrorImplementation;
export { TokenError } from '../adapters/qq-official/token.js';
import {
  canResumeAfterClose as canResumeAfterCloseImplementation,
  describeIntents as describeIntentsImplementation,
} from '../adapters/qq-official/types.js';
export const canResumeAfterClose: import('@qqbot/contracts').canResumeAfterClose =
  canResumeAfterCloseImplementation;
export const describeIntents: import('@qqbot/contracts').describeIntents =
  describeIntentsImplementation;
export {
  OpCode,
  WS_CLOSE_CODES,
  Intent,
  DEFAULT_INTENTS,
  MessageType,
  MsgType,
  MediaFileType,
  SendErrorCode,
} from '../adapters/qq-official/types.js';
export { isUserMessage, isObservedMessage, isAddressedMessage } from '../core/connector.js';
