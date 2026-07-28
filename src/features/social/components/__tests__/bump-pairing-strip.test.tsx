import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { BumpPairingStrip } from '../bump-pairing-strip';
import type { BumpSensorState } from '../../hooks/use-bump-to-pair';
import type { PairingSnapshot } from '../../net/location-sharing';

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('@/global.css', () => ({}));

const sensor: BumpSensorState = {
  status: 'ready',
  lastDetectedAt: null,
  lastIntensity: 0,
  error: null,
};

const capable = {
  available: true,
  activeScanToggle: true,
  rssi: true,
  discoveryRefresh: true,
  pairingReady: true,
};

function snapshot(overrides: Partial<PairingSnapshot> = {}): PairingSnapshot {
  return {
    available: true,
    ready: true,
    capabilities: capable,
    nearbyPeers: [],
    sessions: [],
    pendingRequests: [],
    verifications: [],
    bump: { stage: 'idle', expiresAt: null, rssi: null, peerCount: 0, error: null },
    discoveredFriend: null,
    inviteLink: null,
    inviteCode: null,
    mailboxAvailable: false,
    activity: '',
    ...overrides,
  };
}

describe('BumpPairingStrip', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  function render(pairing: PairingSnapshot | null, handlers = {}) {
    const onCommit = jest.fn().mockResolvedValue(undefined);
    const onRetry = jest.fn().mockResolvedValue(undefined);
    act(() => {
      renderer = create(
        <BumpPairingStrip
          onCommit={onCommit}
          onRetry={onRetry}
          pairing={pairing}
          sensor={sensor}
          theme={CryptidThemes.daybreak}
          {...handlers}
        />
      );
    });
    return { onCommit, onRetry };
  }

  it('says why pairing is impossible in Expo Go rather than offering a dead button', () => {
    render(snapshot({ available: false }));

    expect(text(renderer)).toContain('PAIRING NEEDS AN INSTALLED BUILD');
    expect(renderer.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0);
  });

  it('asks for Bluetooth when the radio is off', () => {
    render(
      snapshot({
        capabilities: { ...capable, available: false },
      })
    );

    expect(text(renderer)).toContain('BLUETOOTH OFFLINE');
  });

  it('offers a manual bump only once the radio is armed', async () => {
    const { onCommit } = render(
      snapshot({
        bump: { stage: 'armed', expiresAt: null, rssi: null, peerCount: 0, error: null },
      })
    );

    expect(text(renderer)).toContain('READY FOR IMPACT');
    const button = renderer.root.findByProps({
      accessibilityLabel: 'Pair with the phone touching this one',
    });
    await act(async () => {
      button.props.onPress();
    });
    expect(onCommit).toHaveBeenCalled();
  });

  it('parks on a retry after a miss instead of silently re-arming', async () => {
    const { onRetry } = render(
      snapshot({
        bump: {
          stage: 'failed',
          expiresAt: null,
          rssi: null,
          peerCount: 0,
          error: 'No phone answered.',
        },
      })
    );

    expect(text(renderer)).toContain('BUMP MISSED');
    expect(text(renderer)).toContain('No phone answered.');
    const button = renderer.root.findByProps({ accessibilityLabel: 'Try bump again' });
    await act(async () => {
      button.props.onPress();
    });
    expect(onRetry).toHaveBeenCalled();
  });
});

function text(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map((node) => String(node.props.children));
}
