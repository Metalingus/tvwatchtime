// ESLint flat config for @tvwatch/mobile.
// Goals: (1) block legacy `colors`/`theme`/`Theme` imports, (2) block hardcoded color
// literals via a local rule. Theme UI colors must come from useAppearance().tokens.
const tseslint = require('typescript-eslint');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const reactHooks = require('eslint-plugin-react-hooks');
const noHardcodedColors = require('./.eslint-rules/no-hardcoded-colors.js');

/** Local plugin exposing the custom rule. */
const localPlugin = {
  meta: { name: 'tvwatch-mobile-local' },
  rules: { 'no-hardcoded-colors': noHardcodedColors },
};

module.exports = tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.expo/**',
      '.expo-types/**',
      'android/**',
      'ios/**',
      'public/**',
      'locales/**',
      'assets/**',
      'build/**',
      'expo-env.d.ts',
    ],
  },
  {
    // This config enforces theme-token usage only; don't surface unused-disable
    // warnings for pre-existing directives that reference rules this config doesn't enable.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
      local: localPlugin,
    },
    rules: {
      // Block legacy dark-only palette imports. Static primitives (spacing/radius/
      // typography/poster/design/Design) and token helpers (buildTokens/Tokens) stay allowed.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/theme/theme', '**/theme/theme.ts'],
              importNames: ['colors', 'theme', 'Theme'],
              message:
                'Do not import the legacy dark-only colors/theme/Theme. Use useAppearance().tokens for runtime colors; import spacing/radius/typography/poster for static primitives.',
            },
          ],
        },
      ],
      // Custom: no hardcoded color literals.
      'local/no-hardcoded-colors': 'error',
      // Keep noise low; this config is focused on theme enforcement, not a full lint pass.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Tests/fixtures legitimately compare against exact color values.
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
    rules: {
      'local/no-hardcoded-colors': 'off',
    },
  },
);
