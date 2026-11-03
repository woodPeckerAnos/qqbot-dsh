/**
 * 兴趣池（场景 5 的配置面）：读取、校验、匹配。
 *
 * ## 未来会被 role-play 接管（维护者已预告，别把这个形态当成永久形态）
 *
 * 后续迭代会加入 **role-play（角色扮演）** 环节，由它**动态设定**兴趣池。
 * 因此本模块刻意只承担**三件与上游无关的事**：
 *   1. 校验条目的形状（`InterestEntry`）；
 *   2. 本地关键词匹配（`match()`）；
 *   3. 把条目喂给判定 prompt（`list()`）。
 *
 * **上游是谁不重要**：文件、role-play 会话、两者合并、甚至"role-play 决定
 * 主题 + 人审关键词"，都只需要换一个"产出 `InterestEntry[]`"的来源，
 * 三层判定（`scene/` `judge/` `veto/`）与投递层一行都不用改。
 *
 * 给后续 agent 的三条约定：
 *   - **不要把"兴趣来自 interests.yml"写进判定层或投递层的假设里**；
 *   - 需要更新时用 `replaceEntries()`（保持对象身份，调用方持有的引用继续有效），
 *     不要重建一个同名类或另起一套池；
 *   - role-play 产出的条目**仍然必须过本文件的校验**（id 唯一、关键词 ≥2 字、
 *     条数上限）——"动态"不等于"免检"。
 *
 * ## 为什么是"关键词表"而不是"让 LLM 自己想兴趣"
 *
 * 兴趣池是**人审过的清单**：整份内容会进 prompt，命中才进判定。
 * 关键词匹配放在本地、零成本、可预测、可审计；LLM 只负责"命中之后，
 * 这个话题现在值不值得开口"（场景 5 的成立门槛）。
 *
 * ## 三个纪律
 *
 * 1. **文件缺失 = 空池，是合法状态**（场景 5 不触发即可），不报错；
 *    文件存在但**格式错**则启动期报错（fail-closed，别让 bot 悄悄少一个场景）。
 * 2. **匹配是字符串包含**，不是正则、不是模糊匹配——关键词来自配置，
 *    用正则等于把注入面开给配置文件；包含匹配的可预测性远高于它带来的灵活性损失。
 * 3. **预算不在这里**（"还能主动说几句"属于话题 session 的发言预算，
 *    由 `scene/watcher.ts` 与 `veto/veto.ts` 持有，见 docs/TOPIC-SESSION-REQUIREMENT.md）；
 *    本模块只管"哪些条目被提到了"。
 */
/** 单条兴趣。字段含义见 `interests.yml.example` 顶部注释。 */
export interface InterestEntry {
  readonly id: string;
  readonly topic: string;
  /** 字符串包含匹配（大小写不敏感）；至少一个 */
  readonly keywords: readonly string[];
  readonly why?: string;
  readonly note?: string;
}
/** 兴趣池上限：整份内容会进 prompt，条目越多判定越贵也越飘。 */
export const MAX_INTEREST_ENTRIES = 20;
/** bot 别名的规模上限（同样进 prompt）。 */
export const MAX_BOT_ALIASES = 5;
export interface InterestMatch {
  readonly id: string;
  readonly topic: string;
  /** 命中的关键词（进 trace，回答"为什么这次命中了"） */
  readonly matchedKeyword: string;
}
export interface InterestPool {
  get size(): number;
  /** 供 prompt / 控制面展示（顺序即来源顺序，人工可预期）。 */
  list(): readonly InterestEntry[];
  /**
   * 原地替换条目（**未来 role-play 动态设定兴趣池的接缝**）。
   *
   * 用"原地替换"而不是"新建池"：调用方（`buildSceneEvidence` 的组装处、
   * health 快照）持有的是同一个对象引用，换池不该让它们看到旧数据。
   */
  replaceEntries(entries: readonly InterestEntry[]): void;
  /** 运行期开关（role-play 会话结束时可以整体停用，而不必清空条目）。 */
  setEnabled(enabled: boolean): void;
  /** 当前是否启用（health / 控制面展示用）。 */
  get isEnabled(): boolean;
  /**
   * 文本命中的兴趣条目。空池 / 已停用 → 恒为空数组。
   * 顺序 = 文件顺序；每条最多出现一次。
   */
  match(text: string): readonly InterestMatch[];
  /** 便捷形态：只要 id（喂给 `SceneEvidence.matchedInterestIds`）。 */
  matchIds(text: string): readonly string[];
}
export type createInterestPoolFactory = (
  entries: readonly InterestEntry[],
  enabled?: boolean
) => InterestPool;
/** 空池（未配置兴趣文件时的默认）。 */
export type EMPTY_INTEREST_POOL = InterestPool;
/**
 * 解析兴趣池文件内容（纯函数，便于测试）。
 *
 * 校验规则与报错文案都刻意具体：配置错误必须在**启动期**暴露，
 * 而且要让维护者一眼知道改哪一条。
 */
export type parseInterestPool = (raw: string, source?: string) => InterestPool;
/**
 * 从文件读取兴趣池。
 *
 * 与 `loadConfigFile` 的缺文件策略对齐：**显式指定**的路径缺失即报错
 * （免得静默跑在"没有兴趣池"上），默认路径缺失视为空池。
 */
export type loadInterestPool = (options: {
  path: string;
  explicit?: boolean;
  enabled?: boolean;
}) => InterestPool;
