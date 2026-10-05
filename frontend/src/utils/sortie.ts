import type { LngLat } from '../types/mission';
import type { Waypoint } from '../types/waypoint';
import {
  DEFAULT_BATTERY_CONFIG,
  type PackOptions,
  type PackResult,
  type RejectedWaypoint,
  type Sortie,
  type SortiePlan,
  type SortieTiming,
} from '../types/sortie';
import { distanceMeters } from './geoCalc';
import { newId, round } from './id';

/** 每个航点的转弯附加 s（与 geoCalc.estimateDuration 口径一致） */
const TURN_SEC_PER_WP = 4;
/** 航点未设航速时的兜底 m/s */
const FALLBACK_SPEED = 8;

function legSpeed(w: Waypoint, fallback: number): number {
  return w.speed > 0 ? w.speed : fallback;
}

function hoverMinOf(w: Waypoint): number {
  return w.action === '悬停' && w.hoverSec > 0 ? w.hoverSec / 60 : 0;
}

/** 单点往返（起降点 → 航点 → 起降点）+ 悬停 + 转弯所需 min */
export function soloMinutes(home: LngLat, w: Waypoint, fallbackSpeed: number): number {
  const v = legSpeed(w, fallbackSpeed);
  const outSec = distanceMeters(home, [w.lng, w.lat]) / v;
  const hoverMin = hoverMinOf(w);
  const turnMin = TURN_SEC_PER_WP / 60;
  return (outSec * 2) / 60 + hoverMin + turnMin;
}

/** 架次 i..j（含两端）的时间构成：出航 + 连续航段 + 悬停 + 转弯 + 回程 */
export function sortieMinutes(
  home: LngLat,
  wps: Waypoint[],
  i: number,
  j: number,
  fallbackSpeed: number,
): Omit<SortieTiming, 'batteryUsedPct' | 'batteryRemainPct'> {
  const outSec = distanceMeters(home, [wps[i].lng, wps[i].lat]) / legSpeed(wps[i], fallbackSpeed);
  let segSec = 0;
  for (let k = i + 1; k <= j; k += 1) {
    segSec +=
      distanceMeters([wps[k - 1].lng, wps[k - 1].lat], [wps[k].lng, wps[k].lat]) / legSpeed(wps[k], fallbackSpeed);
  }
  let hoverMin = 0;
  for (let k = i; k <= j; k += 1) hoverMin += hoverMinOf(wps[k]);
  const turnMin = ((j - i + 1) * TURN_SEC_PER_WP) / 60;
  const retSec = distanceMeters([wps[j].lng, wps[j].lat], home) / legSpeed(wps[j], fallbackSpeed);
  const outboundMin = outSec / 60;
  const segmentsMin = segSec / 60;
  const returnMin = retSec / 60;
  return {
    outboundMin,
    segmentsMin,
    hoverMin,
    turnMin,
    returnMin,
    totalMin: outboundMin + segmentsMin + hoverMin + turnMin + returnMin,
  };
}

/**
 * 按航点顺序编排架次：
 * 从起降点出发，连续航段、悬停、回程全部计入续航并留足电量余量；
 * 一架装不下就排下一架（每架都从起降点出发）；
 * 单点往返 + 悬停即超过可用续航则拒绝该点并写明原因。
 */
export function packSorties(home: LngLat | undefined, waypoints: Waypoint[], options: PackOptions = {}): PackResult {
  const enduranceMin = options.enduranceMin ?? DEFAULT_BATTERY_CONFIG.enduranceMin;
  const reserveFraction = options.reserveFraction ?? DEFAULT_BATTERY_CONFIG.reserveFraction;
  const fallbackSpeed = options.fallbackSpeed ?? FALLBACK_SPEED;

  if (!Number.isFinite(enduranceMin) || enduranceMin <= 0) {
    return { ok: false, reason: `标称续航配置无效（${enduranceMin} min）` };
  }
  if (!Number.isFinite(reserveFraction) || reserveFraction < 0 || reserveFraction >= 1) {
    return { ok: false, reason: `电量余量配置无效（${reserveFraction}）` };
  }
  if (!home || !Number.isFinite(home[0]) || !Number.isFinite(home[1])) {
    return { ok: false, reason: '未设置有效的起降点，无法编排架次' };
  }

  const usableMin = enduranceMin * (1 - reserveFraction);
  const ordered = [...waypoints].sort((a, b) => a.seq - b.seq);
  for (const w of ordered) {
    if (!Number.isFinite(w.lng) || !Number.isFinite(w.lat)) {
      return { ok: false, reason: `航点 #${w.seq} 坐标无效，无法计算航程` };
    }
  }

  if (ordered.length === 0) {
    return { ok: true, sorties: [], rejected: [], usableMin: round(usableMin, 1) };
  }

  const sorties: Sortie[] = [];
  const rejected: RejectedWaypoint[] = [];
  let i = 0;
  let sortieNo = 1;
  while (i < ordered.length) {
    const solo = soloMinutes(home, ordered[i], fallbackSpeed);
    if (solo > usableMin) {
      rejected.push({
        waypointId: ordered[i].id,
        seq: ordered[i].seq,
        soloMin: round(solo, 1),
        reason: `航点 #${ordered[i].seq} 单点往返 + 悬停需 ${round(solo, 1)} min，超过单架次可用续航 ${round(
          usableMin,
          1,
        )} min（${enduranceMin} min 续航留 ${Math.round(reserveFraction * 100)}% 余量）`,
      });
      i += 1;
      continue;
    }
    // 贪心：在不超过可用续航的前提下，尽量多装后续航点
    let best = i;
    let j = i;
    while (j < ordered.length) {
      const { totalMin } = sortieMinutes(home, ordered, i, j, fallbackSpeed);
      if (totalMin <= usableMin) {
        best = j;
        j += 1;
      } else {
        break;
      }
    }
    const t = sortieMinutes(home, ordered, i, best, fallbackSpeed);
    const batteryUsedPct = round((t.totalMin / enduranceMin) * 100, 1);
    sorties.push({
      sortieNo: sortieNo++,
      waypointIds: ordered.slice(i, best + 1).map((w) => w.id),
      waypointSeqs: ordered.slice(i, best + 1).map((w) => w.seq),
      timing: {
        outboundMin: round(t.outboundMin, 1),
        segmentsMin: round(t.segmentsMin, 1),
        hoverMin: round(t.hoverMin, 1),
        turnMin: round(t.turnMin, 1),
        returnMin: round(t.returnMin, 1),
        totalMin: round(t.totalMin, 1),
        batteryUsedPct,
        batteryRemainPct: round(100 - batteryUsedPct, 1),
      },
      status: 'planned',
    });
    i = best + 1;
  }

  return { ok: true, sorties, rejected, usableMin: round(usableMin, 1) };
}

/** FNV-1a 32 位哈希（稳定、无依赖） */
function fnv1a32(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 计算输入指纹：起降点 + 航点(序号/坐标/高度/航速/悬停/动作) + 相机参数 + 续航配置 */
export function computeInputHash(
  home: LngLat | undefined,
  waypoints: Waypoint[],
  camera: { sensorWidth: number; sensorHeight: number; focalLength: number; pixelSize: number },
  options: PackOptions = {},
): string {
  const enduranceMin = options.enduranceMin ?? DEFAULT_BATTERY_CONFIG.enduranceMin;
  const reserveFraction = options.reserveFraction ?? DEFAULT_BATTERY_CONFIG.reserveFraction;
  const ordered = [...waypoints].sort((a, b) => a.seq - b.seq);
  const payload = JSON.stringify({
    home: home ? [round(home[0], 6), round(home[1], 6)] : null,
    wps: ordered.map((w) => [w.id, w.seq, round(w.lng, 6), round(w.lat, 6), w.altitude, w.speed, w.hoverSec, w.action]),
    cam: [camera.sensorWidth, camera.sensorHeight, camera.focalLength, camera.pixelSize],
    cfg: [enduranceMin, reserveFraction],
  });
  return fnv1a32(payload);
}

export interface BuildPlanInput {
  missionId: string;
  version: number;
  home: LngLat | undefined;
  waypoints: Waypoint[];
  camera: { sensorWidth: number; sensorHeight: number; focalLength: number; pixelSize: number };
  options?: PackOptions;
  supersedesId?: string;
}

/** 生成一版架次计划（成功为 current，失败为 failed 并写明原因） */
export function buildPlan(input: BuildPlanInput): SortiePlan {
  const { missionId, version, home, waypoints, camera, options, supersedesId } = input;
  const enduranceMin = options?.enduranceMin ?? DEFAULT_BATTERY_CONFIG.enduranceMin;
  const reserveFraction = options?.reserveFraction ?? DEFAULT_BATTERY_CONFIG.reserveFraction;
  const usableMin = enduranceMin * (1 - reserveFraction);
  const inputHash = computeInputHash(home, waypoints, camera, options);
  const packed = packSorties(home, waypoints, options);
  const base = {
    id: newId('plan'),
    missionId,
    version,
    inputHash,
    computedAt: Date.now(),
    enduranceMin,
    reserveFraction,
    usableMin: round(usableMin, 1),
    homeLng: home?.[0] ?? 0,
    homeLat: home?.[1] ?? 0,
    supersedesId,
  };
  if (!packed.ok) {
    return { ...base, status: 'failed', sorties: [], rejected: [], failureReason: packed.reason };
  }
  return { ...base, status: 'current', sorties: packed.sorties, rejected: packed.rejected };
}
