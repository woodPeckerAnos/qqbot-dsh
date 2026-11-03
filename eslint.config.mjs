import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import sonarjs from 'eslint-plugin-sonarjs';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  // 构建产物、依赖、临时探针与生成文档不参与代码检查。
  {
    ignores: [
      'node_modules/**',
      '**/dist/**',
      'packages/contracts/compatibility/**',
      'tmp/**',
      'coverage/**',
      'docs/**',
      'package-lock.json',
    ],
  },

  js.configs.recommended,
  // 类型感知严格集（TS 文件在下面的块里接上 projectService）。
  ...tseslint.configs.strictTypeChecked,

  {
    // 源码与测试：使用最近的 tsconfig（src/ 用根 tsconfig，tests/ 用 tests/tsconfig）。
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    plugins: {
      '@stylistic': stylistic,
      sonarjs,
    },
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.ts', '*.config.mts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // —— 审阅友好性：语句级强制 ——
      '@stylistic/max-statements-per-line': ['error', { max: 1 }],
      'no-nested-ternary': 'error',
      '@stylistic/multiline-ternary': ['error', 'always-multiline'],

      // —— 认知复杂度（比圈复杂度更贴近审阅难度）——
      'sonarjs/cognitive-complexity': ['error', 15],
      'sonarjs/no-nested-conditional': 'error',

      // —— 结构约束 ——
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'max-statements': ['error', 15],
      'max-lines-per-function': ['error', { max: 50 }],

      // —— 类型安全兜底（strictTypeChecked 已含大部分，这里显式钉住关键几条）——
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // 数字插值不会像对象那样退化成 "[object Object]"，构建 key/日志时放开。
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // 接口实现/回调里用 `_` 前缀显式标记"签名要求但此处不用"。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    // 检查脚本、DSH 插件和仓库根配置都是 JS：只做语法/通用规则，不要求类型信息。
    // 显式列出脚本用到的 Node 全局，避免为一个词表引入额外依赖。
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        structuredClone: 'readonly',
        performance: 'readonly',
        queueMicrotask: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
      },
    },
  },

  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'tests/**/*.ts'],
    rules: {
      // 测试夹具可以是长函数/多分支，但断言仍受类型规则约束。
      'max-lines-per-function': 'off',
      'max-statements': 'off',
      complexity: 'off',
      'sonarjs/cognitive-complexity': 'off',

      // 测试里断言 mock 已经构造好，用 `!` 取值是惯用法；生产代码仍禁止。
      '@typescript-eslint/no-non-null-assertion': 'off',
      // 测试替身经常保持 async 签名而同步返回，不强制 await。
      '@typescript-eslint/require-await': 'off',
      // mock 对象的默认字符串化与 vitest 方法引用是测试专用场景。
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // 兼容旧格式的测试会刻意读取 deprecated 字段。
      '@typescript-eslint/no-deprecated': 'off',
      // 测试替身与 JSON 夹具天然带 any；类型收窄的断言价值低于噪声。
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // mock 的对象可以处于生产类型上"不可能"的状态，用于测防御分支。
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  {
    // tests/legacy 是历史回归夹具，只用于对照旧行为，不参与新代码质量门槛。
    files: ['tests/legacy/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-statements': 'off',
      complexity: 'off',
      'sonarjs/cognitive-complexity': 'off',
      'max-depth': 'off',
      'no-nested-ternary': 'off',
      'sonarjs/no-nested-conditional': 'off',
    },
  },

  eslintConfigPrettier // 必须最后，关掉与 Prettier 冲突的规则
);
