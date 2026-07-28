import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useBumpToPair, type BumpSensorState } from './use-bump-to-pair';
import { useLocationSharing } from './use-location-sharing';
import { usePairingHaptics } from './use-pairing-haptics';
import type { PairingSnapshot } from '../net/location-sharing';

export interface ArmedBump {
  readonly pairing: PairingSnapshot | null;
  readonly sensor: BumpSensorState;
  /** True while this surface is the reason bump is armed. */
  readonly live: boolean;
  commit(): Promise<void>;
  retry(): Promise<void>;
}

/**
 * Bump is armed for as long as the roster is actually on screen and the app is
 * in front — that is, the island's FRIENDS tab is selected and nothing is
 * drilled into.
 *
 * There is no ARM button and no pairing screen: showing the roster IS declaring
 * "I am trying to meet someone". Leaving the tab, drilling into a friend's trace,
 * or backgrounding the app disarms, so the radio is never quietly left listening.
 *
 * Arming only ever fires from `idle`, so a failure parks the strip on TRY AGAIN
 * instead of spinning the radio in a retry loop.
 */
export function useArmedBump(active: boolean): ArmedBump {
  const { pairing, armBump, commitBump, cancelBump } = useLocationSharing();
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);

  const live = active && appState === 'active';
  const stage = pairing?.bump.stage ?? 'idle';
  const ready = Boolean(pairing?.available && pairing.ready && pairing.capabilities?.available);
  // A verification or a fresh discovery owns the screen; do not race it with a new bump.
  const busy = Boolean(pairing?.discoveredFriend) || Boolean(pairing?.verifications.length);

  useEffect(() => {
    if (!live || !ready || busy || stage !== 'idle') return;
    void armBump().catch(() => {
      // The provider owns the actionable error; the strip renders the failed stage.
    });
  }, [armBump, busy, live, ready, stage]);

  useEffect(() => {
    if (live || stage === 'idle') return;
    void cancelBump();
  }, [cancelBump, live, stage]);

  const sensor = useBumpToPair(live && stage === 'armed' && !pairing?.discoveredFriend, commitBump);
  usePairingHaptics(pairing, live);

  return { pairing, sensor, live, commit: commitBump, retry: armBump };
}
