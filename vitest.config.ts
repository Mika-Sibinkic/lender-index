import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: ['**/node_modules/**', '**/tests/e2e/**', '**/.next/**'],
  },
  resolve: {
    alias: [
      // The suite pins behaviour against the shipped vocabulary, not a deployer's edits.
      // src/lib/config/vocabulary.check.test.ts imports the real file relatively.
      {
        find: /^@\/lib\/config\/vocabulary$/,
        replacement: path.resolve(__dirname, './src/test/default-vocabulary.ts'),
      },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
})
