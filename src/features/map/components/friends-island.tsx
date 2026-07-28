import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';

/** One roster row's worth of friend, already resolved from live presence. */
export interface MapRosterFriend {
  readonly id: string;
  readonly handle: string;
  readonly sigil: string;
  readonly cryptidName?: string;
  /** The friend's chosen signal color — their one honest color everywhere. */
  readonly color: string;
  /** Metres from you, or null when either side has no fix yet. */
  readonly distanceM: number | null;
  /** Uppercase status line, e.g. `UPDATED 4 MIN AGO`. */
  readonly status: string;
  /** Live presence — offline rows dim rather than disappear. */
  readonly online: boolean;
  /** Whether we have a location to fly the map to. */
  readonly locatable: boolean;
}

interface FriendsIslandProps {
  readonly friends: readonly MapRosterFriend[];
  readonly theme: CryptidTheme;
  onSelect(friendId: string): void;
}

/** Tallest the roster grows before it scrolls — the map stays the hero. */
const MAX_LIST_HEIGHT = 268;

/**
 * The friends roster island from the design archive (`renders/social-roster-*`):
 * the bottom island swapped from "where you are" to "who is out there", without
 * ever leaving the map.
 *
 * Hairline dividers, not cards. One signal color per friend. Offline rows dim
 * instead of vanishing, so the roster's shape is stable. There is deliberately
 * no "shared ground" bar here — the mock showed one, but the app has no overlap
 * metric yet and a fabricated number would break the one-honest-signal rule.
 */
export function FriendsIsland({ friends, theme, onSelect }: FriendsIslandProps) {
  const { chrome } = theme;
  const nearby = friends.filter((friend) => friend.online).length;

  return (
    <View
      style={[styles.island, { backgroundColor: chrome.island, borderColor: chrome.islandBorder }]}
    >
      <View style={styles.header}>
        <Text style={[styles.title, { color: chrome.ink }]}>FRIENDS</Text>
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={
            friends.length === 0
              ? 'No friends in your atlas yet.'
              : `${friends.length} friend${friends.length === 1 ? '' : 's'}, ${nearby} sharing live.`
          }
          style={styles.count}
        >
          <View style={[styles.pip, { backgroundColor: nearby > 0 ? chrome.green : chrome.seg }]} />
          <Text style={[styles.countText, { color: chrome.steel }]}>{nearby} NEARBY</Text>
        </View>
      </View>

      {friends.length === 0 ? (
        <Text style={[styles.empty, { color: chrome.steel }]}>
          No cryptids in your atlas yet. Rub two phones together on the Friends tab to pair.
        </Text>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          {friends.map((friend, index) => (
            <FriendRow
              divider={index > 0}
              friend={friend}
              key={friend.id}
              onSelect={onSelect}
              theme={theme}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function FriendRow({
  divider,
  friend,
  onSelect,
  theme,
}: {
  readonly divider: boolean;
  readonly friend: MapRosterFriend;
  readonly theme: CryptidTheme;
  onSelect(friendId: string): void;
}) {
  const { chrome } = theme;
  const distance = compactDistance(friend.distanceM);
  const trailing = friend.online ? (distance ?? 'NO FIX') : 'OFFLINE';

  return (
    <Pressable
      accessibilityHint={
        friend.locatable ? 'Centers the map on them and shows their trail' : undefined
      }
      accessibilityLabel={`${friend.handle}. ${trailing.toLowerCase()}. ${friend.status.toLowerCase()}.`}
      accessibilityRole="button"
      accessibilityState={{ disabled: !friend.locatable }}
      disabled={!friend.locatable}
      onPress={() => onSelect(friend.id)}
      style={({ pressed }) => [
        styles.row,
        divider && {
          borderTopColor: chrome.islandBorder,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        { opacity: !friend.locatable ? 0.55 : pressed ? 0.58 : 1 },
      ]}
    >
      <CryptidAvatar
        art={friend.sigil || 'unknown'}
        color={friend.color}
        muted={!friend.online}
        name={friend.cryptidName ?? 'Unknown form'}
        style={styles.avatar}
      />
      <View style={styles.copy}>
        <Text numberOfLines={1} style={[styles.handle, { color: friend.color }]}>
          {friend.handle}
        </Text>
        <Text numberOfLines={1} style={[styles.status, { color: chrome.steel }]}>
          {friend.status}
        </Text>
      </View>
      <Text style={[styles.trailing, { color: friend.online ? chrome.ink : chrome.steel }]}>
        {trailing}
      </Text>
      <SymbolView
        name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
        size={15}
        tintColor={chrome.steel}
      />
    </Pressable>
  );
}

/**
 * Distance for a roster row: short, uppercase, and rounded to a precision the
 * fix actually supports — never a false-precision metre count.
 */
export function compactDistance(distanceM: number | null): string | null {
  if (distanceM === null || !Number.isFinite(distanceM)) return null;
  if (distanceM < 950) return `${Math.max(0, Math.round(distanceM / 10) * 10)} M`;
  const km = distanceM / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0)} KM`;
}

const styles = StyleSheet.create({
  island: {
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    paddingBottom: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
    minHeight: 32,
  },
  title: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 24,
    letterSpacing: 3,
    lineHeight: 28,
  },
  count: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.one,
  },
  pip: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  countText: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  empty: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 12,
    lineHeight: 18,
    paddingBottom: Spacing.two,
    paddingTop: Spacing.two,
  },
  list: {
    maxHeight: MAX_LIST_HEIGHT,
  },
  listContent: {
    paddingBottom: Spacing.one,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
    minHeight: 64,
    paddingVertical: Spacing.two,
  },
  avatar: {
    width: 72,
  },
  copy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  handle: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 22,
    lineHeight: 25,
  },
  status: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 9,
    letterSpacing: 1,
  },
  trailing: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 16,
    lineHeight: 19,
  },
});
