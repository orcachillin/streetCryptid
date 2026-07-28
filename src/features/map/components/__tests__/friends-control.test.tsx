import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { FriendsControl } from '../friends-control';

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));
jest.mock('@/global.css', () => ({}));

describe('FriendsControl', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  function render(props: { open: boolean; nearby: number }, onPress = jest.fn()) {
    act(() => {
      renderer = create(
        <FriendsControl
          nearby={props.nearby}
          onPress={onPress}
          open={props.open}
          theme={CryptidThemes.daybreak}
        />
      );
    });
    return onPress;
  }

  function pips() {
    return renderer.root.findAllByProps({ testID: 'friends-presence-pip' });
  }

  it('announces live presence without repeating it once the island is open', () => {
    render({ open: false, nearby: 2 });
    expect(pips().length).toBeGreaterThan(0);

    act(() => {
      renderer.update(
        <FriendsControl nearby={2} onPress={jest.fn()} open theme={CryptidThemes.daybreak} />
      );
    });
    expect(pips()).toHaveLength(0);
  });

  it('stays dotless when nobody is sharing', () => {
    render({ open: false, nearby: 0 });
    expect(pips()).toHaveLength(0);
  });

  it('reads the roster state out to assistive tech', () => {
    const onPress = render({ open: true, nearby: 1 });

    const button = renderer.root.findByProps({ accessibilityLabel: 'Friends' });
    expect(button.props.accessibilityState).toEqual({ expanded: true });
    expect(button.props.accessibilityValue).toEqual({ text: '1 friend sharing live' });

    act(() => button.props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
