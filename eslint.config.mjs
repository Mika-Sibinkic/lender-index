import next from 'eslint-config-next'
import tseslint from 'typescript-eslint'

/**
 * Lint.
 *
 * Deliberately NOT wired into the build or any deploy gate. `pnpm typecheck` and
 * `pnpm test` are the gates; this is a third opinion you run on purpose. A lint
 * rule that can block a production deploy on a stylistic disagreement is a
 * liability on a small-team tool.
 *
 * Scope is the rules that catch real defects — hook dependencies, unreachable
 * code, floating promises — not formatting. This codebase has a deliberate house
 * style (dense explanatory comments, long literal arrays of production values)
 * that a formatter would fight.
 */
export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'supabase/**'] },
  ...next,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // `any` is used knowingly at Supabase row boundaries, where the generated
      // types do not survive a dynamic column name. Warn, never error.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
