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
    },
  },
]);
