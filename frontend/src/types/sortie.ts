/** 架次状态：待飞（在当前可执行计划内）、已执行（冻结不改）、已取消（被新版本取代） */
export type SortieStatus = '待飞' | '已执行' | '已取消';

export const SORTIE_STATUSES: SortieStatus[] = ['待飞', '已执行', '已取消'];

/** 架次计划状态 */
export type SortiePlanStatus = '可执行' | '已失效' | '重算失败';

export const SORTIE_PLAN_STATUSES: SortiePlanStatus[] = ['可执行', '已失效', '重算失败'];

/** 单点拒绝记录（挂在计划版本上）：单点往返也装不进预算，或数据无效 */
export interface PlanRejection {
  waypointId: string;
  seq: number;
  /** 拒绝原因（写明超出的数值） */
  reason: string;
  /** 单点往返所需 s */
  needSec: number;
  /** 单架次预算 s */
  budgetSec: number;
}

/** 架次计划（每次重算生成一个版本，旧版本保留用于成果归属追溯） */
export interface SortiePlan {
  id: string;
  missionId: string;
  /** 版本号，任务内单调递增（含失败版本） */
  version: number;
  /** 输入指纹：航点高度/顺序/相机预设/起降点任一变化即变 */
  fingerprint: string;
  status: SortiePlanStatus;
  /** 重算失败原因（status=重算失败 时填写；此时上一版可执行计划继续有效） */
  error?: string;
  /** 单点超容量 / 数据无效的拒绝记录 */
  rejections: PlanRejection[];
  createdAt: number;
}

/** 架次：从起降点出发，连续航段 + 悬停 + 回程全部计入 20 min × 80% 预算 */
export interface Sortie {
  id: string;
  missionId: string;
  /** 所属计划版本号 */
  planVersion: number;
  /** 架次号（任务内唯一，跨版本不复用，保证成果归属稳定） */
  sortieNo: number;
  /** 覆盖航点 id（按飞行顺序） */
  waypointIds: string[];
  /** 覆盖航点序号范围（展示用） */
  fromSeq: number;
  toSeq: number;
  /** 去程（起降点→首航点，含爬升）s */
  transitSec: number;
  /** 航段飞行 + 转弯附加 s */
  flightSec: number;
  /** 悬停 s */
  hoverSec: number;
  /** 拍照附加 s（相机预设经拍照间隔影响张数） */
  photoSec: number;
  /** 回程（末航点→起降点，含下降）s */
  returnSec: number;
  /** 合计 s */
  totalSec: number;
  /** 单架次预算 s（20 min × 80%） */
  budgetSec: number;
  status: SortieStatus;
  createdAt: number;
  /** 执行完成时间（status=已执行 时填写） */
  executedAt?: number;
}
