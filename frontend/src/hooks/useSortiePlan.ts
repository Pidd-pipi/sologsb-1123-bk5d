import { useEffect, useMemo } from 'react';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { scheduleSortieRecompute, useSortieStore } from '../stores/sortieStore';
import { computeSortieFingerprint } from '../utils/sortiePlan';
import type { Sortie, SortiePlan } from '../types/sortie';

export interface SortiePlanData {
  /** 当前可执行计划（重算失败时仍是上一版可执行计划） */
  currentPlan?: SortiePlan;
  /** 最近一次重算产生的计划（可能是「重算失败」） */
  latestPlan?: SortiePlan;
  /** 当前可执行计划下的架次（含其中已执行的，不含已取消） */
  planSorties: Sortie[];
  /** 跨版本全部已执行架次（冻结不改） */
  executed: Sortie[];
  /** 已失效待重算（防抖中） */
  pending: boolean;
}

/** 读取某任务的架次计划视图：当前可执行版本、其架次与历史已执行架次 */
export function useSortiePlanData(missionId: string): SortiePlanData {
  const plans = useSortieStore((s) => s.plans);
  const sorties = useSortieStore((s) => s.sorties);
  const pendingList = useSortieStore((s) => s.pending);
  return useMemo(() => {
    const missionPlans = plans.filter((p) => p.missionId === missionId).sort((a, b) => b.version - a.version);
    const latestPlan = missionPlans[0];
    const currentPlan = missionPlans.find((p) => p.status === '可执行');
    const planSorties = currentPlan
      ? sorties
          .filter((s) => s.missionId === missionId && s.planVersion === currentPlan.version && s.status !== '已取消')
          .sort((a, b) => a.sortieNo - b.sortieNo)
      : [];
    const executed = sorties
      .filter((s) => s.missionId === missionId && s.status === '已执行')
      .sort((a, b) => a.sortieNo - b.sortieNo);
    return { currentPlan, latestPlan, planSorties, executed, pending: pendingList.includes(missionId) };
  }, [plans, sorties, pendingList, missionId]);
}

/**
 * 兜底重算：航点高度/顺序、相机预设、起降点变化 → 指纹变化 → 立即失效重算。
 * 各 store 变更时已会调度重算，这里兜住其余入口（如首次进入页面、外部数据迁移）；
 * 统一走防抖通道，避免与 store 内调度并发。
 */
export function useSortieAutoRecomputeGuard(missionId: string): void {
  const mission = useMissionStore((s) => s.items.find((m) => m.id === missionId));
  const allWaypoints = useWaypointStore((s) => s.items);
  const plans = useSortieStore((s) => s.plans);
  const fingerprint = useMemo(() => {
    const wps = allWaypoints.filter((w) => w.missionId === missionId).sort((a, b) => a.seq - b.seq);
    return computeSortieFingerprint(mission, wps);
  }, [mission, allWaypoints, missionId]);
  const latestFingerprint = useMemo(() => {
    const latest = plans.filter((p) => p.missionId === missionId).sort((a, b) => b.version - a.version)[0];
    return latest?.fingerprint;
  }, [plans, missionId]);
  useEffect(() => {
    // 仅当输入指纹与最新计划不一致时才失效重算（含首次进入页面）
    if (!missionId || !mission) return;
    if (fingerprint !== latestFingerprint) scheduleSortieRecompute(missionId);
  }, [fingerprint, latestFingerprint, missionId, mission]);
}
