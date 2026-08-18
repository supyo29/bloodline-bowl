// Flat config. eslint-config-next v16 ships flat configs directly, so the
// @eslint/eslintrc FlatCompat shim that Next 15 required is no longer needed.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

export default [
  ...coreWebVitals,
  ...typescript,
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
];
