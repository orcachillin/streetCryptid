import { AppState } from 'react-native';

import { getTelemetry, type SpanContext } from '@/features/dev/telemetry';
import { createCryptidProfileStore } from '@/features/account/storage/profile-store';
import { LocationSharingService } from '../location-sharing';
import { createPersistentKV, loadShareIntervalMs, loadSharingEnabled } from '../persistence';
import { backgroundOutbox } from './background-outbox';
import { isBackgroundLocationRunning, startBackgroundLocation } from './background-task';
import { createBatterySource } from './battery-source';
import { cfgFromDecision } from './cadence-controller';
import { getActiveBackfillHandler } from './register-task';
import { createSamplingPolicy } from './sampling-policy';

// Serialize ALL headless node usage. expo-task-manager delivers each OS callback to a fresh,
// short-lived JS context, and the native iroh runtime is a process-wide singleton (createNode →
// clearRuntime), so two overlapping headless sessions — a send-drain and a periodic backfill —
// would tear each other's node down mid-flight. One chained lock keeps them strictly sequential.
let sessionChain: Promise<void> = Promise.resolve();

interface HeadlessSession<T> {
  /** Cheap precondition checked BEFORE a node is spun up; `false` ⇒ skip and return `fallback`. */
  precheck?: () => Promise<boolean>;
  fallback: T;
  run: (service: LocationSharingService) => Promise<T>;
}

async function session<T>(opts: HeadlessSession<T>): Promise<T> {
  // Never run headless while the app is active: the mounted runtime owns the shared native node and
  // does this work itself. Spinning up a second node would call createNode → clearRuntime and tear
  // down the FOREGROUND node mid-flight (breaking its gossip subscription and pairing poll). The
  // batch is already persisted (senders enqueue before calling us), so nothing is lost — the
  // foreground engine flushes/syncs on its next cycle.
  if (AppState.currentState === 'active') return opts.fallback;
  if (opts.precheck && !(await opts.precheck())) return opts.fallback;

  const profile = await createCryptidProfileStore().load();
  if (!profile) {
    throw new Error('Cannot run background location work before a cryptid profile is configured.');
  }

  const service = new LocationSharingService();
  try {
    await service.init(profile.handle, profile.sigil, profile.cryptidName, profile.color, {
      mode: 'headless',
    });
    return await opts.run(service);
  } finally {
    // Drain telemetry before the node goes away — this short-lived context is exactly the one
    // whose batches die unexported if we skip it.
    await service.flushDevTelemetry();
    await service.shutdownAsync();
  }
}

/** Chain onto the shared lock so send-drain and backfill never spin up two native nodes at once. */
function runHeadless<T>(opts: HeadlessSession<T>): Promise<T> {
  const result = sessionChain.then(() => session(opts));
  sessionChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Re-arm OS background location updates if the user wants sharing on but the OS task is not running.
 *
 * This is the self-heal, and it exists because the ordinary re-arm path is unreachable from here:
 * `rearmBackgroundLocationTask` is only called via `startBackground`, which is driven by a React
 * hook, so it needs the UI to mount. A phone that was terminated (jetsam, a crash, a reboot) can
 * therefore be woken repeatedly — for a backfill, for a geofence exit — sync happily, and still
 * never restart its own location reporting. That is exactly what kept an iPhone dark for hours after
 * a live-mode test killed it.
 *
 * Deliberately NOT wrapped in {@link runHeadless}: it touches only the OS location task, needs no
 * iroh node, and so cannot trip the `createNode → clearRuntime` singleton hazard described above.
 * That also makes it safe to call while a mounted runtime is alive.
 *
 * @returns true when it actually re-armed (for telemetry/tests), false when nothing was needed.
 */
export async function ensureSharingArmedHeadless(parent?: SpanContext): Promise<boolean> {
  const kv = createPersistentKV();
  if (!(await loadSharingEnabled(kv))) return false;
  if (await isBackgroundLocationRunning()) return false;

  const span = getTelemetry().startSpan('bg.selfheal', { parent });
  try {
    const policy = createSamplingPolicy({ intervalMs: await loadShareIntervalMs(kv) });
    // Ambient cadence only. A self-heal never restores live mode: the watcher's window has almost
    // certainly lapsed by now, and resurrecting a 4-second cadence unattended is how this failure
    // mode compounds instead of ending.
    const decision = policy.decide({ battery: await createBatterySource().read() });
    span.setAttribute('decision.interval_ms', decision.timeIntervalMs);
    await startBackgroundLocation(
      cfgFromDecision(decision, {
        title: 'streetCryptid',
        body: "Keeping your friends' map current.",
        color: '#C6791A',
      })
    );
    span.setStatus('ok');
    return true;
  } catch (err) {
    // Android 12+ forbids starting a foreground service from the background, and
    // `startLocationUpdatesAsync` starts one. When that is why we failed, retrying on the next wake
    // will fail identically — the user has to bring the app forward — so name it rather than
    // burying it in a generic error. Never rethrow: a failed self-heal must not fail its caller,
    // which is usually a backfill that still has real work to do.
    const message = err instanceof Error ? err.message : String(err);
    const blocked = /ForegroundServiceStartNotAllowed|not allowed to start service/i.test(message);
    span.setAttribute('sc.drop_reason', blocked ? 'fgs-start-blocked' : 'selfheal-failed');
    span.recordError(err);
    console.warn('[background-location] self-heal re-arm failed', err);
    return false;
  } finally {
    span.end();
  }
}

/**
 * Publish queued fixes from a fresh headless context — the SEND path when the app is backgrounded or
 * killed. Called by the location TaskManager handler after it persists a batch. No-op while active
 * (the mounted runtime drains the outbox itself) or when nothing is queued.
 */
export function flushBackgroundOutboxHeadless(parent?: SpanContext): Promise<number> {
  return runHeadless({
    precheck: async () => (await backgroundOutbox.pending()) > 0,
    fallback: 0,
    run: async (service) => {
      const published = await backgroundOutbox.drain(async (fix, drainParent) => {
        await service.publishFix(fix, drainParent);
      }, parent);
      // `publishFix` only broadcasts live (to a swarm that is usually empty out here) and writes
      // the LOCAL docs replica. Without this push the envelopes never leave the phone, so a friend
      // who wasn't online at this exact moment never sees them — the whole reason the stash exists.
      // Must happen before the `finally` in `session()` shuts the node down.
      if (published > 0) await service.pushTrail(parent);
      return published;
    },
  });
}

/**
 * Periodic RECEIVE path: backfill fixes missed while backgrounded (from the trail-stash + peers),
 * then publish anything still queued. Driven by the `expo-background-task` scheduler — see
 * `backfill-task.ts`. No-op while the app is active (the foreground lifecycle already syncs).
 */
export function runBackgroundBackfillHeadless(parent?: SpanContext): Promise<void> {
  // If a mounted runtime is alive it owns the process-wide native node. On Android that runtime
  // stays alive while backgrounded (the location foreground service), so `AppState` is NOT 'active'
  // and the `session()` guard alone would let us spin up a SECOND node here — whose `createNode`
  // calls `clearRuntime()` and tears the live node's subscriptions down, silently killing outgoing
  // publishes and live receive until relaunch. Route the backfill to the live runtime instead.
  // Self-heal BEFORE anything else, and regardless of whether a runtime is mounted. This periodic
  // wake is Android's resurrection path (WorkManager survives reboot), and on iOS it is the one
  // regular opportunity to notice that the location task died with a previous process.
  void ensureSharingArmedHeadless(parent);

  const runMounted = getActiveBackfillHandler();
  if (runMounted) return runMounted(parent);
  return runHeadless<void>({
    fallback: undefined,
    run: async (service) => {
      // Drain FIRST, then sync. `syncTrail` is bidirectional, so the one call both pushes what we
      // just published and pulls what friends left at the stash. Syncing first (as this did) meant
      // every fix published here waited for the *next* OS wake to be pushed — ~15 min at best on
      // Android, and on iOS potentially never.
      if ((await backgroundOutbox.pending()) > 0) {
        await backgroundOutbox.drain(async (fix, drainParent) => {
          await service.publishFix(fix, drainParent);
        }, parent);
      }
      await service.syncTrail(0, parent);
    },
  });
}
