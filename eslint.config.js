import { defineConfig } from "eslint/config";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default defineConfig([
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      semi: "error",
      "prefer-const": "error",
      "@typescript-eslint/no-explicit-any": "off",
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@salesforce/core",
              allowTypeImports: true,
              message:
                "Import types only. The SDK costs about 250 ms to load and a session that only reads logs must never pay it, and `verbatimModuleSyntax` emits a plain import even where every name is a type. A module that calls the SDK disables this rule at the import, and is reached only through `await import()`.",
            },
          ],
        },
      ],
    },
  },
]);
