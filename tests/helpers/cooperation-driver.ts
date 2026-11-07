import { installLaneCooperation } from '../../dsh-profile/plugins/task-control.js';
import type { ExecutionBinding, ExecutionHandlers, TaskCooperationUpdate } from '@qqbot/contracts';

export interface MockCooperationMessage {
  id: string;
  content: { text: string }[];
  source?: { kind: string };
}
export interface MockCooperationAgent {
  session: { id: string };
  inject(message: MockCooperationMessage): void;
}
export interface PluginHooks {
  'agent/created': (payload: { agent: MockCooperationAgent }) => void;
  'session/event': (
    session: { id: string },
    event: { type: string; data: MockCooperationMessage }
  ) => void;
  'agent/turn-stopping': (payload: {
    agent: MockCooperationAgent;
    signal: AbortSignal;
    turn: number;
  }) => Promise<void>;
}

/** Drives the real plugin with an offline root agent and committed next-step messages. */
export class CooperationDriver {
  readonly controller = new AbortController();
  readonly inbox: { id: string; content: { text: string }[] }[] = [];
  readonly consumed: string[] = [];
  readonly responses: string[] = [];
  private readonly hooks: Partial<PluginHooks> = {};
  private readonly plugin;
  private readonly agent;
  constructor(binding: ExecutionBinding, handlers: ExecutionHandlers) {
    const sessionId = binding.sessionId;
    this.agent = {
      session: { id: sessionId },
      inject: (message: { id: string; content: { text: string }[] }) => this.inbox.push(message),
    };
    this.plugin = installLaneCooperation(
      {
        on: <K extends keyof PluginHooks>(event: K, hook: PluginHooks[K]) => {
          this.hooks[event] = hook;
        },
      },
      async (
        action: 'cooperation-read' | 'cooperation-wait',
        _taskId: string,
        exec: { signal?: AbortSignal }
      ) => handlers.cooperation!({ ...binding, action }, exec.signal ?? this.controller.signal),
      binding
    );
    this.hooks['agent/created']!({ agent: this.agent });
  }
  receive(update: TaskCooperationUpdate): void {
    this.plugin.receive(update);
  }
  begin(messageId: string): void {
    this.hooks['session/event']!(this.agent.session, {
      type: 'user/message',
      data: { id: messageId, source: { kind: 'user' }, content: [] },
    });
  }
  /** Each committed injection is consumed at the next step, inside the same turn. */
  async stop(text: string): Promise<string> {
    for (;;) {
      await this.hooks['agent/turn-stopping']!({
        agent: this.agent,
        turn: 1,
        signal: this.controller.signal,
      });
      if (!this.inbox.length) return text;
      for (const message of this.inbox.splice(0)) {
        this.consumed.push(message.content[0]!.text);
        this.hooks['session/event']!(this.agent.session, { type: 'user/message', data: message });
      }
      text = this.responses.shift() ?? text;
    }
  }
  close(): void {
    this.controller.abort();
    this.plugin.close();
    this.inbox.length = 0;
  }
}
