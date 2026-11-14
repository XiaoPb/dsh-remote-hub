/**
 * 最小运行时替身：替代 vendored 官方 UI 用到的**宿主内置包**。
 *
 * ## 为什么需要（依赖最小化，ADR-008）
 *
 * 官方 `ui-plugin-manager` 的客户端代码从 10 个内置包里取值。若把它们全部声明到本包的
 * `dsh.client.inject` 并在宿主加载，会把**整棵官方客户端依赖树**（含 testing-library / react-dom /
 * product-analytics 等 30+ 传递依赖）拉进插件，成本与收益完全不成比例。
 *
 * 实测统计后，真正被**运行时取值**（非类型）的只有 5 处小东西：
 *
 * | 官方导入 | 用在 | 本文件提供 |
 * | --- | --- | --- |
 * | `randomUUID`（`dsh-util-crypto`） | 安装/更新的 `requestId` | `crypto.randomUUID()`（与官方同源） |
 * | `normalizeRegistry` / `NPMMIRROR_REGISTRY` / `OFFICIAL_NPM_REGISTRY` / `REGISTRY_URL`（`dsh-plugin-manager/registry`） | 安装对话框的 registry 选择 | 与官方 `registry.ts` 逐字同构的常量与函数 |
 * | `EXPERIMENTAL_BUNDLES`（`dsh-official-bundles`） | 卡片的「实验」徽标 | 官方 14 个包名（数据，4 行） |
 * | `createSnapshotStore`（`dsh-client-store`） | 控制器/导航的状态容器 | 与官方签名一致的极简实现 |
 * | `bindSnapshotSelector` | 渲染层 `useX(selector)` 绑定 | 极简实现（面板注册处使用） |
 *
 * 其余官方导入全是**类型**（`ResolvedText` / `RemoteFailure` / `LocaleSnapshot` / 槽位 props 等），
 * 由 `official-stubs.d.ts` 声明，编译期擦除，运行时为零。
 *
 * ## 与官方实现的一致性
 *
 * `normalizeRegistry` / 两个 registry 常量 / `REGISTRY_URL` 与 `dsh-plugin-manager/src/registry.ts` **逐字一致**
 * （含 `⚠️` 注释里的行为：非 http(s) 抛错、补尾斜杠）。`EXPERIMENTAL_BUNDLES` 取自
 * `dsh-official-bundles/src/plugin-manager.ts`。`04-verification.md` §5 的 drift 检查提醒同步。
 *
 * @module dsh-remote-hub/client/local-plugin-manager/official-shims
 */

// ── randomUUID（替代 @deepseek-ai/dsh-util-crypto）─────────────────────────────

/**
 * 生成一个 RFC 4122 v4 UUID。
 * @returns 小写 UUID 字符串。
 */
export function randomUUID(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  // 极旧浏览器的兜底：不用于安全用途（只做请求 id），但格式必须合法。
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/gu, (char) => {
    const random = Math.floor(Math.random() * 16)
    const value = char === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

// ── registry 规则（替代 @deepseek-ai/dsh-plugin-manager/registry）──────────────

/** npm 自己的 registry：pnpm 无配置时默认的那个。 */
export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/'

/** 公共 npmmirror 地址（与官方 fallback 配置一致）。 */
export const NPMMIRROR_REGISTRY = 'https://registry.npmmirror.com/'

/** http(s) URL 形状（pnpm `--registry` 接受的形式）。 */
export const REGISTRY_URL = /^https?:\/\/\S+$/u

/**
 * 把 registry URL 解析成 pnpm 比较用的形式：小写 host + 尾斜杠。
 * @param url - 配置或请求里的 registry。
 * @returns 归一化后的 URL。
 * @throws {Error} 不是 http(s) URL 时。
 */
export function normalizeRegistry(url: string): string {
  let parsed: URL | undefined
  try {
    parsed = new URL(url)
  } catch {
    // 只有 http(s) URL 才是 registry；下面统一报错。
  }
  if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error(`a registry must be an http(s) URL: ${url}`)
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed.href
}

// ── 实验包标记（替代 @deepseek-ai/dsh-official-bundles）────────────────────────

/**
 * 插件管理页打「实验」徽标的官方包（取自 `dsh-official-bundles/src/plugin-manager.ts`）。
 * 这是**数据**，不是逻辑：新增实验包时同步这里即可。
 */
export const EXPERIMENTAL_BUNDLES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-personalized-recommendations',
  '@deepseek-ai/dsh-cua-bundle',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-experimental-forge-bundle',
  '@deepseek-ai/dsh-experimental-tool-worktree',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-experimental-liveshare',
])

/**
 * 有独立插件页、但在插件管理页里**不显示**的内置包（官方 `HIDDEN_BUNDLES`）。
 * 这些包永远不占列表位置，与「本机/云端」无关。
 */
export const HIDDEN_BUNDLES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-minimal',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-tool-worktree',
])

/** 主列表里排在最前面的可选扩展包（官方 `EXTENSION_BUNDLES`，顺序有意义）。 */
export const EXTENSION_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-experimental-auto-review',
]

/** 主列表默认不收、只在「更多」里靠后排列的可选包（官方 `MORE_BUNDLES`，顺序有意义）。 */
export const MORE_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-personalized-recommendations',
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-cua-bundle',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-subagent-claude-code',
]

// ── 快照 store（替代 @deepseek-ai/dsh-client-store）────────────────────────────

/** 一个可订阅的只读快照源（与官方 `HostObservable` 同形）。 */
export interface HostObservable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 面板导航 store 的句柄形状（官方 `navigation-store.ts` 的 `createNavigationStore()` 返回值）。 */
export interface LocalSnapshotHandle<S, A> {
  getSnapshot(): S
  subscribe(listener: () => void): () => void
  set(next: S): void
  actions: A
}

/**
 * 官方 `createSnapshotStore` 的最小等价实现。
 *
 * 语义与官方一致：快照引用只在 `set` 时变化（`useSyncExternalStore` 依赖这一点）；
 * 立即回调一次 `onChange`；`subscribe` 返回退订函数。
 * @param initial - 初始快照。
 * @param options - 可选变更回调与持久化（官方里用于记住上次选择的 registry）。
 * @returns 快照 store 句柄。
 */
export function createSnapshotStore<S>(
  initial: S,
  options: {
    readonly onChange?: (next: S) => void
    readonly persist?: { readonly name: string }
  } = {},
): LocalSnapshotHandle<S, Record<string, never>> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const storageKey = options.persist?.name
  if (storageKey !== undefined) {
    try {
      const stored = globalThis.localStorage?.getItem(storageKey)
      if (stored !== null && stored !== undefined) snapshot = JSON.parse(stored) as S
    } catch {
      // 无痕模式 / 损坏数据：用初始值。
    }
  }
  const store: LocalSnapshotHandle<S, Record<string, never>> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      snapshot = next
      if (storageKey !== undefined) {
        try {
          globalThis.localStorage?.setItem(storageKey, JSON.stringify(next))
        } catch {
          // 配额/无痕：忽略持久化失败。
        }
      }
      options.onChange?.(next)
      for (const listener of [...listeners]) listener()
    },
    actions: {},
  }
  return store
}

/**
 * 官方 `bindSnapshotSelector` 的最小等价实现：把快照源绑定成「按 selector 取值的 hook」。
 *
 * 返回值形状与官方一致（`useX(selector)`），供面板注册处的 `inject` 面使用。
 * 注意：这里不依赖 React（面板注册只做类型对齐），真正的订阅由运行时的槽位渲染器建立。
 * @param source - 快照源。
 * @returns 选择器绑定函数。
 */
export function bindSnapshotSelector<T, R>(
  source: HostObservable<T>,
): (selector: (snapshot: T) => R) => R {
  return selector => selector(source.getSnapshot())
}
