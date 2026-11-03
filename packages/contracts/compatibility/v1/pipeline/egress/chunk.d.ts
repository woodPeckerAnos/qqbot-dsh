/**
 * 长回复分段。
 *
 * 官方**没有公布**单条消息的字符数上限，只在超限时返回 `40054007`。
 * 社区普遍使用 4000，但没有权威依据。因此策略是"保守默认 + 遇错折半"：
 *
 *   1. 默认按 `maxChars`（1500）切分；
 *   2. 切分点优先选自然边界：段落 → 换行 → 句末标点 → 空格 → 硬切；
 *   3. 若某段仍被平台判为超长（40054007），调用方把上限折半重试。
 *
 * 代码块处理：切分时不破坏围栏。若一段的起止落在 ``` 块内部，会给该段重新补上
 * 开启/闭合围栏，保证每段 Markdown 自身合法（否则 QQ 端渲染会错乱）。
 */
export interface SegmentOptions {
    /** 单段最大字符数 */
    maxChars: number;
    /** 最多分多少段；超出部分合并进最后一段并截断 */
    maxSegments: number;
}
export interface SegmentationResult {
    segments: string[];
    /** 是否因为段数上限而丢弃了内容 */
    truncated: boolean;
    /** 原始文本长度 */
    originalLength: number;
}
/**
 * 把一段文本切成至多 maxSegments 段，每段尽量不超过 maxChars。
 * 段数不足时返回实际段数；内容超限时最后一段截断并标记 truncated。
 */
export type segmentText = (text: string, options: SegmentOptions) => SegmentationResult;
