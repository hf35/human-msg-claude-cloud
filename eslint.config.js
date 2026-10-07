import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'pnpm-lock.yaml'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // The project uses ES modules only (see CLAUDE.md)
      '@typescript-eslint/no-require-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='module'][property.name='exports']",
          message: 'Use ES module exports instead of module.exports.',
        },
        {
          selector: "AssignmentExpression > Identifier.left[name='exports']",
          message: 'Use ES module exports instead of CommonJS exports.',
        },
      ],
    },
  },
  // Must stay last: turns off rules that conflict with Prettier
  prettier,
);
