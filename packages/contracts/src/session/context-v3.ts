import type { DeepReadonly } from '../readonly.js';
import type { AttachmentReference, TaskPhaseV3, TaskSnapshotV3 } from '../task/types-v3.js';
import type {
  ContextDeliveryStatus,
  SessionContextViewValue,
  createSessionContextViewFactory,
  classifyTaskFollowUp,
} from './context.js';
export interface ContextTaskV3 {
  taskId: string;
  source: 'user' | 'proactive';
  senderId: string;
  status: TaskSnapshotV3['status'];
  phase: TaskPhaseV3;
  explicit: boolean;
  createdAt: number;
  endedAt?: number;
  question: string;
  questionOmittedChars: number;
  worker?: {
    status: string;
    resultKind?: string;
    text: string;
    originalChars: number;
    omittedChars: number;
    attachments: AttachmentReference[];
  };
  frontend: {
    phase: TaskPhaseV3;
    attempts: number;
    text: string;
    originalChars: number;
    omittedChars: number;
    delivery: ContextDeliveryStatus;
  };
}
export interface SessionContextViewValueV3 extends Omit<SessionContextViewValue, 'tasks'> {
  tasks: ContextTaskV3[];
}
export type SessionContextViewV3 = DeepReadonly<SessionContextViewValueV3>;
export type createSessionContextViewFactoryV3 = (
  options: Omit<Parameters<createSessionContextViewFactory>[0], 'tasks'> & {
    tasks: (sessionKey: string) => DeepReadonly<TaskSnapshotV3[]>;
  }
) => { read(task: DeepReadonly<TaskSnapshotV3>): SessionContextViewV3 };
export type renderSessionContextViewV3 = (view: SessionContextViewV3) => string;
export type classifyTaskFollowUpV3 = (
  options: Omit<Parameters<classifyTaskFollowUp>[0], 'tasks'> & {
    tasks: DeepReadonly<TaskSnapshotV3[]>;
  }
) => Readonly<{ followUpOf?: string; progressOnly?: boolean }>;
