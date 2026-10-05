import { create } from 'zustand';
import { db } from '../utils/db';
import { newId, round } from '../utils/id';
import { computeSortieFingerprint, planSorties, sortieBudgetSec, validateSortieInputs } from '../utils/sortiePlan';
import type { Sortie, SortiePlan } from '../types/sortie';

interface SortieState {
  plans: SortiePlan[];
  sorties: Sortie[];
  /** 已失效待重算（防抖中）的任务 id 列表 */
  pending: string[];
  loaded: boolean;
  load: () => Promise<void>;
  /**
   * 指纹变化时立即重算：
   * - 成功 → 旧可执行版本置「已失效」、其未飞架次置「已取消」，生成新版本与待飞架次；
   * - 失败 → 只追加一条「重算失败」版本记录，上一版可执行计划原样保留，恢复后继续。
   * 已执行架次任何情况下都不改动。同一任务的重算串行执行，期间的变更排队补算。
   */
  recompute: (missionId: string) => Promise<SortiePlan | undefined>;
  /** 标记架次已执行（冻结，后续重算不再改动它，只为剩余航点排新架次） */
  markExecuted: (sortieId: string) => Promise<void>;
}

const recomputeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const recomputeInflight = new Set<string>();
const recomputeQueued = new Set<string>();

export const useSortieStore = create<SortieState>((set, get) => {
  /** 单次重算主体（不做并发控制，由 recompute 串行化） */
  const runRecompute = async (missionId: string): Promise<SortiePlan | undefined> => {
    const mission = await db.missions.get(missionId);
    if (!mission) return undefined;
    const waypoints = (await db.waypoints.where('missionId').equals(missionId).toArray()).sort((a, b) => a.seq - b.seq);
    const fingerprint = computeSortieFingerprint(mission, waypoints);
    const latest = get()
      .plans.filter((p) => p.missionId === missionId)
      .sort((a, b) => b.version - a.version)[0];
    // 指纹一致（含与最近一次失败记录一致）→ 无需重算
    if (latest && latest.fingerprint === fingerprint) return latest;

    const version = (latest?.version ?? 0) + 1;
    const now = Date.now();

    // 计划级输入无效 → 重算失败：保留上一版可执行计划，仅记录失败版本
    const error = validateSortieInputs(mission);
    if (error) {
      const failed: SortiePlan = {
        id: newId('splan'),
        missionId,
        version,
        fingerprint,
        status: '重算失败',
        error,
        rejections: [],
        createdAt: now,
      };
      await db.sortiePlans.put(failed);
      set((s) => ({ plans: [...s.plans, failed] }));
      return failed;
    }

    // 已执行架次冻结：只为其未覆盖的航点重排架次
    const executed = get().sorties.filter((s) => s.missionId === missionId && s.status === '已执行');
    const covered = new Set(executed.flatMap((s) => s.waypointIds));
    const remaining = waypoints.filter((w) => !covered.has(w.id));
    const { sorties: planned, rejections } = planSorties(mission, remaining);

    const maxNo = Math.max(0, ...get().sorties.filter((s) => s.missionId === missionId).map((s) => s.sortieNo));
    const budget = sortieBudgetSec();
    const records: Sortie[] = planned.map((p, i) => ({
      id: newId('sortie'),
      missionId,
      planVersion: version,
      sortieNo: maxNo + 1 + i,
      waypointIds: p.waypointIds,
      fromSeq: p.fromSeq,
      toSeq: p.toSeq,
      transitSec: round(p.transitSec, 1),
      flightSec: round(p.flightSec, 1),
      hoverSec: round(p.hoverSec, 1),
      photoSec: round(p.photoSec, 1),
      returnSec: round(p.returnSec, 1),
      totalSec: round(p.totalSec, 1),
      budgetSec: budget,
      status: '待飞',
      createdAt: now,
    }));
    const plan: SortiePlan = {
      id: newId('splan'),
      missionId,
      version,
      fingerprint,
      status: '可执行',
      rejections,
      createdAt: now,
    };

    // 旧可执行版本 → 已失效；其未飞架次 → 已取消（已执行架次不动）
    const stalePlans = get().plans.filter((p) => p.missionId === missionId && p.status === '可执行');
    const stalePlanIds = new Set(stalePlans.map((p) => p.id));
    const staleVersions = new Set(stalePlans.map((p) => p.version));
    const cancelledIds = new Set(
      get()
        .sorties.filter((s) => s.missionId === missionId && s.status === '待飞' && staleVersions.has(s.planVersion))
        .map((s) => s.id),
    );

    await db.transaction('rw', [db.sortiePlans, db.sorties], async () => {
      if (stalePlans.length > 0) {
        await db.sortiePlans.bulkPut(stalePlans.map((p) => ({ ...p, status: '已失效' as const })));
      }
      if (cancelledIds.size > 0) {
        await db.sorties.where('id').anyOf([...cancelledIds]).modify({ status: '已取消' });
      }
      await db.sortiePlans.put(plan);
      await db.sorties.bulkPut(records);
    });
    set((s) => ({
      plans: [...s.plans.map((p) => (stalePlanIds.has(p.id) ? { ...p, status: '已失效' as const } : p)), plan],
      sorties: [...s.sorties.map((x) => (cancelledIds.has(x.id) ? { ...x, status: '已取消' as const } : x)), ...records],
    }));
    return plan;
  };

  return {
    plans: [],
    sorties: [],
    pending: [],
    loaded: false,
    async load() {
      const [plans, sorties] = await Promise.all([db.sortiePlans.toArray(), db.sorties.toArray()]);
      set({ plans, sorties, loaded: true });
    },
    async recompute(missionId) {
      // 同一任务串行：重算期间的再次触发先排队，结束后补算一次
      if (recomputeInflight.has(missionId)) {
        recomputeQueued.add(missionId);
        return undefined;
      }
      recomputeInflight.add(missionId);
      try {
        let result = await runRecompute(missionId);
        while (recomputeQueued.has(missionId)) {
          recomputeQueued.delete(missionId);
          result = await runRecompute(missionId);
        }
        return result;
      } finally {
        recomputeInflight.delete(missionId);
        set((s) => ({ pending: s.pending.filter((x) => x !== missionId) }));
      }
    },
    async markExecuted(sortieId) {
      // 只有当前待飞架次可以标记已执行（已取消/已执行的不接受变更）
      const target = get().sorties.find((s) => s.id === sortieId);
      if (!target || target.status !== '待飞') return;
      const executedAt = Date.now();
      await db.sorties.update(sortieId, { status: '已执行', executedAt });
      set((s) => ({
        sorties: s.sorties.map((x) => (x.id === sortieId ? { ...x, status: '已执行', executedAt } : x)),
      }));
    },
  };
});

/**
 * 航点高度/顺序、相机预设、起降点变化后调用：先把任务标为「待重算」（计划立即视为失效），
 * 300 ms 防抖后重算，避免批量修改（如统一改高度）产生版本风暴。
 */
export function scheduleSortieRecompute(missionId: string): void {
  if (!missionId) return;
  useSortieStore.setState((s) => ({ pending: s.pending.includes(missionId) ? s.pending : [...s.pending, missionId] }));
  const prev = recomputeTimers.get(missionId);
  if (prev) clearTimeout(prev);
  recomputeTimers.set(
    missionId,
    setTimeout(() => {
      recomputeTimers.delete(missionId);
      void useSortieStore.getState().recompute(missionId);
    }, 300),
  );
}
