import React from 'react';
import { StyleSheet } from 'react-native';
import { Header } from './Header';

const mockButtons: any[] = [];
const mockBack = jest.fn();
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native-web');
  return {
    ...actual,
    Pressable: (props: any) => {
      mockButtons.push(props);
      return null;
    },
  };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-router', () => ({ router: { back: () => mockBack() } }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../context/PreferencesProvider', () => ({
  useAppearance: () => ({ tokens: jest.requireActual('@tvwatch/shared').buildTokens('dark') }),
}));
jest.mock('./primitives', () => ({ T: () => null }));

const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};

it('gives the back button a full touch target that does not rely on hitSlop', () => {
  mockButtons.length = 0;
  renderToStaticMarkup(<Header showBack tone="media" />);
  const back = mockButtons.find((props) => props.accessibilityLabel === 'common:back');
  expect(back?.accessibilityRole).toBe('button');
  const style = StyleSheet.flatten(back.style);
  expect(style.width).toBeGreaterThanOrEqual(44);
  expect(style.height).toBeGreaterThanOrEqual(44);
  back.onPress();
  expect(mockBack).toHaveBeenCalledTimes(1);
});
