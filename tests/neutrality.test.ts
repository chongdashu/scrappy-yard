// Guard dependency boundaries, not one source game's vocabulary: engine code (src/, the root
// vite.config.ts, scripts/ and the engine's tests/) reaches a game only through the `@game` alias
// (src/main.ts, and engine tests that run against the active game) or the active-game resolver
// (scripts/lib/active-game.mjs, which computes paths at run time), never through a literal path
// into game/ or addons/. A game's own build needs (a dev server) go through game.json "vite".
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CODE = /\.(ts|mts|cts|js|mjs|cjs)$/;
function* files(dir: string): Generator<string> {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, item.name);
    if (item.isDirectory()) { if (item.name !== 'node_modules') yield* files(p); }
    else if (CODE.test(p) && !p.endsWith('.d.ts')) yield p;
  }
}

/**
 * Literal module references in `text` (static imports/exports, dynamic imports, requires and `new URL(…)`) that reach into game/ or
 * addons/, or use `@game` outside src/main.ts and tests/ (`@game/…` nowhere). Deliberately lightweight: clean-export checks also catch runtime and add-on
 * dependencies, and computed paths (the resolver's) are not literals.
 */
function boundaryHits(file: string, text: string): string[] {
  const rel = relative(ROOT, file).split('\\').join('/');
  const source = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const hits: string[] = [];
  const check = (value: string) => {
    if (value === '@game' || value.startsWith('@game/')) {
      if (value !== '@game' || !(rel === 'src/main.ts' || rel.startsWith('tests/'))) hits.push(`${rel}: ${value}`);
      return;
    }
    const target = value.startsWith('.') ? relative(ROOT, resolve(dirname(file), value)).split('\\').join('/') : value;
    if (/^(game|addons)(\/|$)/.test(target)) hits.push(`${rel}: ${value}`);
  };
  const refs = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)["'`]([^"'`]+)["'`]/g;
  for (const match of source.matchAll(refs)) check(match[1]);
  return hits;
}

const SELF = fileURLToPath(import.meta.url); // (its examples below are strings, not imports)
const engineFiles = () => [join(ROOT, 'vite.config.ts'), ...files(join(ROOT, 'src')), ...files(join(ROOT, 'scripts')), ...files(join(ROOT, 'tests'))].filter((f) => resolve(f) !== resolve(SELF));

describe('engine dependency boundaries', () => {
  it('reaches a game only through the entrypoint alias or the resolver, never through game/add-on paths', () => {
    const scanned = engineFiles().map((f) => relative(ROOT, f).split('\\').join('/'));
    for (const must of ['vite.config.ts', 'src/main.ts', 'scripts/lib/active-game.mjs', 'scripts/package-web.mjs', 'tests/smoke.mjs']) expect(scanned).toContain(must);
    const hits = engineFiles().flatMap((file) => boundaryHits(file, readFileSync(file, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('flags the shapes a game-specific dependency takes', () => {
    const at = (rel: string) => join(ROOT, rel);
    expect(boundaryHits(at('vite.config.ts'), `import { gameServer } from "./game/server/index.ts";`)).toEqual(['vite.config.ts: ./game/server/index.ts']);
    expect(boundaryHits(at('scripts/x.mjs'), `const m = await import("../addons/starter-arena/tools.mjs");`)).toHaveLength(1);
    expect(boundaryHits(at('scripts/lib/x.mjs'), `const p = new URL("../../game/game.json", import.meta.url);`)).toHaveLength(1);
    expect(boundaryHits(at('tests/x.mjs'), `const s = require('../game/src/sim-abi.ts');`)).toHaveLength(1);
    expect(boundaryHits(at('src/flow.ts'), `import game from "@game";`)).toEqual(['src/flow.ts: @game']);
    expect(boundaryHits(at('src/main.ts'), `import game from "@game"; import x from "@game/other";`)).toEqual(['src/main.ts: @game/other']);
    // Fine: the resolver's computed paths, the alias in main.ts, comments and look-alike names.
    expect(boundaryHits(at('scripts/x.mjs'), `const m = await import(pathToFileURL(join(active.abs, active.manifest.smoke)).href);`)).toEqual([]);
    expect(boundaryHits(at('src/main.ts'), `import game from "@game";`)).toEqual([]);
    expect(boundaryHits(at('tests/abi.test.ts'), `import game from "@game";`)).toEqual([]);
    expect(boundaryHits(at('vite.config.ts'), `import game from "@game";`)).toEqual(['vite.config.ts: @game']);
    expect(boundaryHits(at('scripts/x.mjs'), `// import x from "../game/a.mjs"\nimport { y } from "./game-command-lib.mjs";`)).toEqual([]);
  });
});
