import { CONSTANTS } from '../physics/constants';
import { dot } from '../frames/transforms';
import type {
  DownlinkWindow,
  IndependentVerificationReport,
  ObservationWindow,
  PropagationBundle,
  SatelliteResourceTracePoint,
  ScheduledAction,
  Vec3,
  VerificationViolation,
} from '../types';

/**
 * Compute required attitude slew + setup transition time (s) between two consecutive actions.
 */
export function requiredTransitionTimeSec(
  prevLookVec: Vec3 | null,
  nextLookVec: Vec3 | null,
  slewRateDegPerSec: number,
  setupTimeSec: number,
): number {
  if (!prevLookVec || !nextLookVec) return setupTimeSec;
  const cosAngle = Math.max(-1, Math.min(1, dot(prevLookVec, nextLookVec)));
  const angleDeg = Math.acos(cosAngle) * CONSTANTS.RAD_TO_DEG;
  return setupTimeSec + angleDeg / Math.max(0.1, slewRateDegPerSec);
}

/**
 * Compute sunlit fraction of interval [tStart, tEnd] for a satellite from propagated states.
 */
export function computeSunlitDurationSec(
  satStates: PropagationBundle['satellites'][number]['states'],
  tStart: number,
  tEnd: number,
): number {
  if (tEnd <= tStart || satStates.length === 0) return 0;
  let sunlitSec = 0;
  for (let i = 0; i < satStates.length - 1; i++) {
    const a = satStates[i].tSec;
    const b = satStates[i + 1].tSec;
    const overlapStart = Math.max(a, tStart);
    const overlapEnd = Math.min(b, tEnd);
    if (overlapEnd > overlapStart) {
      if (!satStates[i].inEclipse) {
        sunlitSec += overlapEnd - overlapStart;
      }
    }
  }
  return sunlitSec;
}

/**
 * INDEPENDENT SOLUTION VERIFIER
 * Completely decoupled from every solver algorithm.
 * Validates every hard constraint and independently recomputes deterministic and realized objectives.
 */
export function verifyScheduleIndependently(
  bundle: PropagationBundle,
  actions: ScheduledAction[],
): IndependentVerificationReport {
  const violations: VerificationViolation[] = [];
  const res = bundle.scenario.resources;
  const obsMap = new Map<string, ObservationWindow>(
    bundle.observationWindows.map((w) => [w.windowId, w]),
  );
  const dlMap = new Map<string, DownlinkWindow>(
    bundle.downlinkWindows.map((w) => [w.contactId, w]),
  );
  const satMap = new Map(bundle.satellites.map((s) => [s.satId, s]));

  // Group actions by satellite and sort chronologically
  const actionsBySat = new Map<string, ScheduledAction[]>();
  for (const sat of bundle.satellites) {
    actionsBySat.set(sat.satId, []);
  }
  for (const act of actions) {
    const list = actionsBySat.get(act.satId);
    if (!list) {
      violations.push({
        code: 'UNKNOWN_WINDOW',
        satId: act.satId,
        actionId: act.actionId,
        message: `Unknown satellite ${act.satId}`,
      });
      continue;
    }
    list.push(act);
  }

  const resourceTraces: Record<string, SatelliteResourceTracePoint[]> = {};
  const capturedTargetsDet = new Map<string, number>(); // targetId -> max priority credit
  const deliveredTargetsDet = new Map<string, number>();
  const deliveredTargetsRealized = new Map<string, number>();
  const captureLatenciesSec: number[] = [];

  let totalDataCapturedGb = 0;
  let totalDataDownlinkedGb = 0;
  let peakStoragePct = 0;
  let minBatteryMarginPct = 100;

  for (const [satId, satActionsRaw] of actionsBySat.entries()) {
    const sat = satMap.get(satId)!;
    const satActions = satActionsRaw.slice().sort((a, b) => a.startSec - b.startSec);

    let batteryWh = res.batteryInitialWh;
    let storageGb = res.storageInitialGb;
    let currentTime = 0;
    let prevEndTime = -1e9;
    let prevLookVec: Vec3 | null = null;

    // FIFO queue of buffered observations for deterministic & realized downlink attribution
    const detQueue: Array<{ targetId: string; priority: number; remGb: number; captureEndSec: number }> = [];
    const realQueue: Array<{
      targetId: string;
      priority: number;
      remGb: number;
      captureEndSec: number;
      cloudBlocked: boolean;
    }> = [];

    const trace: SatelliteResourceTracePoint[] = [
      { tSec: 0, batteryWh: +batteryWh.toFixed(2), storageGb: +storageGb.toFixed(2), event: 'epoch' },
    ];

    const advanceBattery = (fromT: number, toT: number, extraPowerW: number) => {
      if (toT <= fromT) return;
      const dtSec = toT - fromT;
      const sunlitSec = computeSunlitDurationSec(sat.states, fromT, toT);
      const chargeWh = (res.solarChargePowerW * sunlitSec) / 3600;
      const drainWh = ((res.idlePowerW + extraPowerW) * dtSec) / 3600;
      batteryWh = Math.min(res.batteryCapacityWh, batteryWh + chargeWh - drainWh);
    };

    for (const act of satActions) {
      if (act.type === 'observation') {
        const win = obsMap.get(act.windowId);
        if (!win || win.satId !== satId) {
          violations.push({
            code: 'UNKNOWN_WINDOW',
            satId,
            actionId: act.actionId,
            message: `Observation window ${act.windowId} does not exist for ${satId}`,
          });
          continue;
        }

        // 1. Window containment & required duration
        if (
          act.startSec < win.startSec - 1e-6 ||
          act.endSec > win.endSec + 1e-6 ||
          act.endSec - act.startSec < win.requiredObsSec - 1e-6
        ) {
          violations.push({
            code: 'WINDOW_BOUNDS',
            satId,
            actionId: act.actionId,
            message: `Action [${act.startSec}, ${act.endSec}] violates window [${win.startSec}, ${win.endSec}] or min duration ${win.requiredObsSec}s`,
          });
        }

        // 2. Deadline check
        if (act.endSec > win.deadlineSec + 1e-6) {
          violations.push({
            code: 'DEADLINE_EXCEEDED',
            satId,
            actionId: act.actionId,
            message: `Observation ends at ${act.endSec}s after target deadline ${win.deadlineSec}s`,
          });
        }

        // 3. Exclusivity + slew transition check
        const reqGap =
          prevEndTime > -1e8
            ? requiredTransitionTimeSec(prevLookVec, win.lookVecEcef, res.slewRateDegPerSec, res.setupTimeSec)
            : 0;
        if (prevEndTime > -1e8 && act.startSec < prevEndTime + reqGap - 1e-4) {
          violations.push({
            code: 'TASK_OVERLAP_OR_SLEW',
            satId,
            actionId: act.actionId,
            message: `Start ${act.startSec.toFixed(1)}s violates slew/exclusivity gap (${(prevEndTime + reqGap).toFixed(1)}s required)`,
          });
        }

        // 4. Advance battery to start, then during observation
        advanceBattery(currentTime, act.startSec, 0);
        advanceBattery(act.startSec, act.endSec, res.imagingPowerW);
        currentTime = act.endSec;

        if (batteryWh < res.batteryMinWh - 1e-4) {
          violations.push({
            code: 'BATTERY_BELOW_MIN',
            satId,
            actionId: act.actionId,
            message: `Battery ${batteryWh.toFixed(2)} Wh dropped below minimum ${res.batteryMinWh} Wh`,
          });
        }

        // 5. Storage accumulation
        storageGb += win.dataVolumeGb;
        totalDataCapturedGb += win.dataVolumeGb;
        if (storageGb > res.storageCapacityGb + 1e-4) {
          violations.push({
            code: 'STORAGE_OVERFLOW',
            satId,
            actionId: act.actionId,
            message: `Storage ${storageGb.toFixed(2)} Gb exceeded capacity ${res.storageCapacityGb} Gb`,
          });
        }

        capturedTargetsDet.set(
          win.targetId,
          Math.max(capturedTargetsDet.get(win.targetId) ?? 0, win.targetPriority),
        );
        detQueue.push({
          targetId: win.targetId,
          priority: win.targetPriority,
          remGb: win.dataVolumeGb,
          captureEndSec: act.endSec,
        });
        realQueue.push({
          targetId: win.targetId,
          priority: win.targetPriority,
          remGb: win.dataVolumeGb,
          captureEndSec: act.endSec,
          cloudBlocked: win.realizedCloudBlocked,
        });

        prevEndTime = act.endSec;
        prevLookVec = win.lookVecEcef;
      } else {
        // Downlink action
        const dl = dlMap.get(act.windowId);
        if (!dl || dl.satId !== satId) {
          violations.push({
            code: 'UNKNOWN_WINDOW',
            satId,
            actionId: act.actionId,
            message: `Downlink contact ${act.windowId} does not exist for ${satId}`,
          });
          continue;
        }

        if (act.startSec < dl.startSec - 1e-6 || act.endSec > dl.endSec + 1e-6 || act.endSec <= act.startSec) {
          violations.push({
            code: 'WINDOW_BOUNDS',
            satId,
            actionId: act.actionId,
            message: `Downlink [${act.startSec}, ${act.endSec}] outside contact [${dl.startSec}, ${dl.endSec}]`,
          });
        }

        const reqGap = prevEndTime > -1e8 ? res.setupTimeSec : 0;
        if (prevEndTime > -1e8 && act.startSec < prevEndTime + reqGap - 1e-4) {
          violations.push({
            code: 'TASK_OVERLAP_OR_SLEW',
            satId,
            actionId: act.actionId,
            message: `Downlink start ${act.startSec.toFixed(1)}s overlaps previous task (ends ${prevEndTime.toFixed(1)}s + ${reqGap}s)`,
          });
        }

        const requestedTransferGb = Math.max(0, -act.dataDeltaGb);
        const maxAllowedGb = (act.endSec - act.startSec) * dl.downlinkRateGbps + 1e-3;
        if (requestedTransferGb > maxAllowedGb) {
          violations.push({
            code: 'DOWNLINK_CAPACITY_EXCEEDED',
            satId,
            actionId: act.actionId,
            message: `Downlink volume ${requestedTransferGb.toFixed(2)} Gb exceeds link capacity ${maxAllowedGb.toFixed(2)} Gb`,
          });
        }

        advanceBattery(currentTime, act.startSec, 0);
        advanceBattery(act.startSec, act.endSec, res.downlinkPowerW);
        currentTime = act.endSec;

        if (batteryWh < res.batteryMinWh - 1e-4) {
          violations.push({
            code: 'BATTERY_BELOW_MIN',
            satId,
            actionId: act.actionId,
            message: `Battery ${batteryWh.toFixed(2)} Wh dropped below min ${res.batteryMinWh} Wh during downlink`,
          });
        }

        if (requestedTransferGb > storageGb + 1e-3) {
          violations.push({
            code: 'STORAGE_UNDERFLOW',
            satId,
            actionId: act.actionId,
            message: `Downlink attempts to drain ${requestedTransferGb.toFixed(2)} Gb with only ${storageGb.toFixed(2)} Gb buffered`,
          });
        }

        const actualDrainedGb = Math.min(storageGb, requestedTransferGb);
        storageGb = Math.max(0, storageGb - actualDrainedGb);
        totalDataDownlinkedGb += actualDrainedGb;

        // Attribute deterministic delivery FIFO
        let remDet = actualDrainedGb;
        while (remDet > 1e-6 && detQueue.length > 0) {
          const head = detQueue[0];
          if (remDet >= head.remGb - 1e-6) {
            remDet -= head.remGb;
            detQueue.shift();
            deliveredTargetsDet.set(
              head.targetId,
              Math.max(deliveredTargetsDet.get(head.targetId) ?? 0, head.priority),
            );
            captureLatenciesSec.push(Math.max(0, act.endSec - head.captureEndSec));
          } else {
            head.remGb -= remDet;
            remDet = 0;
          }
        }

        // Attribute realized delivery (only if ground station did NOT suffer outage & target was NOT cloud-blocked)
        if (!dl.realizedOutage) {
          let remReal = actualDrainedGb;
          while (remReal > 1e-6 && realQueue.length > 0) {
            const head = realQueue[0];
            if (remReal >= head.remGb - 1e-6) {
              remReal -= head.remGb;
              realQueue.shift();
              if (!head.cloudBlocked) {
                deliveredTargetsRealized.set(
                  head.targetId,
                  Math.max(deliveredTargetsRealized.get(head.targetId) ?? 0, head.priority),
                );
              }
            } else {
              head.remGb -= remReal;
              remReal = 0;
            }
          }
        }

        prevEndTime = act.endSec;
        prevLookVec = null;
      }

      const storagePct = (100 * storageGb) / Math.max(res.storageCapacityGb, 1e-6);
      if (storagePct > peakStoragePct) peakStoragePct = storagePct;
      const marginPct =
        (100 * (batteryWh - res.batteryMinWh)) /
        Math.max(res.batteryCapacityWh - res.batteryMinWh, 1e-6);
      if (marginPct < minBatteryMarginPct) minBatteryMarginPct = marginPct;

      trace.push({
        tSec: act.endSec,
        batteryWh: +batteryWh.toFixed(2),
        storageGb: +storageGb.toFixed(2),
        event: `${act.type}:${act.entityId}`,
      });
    }

    // Advance battery to horizon end to verify no late eclipse brownout
    advanceBattery(currentTime, bundle.scenario.horizonSec, 0);
    trace.push({
      tSec: bundle.scenario.horizonSec,
      batteryWh: +batteryWh.toFixed(2),
      storageGb: +storageGb.toFixed(2),
      event: 'horizon_end',
    });
    resourceTraces[satId] = trace;
  }

  // Recompute exact deterministic & realized objectives
  let verifiedDeterministicObjective = 0;
  for (const [targetId, priority] of capturedTargetsDet.entries()) {
    if (deliveredTargetsDet.has(targetId)) {
      verifiedDeterministicObjective += priority;
    } else {
      verifiedDeterministicObjective += priority * res.captureCreditFraction;
    }
  }

  let verifiedRealizedObjective = 0;
  for (const priority of deliveredTargetsRealized.values()) {
    verifiedRealizedObjective += priority;
  }

  const totalTargets = bundle.scenario.targets.length;
  const meanDataLatencySec =
    captureLatenciesSec.length > 0
      ? captureLatenciesSec.reduce((s, v) => s + v, 0) / captureLatenciesSec.length
      : 0;

  return {
    verifiedFeasible: violations.length === 0,
    violationCount: violations.length,
    violations,
    verifiedDeterministicObjective: +verifiedDeterministicObjective.toFixed(2),
    verifiedRealizedObjective: +verifiedRealizedObjective.toFixed(2),
    uniqueTargetsCaptured: capturedTargetsDet.size,
    uniqueTargetsDelivered: deliveredTargetsDet.size,
    realizedTargetsDelivered: deliveredTargetsRealized.size,
    onTimeDeliveryRate:
      totalTargets > 0 ? +(deliveredTargetsDet.size / totalTargets).toFixed(4) : 0,
    totalDataCapturedGb: +totalDataCapturedGb.toFixed(2),
    totalDataDownlinkedGb: +totalDataDownlinkedGb.toFixed(2),
    meanDataLatencySec: +meanDataLatencySec.toFixed(1),
    peakStorageUtilizationPct: +peakStoragePct.toFixed(1),
    minBatteryMarginPct: +Math.max(0, minBatteryMarginPct).toFixed(1),
    resourceTraces,
  };
}
