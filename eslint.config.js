import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Type-checked linting: the rules can see TYPES, so they catch what syntax-only rules cannot
// (a Promise nobody awaits, an `any` leaking out of JSON.parse, a method passed without its `this`...).
// Every .ts file must belong to one of these tsconfigs; the FIRST one that includes a file is used, so shared/src
// is still checked with no DOM and no Node types.
const projects = [
  "./shared/tsconfig.json",
  "./shared/tsconfig.test.json",
  "./client/tsconfig.json",
  "./client/tsconfig.test.json",
  "./client/tsconfig.node.json",
  "./server/tsconfig.json",
  "./tsconfig.tools.json",
];

export default tseslint.config(
  { ignores: ["**/dist", "**/node_modules", "**/logs", "coverage", "playwright-report", "test-results", "perf"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked, // includes no-floating-promises, no-misused-promises, no-unsafe-*
  {
    languageOptions: { parserOptions: { project: projects, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-non-null-assertion": "error", // no `x!`
      // No `as` casts at all (`as const` is always allowed). The few deliberate ones carry an eslint-disable + justification.
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      // Already in the preset; listed so it is visible: a server must never drop a rejected promise on the floor.
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  { files: ["**/*.js", "**/*.mjs"], ...tseslint.configs.disableTypeChecked },
  { files: ["client/src/**/*.ts"], languageOptions: { globals: globals.browser } },
  {
    files: [
      "server/**/*.ts",
      "shared/test/**/*.ts",
      "shared/tools/**/*.ts",
      "client/test/**/*.ts",
      "**/vite.config.ts",
      "**/vitest.config.ts",
      "playwright.config.ts",
      "e2e/**/*.ts",
      "tools/**/*.ts",
      "*.js",
      "experiments/**/*.mjs",
    ],
    languageOptions: { globals: globals.node },
  },
);
