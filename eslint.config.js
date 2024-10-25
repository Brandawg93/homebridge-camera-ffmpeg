import antfu from '@antfu/eslint-config'

export default antfu(
  {
    ignores: ['dist', 'docs'],
    jsx: false,
    typescript: true,
    formatters: {
      markdown: true,
    },
    rules: {
      'curly': ['error', 'multi-line'],
      'import/extensions': ['error', 'ignorePackages'],
      'import/order': 0,
      'jsdoc/check-alignment': 'error',
      'jsdoc/check-line-alignment': 'error',
      'perfectionist/sort-exports': 'error',
      'perfectionist/sort-imports': [
        'error',
        {
          groups: [
            'builtin-type',
            'external-type',
            'internal-type',
            ['parent-type', 'sibling-type', 'index-type'],
            'builtin',
            'external',
            'internal',
            ['parent', 'sibling', 'index'],
            'object',
            'unknown',
          ],
          order: 'asc',
          type: 'natural',
        },
      ],
      'perfectionist/sort-named-exports': 'error',
      'perfectionist/sort-named-imports': 'error',
      'sort-imports': 0,
      'style/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      'style/quote-props': ['error', 'consistent-as-needed'],
      'test/no-only-tests': 'error',
      'unicorn/no-useless-spread': 'error',
      'unused-imports/no-unused-vars': ['error', { caughtErrors: 'none' }],
      'no-new': 0, // Disable the no-new rule
      'new-cap': 0, // Disable the new-cap rule
      'no-undef': 0, // Disable the no-undef rule
    },
  },
)
