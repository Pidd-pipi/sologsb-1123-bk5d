import { create } from 'zustand';
import { db } from '../utils/db';
import { buildPlan, computeInputHash } from '../utils/sortie';
import { DEFAULT_BATTERY_CONFIG, type SortiePlan } from '../types/sortie';

interface SortieState {
  plans: SortiePlan[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 按当前航点/相机/起降点重算并落库；成功返回新计划，失败保留上一版并返回 null */
  recompute: (missionId: string) => Promise<SortiePlan | null>;
  /** 标记某架次已执行（冻结，不因重算改写） */
  markFlown: (planId: string, sortieNo: number) => Promise<void>;
  removeByMission: (missionId: string) => Promise<void>;
  currentPlan: (missionId: string) => SortiePlan | undefined;
}

export const useSortieStore = create<SortieState>((set, get) => ({
  plans: [],
  loaded: false,
  async load() {
    const rows = await db.sortiePlans.toArray();
    rows.sort((a, b) => b.version - a.version);
    set({ plans: rows, loaded: true });
  },
  async recompute(missionId) {
    const mission = await db.missions.get(missionId);
    if (!mission) return null;
    const waypoints = await db.waypoints.where('missionId').equals(missionId).toArray();
    waypoints.sort((a, b) => a.seq - b.seq);

    // 起降点：优先取任务显式设置，缺省取首个航点
    const home: [number, number] | undefined =
      mission.homeLng !== undefined && mission.homeLat !== undefined
        ? [mission.homeLng, mission.homeLat]
        : waypoints.length > 0
          ? [waypoints[0].lng, waypoints[0].lat]
          : undefined;
    const camera = {
      sensorWidth: mission.sensorWidth,
      sensorHeight: mission.sensorHeight,
      focalLength: mission.focalLength,
      pixelSize: mission.pixelSize,
    };
    const options = {
      enduranceMin: DEFAULT_BATTERY_CONFIG.enduranceMin,
      reserveFraction: DEFAULT_BATTERY_CONFIG.reserveFraction,
    };
    const hash = computeInputHash(home, waypoints, camera, options);

    const existing = get().plans.filter((p) => p.missionId === missionId);
    const current = existing.find((p) => p.status === 'current');
    // 输入未变 → 不产生新版本
    if (current && current.inputHash === hash) return current;

    const nextVersion = existing.reduce((m, p) => Math.max(m, p.version), 0) + 1;
    const plan = buildPlan({
      missionId,
      version: nextVersion,
      home,
      waypoints,
      camera,
      options,
      supersedesId: current?.id,
    });

    if (plan.status === 'failed') {
      // 重算失败：保留上一版可执行计划，仅登记一次失败尝试（同指纹不重复落库）
      const alreadyFailed = existing.some((p) => p.status === 'failed' && p.inputHash === hash);
      if (!alreadyFailed) {
        await db.sortiePlans.put(plan);
        set({ plans: [plan, ...get().plans] });
      }
      return null;
    }

    // 成功：旧 current 置为 superseded（已执行架次原样保留，不改写）
    if (current) {
      await db.sortiePlans.put({ ...current, status: 'superseded' });
    }
    await db.sortiePlans.put(plan);
    set({
      plans: [
        plan,
        ...get().plans.map((p) => (p.id === current?.id ? { ...p, status: 'superseded' as const } : p)),
      ],
    });
    return plan;
  },
  async markFlown(planId, sortieNo) {
    const plan = get().plans.find((p) => p.id === planId);
    if (!plan) return;
    const sorties = plan.sorties.map((s) =>
      s.sortieNo === sortieNo && s.status === 'planned'
        ? { ...s, status: 'flown' as const, executedAt: Date.now() }
        : s,
    );
    const next: SortiePlan = { ...plan, sorties };
    await db.sortiePlans.put(next);
    set({ plans: get().plans.map((p) => (p.id === planId ? next : p)) });
  },
  async removeByMission(missionId) {
    await db.sortiePlans.where('missionId').equals(missionId).delete();
    set({ plans: get().plans.filter((p) => p.missionId !== missionId) });
  },
  currentPlan(missionId) {
    return get().plans.find((p) => p.missionId === missionId && p.status === 'current');
  },
}));
