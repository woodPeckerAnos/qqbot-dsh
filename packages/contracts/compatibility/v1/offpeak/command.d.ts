/**
 * /offpeak 管理员命令：解析与文案。
 *
 * 这里只负责把消息文本解析成结构化的 OffpeakCommand 以及渲染用户可见的
 * 提示文案；命令的执行（权限检查、调用 OffpeakGate、回执）在 ingress 的
 * offpeak-command stage 里。
 */
/**
 * /offpeak 管理员命令：解析与文案。
 *
 * 这里只负责把消息文本解析成结构化的 OffpeakCommand 以及渲染用户可见的
 * 提示文案；命令的执行（权限检查、调用 OffpeakGate、回执）在 ingress 的
 * offpeak-command stage 里。
 */
import type { OffpeakGateConfig } from './gate.js';
export type OffpeakCommand = {
    action: 'status';
} | {
    action: 'whoami';
} | {
    action: 'set-enabled';
    enabled: boolean;
} | {
    action: 'set-windows';
    spec: string;
} | {
    action: 'holiday-add';
    date: string;
} | {
    action: 'holiday-del';
    date: string;
} | {
    action: 'holiday-list';
} | {
    action: 'reset';
} | {
    action: 'invalid';
    detail: string;
};
export declare const OFFPEAK_COMMAND_USAGE = "\u7528\u6CD5\uFF1A/offpeak status | whoami | on | off | window 00:00-09:00,12:00-14:00,18:00-24:00 | holiday list | holiday add 2027-01-01 | holiday del 2027-01-01 | reset\uFF08\u4EC5\u7BA1\u7406\u5458\u53EF\u53D8\u66F4\uFF09";
/**
 * 解析 /offpeak 命令。返回 undefined 表示这不是命令（按普通消息处理）。
 *
 * 群聊 @机器人 时 content 可能带 `<@!...>` mention 前缀，先剥掉再匹配。
 */
export type parseOffpeakCommand = (content: string) => OffpeakCommand | undefined;
/** 需要管理员权限的子命令。status / whoami 对所有人开放（不消耗 API）。 */
export type commandNeedsAdmin = (command: OffpeakCommand) => boolean;
/** 拦截时给用户的提示文案（窗口从生效配置渲染，不写死）。 */
export type renderGateNotice = (config: OffpeakGateConfig) => string;
