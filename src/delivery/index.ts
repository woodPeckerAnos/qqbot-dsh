/** Public module boundary. Consumers receive contract interfaces. */
import { Responder } from '../pipeline/egress/responder.js';
import { MessageQueue } from '../task/message-queue.js';
import { SessionOutputCoordinator } from '../task/output-coordinator.js';
import { SessionOutputCoordinatorV3 } from '../task/output-coordinator-v3.js';
export const createResponder: import('@qqbot/contracts').createResponderFactory = (...args) =>
  new Responder(...args);
export const createMessageQueue: import('@qqbot/contracts').createMessageQueueFactory = (...args) =>
  new MessageQueue(...args);
export const createSessionOutputCoordinatorV2: import('@qqbot/contracts').createSessionOutputCoordinatorFactoryV2 =
  (...args) => new SessionOutputCoordinator(...args);
export const createSessionOutputCoordinatorV3: import('@qqbot/contracts').createSessionOutputCoordinatorFactoryV3 =
  (...args) => new SessionOutputCoordinatorV3(...args);
