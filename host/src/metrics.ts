/**
 * 守卫运行指标（纯内存，重启清零）。
 *
 * 设计约束：
 * - **零阻塞**：埋点只做计数/桶自增（无 IO、无锁），调用方在请求热路径上；
 * - **永不抛**：诊断数据不能反过来影响主链路（与 writeStatus 同精神）；
 * - **环形桶**：`hourly`（24 桶 × 1h）与 `daily`（7 桶 × 1d）按时间窗滚动，
 *   供统计区的折线/柱状/热力图直接消费。
 *
 * @module dsh-remote-hub/host/metrics
 */

/** 守卫运行指标快照（`GET /remote/stats` 返回体）。 */
export interface HubMetrics {
  /** ISO 时间：守卫启动时刻（→ 页面「运行时长」）。 */
  startedAt: string
  /** 累计签发次数（票据 + 短码）。 */
  pairIssued: number
  /** 累计兑换成功（= 成功配对次数）。 */
  pairRedeemed: number
  /** 累计兑换拒绝（错码/过期/超限）。 */
  pairRejected: number
  /** 认证通过的一元 RPC 请求数。 */
  authAccepted: number
  /** 认证拒绝（无效/缺失令牌）次数。 */
  authDenied: number
  /** 当前活跃流数（打开 - 关闭）。 */
  activeStreams: number
  /** 累计流打开数。 */
  streamsOpened: number
  /** 24 桶 × 1h：每小时认证通过数（热力图/折线源；索引 0 = 最早一小时）。 */
  hourly: readonly number[]
  /** 7 桶 × 1d：每日兑换成功数（柱状源；索引 0 = 最早一天）。 */
  daily: readonly number[]
}

const HOURLY_BUCKETS = 24
const DAILY_BUCKETS = 7
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** 可变内部状态（快照接口只读）。 */
interface MetricsState {
  startedAt: number
  pairIssued: number
  pairRedeemed: number
  pairRejected: number
  authAccepted: number
  authDenied: number
  streamsOpened: number
  activeStreams: number
  /** 桶起点（ms epoch）；滚动时左移。 */
  hourlyStart: number
  dailyStart: number
  hourly: number[]
  daily: number[]
}

/** 创建指标收集器。 */
export function createMetricsCollector(now: () => number = Date.now): {
  snapshot(): HubMetrics
  countPairIssued(): void
  countPairRedeemed(): void
  countPairRejected(): void
  countAuthAccepted(): void
  countAuthDenied(): void
  countStreamOpened(): void
  countStreamClosed(): void
} {
  const state: MetricsState = {
    startedAt: now(),
    pairIssued: 0,
    pairRedeemed: 0,
    pairRejected: 0,
    authAccepted: 0,
    authDenied: 0,
    streamsOpened: 0,
    activeStreams: 0,
    hourlyStart: bucketStart(now(), HOUR_MS),
    dailyStart: bucketStart(now(), DAY_MS),
    hourly: new Array<number>(HOURLY_BUCKETS).fill(0),
    daily: new Array<number>(DAILY_BUCKETS).fill(0),
  }

  /** 计算给定时刻的桶起点（对齐到小时/天边界）。 */
  function bucketStart(at: number, windowMs: number): number {
    return Math.floor(at / windowMs) * windowMs
  }

  /** 把窗口滚动到给定时刻（只移动/清零桶，不计数）。返回新的窗口起点。 */
  function roll(at: number, windowMs: number, buckets: number[], start: number): number {
    const target = bucketStart(at, windowMs)
    if (target === start) return start
    const elapsed = Math.floor((target - start) / windowMs)
    if (elapsed >= buckets.length) {
      buckets.fill(0)
    } else if (elapsed > 0) {
      buckets.copyWithin(0, elapsed)
      buckets.fill(0, buckets.length - elapsed)
    }
    return target
  }

  /** 计一次最新桶（先滚动）。 */
  function tick(at: number, windowMs: number, buckets: number[], start: number): number {
    const rolled = roll(at, windowMs, buckets, start)
    const last = buckets.length - 1
    buckets[last] = (buckets[last] ?? 0) + 1
    return rolled
  }

  return {
    snapshot() {
      const at = now()
      // 快照前同样滚动（长时间无请求时桶保持对齐）——只滚动不计数。
      state.hourlyStart = roll(at, HOUR_MS, state.hourly, state.hourlyStart)
      state.dailyStart = roll(at, DAY_MS, state.daily, state.dailyStart)
      return {
        startedAt: new Date(state.startedAt).toISOString(),
        pairIssued: state.pairIssued,
        pairRedeemed: state.pairRedeemed,
        pairRejected: state.pairRejected,
        authAccepted: state.authAccepted,
        authDenied: state.authDenied,
        activeStreams: Math.max(0, state.activeStreams),
        streamsOpened: state.streamsOpened,
        hourly: [...state.hourly],
        daily: [...state.daily],
      }
    },
    countPairIssued() { state.pairIssued += 1 },
    countPairRedeemed() {
      state.pairRedeemed += 1
      state.dailyStart = tick(now(), DAY_MS, state.daily, state.dailyStart)
    },
    countPairRejected() { state.pairRejected += 1 },
    countAuthAccepted() {
      state.authAccepted += 1
      state.hourlyStart = tick(now(), HOUR_MS, state.hourly, state.hourlyStart)
    },
    countAuthDenied() { state.authDenied += 1 },
    countStreamOpened() { state.streamsOpened += 1; state.activeStreams += 1 },
    countStreamClosed() { state.activeStreams = Math.max(0, state.activeStreams - 1) },
  }
}

export type MetricsCollector = ReturnType<typeof createMetricsCollector>
