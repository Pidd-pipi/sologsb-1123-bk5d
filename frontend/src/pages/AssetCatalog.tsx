import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import { DownloadOutlined, PlusOutlined } from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import { useSortieStore } from '../stores/sortieStore';
import AssetGrid from '../components/common/AssetGrid';
import AmapRouteView from '../components/common/AmapRouteView';
import { IMAGE_QUALITIES, type ImageAsset, type ImageAssetDraft, type ImageQuality } from '../types/imageasset';
import type { Sortie } from '../types/sortie';
import { calcGsd, distanceMeters } from '../utils/geoCalc';

/** /missions/:id/assets 成果影像编目：格子列出片号/缩略图/GSD/质量，多选标记、定位到图 */
export default function AssetCatalog() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const assets = useAssetStore((s) => s.items);
  const thumbs = useAssetStore((s) => s.thumbs);
  const addMany = useAssetStore((s) => s.addMany);
  const markMany = useAssetStore((s) => s.markMany);
  const removeMany = useAssetStore((s) => s.removeMany);

  const mission = missions.find((m) => m.id === id);
  const missionAssets = useMemo(
    () => assets.filter((a) => a.missionId === id).sort((a, b) => a.imageNo.localeCompare(b.imageNo, 'zh-Hans-CN', { numeric: true })),
    [assets, id],
  );
  const missionWaypoints = useMemo(
    () => waypoints.filter((w) => w.missionId === id).sort((a, b) => a.seq - b.seq),
    [waypoints, id],
  );

  // 架次归属：成果条目记录编目时的架次与计划版本
  const sortiePlans = useSortieStore((s) => s.plans);
  const sortieItems = useSortieStore((s) => s.sorties);
  const missionSorties = useMemo(
    () => sortieItems.filter((s) => s.missionId === id).sort((a, b) => a.sortieNo - b.sortieNo),
    [sortieItems, id],
  );
  const sortieLabels = useMemo(() => {
    const map: Record<string, string> = {};
    missionSorties.forEach((s) => {
      map[s.id] = `第${s.sortieNo}架次 · v${s.planVersion}`;
    });
    return map;
  }, [missionSorties]);

  const [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [qualityFilter, setQualityFilter] = useState<ImageQuality | 'all'>('all');
  const [sortieFilter, setSortieFilter] = useState<string>('all');
  const [locateSeq, setLocateSeq] = useState<number | undefined>(undefined);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filtered = missionAssets.filter((a) => {
    if (qualityFilter !== 'all' && a.quality !== qualityFilter) return false;
    if (sortieFilter === 'none' && a.sortieId) return false;
    if (sortieFilter !== 'all' && sortieFilter !== 'none' && a.sortieId !== sortieFilter) return false;
    if (keyword && !a.imageNo.toLowerCase().includes(keyword.trim().toLowerCase())) return false;
    return true;
  });

  const stats = IMAGE_QUALITIES.map((quality) => ({
    quality,
    count: missionAssets.filter((a) => a.quality === quality).length,
  }));

  /** 批量编目：按航点位置与当前航线 GSD 生成影像条目，并关联当前可执行计划的架次与版本 */
  const catalogFromWaypoints = async () => {
    if (!mission) return;
    if (missionWaypoints.length === 0) {
      setError('该任务暂无航点，请先到「航点明细」录入或点击网格新增');
      return;
    }
    const currentPlan = sortiePlans
      .filter((p) => p.missionId === id && p.status === '可执行')
      .sort((a, b) => b.version - a.version)[0];
    const coverage = new Map<string, Sortie>();
    if (currentPlan) {
      sortieItems
        .filter((s) => s.missionId === id && s.planVersion === currentPlan.version && s.status !== '已取消')
        .forEach((s) => s.waypointIds.forEach((wid) => coverage.set(wid, s)));
    }
    const gsd = calcGsd(mission.pixelSize, missionWaypoints[0].altitude, mission.focalLength);
    const startNo = missionAssets.length + 1;
    let linked = 0;
    const drafts: ImageAssetDraft[] = missionWaypoints.map((w, index) => {
      const sortie = coverage.get(w.id);
      if (sortie) linked += 1;
      return {
        missionId: mission.id,
        imageNo: `IMG_${String(2000 + startNo + index)}`,
        lng: w.lng,
        lat: w.lat,
        altitude: w.altitude,
        gsd: calcGsd(mission.pixelSize, w.altitude, mission.focalLength) || gsd,
        overlap: 75,
        tiltAngle: Math.abs(w.gimbalPitch + 90),
        shotAt: Date.now() + index * 1000,
        quality: '合格' as ImageQuality,
        folder: `/${mission.missionNo}/100MEDIA`,
        sortieId: sortie?.id,
        planVersion: sortie?.planVersion,
      };
    });
    await addMany(drafts);
    setError('');
    setToast(
      `已按 ${drafts.length} 个航点批量编目影像条目（GSD ${gsd} cm/px` +
        (currentPlan ? `，关联计划 v${currentPlan.version}：${linked} 张归属架次` : '，暂无可执行架次计划') +
        '）',
    );
  };

  const locate = (asset: ImageAsset) => {
    if (missionWaypoints.length === 0) return;
    let best = missionWaypoints[0];
    let bestDist = Number.POSITIVE_INFINITY;
    missionWaypoints.forEach((w) => {
      const d = distanceMeters([asset.lng, asset.lat], [w.lng, w.lat]);
      if (d < bestDist) {
        bestDist = d;
        best = w;
      }
    });
    setLocateSeq(best.seq);
    setToast(`已定位到航点 #${best.seq}（距离 ${bestDist.toFixed(1)} m）`);
  };

  const exportList = () => {
    const sortieById = new Map(missionSorties.map((s) => [s.id, s]));
    const header = '片号,经度,纬度,航高m,GSDcm/px,重叠%,倾角°,质量,架次,计划版本,归档目录';
    const lines = missionAssets.map((a) => {
      const sortie = a.sortieId ? sortieById.get(a.sortieId) : undefined;
      return [
        a.imageNo,
        a.lng,
        a.lat,
        a.altitude,
        a.gsd,
        a.overlap,
        a.tiltAngle,
        a.quality,
        sortie ? `第${sortie.sortieNo}架次` : '',
        sortie ? `v${sortie.planVersion}` : '',
        a.folder,
      ].join(',');
    });
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `成果影像清单_${mission?.missionNo ?? 'mission'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setToast(`已导出 ${lines.length} 条影像清单（含架次归属）`);
  };

  if (!mission) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该任务" />
        <Link to="/missions">返回任务台账</Link>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          成果影像编目 · {mission.missionNo}
        </Typography.Title>
        <Tag color="cyan">{mission.purpose}</Tag>
        <Tag>条目 {missionAssets.length} 张</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/missions/${mission.id}/route`}>航线规划</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/sorties`}>架次编排</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/waypoints`}>航点明细</Link>
        </Button>
        <Button type="link">
          <Link to="/missions">返回台账</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Row gutter={12}>
        {stats.map((s) => (
          <Col span={6} key={s.quality}>
            <Card size="small">
              <Statistic title={`${s.quality}影像`} value={s.count} suffix="张" />
            </Card>
          </Col>
        ))}
        <Col span={6}>
          <Card size="small">
            <Statistic title="航点数量" value={missionWaypoints.length} suffix="个" />
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Space wrap size={10}>
          <Input
            allowClear
            style={{ width: 200 }}
            placeholder="按片号筛选"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Select
            style={{ width: 140 }}
            value={qualityFilter}
            onChange={(v) => setQualityFilter(v as ImageQuality | 'all')}
            options={[{ value: 'all', label: '全部质量' }, ...IMAGE_QUALITIES.map((q) => ({ value: q, label: q }))]}
          />
          <Select
            style={{ width: 210 }}
            value={sortieFilter}
            onChange={setSortieFilter}
            options={[
              { value: 'all', label: '全部架次' },
              { value: 'none', label: '未关联架次' },
              ...missionSorties.map((s) => ({
                value: s.id,
                label: `第${s.sortieNo}架次 · v${s.planVersion}（${s.status}）`,
              })),
            ]}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={catalogFromWaypoints}>
            按航点批量编目
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={async () => {
              await markMany(selected, '合格');
              setToast(`已把 ${selected.length} 张标记为「合格」`);
            }}
          >
            标记合格
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={async () => {
              await markMany(selected, '模糊');
              setToast(`已把 ${selected.length} 张标记为「模糊」`);
            }}
          >
            标记模糊
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={async () => {
              await markMany(selected, '过曝');
              setToast(`已把 ${selected.length} 张标记为「过曝」`);
            }}
          >
            标记过曝
          </Button>
          <Button
            danger
            disabled={selected.length === 0}
            onClick={async () => {
              await removeMany(selected);
              setToast(`已删除 ${selected.length} 条影像条目`);
              setSelected([]);
            }}
          >
            删除选中
          </Button>
          <Button icon={<DownloadOutlined />} onClick={exportList} disabled={missionAssets.length === 0}>
            导出成果清单
          </Button>
        </Space>
      </Card>

      <Row gutter={14}>
        <Col span={16}>
          <Card size="small" title={`影像格子（筛选后 ${filtered.length} 张）`}>
            <AssetGrid
              assets={filtered}
              thumbs={thumbs}
              selectedIds={selected}
              sortieLabels={sortieLabels}
              onToggle={(assetId) =>
                setSelected((prev) => (prev.includes(assetId) ? prev.filter((x) => x !== assetId) : [...prev, assetId]))
              }
              onToggleAll={(ids) => setSelected(ids)}
              onLocate={locate}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small" title="定位到图">
            <AmapRouteView
              mission={mission}
              waypoints={missionWaypoints}
              altitude={missionWaypoints[0]?.altitude ?? 120}
              height={340}
              highlightSeq={locateSeq}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
