import React from 'react';
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { buildTokens } from '@tvwatch/shared';
import { SortBar } from './SortBar';

let mockTheme: 'light' | 'dark' = 'light';
jest.mock('react-native', () => jest.requireActual('react-native-web'));
jest.mock('../../assets/branding/commsuni_logo_smooth.svg', () => ({
  uri:
    'data:image/svg+xml;base64,' +
    jest
      .requireActual('fs')
      .readFileSync(
        jest
          .requireActual('path')
          .join(__dirname, '../../assets/branding/commsuni_logo_smooth.svg'),
      )
      .toString('base64'),
}));
jest.mock('expo-image', () => ({
  Image: (props: any) =>
    React.createElement('img', {
      src: props.source.uri,
      alt: props.accessibilityLabel,
      style: { ...props.style, objectFit: props.contentFit === 'cover' ? 'cover' : 'contain' },
    }),
}));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: (props: any) =>
    React.createElement('span', { style: { color: props.color, fontSize: props.size } }, 'ⓘ'),
}));
jest.mock('../primitives', () => ({
  T: ({ children, style, muted, variant }: any) => {
    const { Text } = jest.requireActual('react-native-web');
    const tokens = jest.requireActual('@tvwatch/shared').buildTokens(mockTheme);
    return React.createElement(
      Text,
      {
        style: [
          {
            color: muted ? tokens.textMuted : tokens.textPrimary,
            ...jest.requireActual('../../theme/theme').typography[variant ?? 'body'],
          },
          style,
        ],
      },
      children,
    );
  },
}));
jest.mock('../../context/PreferencesProvider', () => ({
  useAppearance: () => ({ tokens: jest.requireActual('@tvwatch/shared').buildTokens(mockTheme) }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const data = jest.requireActual('../../locales/en/comments.json');
      return (
        key
          .replace('comments:', '')
          .split('.')
          .reduce((value: any, part: string) => value?.[part], data) ?? key
      );
    },
  }),
}));
jest.mock('../../api/commsuni', () => ({
  useCommsUniSources: () => ({
    data: {
      ownSource: 'tvwatch',
      sources: [
        {
          sourceId: 1,
          slug: 'tvtime',
          kind: 'tvtime',
          displayName: 'TV Community Archive',
          iconUrl:
            'data:image/svg+xml,' +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="20" fill="#e5b900"/><text x="8" y="26" font-size="16">TV</text></svg>',
            ),
        },
        {
          sourceId: 2,
          slug: 'commsunitv',
          kind: 'partner',
          displayName: 'CommsUni',
          iconUrl:
            'data:image/svg+xml,' +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="20" fill="#e5b900"/><text x="13" y="26" font-size="16">C</text></svg>',
            ),
        },
        { slug: 'tvwatch', kind: 'partner', displayName: 'TV Watch Time', iconUrl: null },
      ],
    },
  }),
}));

describe('attribution', () => {
  it.each(['light', 'dark'] as const)(
    'renders attribution without source filters in %s theme',
    (theme) => {
      mockTheme = theme;
      const open = jest
        .spyOn(React, 'useState')
        .mockImplementationOnce(() => [true, jest.fn()] as any);
      const html = renderToStaticMarkup(
        <>
          <SortBar attribution sort="LATEST" onChange={() => undefined} />
        </>,
      );
      open.mockRestore();
      expect(html).toContain('Comments by CommsUni.tv');
      expect(html).toContain('font-style:italic');
      expect(html).toContain('alt="CommsUni.tv"');
      expect(html).toContain('Recent');
      expect(html).toContain('Top');
      expect(html).toContain('Visit and support CommsUni');
      expect(html).toContain('Visit TV Community Archive');
      expect(html).not.toContain('All sources');
      expect(html).toContain('Shared comments use your TV Watch Time username');
      expect(html.match(/<img /g)).toHaveLength(3);
      expect(html).toContain('alt="TV Community Archive"');
      expect(html).toContain('data-testid="community-project-icons"');
      if (process.env.COMMSUNI_UI_REVIEW_DIR) {
        mkdirSync(process.env.COMMSUNI_UI_REVIEW_DIR, { recursive: true });
        const { AppRegistry } = jest.requireActual('react-native-web');
        AppRegistry.registerComponent('CommsUniReview', () => () => null);
        const css = renderToStaticMarkup(
          AppRegistry.getApplication('CommsUniReview').getStyleElement(),
        );
        const tokens = buildTokens(theme);
        writeFileSync(
          join(process.env.COMMSUNI_UI_REVIEW_DIR, theme + '.html'),
          '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            css +
            '</head><body style="margin:0;background:' +
            tokens.background +
            '"><main style="max-width:420px;margin:24px auto;padding:16px">' +
            html +
            '</main></body></html>',
        );
      }
    },
  );
});

it.each(['light', 'dark'] as const)(
  'keeps the new text/background pairs readable in %s mode',
  (theme) => {
    const tokens = buildTokens(theme);
    const luminance = (hex: string) => {
      const channels = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    for (const [text, background] of [
      [tokens.textPrimary, tokens.background],
      [tokens.textPrimary, tokens.surfaceAlt],
      [tokens.textSecondary, tokens.surfaceAlt],
      [tokens.textPrimary, tokens.primarySoft],
      [tokens.textSecondary, tokens.surface],
    ]) {
      const a = luminance(text),
        b = luminance(background);
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  },
);
