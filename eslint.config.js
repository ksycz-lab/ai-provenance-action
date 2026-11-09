import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", ".dependency-cruiser.cjs"],
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@actions/*"],
              message: "src/core must stay pure — use src/adapters for I/O.",
            },
            {
              group: ["node:*", "fs", "path", "node:fs", "node:path"],
              message: "src/core must not import Node filesystem APIs.",
            },
            {
              group: ["**/adapters/**", "../adapters/*", "../../adapters/*"],
              message: "src/core must not import src/adapters.",
            },
          ],
        },
      ],
    },
  },
);
