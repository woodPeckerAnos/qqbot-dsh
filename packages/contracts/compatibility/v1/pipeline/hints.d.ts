/** Deprecated configuration compatibility. Production lane prompts do not use keyword hints. */
export interface LongTaskHintConfig {
    enabled: boolean;
    /** 命中子串（大小写不敏感）；空串条目在配置层已被滤掉 */
    patterns: string[];
    /** 注入的提示文本 */
    text: string;
}
/** 默认命中词：覆盖实测中"模型自判不长、实际卡死会话"的典型任务类。 */
export declare const DEFAULT_LONG_TASK_PATTERNS: string[];
export declare const DEFAULT_LONG_TASK_HINT_TEXT: string;
/** 本条消息是否命中长任务提示（大小写不敏感的子串匹配）。 */
export type matchLongTaskHint = (content: string, patterns: readonly string[]) => boolean;
