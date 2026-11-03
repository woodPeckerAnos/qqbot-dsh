/** Historical runtime-event routing seam used only by legacy regression fixtures. */
/** Historical runtime-event routing seam used only by legacy regression fixtures. */
import {
  Orchestrator as IngressOrchestrator,
  type OrchestratorDeps,
} from '../../../src/pipeline/orchestrator.js';
import type {
  SessionEventNotification,
  SessionStatusNotification,
} from '../../../src/dsh/protocol.js';
interface LegacyDeps extends OrchestratorDeps {
  turns: {
    routeSessionEvent(key: string, notification: SessionEventNotification): void;
    routeSessionStatus(key: string, notification: SessionStatusNotification): void;
  };
}
export class Orchestrator extends IngressOrchestrator {
  constructor(override readonly deps: LegacyDeps) {
    super(deps);
  }
  routeSessionEvent(key: string, notification: SessionEventNotification): void {
    this.deps.turns.routeSessionEvent(key, notification);
  }
  routeSessionStatus(key: string, notification: SessionStatusNotification): void {
    this.deps.turns.routeSessionStatus(key, notification);
  }
}
