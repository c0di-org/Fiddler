import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** `--mode web` builds the browser version served at files.c0di.com; anything
 * else builds the frontend Tauri wraps. The only difference is which backend
 * `@backend` resolves to, plus where the output lands so the two never tread on
 * each other's `dist`. */
export default defineConfig(({ mode }) => {
  const web = mode === "web";

  return {
    plugins: [react()],
    clearScreen: false,
    define: { __FIDDLER_WEB__: JSON.stringify(web) },
    resolve: {
      alias: {
        "@backend": src(web ? "./src/backend/web.ts" : "./src/backend/tauri.ts"),
      },
    },
    server: {
      port: web ? 1420 : 1421,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: "ws", host, port: 1422 } : undefined,
      watch: { ignored: ["**/src-tauri/**"] },
    },
    build: {
      outDir: web ? "dist-web" : "dist",
      // Safari 15 is the floor for the Tauri webview; the web build can lean on
      // File System Access and OPFS, neither of which ships that far back, but
      // the syntax level is the same either way.
      target: "safari15",
      minify: "esbuild",
    },
  };
});
