import type { Mission } from '../types/mission';
import type { Waypoint } from '../types/waypoint';
import type { PlanRejection } from '../types/sortie';
import { distanceMeters } from './geoCalc';
import { round } from './id';

/**
 * 架次续航模型常量：
 * 标称续航 20 min，留 20% 电量 → 单架次可用预算 16 min（960 s）。
 * 去程 / 连续航段 / 悬停 / 拍照 / 回程全部计入该预算。
 */
export const SORTIE_LIMITS = {
  /** 标称续航 min */
  ENDURANCE_MIN: 20,
  /** 预留电量比例 */
  RESERVE_RATIO: 0.2,
  /** 爬升速率 m/s */
  CLIMB_MS: 3,
  /** 下降速率 m/s */
  DESCENT_MS: 2.5,
  /** 每航点转弯/调整附加 s */
  TURN_SEC: 4,
  /** 每张拍照附加 s（相机预设经拍照间隔影响张数，从而影响该附加） */
  PHOTO_SEC: 2,
  /** 估算拍照间隔用的航向重叠率 % */
  OVERLAP_FORWARD_PCT: 75,
} as const;

/** 单架次可用预算 s = 20 min × (1 − 20%) */
export function sortieBudgetSec(): number {
  return SORTIE_LIMITS.ENDURANCE_MIN * 60 * (1 - SORTIE_LIMITS.RESERVE_RATIO);
}

/**
 * 架次计划输入指纹：航点经纬度/高度/航速/动作/悬停与顺序、任务相机参数（相机预设带入）、起降点。
 * 任一变化 → 指纹变化 → 当前计划立即失效并重算。
 */
export function computeSortieFingerprint(mission: Mission | undefined, waypoints: Waypoint[]): string {
  if (!mission) return 'no-mission';
  const home = mission.homePoint;
  const payload = [
    mission.sensorWidth,
    mission.sensorHeight,
    mission.focalLength,
    mission.pixelSize,
    home ? `${home[0]},${home[1]}` : 'no-home',
    ...waypoints.map((w) => [w.seq, w.lng, w.lat, w.altitude, w.speed, w.action, w.hoverSec].join(':')),
  ].join('|');
  // djb2 → base36，足够做变更检测
  let hash = 5381;
  for (let i = 0; i < payload.length; i += 1) {
    hash = ((hash << 5) + hash + payload.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/** 计划级输入校验：失败时重算整体失败，保留上一版可执行计划 */
export function validateSortieInputs(mission: Mission | undefined): string | null {
  if (!mission) return '任务不存在或已被删除';
  const home = mission.homePoint;
  if (!home || !Number.isFinite(home[0]) || !Number.isFinite(home[1])) {
    return '未设置起降点：请在「架次编排」页点选或填写起降点';
  }
  if (Math.abs(home[0]) > 180 || Math.abs(home[1]) > 90) {
    return `起降点经纬度超出有效范围（${home[0]}, ${home[1]}）`;
  }
  if (!(mission.focalLength > 0)) return `相机焦距无效（${mission.focalLength} mm）：请检查相机预设`;
  if (!(mission.sensorWidth > 0) || !(mission.sensorHeight > 0)) {
    return `相机传感器尺寸无效（${mission.sensorWidth} × ${mission.sensorHeight} mm）：请检查相机预设`;
  }
  if (!(mission.pixelSize > 0)) return `像元尺寸无效（${mission.pixelSize} μm）：请检查相机预设`;
  return null;
}

/** 单点数据校验：无效点按拒绝处理并写明原因，不阻塞其余航点编排 */
function validateWaypoint(wp: Waypoint): string | null {
  if (!Number.isFinite(wp.lng) || !Number.isFinite(wp.lat) || Math.abs(wp.lng) > 180 || Math.abs(wp.lat) > 90) {
    return `航点 #${wp.seq} 经纬度无效（${wp.lng}, ${wp.lat}）`;
  }
  if (!(wp.speed > 0)) return `航点 #${wp.seq} 航速无效（${wp.speed} m/s）`;
  if (wp.altitude < 20 || wp.altitude > 600) return `航点 #${wp.seq} 相对航高 ${wp.altitude} m 超出 20–600 m 范围`;
  if (wp.hoverSec < 0) return `航点 #${wp.seq} 悬停时间无效（${wp.hoverSec} s）`;
  return null;
}

interface LegPoint {
  lng: number;
  lat: number;
  altitude: number;
}

/** 单段耗时 s = 水平距离 / 航速 + 高差爬升（或下降）时间 */
function legSec(from: LegPoint, to: LegPoint, speedMs: number): number {
  const horizontal = distanceMeters([from.lng, from.lat], [to.lng, to.lat]) / speedMs;
  const dz = to.altitude - from.altitude;
  const vertical = dz >= 0 ? dz / SORTIE_LIMITS.CLIMB_MS : -dz / SORTIE_LIMITS.DESCENT_MS;
  return horizontal + vertical;
}

/** 拍照间隔 m（相机传感器 × 航高 / 焦距 × (1 − 航向重叠率)） */
function photoIntervalM(mission: Mission, altitude: number): number {
  const cover = (mission.sensorHeight * altitude) / mission.focalLength;
  return cover * (1 - SORTIE_LIMITS.OVERLAP_FORWARD_PCT / 100);
}

/** 一个架次（一段连续航点）的完整耗时拆解 */
export interface SortieTiming {
  transitSec: number;
  flightSec: number;
  hoverSec: number;
  photoSec: number;
  returnSec: number;
  totalSec: number;
}

/** 从起降点出发，顺序飞完给定航点并返回起降点的总耗时（全部计入续航预算） */
export function timeSortie(mission: Mission, wps: Waypoint[]): SortieTiming {
  const home: LegPoint = {
    lng: mission.homePoint?.[0] ?? 0,
    lat: mission.homePoint?.[1] ?? 0,
    altitude: 0,
  };
  const first = wps[0];
  const last = wps[wps.length - 1];
  const transitSec = legSec(home, first, first.speed);
  let legFlySec = 0;
  let photoSec = 0;
  for (let i = 1; i < wps.length; i += 1) {
    legFlySec += legSec(wps[i - 1], wps[i], wps[i].speed);
    const legLen = distanceMeters([wps[i - 1].lng, wps[i - 1].lat], [wps[i].lng, wps[i].lat]);
    const interval = photoIntervalM(mission, wps[i].altitude);
    if (interval > 0) photoSec += (legLen / interval) * SORTIE_LIMITS.PHOTO_SEC;
  }
  const flightSec = legFlySec + wps.length * SORTIE_LIMITS.TURN_SEC;
  const hoverSec = wps.reduce((s, w) => s + (w.action === '悬停' ? w.hoverSec : 0), 0);
  const returnSec = legSec(last, home, last.speed);
  return {
    transitSec,
    flightSec,
    hoverSec,
    photoSec,
    returnSec,
    totalSec: transitSec + flightSec + hoverSec + photoSec + returnSec,
  };
}

/** 规划出的一个架次（尚未分配 id 与架次号） */
export interface PlannedSortie extends SortieTiming {
  waypointIds: string[];
  fromSeq: number;
  toSeq: number;
}

export interface PlanOutput {
  sorties: PlannedSortie[];
  rejections: PlanRejection[];
}

/** 单点超容量拒绝原因：写明各段数值与预算来源 */
function overflowReason(mission: Mission, wp: Waypoint, timing: SortieTiming, budgetSec: number): string {
  const m = (sec: number) => (sec / 60).toFixed(1);
  const hoverTurn = timing.hoverSec + SORTIE_LIMITS.TURN_SEC;
  return (
    `航点 #${wp.seq} 单点往返需 ${m(timing.totalSec)} min` +
    `（去程 ${m(timing.transitSec)} + 悬停/转弯 ${m(hoverTurn)} + 回程 ${m(timing.returnSec)}），` +
    `超过单架次可用续航 ${m(budgetSec)} min（${SORTIE_LIMITS.ENDURANCE_MIN} min × ${(1 - SORTIE_LIMITS.RESERVE_RATIO) * 100}%）。` +
    `请缩短起降点到航点的距离、降低悬停时间或提高航速`
  );
}

/**
 * 按航点顺序贪心装架：
 * 逐个把航点追加进当前架次，含回程仍装得下就继续；装不下就封架、以该点另起一架；
 * 单点也超容量 → 拒绝该点并写明原因，继续编排后续航点。
 * 入参 remaining 为「尚未被已执行架次覆盖」的航点（已按 seq 排序）。
 */
export function planSorties(mission: Mission, remaining: Waypoint[]): PlanOutput {
  const budget = sortieBudgetSec();
  const sorties: PlannedSortie[] = [];
  const rejections: PlanRejection[] = [];
  let current: Waypoint[] = [];

  const closeCurrent = () => {
    if (current.length === 0) return;
    const timing = timeSortie(mission, current);
    sorties.push({
      ...timing,
      waypointIds: current.map((w) => w.id),
      fromSeq: current[0].seq,
      toSeq: current[current.length - 1].seq,
    });
    current = [];
  };

  for (const wp of remaining) {
    const invalid = validateWaypoint(wp);
    if (invalid) {
      rejections.push({ waypointId: wp.id, seq: wp.seq, reason: `${invalid}，无法纳入架次`, needSec: 0, budgetSec: budget });
      continue;
    }
    const candidate = [...current, wp];
    if (timeSortie(mission, candidate).totalSec <= budget) {
      current = candidate;
      continue;
    }
    if (current.length > 0) closeCurrent();
    // 新架次从该点开始；单点也超容量则拒绝
    const single = timeSortie(mission, [wp]);
    if (single.totalSec > budget) {
      rejections.push({
        waypointId: wp.id,
        seq: wp.seq,
        reason: overflowReason(mission, wp, single, budget),
        needSec: round(single.totalSec, 1),
        budgetSec: budget,
      });
    } else {
      current = [wp];
    }
  }
  closeCurrent();
  return { sorties, rejections };
}
