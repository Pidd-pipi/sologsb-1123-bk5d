import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Descriptions, Progress, Row, Space, Table, Tag, Typography, type TableProps } from 'antd';
import { AimOutlined, CheckCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import { useSortieStore } from '../stores/sortieStore';
import { useSortieAutoRecomputeGuard, useSortiePlanData } from '../hooks/useSortiePlan';
import AmapRouteView from '../components/common/AmapRouteView';
import { SORTIE_LIMITS, sortieBudgetSec } from '../utils/sortiePlan';
import { calcGsd } from '../utils/geoCalc';
import type { Sortie, SortiePlan } from '../types/sortie';
import type { Waypoint } from '../types/waypoint';
import type { ImageAssetDraft } from '../types/imageasset';

const minFmt = (sec: number) => (sec / 60).toFixed(1);

const SORTIE_STATUS_COLOR: Record<Sortie['status'], string> = { 待飞: 'blue', 已执行: 'green', 已取消: 'default' };
const PLAN_STATUS_COLOR: Record<SortiePlan['status'], string> = { 可执行: 'green', 已失效: 'default', 重算失败: 'red' };

/**
 * /missions/:id/sorties 架次编排：
 * 从起降点出发按航点顺序装架，连续航段/悬停/回程都计入 20 min × 80% 预算；
 * 航点高度/顺序/相机预设/起降点变化 → 立即失效重算；已执行架次冻结，成果关联当时版本。
 */
export default function SortiePlanner() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const updateMission = useMissionStore((s) => s.update);
  const waypointItems = useWaypointStore((s) => s.items);
  const assets = useAssetStore((s) => s.items);
  const addAssets = useAssetStore((s) => s.addMany);
  const allPlans = useSortieStore((s) => s.plans);
  const allSorties = useSortieStore((s) => s.sorties);
  const recompute = useSortieStore((s) => s.recompute);
  const markExecuted = useSortieStore((s) => s.markExecuted);

  const mission = missions.find((m) => m.id === id);
  const waypoints = useMemo(
    () => waypointItems.filter((w) => w.missionId === id).sort((a, b) => a.seq - b.seq),
    [waypointItems, id],
  );
  const { currentPlan, latestPlan, planSorties, executed, pending } = useSortiePlanData(id);
  useSortieAutoRecomputeGuard(id);

  const [picking, setPicking] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const budget = sortieBudgetSec();
  const missionPlans = useMemo(
    () => allPlans.filter((p) => p.missionId === id).sort((a, b) => b.version - a.version),
    [allPlans, id],
  );
  /** 主表行：历史已执行架次 + 当前计划的待飞/已执行架次（按架次号排列，已取消的进版本史） */
  const rows = useMemo(() => {
    const map = new Map<number, Sortie>();
    [...executed, ...planSorties].forEach((s) => map.set(s.sortieNo, s));
    return [...map.values()].sort((a, b) => a.sortieNo - b.sortieNo);
  }, [executed, planSorties]);
  const nextSortie = planSorties.find((s) => s.status === '待飞');
  const rejectedCount = currentPlan?.rejections.length ?? 0;

  const catalogedCount = (sortieId: string) => assets.filter((a) => a.sortieId === sortieId).length;

  /** 编目某已执行架次的成果：按当时覆盖的航点生成影像条目并关联该架次与计划版本 */
  const catalogSortieAssets = async (sortie: Sortie) => {
    if (!mission) return;
    const existing = catalogedCount(sortie.id);
    if (existing > 0) {
      setToast(`架次 #${sortie.sortieNo} 已编目 ${existing} 张成果，未重复生成`);
      return;
    }
    const wps = sortie.waypointIds
      .map((wid) => waypointItems.find((w) => w.id === wid))
      .filter((w): w is Waypoint => !!w);
    if (wps.length === 0) {
      setError(`架次 #${sortie.sortieNo} 覆盖的航点已不存在，无法编目`);
      return;
    }
    const startNo = assets.filter((a) => a.missionId === id).length + 1;
    const no = String(sortie.sortieNo).padStart(2, '0');
    const drafts: ImageAssetDraft[] = wps.map((w, index) => ({
      missionId: mission.id,
      imageNo: `IMG_S${no}_${String(1000 + startNo + index)}`,
      lng: w.lng,
      lat: w.lat,
      altitude: w.altitude,
      gsd: calcGsd(mission.pixelSize, w.altitude, mission.focalLength),
      overlap: SORTIE_LIMITS.OVERLAP_FORWARD_PCT,
      tiltAngle: Math.abs(w.gimbalPitch + 90),
      shotAt: (sortie.executedAt ?? Date.now()) + index * 1000,
      quality: '合格',
      folder: `/${mission.missionNo}/S${no}`,
      sortieId: sortie.id,
      planVersion: sortie.planVersion,
    }));
    await addAssets(drafts);
    setError('');
    setToast(`已把架次 #${sortie.sortieNo} 的 ${drafts.length} 张成果编目，关联计划 v${sortie.planVersion}`);
  };

  const pickHome = async (lng: number, lat: number) => {
    if (!mission) return;
    await updateMission(mission.id, { homePoint: [Number(lng.toFixed(6)), Number(lat.toFixed(6))] });
    setPicking(false);
    setToast('起降点已更新，架次计划已自动失效并重算');
  };

  const sortieColumns: NonNullable<TableProps<Sortie>['columns']> = [
    { title: '架次', width: 70, render: (_: unknown, r: Sortie) => `#${r.sortieNo}` },
    { title: '计划版本', dataIndex: 'planVersion', width: 90, render: (v: number) => `v${v}` },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: Sortie['status']) => <Tag color={SORTIE_STATUS_COLOR[v]}>{v}</Tag>,
    },
    {
      title: '航点范围',
      width: 140,
      render: (_: unknown, r: Sortie) => `#${r.fromSeq} – #${r.toSeq}（${r.waypointIds.length} 点）`,
    },
    { title: '去程 min', dataIndex: 'transitSec', width: 90, render: minFmt },
    { title: '航段+转弯 min', dataIndex: 'flightSec', width: 110, render: minFmt },
    { title: '悬停 min', dataIndex: 'hoverSec', width: 90, render: minFmt },
    { title: '拍照 min', dataIndex: 'photoSec', width: 90, render: minFmt },
    { title: '回程 min', dataIndex: 'returnSec', width: 90, render: minFmt },
    {
      title: '合计 min',
      dataIndex: 'totalSec',
      width: 90,
      render: (v: number) => <strong>{minFmt(v)}</strong>,
    },
    {
      title: '预算占比',
      width: 130,
      render: (_: unknown, r: Sortie) => (
        <Progress
          size="small"
          percent={Math.round((r.totalSec / r.budgetSec) * 100)}
          status={r.totalSec > r.budgetSec ? 'exception' : 'normal'}
        />
      ),
    },
    {
      title: '操作',
      width: 230,
      render: (_: unknown, r: Sortie) => {
        if (r.status === '待飞') {
          return (
            <Button
              size="small"
              type="primary"
              ghost
              icon={<CheckCircleOutlined />}
              onClick={async () => {
                await markExecuted(r.id);
                setToast(`架次 #${r.sortieNo} 已标记为已执行（冻结，后续重算不再改动）`);
              }}
            >
              标记已执行
            </Button>
          );
        }
        if (r.status === '已执行') {
          const count = catalogedCount(r.id);
          return count > 0 ? (
            <Tag color="geekblue">已编目 {count} 张 · v{r.planVersion}</Tag>
          ) : (
            <Button size="small" onClick={() => catalogSortieAssets(r)}>
              编目该架次成果
            </Button>
          );
        }
        return '—';
      },
    },
  ];

  const planColumns: NonNullable<TableProps<SortiePlan>['columns']> = [
    { title: '版本', width: 70, render: (_: unknown, p: SortiePlan) => `v${p.version}` },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: SortiePlan['status']) => <Tag color={PLAN_STATUS_COLOR[v]}>{v}</Tag>,
    },
    {
      title: '架次 / 拒绝',
      width: 110,
      render: (_: unknown, p: SortiePlan) => {
        const n = allSorties.filter((s) => s.missionId === id && s.planVersion === p.version).length;
        return `${n} 架 / ${p.rejections.length} 拒`;
      },
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (v: number) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '说明',
      render: (_: unknown, p: SortiePlan) =>
        p.error ? <Typography.Text type="danger">{p.error}</Typography.Text> : '—',
    },
  ];

  if (!mission) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该任务（可能已被删除）" />
        <Link to="/missions">返回任务台账</Link>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          架次编排 · {mission.missionNo}
        </Typography.Title>
        <Tag color="cyan">{mission.purpose}</Tag>
        <Tag>航点 {waypoints.length} 个</Tag>
        {currentPlan ? <Tag color="green">当前计划 v{currentPlan.version} 可执行</Tag> : <Tag>暂无可执行计划</Tag>}
        {pending ? <Tag color="gold">输入已变更，正在重算…</Tag> : null}
        {nextSortie ? <Tag color="blue">下一架次 #{nextSortie.sortieNo}</Tag> : null}
        {rejectedCount > 0 ? <Tag color="red">单点拒绝 {rejectedCount} 个</Tag> : null}
        <div style={{ flex: 1 }} />
        <Button icon={<ReloadOutlined />} onClick={() => void recompute(id)}>
          立即重算
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/route`}>航线规划</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/waypoints`}>航点明细</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/assets`}>成果编目</Link>
        </Button>
        <Button type="link">
          <Link to="/missions">返回台账</Link>
        </Button>
      </Space>

      {latestPlan?.status === '重算失败' ? (
        <Alert
          type="error"
          showIcon
          message={`第 v${latestPlan.version} 次架次重算失败`}
          description={`${latestPlan.error}。${
            currentPlan
              ? `已保留上一版可执行计划 v${currentPlan.version}，修正数据后将自动重算并继续。`
              : '暂无可执行的历史计划，请修正数据后重算。'
          }`}
        />
      ) : null}
      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Row gutter={14}>
        <Col span={15}>
          <Card
            size="small"
            title="航迹与起降点"
            extra={
              <Button size="small" icon={<AimOutlined />} type={picking ? 'primary' : 'default'} onClick={() => setPicking((v) => !v)}>
                {picking ? '点击网格设置起降点…' : '在网格上点选起降点'}
              </Button>
            }
          >
            <AmapRouteView
              mission={mission}
              waypoints={waypoints}
              altitude={waypoints[0]?.altitude ?? 120}
              height={380}
              homePoint={mission.homePoint}
              onPickPoint={picking ? pickHome : undefined}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              起降点：
              {mission.homePoint ? `${mission.homePoint[0].toFixed(6)}, ${mission.homePoint[1].toFixed(6)}` : '未设置'}
              （每个架次从起降点出发并返回；修改起降点、航点高度/顺序或相机预设都会使架次立即失效并重算）
            </Typography.Text>
          </Card>

          <Card size="small" title={`架次表（当前计划 ${currentPlan ? `v${currentPlan.version}` : '—'}，含历史已执行架次）`} style={{ marginTop: 14 }}>
            <Table<Sortie>
              rowKey="id"
              size="small"
              columns={sortieColumns}
              dataSource={rows}
              pagination={false}
              scroll={{ x: 1200 }}
              locale={{ emptyText: '暂无可执行架次：请先录入航点，或查看右侧失败原因' }}
            />
          </Card>

          {currentPlan && currentPlan.rejections.length > 0 ? (
            <Card size="small" title={`单点拒绝（${currentPlan.rejections.length} 个航点未排入任何架次）`} style={{ marginTop: 14 }}>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {currentPlan.rejections.map((r) => (
                  <Alert key={r.waypointId} type="error" showIcon message={`航点 #${r.seq} 被拒绝`} description={r.reason} />
                ))}
              </Space>
            </Card>
          ) : null}
        </Col>

        <Col span={9}>
          <Card size="small" title="续航模型（单架次预算）">
            <Descriptions size="small" column={1} colon={false}>
              <Descriptions.Item label="标称续航">{SORTIE_LIMITS.ENDURANCE_MIN} min</Descriptions.Item>
              <Descriptions.Item label="预留电量">{(SORTIE_LIMITS.RESERVE_RATIO * 100).toFixed(0)} %</Descriptions.Item>
              <Descriptions.Item label="单架次可用预算">
                <strong>{minFmt(budget)} min（{budget} s）</strong>
              </Descriptions.Item>
              <Descriptions.Item label="计入项">去程（含爬升）+ 连续航段（含高差与转弯）+ 悬停 + 拍照 + 回程（含下降）</Descriptions.Item>
              <Descriptions.Item label="爬升 / 下降">
                {SORTIE_LIMITS.CLIMB_MS} m/s / {SORTIE_LIMITS.DESCENT_MS} m/s
              </Descriptions.Item>
              <Descriptions.Item label="转弯附加">{SORTIE_LIMITS.TURN_SEC} s/航点</Descriptions.Item>
              <Descriptions.Item label="拍照附加">
                {SORTIE_LIMITS.PHOTO_SEC} s/张（张数 = 航段长 ÷ 拍照间隔，随相机预设变化）
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card size="small" title="计划版本史（重算失败保留上一版可执行计划）" style={{ marginTop: 14 }}>
            <Table<SortiePlan>
              rowKey="id"
              size="small"
              columns={planColumns}
              dataSource={missionPlans}
              pagination={false}
              scroll={{ x: 560 }}
              locale={{ emptyText: '暂无架次计划版本' }}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
