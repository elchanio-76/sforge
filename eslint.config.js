import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'sites/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Client-side scripts shipped with sites and themes run in the browser.
    files: ['examples/**/assets/**/*.js', 'packages/theme-*/assets/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
