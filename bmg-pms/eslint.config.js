// Lint: catches undefined names, misused React hooks, unreachable code and missing list keys. Run: npm run lint
import hooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'tests/local-stack/**'] },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser }, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { 'react-hooks': hooks, react },
    rules: {
      'no-undef': 'error', 'react/jsx-no-undef': 'error', 'react/jsx-uses-vars': 'error', 'react/jsx-key': 'error',
      'react-hooks/rules-of-hooks': 'error', 'no-dupe-keys': 'error', 'no-unreachable': 'error',
      'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    files: ['supabase/functions/**/*.js', 'tools/**/*.mjs', 'scripts/**/*.mjs', 'tests/*.mjs', 'integrations/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, Deno: 'readonly' } },
    rules: { 'no-undef': 'error', 'no-dupe-keys': 'error', 'no-unreachable': 'error', 'no-unused-vars': ['warn', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }] },
  },
];
