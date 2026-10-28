import { defineConfig } from "eslint/config";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const salesforceCoreTypesOnly = {
  name: "@salesforce/core",
  allowTypeImports: true,
  message:
    "Import types only. The SDK costs about 250 ms to load and a session that only reads logs must never pay it, and `verbatimModuleSyntax` emits a plain import even where every name is a type. A module that calls the SDK disables this rule at the import, and is reached only through `await import()`.",
};

const BIND_OPEN_ORG_MESSAGE =
  "A handler takes `open` from src/server.ts, bound to its registered name. Binding its own could spend another tool's production confirmation.";

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
          paths: [salesforceCoreTypesOnly],
        },
      ],
    },
  },
  {
    // A later block replaces the rule's options, so the SDK entry is repeated.
    files: ["src/tools/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [salesforceCoreTypesOnly],
          patterns: [
            {
              group: ["**/salesforce/orgAccess.js"],
              importNames: ["bindOpenOrg"],
              message: BIND_OPEN_ORG_MESSAGE,
            },
          ],
        },
      ],
      // The rule above sees only a static import.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/salesforce\\/orgAccess\\.js$/]",
          message: BIND_OPEN_ORG_MESSAGE,
        },
      ],
    },
  },
]);
