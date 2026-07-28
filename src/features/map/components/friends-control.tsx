import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';

interface FriendsControlProps {
  readonly open: boolean;
  /** Friends currently sharing live — drives the contact-green presence pip. */
  readonly nearby: number;
  readonly theme: CryptidTheme;
  onPress(): void;
}

/**
 * The friends toggle in the map's right-hand control stack (DESIGN.md: layers ·
 * friends [green] · locate [amber]). Swaps the bottom island between the
 * coverage readout and the roster without ever leaving the map.
 *
 * Contact-green is this control's only accent — amber stays reserved for YOU
 * and the frontier rim. The pip is the one live indicator; the count is not
 * repeated here because the island itself already states it.
 */
export function FriendsControl({ open, nearby, theme, onPress }: FriendsControlProps) {
  const { chrome } = theme;

  return (
    <Pressable
      accessibilityLabel="Friends"
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityValue={{
        text:
          nearby === 0
            ? 'No friends sharing live'
            : `${nearby} friend${nearby === 1 ? '' : 's'} sharing live`,
      }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.fab,
        {
          backgroundColor: chrome.island,
          borderColor: open ? chrome.green : chrome.islandBorder,
          opacity: pressed ? 0.68 : 1,
        },
      ]}
    >
      <SymbolView
        name={{ ios: 'person.2.fill', android: 'group', web: 'group' }}
        size={21}
        tintColor={open || nearby > 0 ? chrome.green : chrome.steel}
      />
      {/* One live dot, and only while the island is not already saying "N NEARBY" —
          the declutter law forbids stating presence twice. */}
      {!open && nearby > 0 ? (
        <View
          style={[styles.pip, { backgroundColor: chrome.green, borderColor: chrome.island }]}
          testID="friends-presence-pip"
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    alignItems: 'center',
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  pip: {
    borderRadius: 5,
    borderWidth: 1.5,
    height: 10,
    position: 'absolute',
    right: 9,
    top: 9,
    width: 10,
  },
});
