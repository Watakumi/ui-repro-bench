import shadcn from '@shadcn/lint'
import tsParser from '@typescript-eslint/parser'
export default [
  { files: ['**/*.tsx'], languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { '@shadcn': shadcn },
    rules: { '@shadcn/no-raw-colors': 'error', '@shadcn/no-arbitrary-values': 'error', '@shadcn/no-inline-styles': 'error', '@shadcn/no-unknown-classes': 'error', '@shadcn/no-restyle': 'error', '@shadcn/require-static-classes': 'error' } },
]
