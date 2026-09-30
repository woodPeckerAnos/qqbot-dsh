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
import { rule as offpeakWindow } from './03-offpeak-window/rule.js';
import { rule as duplicateEvent } from './04-duplicate-event/rule.js';
import { rule as atOthers } from './05-at-others/rule.js';
import { rule as noText } from './06-no-text/rule.js';
import { rule as rateLimitPrecheck } from './07-rate-limit-precheck/rule.js';
import { rule as strongQuickReply } from './08-strong-quick-reply/rule.js';
import { rule as strongQuoteBot } from './09-strong-quote-bot/rule.js';
import { rule as strongOpenQuestion } from './10-strong-open-question/rule.js';
import { rule as strongKeywordEcho } from './11-strong-keyword-echo/rule.js';
import { rule as evalCooldown } from './12-eval-cooldown/rule.js';
import { rule as samplingDebounce } from './13-sampling-debounce/rule.js';
import { rule as semanticGate } from './20-semantic-gate/rule.js';
import { rule as rateLimitVeto } from './30-rate-limit-veto/rule.js';
import { rule as focusBudget } from './31-focus-budget/rule.js';
import { rule as admissionTry } from './32-admission-try/rule.js';
import { rule as promotionWindow } from './40-promotion-window/rule.js';
import { rule as inflightMerge } from './41-inflight-merge/rule.js';
import { rule as nightSilenceVeto } from './33-night-silence-veto/rule.js';

export const RULE_REGISTRY: RuleRegistry = {
  continuation: [promotionWindow, inflightMerge],
  intake: [
    masterSwitch,
    groupWhitelist,
    offpeakWindow,
    duplicateEvent,
    atOthers,
    noText,
    rateLimitPrecheck,
    strongQuickReply,
    strongQuoteBot,
    strongOpenQuestion,
    strongKeywordEcho,
    evalCooldown,
    samplingDebounce,
  ],
  evaluate: [semanticGate],
  speak: [rateLimitVeto, focusBudget, admissionTry, nightSilenceVeto],
};

/** 全部已注册规则名（配置校验用：qqbot.yml 里出现未注册名 → 启动报错）。 */
export const REGISTERED_RULE_NAMES: readonly string[] = [
  ...RULE_REGISTRY.continuation,
  ...RULE_REGISTRY.intake,
  ...RULE_REGISTRY.evaluate,
  ...RULE_REGISTRY.speak,
].map((rule) => rule.name);
