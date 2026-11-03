/**
 * 配置层：env（密钥）+ 配置文件（qqbot.yml 入口 + config/ 模块）+ 代码内置默认，
 * 三层合并 + 启动期快速失败。
 *
 * 为什么要分层（而不是全塞 .env）：
 *   `.env` 里 39 个变量中真正敏感的只有 4 个（QQ_APP_ID / QQ_APP_SECRET /
 *   DEEPSEEK_API_KEY / ONEBOT_ACCESS_TOKEN），其余都是行为参数。混在一起的结果是
 *   重要信息被稀释——想改个端口要在一堆参数里翻。所以：
 *
 *     .env        只放密钥（以及 docker-compose 传递的少数几个）
 *     qqbot.yml   配置入口（include 清单）；其余行为参数在 config/*.yml
 *                  （随仓库提供，带注释，就是默认配置）
 *
 * 取值优先级：**env > 配置文件合并结果 > 内置默认**。模块之间后加载覆盖先加载，
 * 入口自己的配置最后合并；映射深合并，数组/标量整体替换。
 * 让 env 仍然优先有两个理由：既有部署的 .env 零破坏；临时覆盖不用改文件。
 * 密钥类（appId/appSecret/apiKey/accessToken）**只能**来自 env——它们绝不写进配置文件。
 *
 * 设计原则：
 *   - 所有可调参数集中在这里，其余模块不直接读 process.env 或读配置文件；
 *   - 必填项缺失/范围越界立刻抛错并说清怎么修，不等到运行中途才发现；
 *   - 配置文件只做形状与类型校验（见 config-file.ts），语义校验（取值范围、
 *     配额不变量、窗口重叠…）在这里做，因为要等 env 合并完才能判。
 */
/**
 * 配置层：env（密钥）+ 配置文件（qqbot.yml 入口 + config/ 模块）+ 代码内置默认，
 * 三层合并 + 启动期快速失败。
 *
 * 为什么要分层（而不是全塞 .env）：
 *   `.env` 里 39 个变量中真正敏感的只有 4 个（QQ_APP_ID / QQ_APP_SECRET /
 *   DEEPSEEK_API_KEY / ONEBOT_ACCESS_TOKEN），其余都是行为参数。混在一起的结果是
 *   重要信息被稀释——想改个端口要在一堆参数里翻。所以：
 *
 *     .env        只放密钥（以及 docker-compose 传递的少数几个）
 *     qqbot.yml   配置入口（include 清单）；其余行为参数在 config/*.yml
 *                  （随仓库提供，带注释，就是默认配置）
 *
 * 取值优先级：**env > 配置文件合并结果 > 内置默认**。模块之间后加载覆盖先加载，
 * 入口自己的配置最后合并；映射深合并，数组/标量整体替换。
 * 让 env 仍然优先有两个理由：既有部署的 .env 零破坏；临时覆盖不用改文件。
 * 密钥类（appId/appSecret/apiKey/accessToken）**只能**来自 env——它们绝不写进配置文件。
 *
 * 设计原则：
 *   - 所有可调参数集中在这里，其余模块不直接读 process.env 或读配置文件；
 *   - 必填项缺失/范围越界立刻抛错并说清怎么修，不等到运行中途才发现；
 *   - 配置文件只做形状与类型校验（见 config-file.ts），语义校验（取值范围、
 *     配额不变量、窗口重叠…）在这里做，因为要等 env 合并完才能判。
 */
import type { ModelApiConfig } from './dsh/model-config.js';
import { QQ_OFFICIAL_PLATFORM } from './adapters/qq-official/gateway.js';
import { ONEBOT_PLATFORM } from './adapters/onebot/connector.js';
import type { FileConfig } from './config-file.js';
import type { LongTaskHintConfig } from './pipeline/hints.js';
import type { OffpeakWindow } from './offpeak/index.js';
import type { LoggingSettings } from './logger.js';
export type { ConfigError } from './config-error.js';
export type ConnectorName = typeof QQ_OFFICIAL_PLATFORM | typeof ONEBOT_PLATFORM;
/**
 * 内置的默认谷时段窗口：北京时间 00:00-09:00、12:00-14:00、18:00-24:00。
 * 窗口之外（09:00-12:00、14:00-18:00）是正价时段。
 */
export declare const DEFAULT_OFFPEAK_WINDOWS = "00:00-09:00,12:00-14:00,18:00-24:00";
export interface Config {
    logging: LoggingSettings;
    /** 启用的接入平台（BOT_CONNECTORS / connectors，逗号分隔） */
    connectors: ConnectorName[];
    /**
     * 管理员白名单，**只来自 env**（BOT_ADMINS，逗号分隔）。
     *
     * 条目格式为 `platform:senderId`，例如 `qq-official:ABCDEF...` 或 `onebot:123456`。
     * 兼容项：QQ_ADMIN_OPENIDS 里的裸 openid 会自动加上 `qq-official:` 前缀。
     * 留空 = 没有管理员，/offpeak 的变更类子命令对所有人关闭（fail-closed）。
     *
     * 为什么只认 env：这里是真实 QQ 号 / openid，属于个人标识，不该进随仓库提交的
     * 配置文件（写在那里会在启动期被明确拒绝）。
     */
    admins: string[];
    /** 官方开放平台接入（仅 connectors 含 qq-official 时有意义） */
    qq: {
        /** 密钥，只能来自 env（QQ_APP_ID） */
        appId: string;
        /** 密钥，只能来自 env（QQ_APP_SECRET） */
        appSecret: string;
        /** OpenAPI 基址；2026-08-10 起统一为 api.bot.qq.com */
        apiBase: string;
        /** 订阅的 intents 位掩码 */
        intents: number;
        /** 发送消息用 markdown(2) 还是纯文本(0) */
        msgType: 0 | 2;
        maxChars: number;
        maxRepliesPerMsg: number;
        progressAfterMs: number;
        progressIntervalMs: number;
        progressMax: number;
        turnTimeoutMs: number;
        /**
         * 单聊（C2C）相关配置。
         *
         * 单聊与群聊共用 `1<<25` 这一个 intent，无法在订阅层屏蔽，所以用一个
         * 显式开关在业务层决定是否响应私聊。
         */
        c2c: {
            /** 是否响应单聊消息（false = 只服务群聊） */
            enabled: boolean;
            /** 单聊每条消息的最大回复条数（官方上限 4） */
            maxRepliesPerMsg: number;
            /** 单聊进度回执条数上限，必须 < maxRepliesPerMsg */
            progressMax: number;
        };
    };
    /** OneBot v11 社区框架接入（仅 connectors 含 onebot 时有意义） */
    onebot: {
        /** 反向 WS 监听地址（本服务起 server，LLBot/NapCat 等作为客户端连入） */
        host: string;
        port: number;
        /** 密钥，只能来自 env（ONEBOT_ACCESS_TOKEN；启用 onebot 时必填） */
        accessToken: string;
        /** 是否响应私聊消息 */
        c2cEnabled: boolean;
        maxChars: number;
        /** 无平台级配额，这里只是防失控的安全阀 */
        maxRepliesPerMsg: number;
        progressMax: number;
        progressAfterMs: number;
        progressIntervalMs: number;
        /** 无被动回复窗口，单轮超时可以放宽到任务真正需要的时长 */
        turnTimeoutMs: number;
        /** 收到加好友请求时自动同意（否则私聊路径永远打不开） */
        autoAcceptFriend: boolean;
        /** 收到拉群邀请时自动同意（默认关闭：被拉进陌生群意味着陌生人能触发 agent） */
        autoAcceptGroupInvite: boolean;
        /** 附件字节传输方式：base64（跨容器安全）或 path（同机部署省体积） */
        fileTransport: 'base64' | 'path';
    };
    dsh: {
        provider: string;
        model: string;
        /** profile patch 的绝对路径 */
        profilePatch: string;
        /** dsh 可执行文件；默认从 PATH 解析 */
        bin: string;
        /** 单轮上限（毫秒），与 qq.turnTimeoutMs 保持一致语义 */
        runtimeStartTimeoutMs: number;
        runtimeShutdownTimeoutMs: number;
    };
    /**
     * 模型 API 配置层（配置文件的 `models:` 段；推荐写在 config/local/models.yml，
     * 只认配置文件——结构化嵌套配置没法用 env 平铺表达，与 interests 文件同口径）。
     *
     * 声明的提供商路由在启动时渲染成一份生成的 patch 文件，作为第二个 `--patch`
     * 传给 dsh 子进程（见 dsh/model-config.ts 与 main.ts）。配了本段时，
     * `dsh.provider` 必须是原生路由 `deepseek-official` 或这里 `providers`
     * 声明过的路由名（启动期校验）；没配本段则不做此校验（路由可能由 DSH
     * 自己的 settings 层带外提供）。
     */
    modelApi: ModelApiConfig;
    tasks: {
        fastTimeoutMs: number;
        slowTimeoutMs: number;
        fastProvider: string;
        fastModel: string;
        slowProvider: string;
        slowModel: string;
        fastRuntimes: number;
        slowRuntimes: number;
        maxPerSession: number;
        maxGlobal: number;
        retentionMs: number;
        reminderMs: number;
    };
    pool: {
        maxConcurrentTurns: number;
        maxRuntimes: number;
        runtimeIdleMs: number;
        replayTurns: number;
    };
    /**
     * 话题判定：新消息与既有话题是否相关由一个小模型调用判断（不经 DSH 进程，
     * 见 pipeline/topic-judge.ts）。判定为无关 → 关闭话题（回收 runtime、
     * 跳过冷启动回放）。判定失败一律视为相关（fail-safe）。
     *
     * 凭证与端点**收口到模型 API 配置层**：`provider` 指定 models: 段里声明的
     * 路由，apiKey 从该路由的 apiKeyEnv 引用解析；不配 provider = 历史默认
     * （apiBase 直连 + DEEPSEEK_API_KEY）。主动介入判定复用同一解析（它本来
     * 就借用这里的 apiBase/model）。
     */
    topic: {
        /** 总开关（BOT_TOPIC_ENABLED / topic.enabled，默认 true） */
        enabled: boolean;
        /** 判定调用走的模型路由名（BOT_TOPIC_PROVIDER / topic.provider）；未设 = 直连 apiBase */
        provider?: string;
        /** 判定用的凭证变量名（所选路由的 apiKeyEnv；供告警文案与排障使用） */
        apiKeyEnv: string;
        /**
         * 已从 env 解析好的密钥（只来自 env，绝不来自配置文件）。
         * `enabled` 时保证非空（缺失在启动期就报错）；`enabled: false` 时可能为空串，
         * 此时主动介入判定降级为"只听不说"（main.ts 会打 warn）。
         */
        apiKey: string;
        /** chat completions 基址（BOT_TOPIC_API_BASE / topic.apiBase > 路由 baseURL > 官方默认） */
        apiBase: string;
        /** 判定用模型（BOT_TOPIC_MODEL / topic.model），默认与主模型同档的小模型 */
        model: string;
        /** 单次判定超时（毫秒） */
        timeoutMs: number;
        /** 送给判定器的最近记录条数（不含当前新消息） */
        contextTurns: number;
    };
    paths: {
        dshHome: string;
        workspacesRoot: string;
        stateDir: string;
    };
    /**
     * 谷时段闸：命中 modelPattern 的模型在谷时段窗口之外不调用 API，直接回复提示。
     * 运行期可被管理员 /offpeak 命令覆盖（见 offpeak/ 目录），这里只是 env/文件默认层。
     */
    offpeak: {
        /** 总开关（QQ_OFFPEAK_ENABLED / offpeak.enabled，默认 false） */
        enabled: boolean;
        /** 一天内的谷时段窗口列表（QQ_OFFPEAK_WINDOWS / offpeak.windows） */
        windows: OffpeakWindow[];
        /** 窗口所在时区（QQ_OFFPEAK_TZ / offpeak.timeZone，默认 Asia/Shanghai） */
        timeZone: string;
        /** 命中判定：`<provider>/<model>` 包含该子串（默认 deepseek） */
        modelPattern: string;
        /** 周六、周日全天谷价（默认 true，DeepSeek 2026-08-23 起规则） */
        weekendsAllDay: boolean;
        /** 追加的全天谷价日期（YYYY-MM-DD），与内置官方节假日表合并 */
        holidays: string[];
    };
    /**
     * 富媒体输入（图片 / 语音 / 引用 / 卡片）送进模型的总开关与配额。
     *
     * 与平台无关：官方与 OneBot 都走这一套。关闭后所有消息都退回"纯文本 +
     * `[图片]` 之类占位标记"的行为，适合模型不支持多模态时使用。
     */
    attachments: AttachmentsConfig;
    /**
     * 富媒体出站（agent 产物回发用户）：outbox 目录约定 + 体积/数量上限。
     *
     * 与平台无关：官方走 /files 上传 + msg_type=7，OneBot 走消息段/upload 动作，
     * 差异都在适配器内部。agent 侧只有一条约定——把要发的文件放进工作区的
     * `outboxDir` 目录（见 dsh-profile 的 persona 与 docs/RICH-MEDIA-PLAN.md）。
     */
    media: MediaConfig;
    health: {
        port: number;
    };
    /**
     * 主动发言（旁听 → 判定 → 主动开口）的配置面。
     *
     * 场景清单与判据见 `src/pipeline/proactive/interests/SCENES.md`；
     * 兴趣池文件（场景 5）另存，见 `proactive.interestsFile`。
     * 注意：`enabled` 是**主动发言的总开关**，缺省 false（fail-closed）。
     */
    proactive: {
        enabled: boolean;
        /** 灰度观察：判定照跑、记录"本应发言"，但不真的发（BOT_PROACTIVE_DRY_RUN，默认 true） */
        dryRun: boolean;
        /** 兴趣池总开关（BOT_PROACTIVE_INTERESTS / proactive.interestsEnabled，默认 true） */
        interestsEnabled: boolean;
        /**
         * 兴趣池文件路径（QQ_INTERESTS_FILE / proactive.interestsFile，默认 ./interests.yml）。
         * 这是**过渡期的上游**：后续 role-play 迭代会动态设定兴趣池，
         * 届时它是"人审 / 兜底来源"，判定层与投递层不受影响。
         */
        interestsFile: string;
        /** 兴趣池是否真的读到了文件（health / 排障用：false + enabled = 配置指错了） */
        interestsLoaded: boolean;
        /** 兴趣池条目数（health 用） */
        interestsCount: number;
        /**
         * 群白名单（**只认 env `BOT_LISTEN_GROUPS`**，与介入层共用同一个变量）。
         *
         * 为什么只从 env 来：群号属于个人标识，本项目既有的纪律是"个人标识不进
         * 配置文件"（见 BOT_ADMINS 的处理）。条目形如 `onebot:123456` 或
         * `ob11:g123456`；**空列表 = 不接任何群**（fail-closed）。
         */
        whitelistGroups: string[];
        /** bot 在本群的别名（BOT_BOT_ALIASES / proactive.botAliases），场景 4 指代检测用 */
        botAliases: string[];
        /** 话题滚动周期（条）：每多少条旁听消息收敛一次，场景 2/5 的入口 */
        topicRollMessages: number;
        /** 话题滚动周期（毫秒）：无仲裁时的兜底收敛间隔 */
        topicRollMs: number;
        /** 问题挂起多久后探针（BOT_PROACTIVE_QUESTION_PROBE_MS / proactive.questionProbeMs） */
        questionProbeMs: number;
        /**
         * 每个挂起问题最多"让路"几次（BOT_PROACTIVE_MAX_WAIT_PER_ITEM /
         * proactive.maxWaitPerItem，默认 1，硬上限 3）。
         *
         * 这是"让路只能让一次"的**代码级**硬上限：超出硬上限按 3 处理并 warn，
         * 因为把收敛改回不收敛不该只需要改一行配置（见 wait 收敛需求）。
         */
        maxWaitPerItem: number;
        /**
         * "让路"理由的等待时长（BOT_PROACTIVE_WAIT_YIELD_MS / proactive.waitYieldMs，
         * 默认 45000，范围 15000–120000）。
         *
         * 语义是"现在差不多该说了，但此刻有人在动，再给几十秒"，因此刻意短：
         * 它只是**把下一次唤醒提前一点**，不是一台新的等待机器。
         */
        waitYieldMs: number;
        /**
         * 一个话题 session 内允许的主动发言条数（BOT_PROACTIVE_SESSION_BUDGET /
         * proactive.sessionBudget，默认 2，**硬上限 5**）。
         *
         * 它是"防刷屏"的主闸门：LLM 判"值得"时开一个 session，之后每说一句扣 1 点，
         * 扣到 0 立即关闭；再要开口就得 LLM 重新判"值得"。配得比硬上限大时按硬上限
         * 处理并 warn——"少说两句"是产品决策，不该被一行配置改回"多说几句"。
         */
        sessionBudget: number;
        /**
         * 静默多久自动关闭 session（BOT_PROACTIVE_SESSION_IDLE_MS /
         * proactive.sessionIdleMs，默认 600000 = 10 分钟，与活动窗口同值；
         * 范围 60000–3600000）。
         *
         * 锚点是 bot **自己**上次在这个 session 里发言的时间（没说过则是开启时刻），
         * 刻意不被群消息刷新：这是"bot 说话的节奏"，不是"群消息的密度"。
         */
        sessionIdleMs: number;
        /**
         * 同一 session 内两次发言的**最小间隔**（BOT_PROACTIVE_SESSION_MIN_GAP_MS /
         * proactive.sessionMinGapMs，默认 45000，范围 10000–300000）。
         *
         * 与 `waitYieldMs` 数值巧合地接近，但语义完全不同：那个是"让路后多久重查"
         * （能不能再看一眼），这个是"两次开口至少隔多久"（闸门不让过，且**不消耗预算**）。
         */
        sessionMinGapMs: number;
        /**
         * 判定调用超时（BOT_PROACTIVE_JUDGE_TIMEOUT_MS / proactive.judgeTimeoutMs）。
         *
         * **刻意与 `topic.timeoutMs` 分开**：话题判定只输出一个布尔值（10 秒够），
         * 而主动介入的判定要逐场景输出多段 JSON（最多 5 条判定 + 理由），
         * 借用话题判定的 10 秒会频繁超时——超时 = 沉默，表现为「它从来不说话」。
         */
        judgeTimeoutMs: number;
        /**
         * 发言生成（措辞轮次）的超时（BOT_PROACTIVE_SPEAK_TIMEOUT_MS /
         * proactive.speakTimeoutMs，默认 120000，范围 30000–300000）。
         *
         * 主动发言要走一次真实 agent turn（可能带工具查证），比判定调用重，
         * 但它是"插一句话"而不是"跑一个任务"，所以上限刻意低于被动轮次的
         * `turnTimeoutMs`——超时的表现是本次不发言（`compose-failed`），不是报错。
         */
        speakTimeoutMs: number;
        /**
         * 旁听缓冲上限（条）：判定只需要近期上下文。
         *
         * @deprecated 取值搬到 `Config.observation.maxMessages`（滚窗已成为两条唤醒
         *   路径共享的设施，配置不该挂在 `proactive:` 段下）。这里保留**旧键的读取**
         *   （`undefined` = 用户没配），由 `buildObservationConfig` 决定优先级并 warn
         *   ——静默失效比报错更糟。
         */
        bufferMaxMessages?: number;
        /** @deprecated 取值搬到 `Config.observation.maxAgeMs`，理由同上 */
        bufferMaxAgeMs?: number;
    };
    /**
     * 观察窗口（旁听滚窗）：**与主动发言开关无关**。
     *
     * 它是"群里刚刚说了什么"的唯一来源，被 @ 的回复与主动发言判定读的是同一份。
     * 因此配置放在顶层，而不是 `proactive:` 段下——放在那里会让人合理地以为
     * "关掉主动发言就没有滚窗了"，而那正是这次重构要消灭的耦合。
     */
    observation: ObservationConfig;
    /**
     * 预设风格前台（/persona 命令）：预设目录里每个 `<名>.md` 是一个可切换人设，
     * 切换即写入该会话工作区 AGENTS.md 的标记区块，下个 turn 生效（见 store/personas.ts）。
     */
    personas: {
        /** 预设目录（BOT_PERSONA_DIR / personas.dir，默认 dsh-profile/personas） */
        dir: string;
    };
    /**
     * 旧关键词提示的解析兼容（生产 lane prompt 不使用）。
     */
    hints: {
        longTask: LongTaskHintConfig;
    };
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}
/** 观察窗口配置（见 Config.observation）。 */
export interface ObservationConfig {
    /**
     * 观察范围（`BOT_LISTEN_GROUPS`，与介入层白名单**同一个变量**）。
     *
     * 空 = 不观察任何会话（fail-closed）。之所以与介入层共用一个白名单：两个
     * 白名单会让"这个群到底算不算接入"有两个答案，而它们必须一致——滚窗记了
     * 但判定不看，或反过来，都是没人能解释的状态。
     */
    allowlist: string[];
    /** 每会话保留的消息条数上限（BOT_OBSERVATION_MAX_MESSAGES / observation.maxMessages） */
    maxMessages: number;
    /** 每条消息的最长保留时长（毫秒） */
    maxAgeMs: number;
    /**
     * 注入给**被动唤醒**（被 @）的窗口宽度（毫秒）。
     *
     * 刻意**窄于保留期**：留 30 分钟是为了让判定能回看，而回答"在吗，帮我看看这个"
     * 时把半小时前另一个话题的 200 条灌进去只会稀释注意力。缺省与活动窗口同值
     * （`DEFAULT_ACTIVITY_WINDOW_MS`）——"当前话题有多长"在判定层已经定义过一次，
     * 这里直接复用那个口径，不再造第二个。
     */
    injectWindowMs: number;
    /**
     * 被 @ 时，最多把上下文里的几张图片内联进 prompt（0 = 不内联，只留占位文本）。
     *
     * 为什么需要它：上下文里的 `[图片: x.jpg]` 只是占位，模型看不到图——而"群里先
     * 发一张图、再 @ bot 问这是什么"是最常见的用法（见 `store/window.ts` 的
     * `ObservationMedia`）。代价是 token：图片按像素烧，所以配额刻意小于
     * `attachments.maxImages`，且**只取最近的几张**（"看看这个"的对象几乎总是刚发的那张）。
     */
    injectImages: number;
    /**
     * 被 @ 时，最多摄取几个上下文里的文件（0 = 不摄取）。
     *
     * 比图片更保守（缺省 1）：文件要下载、落 inbox、可能起 pdftotext 子进程，
     * 而"翻背景资料"通常只需要最近那一个。
     */
    injectFiles: number;
    /**
     * 迁移提示（旧键 → 新键）：配置层不持有 logger，只生成句子，由启动摘要打出来。
     * 空数组 = 用户没配旧键。
     */
    deprecations: string[];
}
/** 富媒体出站配置（见 Config.media）。 */
export interface MediaConfig {
    /** 是否扫描并发送 outbox 产物（BOT_MEDIA_ENABLED / media.enabled） */
    enabled: boolean;
    /** 单附件体积上限（字节）。超出的文件降级为文本说明 */
    maxFileBytes: number;
    /** 单次回复最多发几个附件（超出的降级为文本说明） */
    maxAttachmentsPerMsg: number;
    /** 图片扩展名白名单（小写不带点）；其余一律按文件发 */
    imageExtensions: string[];
    /**
     * 工作区内的约定目录名（BOT_MEDIA_OUTBOX_DIR / media.outboxDir，默认 outbox）。
     * 必须是不含路径分隔符的纯目录名——它会拼进每个会话的工作区路径。
     */
    outboxDir: string;
}
/** 富媒体输入配额（见 Config.attachments）。 */
export interface AttachmentsConfig {
    /** 是否把图片内联送进模型（BOT_ATTACHMENT_ENABLED / attachments.enabled） */
    enabled: boolean;
    /** 单条消息最多内联几张图（含引用消息里的图片） */
    maxImages: number;
    /** 单张图片最大字节数（内联上限；超限会先尝试降采样） */
    maxImageBytes: number;
    /** 一张长图最多切成几块送入模型（BOT_ATTACHMENT_MAX_IMAGE_TILES） */
    maxImageTiles: number;
    /** 单张图片下载超时（毫秒） */
    downloadTimeoutMs: number;
    /** 转发消息块（合并转发 / 聊天记录）的展开配额 */
    forward: ForwardConfig;
    /** 文件（PDF 等）的下载与解析配额 */
    files: FilesConfig;
}
/**
 * 转发消息块的配额（见 Config.attachments.forward）。
 *
 * 四重上限刻意都保守：一个转发块动辄上百条，全量展开既烧 token 也把真正的问题
 * 淹掉。超限**不是错误**，是渲染成"仅展开以上条目"的显式说明。
 */
export interface ForwardConfig {
    /** 是否展开转发块（BOT_ATTACHMENT_FORWARD_ENABLED / attachments.forward.enabled） */
    enabled: boolean;
    /** 单个转发块最多展开几条 */
    maxNodes: number;
    /** 单条发言的字符上限（超出截断，防一条长文吃掉整个预算） */
    maxNodeChars: number;
    /** 一个转发块展开后的总字符上限 */
    maxChars: number;
    /** 最多再下钻几层嵌套转发（0 = 只展开最外层，最外层永远展开） */
    maxDepth: number;
    /** 回查超时（毫秒） */
    timeoutMs: number;
}
/**
 * 文件（PDF 等）的下载与解析配额（见 Config.attachments.files）。
 *
 * 与图片配额分开的原因：文件的"读入成本"比图片高一个量级（下载 + 落盘 + 解析
 * 子进程 + 可能两三万字的正文），共用一套数值会逼着两件事中的一个妥协。
 */
export interface FilesConfig {
    /** 是否下载并解析文件（BOT_ATTACHMENT_FILE_ENABLED / attachments.files.enabled） */
    enabled: boolean;
    /** 单条消息最多解析几个文件（超出的只列名字与体积） */
    maxFiles: number;
    /** 单文件字节上限；平台声明超限时**不下载** */
    maxFileBytes: number;
    /** 抽取文本的字符上限（超出截断并在 prompt 里说明） */
    maxExtractChars: number;
    /** PDF 最多读多少页 */
    maxPdfPages: number;
    /** 解析子进程超时（毫秒） */
    extractTimeoutMs: number;
    /** 是否把原文落到工作区的 inbox 目录（给 agent 自己深挖用） */
    saveToInbox: boolean;
    /** 工作区内的 inbox 目录名（必须是纯目录名，见 media.outboxDir 的同款校验） */
    inboxDir: string;
    /** inbox 文件保留天数，超期清理（0 = 不清理） */
    retentionDays: number;
    /** 单会话 inbox 总字节上限；超出时**删最旧的**而不是拒绝新文件 */
    maxInboxBytes: number;
    /** 允许抽取正文的扩展名白名单（小写不带点）；不在名单里的文件不下载 */
    extractExtensions: string[];
}
type Env = Record<string, string | undefined>;
export type loadConfig = (env?: Env, file?: FileConfig) => Config;
export type resolveLoggingSettings = (env: Record<string, string | undefined>, file?: FileConfig) => LoggingSettings;
/** 供日志/health 展示的配置摘要（不含任何密钥） */
export type describeConfig = (config: Config) => Record<string, unknown>;
