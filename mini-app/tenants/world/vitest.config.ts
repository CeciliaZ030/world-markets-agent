import { defineConfig } from "vitest/config";
// @wcm-inc/abi ships raw TypeScript, so vite must transform it instead of Node loading it.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], server: { deps: { inline: [/@wcm-inc\//] } } } });
