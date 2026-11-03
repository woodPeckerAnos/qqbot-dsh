import type { LogLevel } from '../logger.js';
export declare const LOG_CATEGORIES: readonly ["input", "proactive", "task", "agent", "runtime", "delivery", "system", "legacy"];
export type LogCategory = (typeof LOG_CATEGORIES)[number];
/** 文案和字段由目录拥有；不得传正文、工具参数/结果或任意错误消息。 */
export declare const EVENTS: {
    readonly 'input.received': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["source", "contentLength", "attachmentCount"];
        diagnostic: boolean;
    };
    readonly 'input.decision': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["related", "mentionsChatRecord"];
        diagnostic: boolean;
    };
    readonly 'input.shortcut': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["reason", "stage"];
        diagnostic: boolean;
    };
    readonly 'input.rejected': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["reason", "errorId"];
        diagnostic: boolean;
    };
    readonly 'proactive.evaluation': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["trigger", "candidateCount"];
        diagnostic: boolean;
    };
    readonly 'proactive.decision': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["action", "reason", "scene", "trigger"];
        diagnostic: boolean;
    };
    readonly 'proactive.wait': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["action", "targetId"];
        diagnostic: boolean;
    };
    readonly 'task.created': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["source", "generation"];
        diagnostic: boolean;
    };
    readonly 'task.lane': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["status", "resultKind", "errorId", "errorClass"];
        diagnostic: boolean;
    };
    readonly 'task.terminal': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["status", "durationMs"];
        diagnostic: boolean;
    };
    readonly 'task.cancel': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["initiatorTraceId", "initiatorSpanId", "initiatorTaskId"];
        diagnostic: boolean;
    };
    readonly 'execution.started': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly [];
        diagnostic: boolean;
    };
    readonly 'execution.ended': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["resultKind", "durationMs", "errorId", "errorClass"];
        diagnostic: boolean;
    };
    readonly 'artifact.prepared': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["resultKind", "contentLength", "attachmentCount", "durationMs", "errorId"];
        diagnostic: boolean;
    };
    readonly 'agent.detail': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["dshSeq", "eventType", "turn", "step", "toolClass", "durationMs", "inputTokens", "outputTokens"];
        diagnostic: boolean;
    };
    readonly 'agent.started': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["parentDshSessionId"];
        diagnostic: boolean;
    };
    readonly 'agent.ended': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["parentDshSessionId", "status", "dshSeq"];
        diagnostic: boolean;
    };
    readonly 'agent.summary': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["dshSeq", "turns", "steps", "tools", "retries", "subagents", "usage", "toolCounts", "errors", "suppressed", "invalid", "unknown", "late", "duplicate", "overflow", "incomplete"];
        diagnostic: boolean;
    };
    readonly 'delivery.enqueued': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["kind", "contentLength", "attachmentCount", "notification", "sourceMessageId"];
        diagnostic: boolean;
    };
    readonly 'delivery.attempt': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["anchorMessageId", "seq"];
        diagnostic: boolean;
    };
    readonly 'delivery.terminal': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["status", "durationMs", "errorId", "errorClass", "recovered"];
        diagnostic: boolean;
    };
    readonly 'delivery.notice': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["sourceMessageId", "errorId"];
        diagnostic: boolean;
    };
    readonly 'runtime.started': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["pid"];
        diagnostic: boolean;
    };
    readonly 'runtime.ready': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["pid", "version"];
        diagnostic: boolean;
    };
    readonly 'runtime.stderr': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["bytes", "lines"];
        diagnostic: boolean;
    };
    readonly 'runtime.notification': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["reason"];
        diagnostic: boolean;
    };
    readonly 'root.error': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["errorId", "errorClass", "code", "signal", "bytes"];
        diagnostic: boolean;
    };
    readonly 'logging.suppressed': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["counts", "executionId"];
        diagnostic: boolean;
    };
    readonly 'logging.configured': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["diagnosticTargets", "expiresAt"];
        diagnostic: boolean;
    };
    readonly 'logging.reload_failed': {
        level: LogLevel;
        component: "input" | "proactive" | "task" | "agent" | "runtime" | "delivery" | "system" | "legacy";
        msg: string;
        fields: readonly ["errorClass"];
        diagnostic: boolean;
    };
};
export type EventName = keyof typeof EVENTS;
export type EventFields = Record<string, unknown>;
export type EventFieldsFor<Name extends EventName> = Partial<Record<(typeof EVENTS)[Name]['fields'][number], unknown>>;
