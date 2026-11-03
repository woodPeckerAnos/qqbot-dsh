import type { modules } from './metadata.js';
export type ContractModuleId = (typeof modules)[number]['id'];
export interface ContractExample {
    readonly id: string;
    readonly module: ContractModuleId;
    readonly kind: 'normal' | 'edge' | 'failure';
    readonly input: Readonly<Record<string, unknown>>;
    readonly expected: Readonly<Record<string, unknown>>;
}
/** 数据夹具由消费者测试和独立离线冒烟共用；此包不包含生产实现。 */
export declare const contractExamples: readonly [{
    readonly id: "config.normal";
    readonly module: "config";
    readonly kind: "normal";
    readonly input: {
        readonly text: "onebot:\n  port: 6700\n";
    };
    readonly expected: {
        readonly value: {
            readonly onebot: {
                readonly port: 6700;
            };
        };
    };
}, {
    readonly id: "config.edge";
    readonly module: "config";
    readonly kind: "edge";
    readonly input: {
        readonly text: "";
    };
    readonly expected: {
        readonly value: {};
    };
}, {
    readonly id: "config.failure";
    readonly module: "config";
    readonly kind: "failure";
    readonly input: {
        readonly text: "unknown_section: true\n";
    };
    readonly expected: {
        readonly rejected: true;
        readonly error: "ConfigError";
    };
}, {
    readonly id: "content.normal";
    readonly module: "content";
    readonly kind: "normal";
    readonly input: {
        readonly text: "甲乙丙丁。戊己庚辛。";
        readonly maxChars: 5;
        readonly maxSegments: 2;
    };
    readonly expected: {
        readonly segments: readonly ["甲乙丙丁。", "戊己庚辛。"];
        readonly truncated: false;
        readonly originalLength: 10;
    };
}, {
    readonly id: "content.edge";
    readonly module: "content";
    readonly kind: "edge";
    readonly input: {
        readonly text: "  ";
        readonly maxChars: 40;
        readonly maxSegments: 2;
    };
    readonly expected: {
        readonly segments: readonly [];
        readonly truncated: false;
        readonly originalLength: 0;
    };
}, {
    readonly id: "content.failure";
    readonly module: "content";
    readonly kind: "failure";
    readonly input: {
        readonly text: "无法交付的正文";
        readonly maxChars: 40;
        readonly maxSegments: 0;
    };
    readonly expected: {
        readonly segments: readonly [];
        readonly truncated: true;
        readonly originalLength: 7;
    };
}, {
    readonly id: "connectors.normal";
    readonly module: "connectors";
    readonly kind: "normal";
    readonly input: {
        readonly token: "fixture-token";
        readonly expiresIn: "7200";
        readonly concurrent: false;
    };
    readonly expected: {
        readonly tokens: readonly ["fixture-token", "fixture-token"];
        readonly fetchCalls: 1;
        readonly hasToken: true;
        readonly expiresInMs: 7200000;
    };
}, {
    readonly id: "connectors.edge";
    readonly module: "connectors";
    readonly kind: "edge";
    readonly input: {
        readonly token: "concurrent-token";
        readonly expiresIn: "120";
        readonly concurrent: true;
    };
    readonly expected: {
        readonly tokens: readonly ["concurrent-token", "concurrent-token"];
        readonly fetchCalls: 1;
        readonly hasToken: true;
        readonly expiresInMs: 120000;
    };
}, {
    readonly id: "connectors.failure";
    readonly module: "connectors";
    readonly kind: "failure";
    readonly input: {
        readonly code: 100016;
        readonly message: "invalid app credentials";
    };
    readonly expected: {
        readonly rejected: true;
        readonly code: 100016;
        readonly fetchCalls: 1;
        readonly hasToken: false;
    };
}, {
    readonly id: "store.normal";
    readonly module: "store";
    readonly kind: "normal";
    readonly input: {
        readonly allowlist: readonly ["ob11:g1"];
        readonly messages: readonly [{
            readonly id: "m1";
            readonly text: "第一条";
            readonly ts: 100;
        }, {
            readonly id: "m2";
            readonly text: "第二条";
            readonly ts: 110;
        }];
        readonly maxAgeMs: 20;
    };
    readonly expected: {
        readonly accepted: readonly [true, true];
        readonly texts: readonly ["第一条", "第二条"];
        readonly buffered: 2;
    };
}, {
    readonly id: "store.edge";
    readonly module: "store";
    readonly kind: "edge";
    readonly input: {
        readonly allowlist: readonly [];
        readonly messages: readonly [{
            readonly id: "m1";
            readonly text: "白名单外";
            readonly ts: 100;
        }];
        readonly maxAgeMs: 20;
    };
    readonly expected: {
        readonly accepted: readonly [false];
        readonly texts: readonly [];
        readonly buffered: 0;
    };
}, {
    readonly id: "store.failure";
    readonly module: "store";
    readonly kind: "failure";
    readonly input: {
        readonly sessionKey: "ob11:g1";
        readonly failWrite: true;
    };
    readonly expected: {
        readonly rejected: true;
        readonly error: "PERSISTENCE_FAILED";
        readonly sessions: 0;
    };
}, {
    readonly id: "media.normal";
    readonly module: "media";
    readonly kind: "normal";
    readonly input: {
        readonly fileName: "note.txt";
        readonly bytes: readonly [104, 101, 108, 108, 111, 13, 10];
        readonly maxChars: 40;
    };
    readonly expected: {
        readonly extraction: {
            readonly text: "hello";
        };
        readonly spawnCalls: 0;
    };
}, {
    readonly id: "media.edge";
    readonly module: "media";
    readonly kind: "edge";
    readonly input: {
        readonly fileName: "empty.txt";
        readonly bytes: readonly [];
        readonly maxChars: 40;
    };
    readonly expected: {
        readonly extraction: {
            readonly reason: "文件内容为空";
        };
        readonly spawnCalls: 0;
    };
}, {
    readonly id: "media.failure";
    readonly module: "media";
    readonly kind: "failure";
    readonly input: {
        readonly fileName: "binary.txt";
        readonly bytes: readonly [0, 1, 2];
        readonly maxChars: 40;
    };
    readonly expected: {
        readonly extraction: {
            readonly reason: "该文件是二进制内容，未按文本读取";
        };
        readonly spawnCalls: 0;
    };
}, {
    readonly id: "runtime.normal";
    readonly module: "runtime";
    readonly kind: "normal";
    readonly input: {
        readonly sessionId: "fixture-session";
        readonly text: "最终答案";
        readonly reason: "completed";
        readonly idle: true;
    };
    readonly expected: {
        readonly initialized: true;
        readonly promptReceipt: "fixture-message";
        readonly settled: true;
        readonly result: {
            readonly kind: "completed";
            readonly text: "最终答案";
            readonly reason: "completed";
        };
        readonly pendingAfterClose: 0;
    };
}, {
    readonly id: "runtime.edge";
    readonly module: "runtime";
    readonly kind: "edge";
    readonly input: {
        readonly sessionId: "fixture-session";
        readonly text: "等待idle";
        readonly reason: "completed";
        readonly idle: false;
    };
    readonly expected: {
        readonly settled: false;
        readonly sawTurnEnd: true;
        readonly text: "等待idle";
    };
}, {
    readonly id: "runtime.failure";
    readonly module: "runtime";
    readonly kind: "failure";
    readonly input: {
        readonly frame: "not-json\n";
    };
    readonly expected: {
        readonly violations: 1;
        readonly error: "ProtocolViolationError";
        readonly pendingAfterClose: 0;
    };
}, {
    readonly id: "task.normal";
    readonly module: "task";
    readonly kind: "normal";
    readonly input: {
        readonly taskId: "fixture-task";
        readonly now: 100;
        readonly finishBoth: true;
    };
    readonly expected: {
        readonly status: "completed";
        readonly fast: "completed";
        readonly slow: "completed";
        readonly done: true;
    };
}, {
    readonly id: "task.edge";
    readonly module: "task";
    readonly kind: "edge";
    readonly input: {
        readonly taskId: "fixture-task";
        readonly now: 100;
        readonly finishBoth: false;
    };
    readonly expected: {
        readonly status: "running";
        readonly fast: "completed";
        readonly slow: "queued";
        readonly done: false;
    };
}, {
    readonly id: "task.failure";
    readonly module: "task";
    readonly kind: "failure";
    readonly input: {
        readonly taskId: "fixture-task";
        readonly now: 100;
        readonly failWrite: true;
    };
    readonly expected: {
        readonly rejected: true;
        readonly tasks: 0;
        readonly notifications: 0;
    };
}, {
    readonly id: "delivery.normal";
    readonly module: "delivery";
    readonly kind: "normal";
    readonly input: {
        readonly text: "交付结果";
        readonly duplicate: false;
        readonly failSend: false;
    };
    readonly expected: {
        readonly sent: 1;
        readonly failed: 0;
        readonly attempts: 1;
        readonly referenceMessageId: "original-message";
    };
}, {
    readonly id: "delivery.edge";
    readonly module: "delivery";
    readonly kind: "edge";
    readonly input: {
        readonly text: "同一产物";
        readonly duplicate: true;
        readonly failSend: false;
    };
    readonly expected: {
        readonly sent: 1;
        readonly failed: 0;
        readonly attempts: 1;
        readonly referenceMessageId: "original-message";
    };
}, {
    readonly id: "delivery.failure";
    readonly module: "delivery";
    readonly kind: "failure";
    readonly input: {
        readonly text: "发送失败";
        readonly duplicate: false;
        readonly failSend: true;
    };
    readonly expected: {
        readonly sent: 0;
        readonly failed: 2;
        readonly attempts: 2;
        readonly failureNotifications: 1;
        readonly sourceAttempts: 1;
    };
}, {
    readonly id: "ingress.normal";
    readonly module: "ingress";
    readonly kind: "normal";
    readonly input: {
        readonly stages: readonly ["dedupe", "command", "record"];
        readonly shortcut: "";
        readonly failAt: "";
    };
    readonly expected: {
        readonly visited: readonly ["dedupe", "command", "record", "actor"];
        readonly rejected: false;
    };
}, {
    readonly id: "ingress.edge";
    readonly module: "ingress";
    readonly kind: "edge";
    readonly input: {
        readonly stages: readonly ["dedupe", "command", "record"];
        readonly shortcut: "command";
        readonly failAt: "";
    };
    readonly expected: {
        readonly visited: readonly ["dedupe", "command"];
        readonly rejected: false;
    };
}, {
    readonly id: "ingress.failure";
    readonly module: "ingress";
    readonly kind: "failure";
    readonly input: {
        readonly stages: readonly ["dedupe", "command", "record"];
        readonly shortcut: "";
        readonly failAt: "dedupe";
    };
    readonly expected: {
        readonly visited: readonly ["dedupe"];
        readonly rejected: true;
    };
}, {
    readonly id: "proactive.normal";
    readonly module: "proactive";
    readonly kind: "normal";
    readonly input: {
        readonly now: 100;
        readonly budget: 2;
        readonly question: "这个接口怎么调用？";
    };
    readonly expected: {
        readonly scopeId: "ob11:g1:topic-2";
        readonly budgetLeft: 1;
        readonly committed: 1;
        readonly pendingQuestions: 1;
        readonly windowWrites: 1;
    };
}, {
    readonly id: "proactive.edge";
    readonly module: "proactive";
    readonly kind: "edge";
    readonly input: {
        readonly now: 100;
        readonly budget: 0;
        readonly question: "";
    };
    readonly expected: {
        readonly scopeId: "ob11:g1:topic-2";
        readonly budgetLeft: 0;
        readonly committed: 0;
        readonly pendingQuestions: 0;
        readonly windowWrites: 0;
    };
}, {
    readonly id: "proactive.failure";
    readonly module: "proactive";
    readonly kind: "failure";
    readonly input: {
        readonly now: 100;
        readonly budget: 2;
    };
    readonly expected: {
        readonly snapshotWriteRejected: true;
        readonly closed: 1;
        readonly firstClose: true;
        readonly secondClose: false;
        readonly afterUnsubscribe: 1;
    };
}, {
    readonly id: "offpeak.normal";
    readonly module: "offpeak";
    readonly kind: "normal";
    readonly input: {
        readonly windows: "00:00-09:00";
        readonly now: 1793665800000;
        readonly isAdmin: false;
    };
    readonly expected: {
        readonly gated: false;
        readonly reason: "in-window";
    };
}, {
    readonly id: "offpeak.edge";
    readonly module: "offpeak";
    readonly kind: "edge";
    readonly input: {
        readonly windows: "00:00-09:00";
        readonly now: 1793707200000;
        readonly isAdmin: true;
    };
    readonly expected: {
        readonly gated: false;
        readonly reason: "admin";
    };
}, {
    readonly id: "offpeak.failure";
    readonly module: "offpeak";
    readonly kind: "failure";
    readonly input: {
        readonly windows: "00:00-09:00,08:00-10:00";
    };
    readonly expected: {
        readonly rejected: true;
        readonly error: "OffpeakConfigError";
    };
}, {
    readonly id: "observability.normal";
    readonly module: "observability";
    readonly kind: "normal";
    readonly input: {
        readonly amount: 2;
        readonly distributionAmount: 1;
    };
    readonly expected: {
        readonly received: 2;
        readonly closedByIdle: 1;
        readonly snapshotWriteRejected: true;
    };
}, {
    readonly id: "observability.edge";
    readonly module: "observability";
    readonly kind: "edge";
    readonly input: {
        readonly amount: 0;
        readonly distributionAmount: 0;
    };
    readonly expected: {
        readonly received: 0;
        readonly closedByIdle: 0;
        readonly snapshotWriteRejected: true;
    };
}, {
    readonly id: "observability.failure";
    readonly module: "observability";
    readonly kind: "failure";
    readonly input: {
        readonly amount: -1;
    };
    readonly expected: {
        readonly rejected: true;
        readonly error: "RangeError";
        readonly received: 0;
    };
}];
