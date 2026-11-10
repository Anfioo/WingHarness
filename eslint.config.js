import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist", "src-tauri", "node_modules"],
  },
  {
    files: ["src/**/*.{ts,tsx}", "vite.config.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-undef": "off",
      // Rest-destructuring is how this codebase drops a field from a record.
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
      // TanStack Virtual is used throughout and is known not to be memoizable;
      // the compiler skipping those components is expected, not a finding.
      "react-hooks/incompatible-library": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
    },
  },
  {
    // Ported upstream code (MIT, see src-tauri/space-preview-core/UPSTREAM.md).
    // It stays close to its source, so these patterns are allowed here instead of
    // being annotated file by file.
    files: [
      "src/lib/space-preview/engine/**/*.{ts,tsx}",
      "src/lib/space-preview/worker/**/*.{ts,tsx}",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "prefer-const": "off",
    },
  },
);
