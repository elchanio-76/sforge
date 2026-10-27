import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'sites/**', '**/.terraform/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Client-side scripts shipped with sites and themes run in the browser.
    files: [
      'examples/**/assets/**/*.js',
      'packages/theme-*/assets/**/*.js',
      'packages/dev-server/client/**/*.js',
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    // The sign-in Lambda of private AWS targets runs on Node.js.
    files: ['scripts/**/*.mjs', 'packages/providers/aws/terraform/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // CloudFront Functions: `handler` is the entry point, the config is substituted
    // at provision time, and the runtime may not support optional catch bindings.
    files: ['packages/providers/aws/terraform/**/*.js'],
    languageOptions: { globals: { __SFORGE_CONFIG__: 'readonly', atob: 'readonly' } },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^handler$', caughtErrors: 'none' },
      ],
    },
  },
);
