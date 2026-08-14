import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // `.next-desktop/**` is the packaging build's dist dir (next.config.ts's
  // NEXT_DIST_DIR knob). Without it here, `bun run lint` starts reporting
  // hundreds of errors in GENERATED code the moment somebody packages the app —
  // require() imports and @ts-ignore in Next's own emitted server. The gate
  // turns red for having built the product.
  globalIgnores([".next/**", ".next-desktop/**", "next-env.d.ts"]),
]);
