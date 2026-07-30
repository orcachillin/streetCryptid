import { Platform } from 'react-native';

import {
  getTelemetry,
  type SpanContext,
  withEventLogLaunchContext,
} from '@/features/dev/telemetry';
import type { LocationFix } from '../../core/types';

/**
 * iOS revive tripwire — a single self-recentering geofence whose only job is to get a *terminated*
 * app running again (ARCHITECTURE §9).
 *
 * ## Why this has to exist at all
 * `startLocationUpdatesAsync` uses Core Location's **standard** location service. That service keeps
 * a suspended app being woken, but it does not relaunch a terminated one: per Apple, "if your app is
 * terminated either by a user or by the system, the system doesn't automatically restart your app
 * when new location updates arrive… the only way to have your app relaunched automatically is to use
 * region monitoring or the significant-change location service."
 *
 * expo-location does not expose the significant-change service, so region monitoring is the only
 * mechanism available to us — and per the Expo docs it does work: on iOS "the system will restart the
 * terminated app when a new geofence event occurs." The other route, a silent push, was deliberately
 * given up when push-token upload was removed (a push token is the one identifier here that a third
 * party can resolve to a real person). Both require `Always` authorization, which the app already
 * requests.
 *
 * ## It earns its keep on Android too, for a completely different reason
 * The Expo docs are explicit that on Android "a terminated app will not automatically restart when a
 * location or geofencing event occurs" — so the fence is NOT a resurrection mechanism there. It is
 * armed anyway because a geofence transition is one of the documented exemptions to the Android 12+
 * ban on starting a foreground service from the background ("your app receives an event that's
 * related to geofencing or activity recognition transition").
 *
 * That matters because re-arming location updates *is* starting a foreground service, so the
 * self-heal has no legal way to run from an ordinary WorkManager wake — it throws
 * `ForegroundServiceStartNotAllowedException`. Arriving via a geofence event is a window in which it
 * is allowed. See `ensureSharingArmedHeadless`.
 *
 * Android's other recovery paths, for reference: `LocationTaskService` returns
 * `START_REDELIVER_INTENT`, so the system restarts it by itself after an ordinary process kill —
 * which is why the kill case needs no help from us there. Reboot is the genuine gap: it needs either
 * a `BOOT_COMPLETED` receiver (expo-location declares none) or the user turning off battery
 * optimisation, which is a blanket exemption. Neither is solved here.
 *
 * ## What it deliberately does NOT do
 * It does not publish, sample, or carry position data anywhere. Crossing the fence re-arms the
 * ordinary ambient location task and re-centers the fence; publishing stays governed by the engine's
 * slot grid exactly as before, so the *wire* cadence remains motion-independent even though the
 * *wake* is motion-derived. That distinction is what keeps this compatible with the constant-cadence
 * rule in `sampling-policy.ts`.
 *
 * Both native modules are lazily + individually guarded (same pattern as `backfill-task.ts`), so
 * merely importing this file is side-effect-free and it degrades gracefully without them.
 */

let taskManagerMod: typeof import('expo-task-manager') | null | undefined;
let locationMod: typeof import('expo-location') | null | undefined;

function tryTaskManager(): typeof import('expo-task-manager') | null {
  if (taskManagerMod !== undefined) return taskManagerMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load; see header
    taskManagerMod = require('expo-task-manager') as typeof import('expo-task-manager');
  } catch {
    taskManagerMod = null;
  }
  return taskManagerMod;
}

function tryLocation(): typeof import('expo-location') | null {
  if (locationMod !== undefined) return locationMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load; see header
    locationMod = require('expo-location') as typeof import('expo-location');
  } catch {
    locationMod = null;
  }
  return locationMod;
}

/** TaskManager task name for the revive fence. Must be stable across app launches. */
export const REVIVE_FENCE_TASK = 'streetcryptid.revive-fence';

/** Stable region id, so re-arming replaces the fence rather than accumulating fences. */
export const REVIVE_FENCE_REGION_ID = 'streetcryptid.revive';

/**
 * Fence radius in metres. A trade-off with no clean answer: too small and a stationary phone
 * thrashes on GPS jitter, waking constantly; too large and a killed app stays dead across a long
 * trip. ~200 m sits above typical urban fix noise while still tripping within a block or two of
 * leaving. iOS allows 20 simultaneous regions (Android 100) and this uses exactly one.
 */
export const REVIVE_FENCE_RADIUS_M = 200;

/** True when this platform + build can actually host the revive fence. */
export function isReviveFenceAvailable(): boolean {
  return Platform.OS !== 'web' && tryTaskManager() !== null && tryLocation() !== null;
}

/**
 * Register the revive handler. Call once at module load (top level) so a **cold, headless** launch —
 * the entire point of this file — can service the event. The runner must be headless-safe and must
 * flush telemetry before returning, or the OS freezes the process with the batch unexported.
 */
export function defineReviveTask(run: (parent?: SpanContext) => Promise<void>): void {
  const taskManager = tryTaskManager();
  if (!taskManager || Platform.OS === 'web') return;
  taskManager.defineTask(REVIVE_FENCE_TASK, ({ error }) =>
    withEventLogLaunchContext('background', async () => {
      const telemetry = getTelemetry();
      const span = telemetry.startSpan('bg.revive');
      try {
        if (error) {
          span.setAttribute('sc.drop_reason', 'geofence-error');
          span.recordError(error);
          return;
        }
        await run(span.context);
        span.setStatus('ok');
      } catch (err) {
        span.recordError(err);
      } finally {
        span.end();
        await telemetry.flush();
      }
    })
  );
}

/**
 * Arm (or re-center) the fence on `fix`. Idempotent: `startGeofencingAsync` replaces the task's
 * whole region set, so repeated calls move the one fence rather than stacking them.
 *
 * Best-effort by design — a phone that has not granted `Always` simply cannot host this, and that
 * must not be an error at the call site.
 */
export async function armReviveFence(fix: LocationFix): Promise<boolean> {
  if (!isReviveFenceAvailable()) return false;
  const location = tryLocation();
  const taskManager = tryTaskManager();
  if (!location || !taskManager) return false;
  // Registering a geofence for a task the OS cannot deliver to is a silent no-op that looks armed.
  if (!taskManager.isTaskDefined(REVIVE_FENCE_TASK)) return false;
  try {
    await location.startGeofencingAsync(REVIVE_FENCE_TASK, [
      {
        identifier: REVIVE_FENCE_REGION_ID,
        latitude: fix.lat,
        longitude: fix.lon,
        radius: REVIVE_FENCE_RADIUS_M,
        // Exit only. Entry would fire immediately on arming (we are, by construction, inside it) and
        // every time the user came home, waking the app to do nothing.
        notifyOnEnter: false,
        notifyOnExit: true,
      },
    ]);
    return true;
  } catch (err) {
    console.warn('[revive-fence] arm failed', err);
    return false;
  }
}

/** Remove the fence. Idempotent; safe when it was never armed. */
export async function disarmReviveFence(): Promise<void> {
  if (Platform.OS === 'web') return;
  const location = tryLocation();
  const taskManager = tryTaskManager();
  if (!location || !taskManager) return;
  try {
    if (await taskManager.isTaskRegisteredAsync(REVIVE_FENCE_TASK)) {
      await location.stopGeofencingAsync(REVIVE_FENCE_TASK);
    }
  } catch {
    // best-effort — an un-armed fence is the desired end state either way
  }
}
