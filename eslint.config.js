import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Fastify handlers and plugins are idiomatically async even when they don't await.
      '@typescript-eslint/require-await': 'off',
    },
  },
  { files: ['tests/**'], rules: { '@typescript-eslint/unbound-method': 'off' } },
  { files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked },
);
