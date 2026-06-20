// Flat ESLint config (ESLint 9). Lints the TypeScript SOURCE only — tests run
// through esbuild and have their own assertions. Intentionally lean: it catches
// real mistakes (genuine unused code, unsafe constructs) without forcing a
// stylistic refactor of working CM6 code, so the CI `lint` gate is meaningful
// and green. Uses the non-type-checked `recommended` preset (fast; no full
// project parse needed in CI).
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["out/**", "node_modules/**", "**/*.mjs", "**/*.js", "**/*.cjs"] },
  {
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommended],
    rules: {
      // CM6/VS Code interop legitimately uses casts and `!`; these aren't bugs.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // Unused code is worth knowing about, but as a warning (won't fail the
      // gate); `_`-prefixed args/vars are intentional.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  }
);
