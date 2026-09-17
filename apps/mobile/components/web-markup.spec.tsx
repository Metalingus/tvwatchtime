import React from 'react';
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};
import { Pressable, View } from 'react-native';
import { ArtworkHero } from './ArtworkHero';
import { ProfileAvatar } from './ProfileAvatar';

const mockButtons: any[] = [];
let mockTheme: 'light' | 'dark' = 'dark';
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native-web');
  return {
    ...actual,
    Pressable: (props: any) => {
      mockButtons.push(props);
      return React.createElement(actual.Pressable, props);
    },
  };
});
jest.mock('react-native-svg', () => {
  const web = jest.requireActual('react-native-svg/lib/commonjs/elements.web');
  return { __esModule: true, default: web.Svg, Circle: web.Circle, Path: web.Path };
});
jest.mock('expo-image', () => {
  const Image = React.forwardRef((_props: any, _ref: any) => null);
  return { Image };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../api/hooks', () => ({ useSetGalleryCover: () => ({ isPending: false }) }));
jest.mock('../context/PreferencesProvider', () => ({
  useAppearance: () => ({ tokens: jest.requireActual('@tvwatch/shared').buildTokens(mockTheme) }),
}));
jest.mock('../lib/toast', () => ({ showToast: jest.fn() }));
jest.mock('./primitives', () => ({
  T: ({ children }: any) => React.createElement('span', {}, children),
}));
jest.mock('./comments/MediaViewer', () => ({ MediaViewer: () => null }));
jest.mock('./ArtworkGalleryGrid', () => ({ ArtworkGalleryGrid: () => null }));

it.each(['light', 'dark'] as const)(
  'keeps hero controls independently accessible in %s mode',
  (theme) => {
    mockTheme = theme;
    mockButtons.length = 0;
    const menu = jest.fn();
    const html = renderToStaticMarkup(
      <ArtworkHero
        gallery={[
          { id: 'image', url: 'https://example.test/image.webp', width: 1600, height: 900 } as any,
        ]}
        fallbackUri={null}
        ownerType="MEDIA"
        ownerId="movie"
        style={{ height: 240 }}
      >
        <View>
          <Pressable accessibilityRole="button" accessibilityLabel="More options" onPress={menu} />
        </View>
      </ArtworkHero>,
    );
    let depth = 0;
    for (const [tag] of html.matchAll(/<\/?button\b[^>]*>/g)) {
      depth += tag.startsWith('</') ? -1 : 1;
      expect(depth).toBeLessThanOrEqual(1);
    }
    expect(depth).toBe(0);
    expect(html).toContain('aria-label="More options"');
    const galleryButton = mockButtons.find(
      (props) => props.accessibilityLabel === 'common:gallery.open',
    );
    expect(galleryButton?.accessibilityRole).toBe('button');
    mockButtons.find((props) => props.accessibilityLabel === 'More options').onPress();
    expect(menu).toHaveBeenCalledTimes(1);
  },
);

it.each(['light', 'dark'] as const)(
  'renders the real avatar SVG without invalid DOM props in %s mode',
  (theme) => {
    mockTheme = theme;
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const html = renderToStaticMarkup(<ProfileAvatar />);
      expect(html).toContain('<svg');
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toMatch(/\saccessible=/);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  },
);
