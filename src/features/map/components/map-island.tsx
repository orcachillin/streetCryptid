import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { IslandTabs, type IslandTab } from './island-tabs';

interface MapIslandProps {
  readonly active: IslandTab;
  readonly children: ReactNode;
  /** Friends currently sharing live — surfaced on the FRIENDS tab. */
  readonly nearby: number;
  readonly theme: CryptidTheme;
  onSelect(tab: IslandTab): void;
}

/**
 * The single card that floats over the map. It owns the surface — radius,
 * hairline border, tint — so whatever readout is inside (coverage, roster,
 * a selected trail) reads as one continuous object rather than three
 * interchangeable panels, and so the segmented bar is part of the island
 * instead of yet another floating control.
 *
 * Children supply their own padding; the shell deliberately supplies none.
 */
export function MapIsland({ active, children, nearby, theme, onSelect }: MapIslandProps) {
  const { chrome } = theme;

  return (
    <View
      style={[styles.island, { backgroundColor: chrome.island, borderColor: chrome.islandBorder }]}
    >
      {children}
      <IslandTabs active={active} nearby={nearby} onSelect={onSelect} theme={theme} />
    </View>
  );
}

const styles = StyleSheet.create({
  island: {
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    // Keeps the roster's scroll edge and the tab bar's fill inside the radius.
    overflow: 'hidden',
  },
});
