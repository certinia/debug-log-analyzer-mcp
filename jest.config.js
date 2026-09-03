export default {
  testEnvironment: "node",
  // The parser ships ESM only and declares no `require` condition, so jest's
  // CommonJS resolver cannot load it by name. The mappers below point at its
  // build directly and this pattern lets the transform compile it.
  transformIgnorePatterns: ["node_modules/(?!(\\.pnpm/)?@apexdevtools)"],
  roots: ["<rootDir>/src", "<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.[tj]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", decorators: true },
          target: "es2022",
        },
        module: { type: "commonjs" },
      },
    ],
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@toon-format/toon$": "<rootDir>/tests/__mocks__/@toon-format/toon.ts",
    "^@apexdevtools/apex-log-parser$":
      "<rootDir>/node_modules/@apexdevtools/apex-log-parser/dist/index.js",
    "^@apexdevtools/apex-log-parser/types$":
      "<rootDir>/node_modules/@apexdevtools/apex-log-parser/dist/publicTypes.js",
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/**/*.test.ts",
    "!src/index.ts", // Entry point bootstrap only; the server itself is tested via src/server.ts
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
