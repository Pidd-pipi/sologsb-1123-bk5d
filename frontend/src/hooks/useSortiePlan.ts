import { useEffect, useMemo } from 'react';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useSortieStore } from '../stores/sortieStore';
import { computeInputHash } from '../utils/sortie';
import { DEFAULT_BATTERY_CONFIG } from '../types/sortie';

/**
 * 架次计划：读取当前任务的最新可执行版本，并在航点高度/顺序、相机参数、
 * 起降点改变后自动失效重算（防抖）。重算失败时保留上一版可执行计划。
 */
export function useSortiePlan(missionId: string | undefined) {
  const mission = useMissionStore((s) => s.items.find((m) => m.id === missionId));
  const allWaypoints = useWaypointStore((s) => s.items);
  const plans = useSortieStore((s) => s.plans);
  const recompute = useSortieStore((s) => s.recompute);
  const markFlown = useSortieStore((s) => s.markFlown);

  const waypoints = useMemo(
    () => allWaypoints.filter((w) => w.missionId === missionId).sort((a, b) => a.seq - b.seq),
    [allWaypoints, missionId],
  );

  const inputHash = useMemo(() => {
    if (!mission) return '';
    const home: [number, number] | undefined =
      mission.homeLng !== undefined && mission.homeLat !== undefined
        ? [mission.homeLng, mission.homeLat]
        : undefined;
    return computeInputHash(
      home,
      waypoints,
      {
        sensorWidth: mission.sensorWidth,
        sensorHeight: mission.sensorHeight,
        focalLength: mission.focalLength,
        pixelSize: mission.pixelSize,
      },
      { enduranceMin: DEFAULT_BATTERY_CONFIG.enduranceMin, reserveFraction: DEFAULT_BATTERY_CONFIG.reserveFraction },
    );
  }, [mission, waypoints]);

  const plan = useMemo(
    () => plans.find((p) => p.missionId === missionId && p.status === 'current'),
    [plans, missionId],
  );
  const history = useMemo(
    () => plans.filter((p) => p.missionId === missionId).sort((a, b) => b.version - a.version),
    [plans, missionId],
  );

  const isStale = !!mission && (!plan || plan.inputHash !== inputHash);

  useEffect(() => {
    if (!missionId || !mission) return;
    if (!plan || plan.inputHash !== inputHash) {
      const timer = window.setTimeout(() => {
        void recompute(missionId);
      }, 450);
      return () => window.clearTimeout(timer);
    }
  }, [missionId, mission, plan, inputHash, recompute]);

  return {
    mission,
    waypoints,
    plan,
    history,
    inputHash,
    isStale,
    recompute: () => recompute(missionId ?? ''),
    markFlown,
  };
}
