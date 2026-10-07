import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  platform: "node",
  target: "node24",
  format: "esm",
  // Bundle everything so the Docker image needs no node_modules.
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
});
