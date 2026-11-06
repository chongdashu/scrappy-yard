/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { fileURLToPath } from "node:url";
import { gameVitePlugins, loadActiveGame, viteGameConfig } from "./scripts/lib/active-game.mjs";

// The active game (game.config.json "gameDir", or GAME_DIR for one command) supplies the
// `@game` alias, the web root (<gameDir>/public), the `__GAME__` identity and the page title;
// scripts/lib/active-game.mjs builds those settings for this file and the release packager.
// A game that needs Vite plugins of its own (a dev server, middleware) names a module in its
// folder with game.json "vite"; they are added here, never imported into this file.
//
// Relative base so a build runs from any static host or nested folder (hosts such as Wavedash
// serve each build under its own path). `--mode https` (npm run dev:https) serves over
// self-signed HTTPS on its own port: browsers only expose WebGPU on secure origins, and a
// LAN/Tailscale address over plain HTTP is not one (localhost is). Both dev ports are strict: a
// busy 5173 would otherwise move dev onto 5174, dev:https's port, and the URL in use would
// silently serve another checkout or mode. A busy port fails instead.
export default defineConfig(async (env) => {
  const { mode } = env;
  const game = loadActiveGame();
  const g = viteGameConfig(game);
  const own = await gameVitePlugins(game, env);
  return {
    base: "./",
    publicDir: g.publicDir,
    resolve: g.resolve,
    define: g.define,
    plugins: [...g.plugins, ...own, ...(mode === "https" ? [basicSsl()] : [])],
    server: { host: true, port: mode === "https" ? 5174 : 5173, strictPort: true },
    preview: { host: true, port: 4173 },
    // npm run test:game (and a bare `npx vitest`): TypeScript that runs without a GPU or
    // browser: the engine's tests/ and the active game's tests/. tests/release/** is node:test
    // (npm run test:release).
    test: {
      include: ["tests/**/*.test.ts", `${game.dir}/tests/**/*.test.ts`],
      exclude: ["tests/release/**", "**/node_modules/**"],
      environment: "node",
    },
    build: {
      target: "es2022",
      outDir: "dist",
      // Two pages: the game and the model previewer (a dev tool; release packaging builds
      // index.html alone).
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL("./index.html", import.meta.url)),
          preview: fileURLToPath(new URL("./preview.html", import.meta.url)),
        },
      },
    },
  };
});
