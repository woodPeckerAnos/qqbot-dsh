/**
 * 规则注册表：四条链的静态装配（唯一允许 import 规则文件夹的地方）。
 *
 * 纪律：
 *   - 链内按 order 升序排列（runner 不排序，顺序错误由链冒烟测试暴露）；
 *   - 新增规则 = 这里加一行 import + 一行注册，不改任何既有规则代码；
 *   - 本表与 CHAIN.md 的自然语言描述必须一致（冒烟测试校验）。
 */

import type { RuleRegistry } from '../watcher.js';
import { rule as masterSwitch } from './01-master-switch/rule.js';
import { rule as groupWhitelist } from './02-group-whitelist/rule.js';
import { rule as duplicateEvent } from './04-duplicate-event/rule.js';

export const RULE_REGISTRY: RuleRegistry = {
  continuation: [],
  intake: [masterSwitch, groupWhitelist, duplicateEvent],
  evaluate: [],
  speak: [],
};

/** 全部已注册规则名（配置校验用：qqbot.yml 里出现未注册名 → 启动报错）。 */
export const REGISTERED_RULE_NAMES: readonly string[] = [
  ...RULE_REGISTRY.continuation,
  ...RULE_REGISTRY.intake,
  ...RULE_REGISTRY.evaluate,
  ...RULE_REGISTRY.speak,
].map((rule) => rule.name);
