import { SymbolView } from 'expo-symbols';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

/** The two things the bottom island can be about. */
export type IslandTab = 'here' | 'friends';

type SymbolName = ComponentProps<typeof SymbolView>['name'];

interface IslandTabsProps {
  readonly active: IslandTab;
  /** Friends currently sharing live — drives the contact-green presence pip. */
  readonly nearby: number;
  readonly theme: CryptidTheme;
  onSelect(tab: IslandTab): void;
}

/**
 * The island's own segmented bar — the app's only navigation, and the reason
 * there is no friends FAB in the right-hand control stack any more.
 *
 * Modelled on Find My: the sheet owns the switch, so the map keeps its corners
 * free for map affordances (layers, locate) and nothing floats that isn't
 * about the map itself.
 */
export function IslandTabs({ active, nearby, theme, onSelect }: IslandTabsProps) {
  const { chrome } = theme;

  return (
    <View accessibilityRole="tablist" style={[styles.bar, { borderTopColor: chrome.islandBorder }]}>
      <IslandTabButton
        active={active === 'here'}
        icon={{ ios: 'hexagon.fill', android: 'hexagon', web: 'hexagon' }}
        label="HERE"
        onPress={() => onSelect('here')}
        theme={theme}
      />
      <IslandTabButton
        active={active === 'friends'}
        icon={{ ios: 'person.2.fill', android: 'group', web: 'group' }}
        label="FRIENDS"
        onPress={() => onSelect('friends')}
        // One live dot, and only while the roster is not already saying
        // "N NEARBY" — the declutter law forbids stating presence twice.
        pip={active !== 'friends' && nearby > 0}
        hint={nearby === 0 ? 'No friends sharing live' : `${nearby} sharing live`}
        theme={theme}
      />
    </View>
  );
}

function IslandTabButton({
  active,
  hint,
  icon,
  label,
  pip = false,
  theme,
  onPress,
}: {
  readonly active: boolean;
  readonly hint?: string;
  readonly icon: SymbolName;
  readonly label: string;
  readonly pip?: boolean;
  readonly theme: CryptidTheme;
  onPress(): void;
}) {
  const { chrome } = theme;
  // Contrast, not colour, carries selection: amber stays reserved for YOU and
  // the frontier rim, contact-green for actual friend presence.
  const tint = active ? chrome.ink : chrome.steel;

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityValue={hint ? { text: hint } : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tab,
        active && { backgroundColor: chrome.seg },
        { opacity: pressed ? 0.6 : 1 },
      ]}
    >
      <View style={styles.iconWrap}>
        <SymbolView name={icon} size={16} tintColor={tint} />
        {pip ? (
          <View
            style={[styles.pip, { backgroundColor: chrome.green, borderColor: chrome.island }]}
            testID="island-tab-presence-pip"
          />
        ) : null}
      </View>
      <Text style={[styles.label, active && styles.labelActive, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  tab: {
    alignItems: 'center',
    borderRadius: 18,
    flex: 1,
    flexDirection: 'row',
    gap: Spacing.two,
    justifyContent: 'center',
    minHeight: 44,
  },
  iconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pip: {
    borderRadius: 4,
    borderWidth: 1.5,
    height: 8,
    position: 'absolute',
    right: -5,
    top: -3,
    width: 8,
  },
  label: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 13,
    letterSpacing: 2,
    lineHeight: 16,
  },
  labelActive: {
    fontFamily: 'Rajdhani_700Bold',
  },
});
