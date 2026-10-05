import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { EnvironmentOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import { useSortieStore } from '../stores/sortieStore';
import { useSortiePlan } from '../hooks/useSortiePlan';
import AmapRouteView from '../components/common/AmapRouteView';
import { DEFAULT_BATTERY_CONFIG, type SortiePlan } from '../types/sortie';

/** /missions/:id/sorties 架次计划：按航点顺序编排、电量余量、版本失效重算、已执行架次冻结 */
export default function SortiePlanner() {
  const { id = '' } = useParams();
  const updateMission = useMissionStore((s) => s.update);
  const { mission, waypoints, plan, history, isStale, recompute, markFlown } = useSortiePlan(id);

  const [pickHomeMode, setPickHomeMode] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /** 航点 id → 架次号（用于地图按架次着色） */
  const waypointSortie = useMemo(() => {
    const map = new Map<string, number>();
    plan?.sorties.forEach((s) => s.waypointIds.forEach((wid) => map.set(wid, s.sortieNo)));
    return map;
  }, [plan]);

  if (!mission) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该任务（可能已被删除）" />
        <Link to="/missions">返回任务台账</Link>
      </Space>
    );
  }

  const enduranceMin = plan?.enduranceMin ?? DEFAULT_BATTERY_CONFIG.enduranceMin;
  const reserveFraction = plan?.reserveFraction ?? DEFAULT_BATTERY_CONFIG.reserveFraction;
  const usableMin = plan?.usableMin ?? enduranceMin * (1 - reserveFraction);
  const coveredCount = plan?.sorties.reduce((s, x) => s + x.waypointIds.length, 0) ?? 0;
  const rejectedCount = plan?.rejected.length ?? 0;
  const home =
    mission.homeLng !== undefined && mission.homeLat !== undefined
      ? ([mission.homeLng, mission.homeLat] as [number, number])
      : undefined;
  // 最新一版若为失败尝试（含首次重算失败、无上一版的情况），展示失败原因
  const failedAttempt = history[0]?.status === 'failed' ? history[0] : undefined;

  const setHome = async (lng: number, lat: number) => {
    await updateMission(mission.id, { homeLng: Number(lng.toFixed(6)), homeLat: Number(lat.toFixed(6)) });
    setPickHomeMode(false);
    setError('');
    setToast('已设置起降点，架次计划将按新起降点重算');
  };

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          架次计划 · {mission.missionNo}
        </Typography.Title>
        <Tag color="cyan">{mission.purpose}</Tag>
        <Tag color={plan ? 'green' : 'default'}>版本 v{plan?.version ?? '—'}</Tag>
        {isStale ? <Tag color="gold">输入已变更，待重算</Tag> : <Tag color="green">计划为最新</Tag>}
        {plan?.status === 'failed' ? <Tag color="red">重算失败</Tag> : null}
        <Tag color="blue">
          续航 {enduranceMin} min · 余量 {Math.round(reserveFraction * 100)}% · 可用 {usableMin} min
        </Tag>
        <div style={{ flex: 1 }} />
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

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      {failedAttempt ? (
        <Alert
          type="error"
          showIcon
          message={plan ? '重算失败，已保留上一版可执行计划' : '重算失败，暂无可执行计划'}
          description={`原因：${failedAttempt.failureReason}。请修正航点 / 起降点 / 相机参数，计划会自动重算${plan ? '并从上一版继续' : ''}。`}
        />
      ) : null}

      <Row gutter={14}>
        <Col span={15}>
          <Card size="small" title="架次地图（红点为起降点，航点按架次着色）">
            <AmapRouteView
              mission={mission}
              waypoints={waypoints}
              altitude={waypoints[0]?.altitude ?? 120}
              height={460}
              pickMode={pickHomeMode ? 'home' : 'waypoint'}
              onPickHome={setHome}
              waypointSortie={waypointSortie}
            />
          </Card>
        </Col>
        <Col span={9}>
          <Card size="small" title="起降点与续航">
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
              <Space wrap>
                <Button
                  type={pickHomeMode ? 'primary' : 'default'}
                  icon={<EnvironmentOutlined />}
                  onClick={() => setPickHomeMode((v) => !v)}
                >
                  {pickHomeMode ? '正在点选…点击地图设置起降点' : '在地图上点选起降点'}
                </Button>
                <Button icon={<ReloadOutlined />} onClick={() => void recompute()}>
                  重新计算
                </Button>
              </Space>
              <Descriptions size="small" column={1} colon={false}>
                <Descriptions.Item label="起降点">
                  {home ? `${home[0].toFixed(6)}, ${home[1].toFixed(6)}` : '未设置（缺省取首个航点）'}
                </Descriptions.Item>
                <Descriptions.Item label="标称续航">{enduranceMin} min / 组</Descriptions.Item>
                <Descriptions.Item label="电量余量">{Math.round(reserveFraction * 100)}%</Descriptions.Item>
                <Descriptions.Item label="可用续航">{usableMin} min</Descriptions.Item>
              </Descriptions>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                每架次从起降点出发，连续航段、悬停与回程全部计入续航；装不下就排下一架，单点往返即超容量则拒绝。
              </Typography.Text>
            </Space>
          </Card>

          <Card size="small" title="计划概览" style={{ marginTop: 12 }}>
            <Row gutter={8}>
              <Col span={8}>
                <Statistic title="架次数" value={plan?.sorties.length ?? 0} suffix="个" />
              </Col>
              <Col span={8}>
                <Statistic title="覆盖航点" value={coveredCount} suffix="个" />
              </Col>
              <Col span={8}>
                <Statistic
                  title="被拒绝"
                  value={rejectedCount}
                  suffix="个"
                  valueStyle={{ color: rejectedCount > 0 ? '#cf1322' : undefined }}
                />
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>

      {plan && plan.rejected.length > 0 ? (
        <Card size="small" title="无法编排的航点（单点往返即超容量）">
          <Space wrap size={6}>
            {plan.rejected.map((r) => (
              <Tooltip key={r.waypointId} title={r.reason}>
                <Tag color="red">
                  #{r.seq} · 需 {r.soloMin} min
                </Tag>
              </Tooltip>
            ))}
          </Space>
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            {plan.rejected.map((r) => r.reason).join('；')}
          </Typography.Paragraph>
        </Card>
      ) : null}

      <Card size="small" title="架次列表（按航点顺序，每架从起降点出发并返回）">
        {!plan || plan.sorties.length === 0 ? (
          <Empty
            description={waypoints.length === 0 ? '暂无航点，请先到「航点明细」录入' : '暂无可执行架次（请检查起降点与航点）'}
            imageStyle={{ height: 40 }}
          />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {plan.sorties.map((s) => {
              const over = s.timing.totalMin > usableMin;
              return (
                <Card
                  key={s.sortieNo}
                  size="small"
                  type="inner"
                  title={
                    <Space wrap size={6}>
                      <Tag color={s.status === 'flown' ? 'green' : 'blue'}>第 {s.sortieNo} 架次</Tag>
                      <Tag>{s.waypointSeqs.map((seq) => `#${seq}`).join(' → ')}</Tag>
                      {s.status === 'flown' ? <Tag color="green">已执行</Tag> : <Tag>待执行</Tag>}
                    </Space>
                  }
                  extra={
                    s.status === 'planned' ? (
                      <Button size="small" type="primary" onClick={() => void markFlown(plan.id, s.sortieNo)}>
                        标记已执行
                      </Button>
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {s.executedAt ? new Date(s.executedAt).toLocaleString('zh-CN') : ''}
                      </Typography.Text>
                    )
                  }
                >
                  <Row gutter={[12, 8]}>
                    <Col span={4}>
                      <Statistic title="出航" value={s.timing.outboundMin} precision={1} suffix="min" />
                    </Col>
                    <Col span={4}>
                      <Statistic title="连续航段" value={s.timing.segmentsMin} precision={1} suffix="min" />
                    </Col>
                    <Col span={4}>
                      <Statistic title="悬停" value={s.timing.hoverMin} precision={1} suffix="min" />
                    </Col>
                    <Col span={4}>
                      <Statistic title="转弯" value={s.timing.turnMin} precision={1} suffix="min" />
                    </Col>
                    <Col span={4}>
                      <Statistic title="回程" value={s.timing.returnMin} precision={1} suffix="min" />
                    </Col>
                    <Col span={4}>
                      <Statistic
                        title="合计"
                        value={s.timing.totalMin}
                        precision={1}
                        suffix="min"
                        valueStyle={{ color: over ? '#cf1322' : undefined }}
                      />
                    </Col>
                  </Row>
                  <div style={{ marginTop: 8 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      电量消耗 {s.timing.batteryUsedPct}% · 剩余 {s.timing.batteryRemainPct}%（余量{' '}
                      {Math.round(reserveFraction * 100)}%）
                    </Typography.Text>
                    <Progress
                      percent={Math.min(100, s.timing.batteryUsedPct)}
                      size="small"
                      status={s.timing.batteryRemainPct < reserveFraction * 100 ? 'exception' : 'active'}
                    />
                  </div>
                </Card>
              );
            })}
          </Space>
        )}
      </Card>

      <Card size="small" title="版本历史（已执行架次原样保留，不因重算改写）">
        <Table
          size="small"
          rowKey="id"
          dataSource={history}
          pagination={false}
          locale={{ emptyText: '暂无版本记录' }}
          columns={[
            { title: '版本', dataIndex: 'version', width: 80, render: (v: number) => `v${v}` },
            {
              title: '状态',
              dataIndex: 'status',
              width: 110,
              render: (st: SortiePlan['status']) => (
                <Tag color={st === 'current' ? 'green' : st === 'failed' ? 'red' : 'default'}>
                  {st === 'current' ? '当前' : st === 'failed' ? '重算失败' : '已失效'}
                </Tag>
              ),
            },
            {
              title: '计算时间',
              dataIndex: 'computedAt',
              width: 180,
              render: (t: number) => new Date(t).toLocaleString('zh-CN'),
            },
            {
              title: '架次数',
              width: 90,
              render: (_: unknown, p: SortiePlan) => p.sorties.length,
            },
            {
              title: '覆盖航点',
              width: 100,
              render: (_: unknown, p: SortiePlan) => p.sorties.reduce((s, x) => s + x.waypointIds.length, 0),
            },
            { title: '拒绝', width: 80, render: (_: unknown, p: SortiePlan) => p.rejected.length },
            {
              title: '指纹',
              dataIndex: 'inputHash',
              width: 110,
              render: (h: string) => <Typography.Text code>{h.slice(0, 8)}</Typography.Text>,
            },
            {
              title: '说明',
              render: (_: unknown, p: SortiePlan) =>
                p.status === 'failed' ? (
                  <Typography.Text type="danger">{p.failureReason}</Typography.Text>
                ) : p.supersedesId ? (
                  '接替上一版'
                ) : (
                  '—'
                ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
