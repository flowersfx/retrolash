// Bundle server/main.ts (+ ws + shared/) into one file, so the runtime image
// needs no node_modules.
import { build } from "esbuild";

await build({
  entryPoints: ["server/main.ts"],
  outfile: "dist-server/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  // ws's optional native speed-ups; it falls back to JS without them.
  external: ["bufferutil", "utf-8-validate"],
  // ws is CommonJS and calls require() on Node built-ins.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});
