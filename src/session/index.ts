import { createView, renderView } from './context.js';
import { classifyFollowUp } from './follow-up.js';
export const createSessionContextView: import('@qqbot/contracts').createSessionContextViewFactory =
  createView;
export const renderSessionContextView: import('@qqbot/contracts').renderSessionContextView =
  renderView;
export const classifyTaskFollowUp: import('@qqbot/contracts').classifyTaskFollowUp =
  classifyFollowUp;
