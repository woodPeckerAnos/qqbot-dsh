import { createView, renderView } from './context.js';
import { classifyFollowUp, classifyFollowUpV3 } from './follow-up.js';
import { createViewV3, renderViewV3 } from './context-v3.js';
export const createSessionContextView: import('@qqbot/contracts').createSessionContextViewFactory =
  createView;
export const renderSessionContextView: import('@qqbot/contracts').renderSessionContextView =
  renderView;
export const classifyTaskFollowUp: import('@qqbot/contracts').classifyTaskFollowUp =
  classifyFollowUp;
export const createSessionContextViewV3: import('@qqbot/contracts').createSessionContextViewFactoryV3 =
  createViewV3;
export const renderSessionContextViewV3: import('@qqbot/contracts').renderSessionContextViewV3 =
  renderViewV3;
export const classifyTaskFollowUpV3: import('@qqbot/contracts').classifyTaskFollowUpV3 =
  classifyFollowUpV3;
