import assert from 'node:assert';
import { test } from 'node:test';
import { buildPlan, computeInputHash, packSorties } from './sortie';
import type { Waypoint } from '../types/waypoint';

const HOME: [number, number] = [116.39, 39.9];

function mkWp(seq: number, lng: number, lat: number, opts: Partial<Waypoint> = {}): Waypoint {
  return {
    id: `wp${seq}`,
    missionId: 'm1',
    seq,
    lng,
    lat,
    altitude: 120,
    speed: 10,
    heading: 90,
    gimbalPitch: -90,
    action: '拍照',
    hoverSec: 0,
    ...opts,
  };
}

test('近距离 3 个航点 → 1 个架次覆盖全部，无拒绝', () => {
  const wps = [mkWp(1, 116.391, 39.9), mkWp(2, 116.392, 39.9), mkWp(3, 116.393, 39.9)];
  const r = packSorties(HOME, wps);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.sorties.length, 1);
  assert.deepEqual(r.sorties[0].waypointSeqs, [1, 2, 3]);
  assert.equal(r.rejected.length, 0);
  // 每架次都从起降点出发并返回
  assert.ok(r.sorties[0].timing.outboundMin > 0);
  assert.ok(r.sorties[0].timing.returnMin > 0);
  // 留 20% 电量：剩余 ≥ 20%
  assert.ok(r.sorties[0].timing.batteryRemainPct >= 20);
});

test('菱形 4 航点（续航 10min、余量 0）→ 2 个架次，每架从起降点出发', () => {
  const wps = [
    mkWp(1, 116.4, 39.9),
    mkWp(2, 116.39, 39.91),
    mkWp(3, 116.38, 39.9),
    mkWp(4, 116.39, 39.89),
  ];
  const r = packSorties(HOME, wps, { enduranceMin: 10, reserveFraction: 0 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.sorties.length, 2);
  assert.deepEqual(r.sorties[0].waypointSeqs, [1, 2, 3]);
  assert.deepEqual(r.sorties[1].waypointSeqs, [4]);
  // 架次序号连续
  assert.equal(r.sorties[0].sortieNo, 1);
  assert.equal(r.sorties[1].sortieNo, 2);
});

test('单点往返即超容量 → 拒绝并写明原因', () => {
  const wps = [mkWp(1, 116.391, 39.9), mkWp(2, 116.5, 39.9)];
  const r = packSorties(HOME, wps, { enduranceMin: 10, reserveFraction: 0 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.sorties.length, 1);
  assert.deepEqual(r.sorties[0].waypointSeqs, [1]);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].seq, 2);
  assert.match(r.rejected[0].reason, /单点往返/);
  assert.match(r.rejected[0].reason, /超过/);
});

test('长悬停计入续航：悬停过长导致单点被拒', () => {
  const wps = [mkWp(1, 116.391, 39.9, { action: '悬停', hoverSec: 600 })];
  const r = packSorties(HOME, wps, { enduranceMin: 10, reserveFraction: 0 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.rejected.length, 1);
  assert.ok(r.rejected[0].soloMin > 10);
});

test('输入指纹：高度/顺序/相机改变 → 指纹改变；不变 → 相同', () => {
  const wps = [mkWp(1, 116.391, 39.9), mkWp(2, 116.392, 39.9)];
  const cam = { sensorWidth: 13.2, sensorHeight: 8.8, focalLength: 8.8, pixelSize: 2.4 };
  const h1 = computeInputHash(HOME, wps, cam);
  assert.equal(computeInputHash(HOME, wps, cam), h1);
  // 高度改变
  assert.notEqual(computeInputHash(HOME, wps.map((w) => ({ ...w, altitude: 200 })), cam), h1);
  // 顺序改变
  const swapped = [wps[1], wps[0]].map((w, i) => ({ ...w, seq: i + 1 }));
  assert.notEqual(computeInputHash(HOME, swapped, cam), h1);
  // 相机改变
  assert.notEqual(
    computeInputHash(HOME, wps, { ...cam, focalLength: 12.29 }),
    h1,
  );
});

test('buildPlan：正常返回 current；无有效起降点返回 failed', () => {
  const wps = [mkWp(1, 116.391, 39.9)];
  const cam = { sensorWidth: 13.2, sensorHeight: 8.8, focalLength: 8.8, pixelSize: 2.4 };
  const plan = buildPlan({ missionId: 'm1', version: 1, home: HOME, waypoints: wps, camera: cam });
  assert.equal(plan.status, 'current');
  assert.equal(plan.version, 1);
  assert.equal(plan.sorties.length, 1);

  const failed = buildPlan({ missionId: 'm1', version: 2, home: undefined, waypoints: wps, camera: cam });
  assert.equal(failed.status, 'failed');
  assert.ok(failed.failureReason);
});

test('无航点 → 空计划（不失败）', () => {
  const r = packSorties(HOME, []);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.sorties.length, 0);
  assert.equal(r.rejected.length, 0);
});
