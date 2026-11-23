import {
  computeSunlitDurationSec,
  requiredTransitionTimeSec,
} from '../../validation/verifier';
import type {
  DownlinkWindow,
  ObservationWindow,
  PropagationBundle,
  ScheduledAction,
  Vec3,
} from '../../types';

export interface CandidateTask {
  type: 'observation' | 'downlink';
  satId: string;
  windowId: string;
  entityId: string;
  entityName: string;
  startSec: number;
  endSec: number;
  dataDeltaGb: number; // + for obs, -maxCap for dl (actual drained capped at buffer)
  priority: number;
  lookVecEcef: Vec3 | null;
  cloudProb?: number;
  downlinkRateGbps?: number;
}

/**
 * Simulates a single satellite's chronological sequence of candidate observations
 * interleaved with available downlink contacts, greedily draining buffered data
 * whenever a non-overlapping downlink contact is available and energy permits.
 * Returns null if any hard constraint (bounds, deadline, overlap/slew, battery, storage) is violated.
 */
export function buildFeasibleSatelliteSchedule(
  bundle: PropagationBundle,
  satId: string,
  obsWindows: ObservationWindow[],
  allowedDownlinkIds?: Set<string>,
  targetNameMap?: Map<string, string>,
  stationNameMap?: Map<string, string>,
): {
  actions: ScheduledAction[];
  finalStorageGb: number;
  minBatteryWh: number;
  totalDownlinkedGb: number;
} | null {
  const sat = bundle.satellites.find((s) => s.satId === satId);
  if (!sat) return null;
  const res = bundle.scenario.resources;

  const sortedObs = obsWindows.slice().sort((a, b) => a.startSec - b.startSec);
  const satDownlinks = bundle.downlinkWindows
    .filter((d) => d.satId === satId && (!allowedDownlinkIds || allowedDownlinkIds.has(d.contactId)))
    .slice()
    .sort((a, b) => a.startSec - b.startSec);

  // First determine exact feasible execution [start, end] for each observation respecting slew/deadlines
  const placedObs: Array<{ win: ObservationWindow; startSec: number; endSec: number }> = [];
  let prevObsEnd = -1e9;
  let prevLook: Vec3 | null = null;

  for (const w of sortedObs) {
    const minStart =
      prevObsEnd > -1e8
        ? prevObsEnd +
          requiredTransitionTimeSec(prevLook, w.lookVecEcef, res.slewRateDegPerSec, res.setupTimeSec)
        : 0;
    const startSec = Math.ceil(Math.max(w.startSec, minStart) * 100) / 100;
    const endSec = +(startSec + w.requiredObsSec).toFixed(2);
    if (endSec > w.endSec + 1e-6 || endSec > w.deadlineSec + 1e-6) {
      return null;
    }
    placedObs.push({ win: w, startSec, endSec });
    prevObsEnd = endSec;
    prevLook = w.lookVecEcef;
  }

  // Merge placed observations with eligible downlink windows chronologically
  type EventItem =
    | { kind: 'obs'; startSec: number; endSec: number; win: ObservationWindow }
    | { kind: 'dl'; startSec: number; endSec: number; dl: DownlinkWindow };

  const events: EventItem[] = [];
  let dlIdx = 0;

  for (let i = 0; i < placedObs.length; i++) {
    const cur = placedObs[i];
    // Insert any downlink contacts that fit strictly before cur.startSec
    while (dlIdx < satDownlinks.length && satDownlinks[dlIdx].startSec < cur.startSec) {
      const dl = satDownlinks[dlIdx];
      dlIdx++;
      const prevEnd = events.length > 0 ? events[events.length - 1].endSec : -1e9;
      const dlStart = Math.ceil(Math.max(dl.startSec, prevEnd > -1e8 ? prevEnd + res.setupTimeSec : 0) * 100) / 100;
      const dlMaxEnd = Math.floor(Math.min(dl.endSec, cur.startSec - res.setupTimeSec) * 100) / 100;
      if (dlMaxEnd - dlStart >= 15) {
        events.push({ kind: 'dl', startSec: dlStart, endSec: dlMaxEnd, dl });
      }
    }
    events.push({ kind: 'obs', startSec: cur.startSec, endSec: cur.endSec, win: cur.win });
  }

  // Remaining downlinks after last observation
  while (dlIdx < satDownlinks.length) {
    const dl = satDownlinks[dlIdx];
    dlIdx++;
    const prevEnd = events.length > 0 ? events[events.length - 1].endSec : -1e9;
    const dlStart = Math.ceil(Math.max(dl.startSec, prevEnd > -1e8 ? prevEnd + res.setupTimeSec : 0) * 100) / 100;
    const dlMaxEnd = Math.floor(dl.endSec * 100) / 100;
    if (dlMaxEnd - dlStart >= 15) {
      events.push({ kind: 'dl', startSec: dlStart, endSec: dlMaxEnd, dl });
    }
  }

  // Forward physical simulation of battery & storage
  let batteryWh = res.batteryInitialWh;
  let storageGb = res.storageInitialGb;
  let currentTime = 0;
  let minBatteryWh = batteryWh;
  let totalDownlinkedGb = 0;
  const actions: ScheduledAction[] = [];
  let actSeq = 0;

  const advanceBattery = (fromT: number, toT: number, extraPowerW: number) => {
    if (toT <= fromT) return;
    const dtSec = toT - fromT;
    const sunlitSec = computeSunlitDurationSec(sat.states, fromT, toT);
    const chargeWh = (res.solarChargePowerW * sunlitSec) / 3600;
    const drainWh = ((res.idlePowerW + extraPowerW) * dtSec) / 3600;
    batteryWh = Math.min(res.batteryCapacityWh, batteryWh + chargeWh - drainWh);
    if (batteryWh < minBatteryWh) minBatteryWh = batteryWh;
  };

  for (const ev of events) {
    if (ev.kind === 'obs') {
      const beforeBat = batteryWh;
      advanceBattery(currentTime, ev.startSec, 0);
      advanceBattery(ev.startSec, ev.endSec, res.imagingPowerW);
      if (batteryWh < res.batteryMinWh + 0.05) {
        return null;
      }
      if (storageGb + ev.win.dataVolumeGb > res.storageCapacityGb - 1e-4) {
        return null;
      }
      storageGb += ev.win.dataVolumeGb;
      currentTime = ev.endSec;
      actSeq++;
      actions.push({
        actionId: `${satId}-ACT-${actSeq}`,
        type: 'observation',
        satId,
        windowId: ev.win.windowId,
        entityId: ev.win.targetId,
        entityName: targetNameMap?.get(ev.win.targetId) ?? ev.win.targetId,
        startSec: ev.startSec,
        endSec: ev.endSec,
        dataDeltaGb: ev.win.dataVolumeGb,
        energyDeltaWh: +(batteryWh - beforeBat).toFixed(3),
        priority: ev.win.targetPriority,
        cloudProb: ev.win.cloudProb,
        realizedFailed: ev.win.realizedCloudBlocked,
      });
    } else {
      // Only use downlink if we have data buffered AND battery can afford it
      if (storageGb <= 0.05) continue;
      // Preview battery at ev.startSec
      const sunlitIdle = computeSunlitDurationSec(sat.states, currentTime, ev.startSec);
      const batAtStart = Math.min(
        res.batteryCapacityWh,
        batteryWh +
          (res.solarChargePowerW * sunlitIdle) / 3600 -
          (res.idlePowerW * Math.max(0, ev.startSec - currentTime)) / 3600,
      );
      const neededSec = storageGb / ev.dl.downlinkRateGbps;
      const maxDur = ev.endSec - ev.startSec;
      // Round desired duration UP slightly (within maxDur) so integer-centisecond endSec covers needed volume
      const desiredDur = Math.min(maxDur, Math.max(10, Math.ceil(neededSec * 100) / 100));
      const dlEnd = Math.min(ev.endSec, +(ev.startSec + desiredDur).toFixed(2));

      const sunlitDl = computeSunlitDurationSec(sat.states, ev.startSec, dlEnd);
      const batAfter = Math.min(
        res.batteryCapacityWh,
        batAtStart +
          (res.solarChargePowerW * sunlitDl) / 3600 -
          ((res.idlePowerW + res.downlinkPowerW) * (dlEnd - ev.startSec)) / 3600,
      );

      // If full downlink would dip below min battery, shrink duration to stay strictly feasible
      let finalEnd = dlEnd;
      if (batAfter < res.batteryMinWh + 0.5) {
        const availableWh = batAtStart - (res.batteryMinWh + 0.8);
        if (availableWh <= 0.2) continue;
        const netPowerW = Math.max(10, res.idlePowerW + res.downlinkPowerW);
        const shrunkDur = Math.min(desiredDur, Math.floor(((availableWh * 3600) / netPowerW) * 100) / 100);
        if (shrunkDur < 10) continue;
        finalEnd = Math.min(ev.endSec, +(ev.startSec + shrunkDur).toFixed(2));
      }

      const actualDur = Math.max(0, finalEnd - ev.startSec);
      if (actualDur < 10) continue;

      const beforeBat = batteryWh;
      advanceBattery(currentTime, ev.startSec, 0);
      advanceBattery(ev.startSec, finalEnd, res.downlinkPowerW);
      if (batteryWh < res.batteryMinWh + 0.05) {
        batteryWh = beforeBat;
        continue;
      }

      // Strictly floor transfer volume to actual rounded duration * rate so verifier never sees capacity excess
      const maxLinkGb = Math.floor(actualDur * ev.dl.downlinkRateGbps * 1000) / 1000;
      const transferGb = Math.min(Math.floor(storageGb * 1000) / 1000, maxLinkGb);
      if (transferGb <= 0.01) {
        batteryWh = beforeBat;
        continue;
      }
      storageGb = Math.max(0, storageGb - transferGb);
      totalDownlinkedGb += transferGb;
      currentTime = finalEnd;
      actSeq++;
      actions.push({
        actionId: `${satId}-ACT-${actSeq}`,
        type: 'downlink',
        satId,
        windowId: ev.dl.contactId,
        entityId: ev.dl.stationId,
        entityName: stationNameMap?.get(ev.dl.stationId) ?? ev.dl.stationId,
        startSec: ev.startSec,
        endSec: finalEnd,
        dataDeltaGb: -transferGb,
        energyDeltaWh: +(batteryWh - beforeBat).toFixed(3),
        priority: 0,
        realizedFailed: ev.dl.realizedOutage,
      });
    }
  }

  return {
    actions,
    finalStorageGb: storageGb,
    minBatteryWh,
    totalDownlinkedGb,
  };
}

export function buildNameMaps(bundle: PropagationBundle) {
  return {
    targetNameMap: new Map(bundle.scenario.targets.map((t) => [t.id, t.name])),
    stationNameMap: new Map(bundle.scenario.groundStations.map((g) => [g.id, g.name])),
  };
}
