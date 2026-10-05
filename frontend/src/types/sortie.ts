import type { LngLat } from './mission';
import type { Waypoint } from './waypoint';

/** 续航与余量配置 */
export interface BatteryConfig {
  /** 标称续航 min（一组电池） */
  enduranceMin: number;
  /** 电量余量比例（0~1），如 0.2 表示留 20% 电量 */
  reserveFraction: number;
}

export const DEFAULT_BATTERY_CONFIG: BatteryConfig = {
  enduranceMin: 20,
  reserveFraction: 0.2,
};

/** 单架次时间构成 min */
export interface SortieTiming {
  /** 起降点 → 首个航点 */
  outboundMin: number;
  /** 航点间连续航段 */
  segmentsMin: number;
  /** 悬停 */
  hoverMin: number;
  /** 转弯附加 */
  turnMin: number;
  /** 末航点 → 起降点 */
  returnMin: number;
  /** 合计 */
  totalMin: number;
  /** 消耗电量 %（按标称续航折算） */
  batteryUsedPct: number;
  /** 剩余电量 %（≥ 余量） */
  batteryRemainPct: number;
}

export type SortieStatus = 'planned' | 'flown';

/** 一个架次：从起降点出发，按序飞过若干航点后返回 */
export interface Sortie {
  sortieNo: number;
  /** 本架次覆盖的航点 id（按执行顺序） */
  waypointIds: string[];
  /** 本架次覆盖的航点序号（冗余快照） */
  waypointSeqs: number[];
  timing: SortieTiming;
  status: SortieStatus;
  executedAt?: number;
}

/** 被拒绝的航点：单点往返 + 悬停即超过可用续航 */
export interface RejectedWaypoint {
  waypointId: string;
  seq: number;
  /** 拒绝原因（写明超出多少） */
  reason: string;
  /** 单点往返 + 悬停所需 min */
  soloMin: number;
}

export type PlanStatus = 'current' | 'superseded' | 'failed';

/** 架次计划（带版本） */
export interface SortiePlan {
  id: string;
  missionId: string;
  /** 计划版本号，从 1 递增 */
  version: number;
  /** 输入指纹：航点序号/高度 + 相机参数 + 起降点，任一改变即失效 */
  inputHash: string;
  /** 计算时刻 */
  computedAt: number;
  status: PlanStatus;
  /** 标称续航 min */
  enduranceMin: number;
  /** 电量余量 */
  reserveFraction: number;
  /** 可用续航 min = enduranceMin × (1 − reserveFraction) */
  usableMin: number;
  /** 起降点（快照，缺省取首个航点） */
  homeLng: number;
  homeLat: number;
  sorties: Sortie[];
  rejected: RejectedWaypoint[];
  /** 失败原因（status='failed' 时） */
  failureReason?: string;
  /** 上一版计划 id（重算失败时保留） */
  supersedesId?: string;
}

/** 打包结果 */
export type PackResult =
  | { ok: true; sorties: Sortie[]; rejected: RejectedWaypoint[]; usableMin: number }
  | { ok: false; reason: string };

/** 打包参数 */
export interface PackOptions {
  enduranceMin?: number;
  reserveFraction?: number;
  fallbackSpeed?: number;
}

export type { LngLat, Waypoint };
