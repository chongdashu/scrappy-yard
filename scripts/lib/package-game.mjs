// Build the game page once per release target and freeze an explicit, hashed package under
// release/<target>/, with its review manifest beside it (release/<target>-manifest.json,
// never uploaded). Every host gets a relative-path build: a static host serves it at an
// origin root, Wavedash and CrazyGames from nested per-build paths.
//
// Rules live in deploy/release.json (targets, preflight, forbidden strings) and the active
// game's game.json (id, the public asset allowlist; see scripts/lib/active-game.mjs).
// docs/release.md explains each check and the incident behind it.
//
//   packageTarget(name)  preflight → prebuild → Vite build → assemblePackage()
//   assemblePackage()    stage, check, hash, swap atomically (tests drive this with fixtures)
//   verifyPackage()      re-hash an upload directory against its manifest before any deploy
//   assertSmoked()       before any deploy: a full `npm run smoke` passed on the same source
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { gameVitePlugins, viteGameConfig } from "./active-game.mjs";
import { ROOT, SAFE_NAME, loadActiveGame, loadReleaseConfig, releasePaths, targetConfig } from "./release-config.mjs";

/** Set for the commands runSteps runs; packageTarget refuses to start under it (a step that packages would recurse). */
const STEP_ENV = "VGD_RELEASE_STEP";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * File types allowed to ship when deploy/release.json sets no "runtimeExtensions". A list there replaces this one (it does
 * not add to it), so it can also narrow it. `txt` is for licence files that must travel with what they cover (a font's OFL.txt).
 */
export const DEFAULT_RUNTIME_EXTENSIONS = ["html", "js", "css", "wasm", "glb", "json", "mp3", "ogg", "wav", "m4a", "png", "jpg", "jpeg", "webp", "avif", "svg", "woff2", "ktx2", "txt"];
/** Top-level directories whose root-absolute form (`"/assets/…`) is always a bug in a bundle. */
const ALWAYS_RELATIVE_DIRS = ["assets", "wasm", "fonts"];

/** Glob (`*` within a path segment, `**` across segments) → RegExp over publicDir-relative paths. */
export const globRegex = (glob) =>
  new RegExp(`^${glob.split("**").map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);

export async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path, base)));
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative(base, path).split(sep).join("/"));
  }
  return out;
}

const git = (root, ...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * The build id: `<game id>-<commit>` plus `-d<hash>` when the source paths have uncommitted
 * changes, so a release always names what it contains. The hash covers the changed files'
 * current bytes (binary assets included), not just their names.
 */
export async function sourceIdentity(root, gameId, sourcePaths) {
  const head = git(root, "rev-parse", "HEAD");
  const commit = head.status === 0 ? head.stdout.trim() : "";
  const status = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...sourcePaths);
  if (!commit || status.status !== 0) return { commit: commit || null, dirty: true, buildId: `${gameId}-nogit-d${Date.now().toString(36)}` };
  const parts = status.stdout.split("\0").filter(Boolean);
  const changes = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const path = parts[i].slice(3);
    if (/[RC]/.test(code)) i++; // renames and copies carry the old path next
    let content = "deleted";
    try {
      content = digest(await readFile(join(root, path)));
    } catch {}
    changes.push(`${code}\0${path}\0${content}`);
  }
  const dirty = changes.length > 0;
  const diffHash = dirty ? digest(changes.sort().join("\n")).slice(0, 8) : "";
  return { commit, dirty, buildId: `${gameId}-${commit.slice(0, 12)}${dirty ? `-d${diffHash}` : ""}` };
}

/** Run named commands from deploy/release.json; any failure stops the release. */
export function runSteps(steps, { root = ROOT, target, kind = "preflight", stdio = "inherit" } = {}) {
  for (const step of steps) {
    if (step.targets && !step.targets.includes(target)) continue;
    console.log(`${kind}: ${step.name}`);
    const [cmd, ...args] = step.run;
    const run = spawnSync(cmd === "node" ? process.execPath : cmd, args, { cwd: root, stdio, env: { ...process.env, RELEASE_TARGET: target ?? "", [STEP_ENV]: `${kind} "${step.name}"` } });
    if (run.error || run.status !== 0) {
      const why = run.error ? run.error.message : `exit ${run.status}`;
      throw new Error(`${kind} "${step.name}" failed (${why}); nothing was packaged.${step.why ? `\n  Why this gate exists: ${step.why}` : ""}`);
    }
  }
}

/** Per-target env: literal strings, or { "fromEnv": "NAME", "optional": true } read from the shell. */
export function resolveEnv(env = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^VITE_[A-Z0-9_]+$/.test(key)) throw new Error(`Release env keys must be VITE_* names: ${key}`);
    if (typeof value === "string") out[key] = value;
    else if (value && typeof value.fromEnv === "string") {
      const v = process.env[value.fromEnv];
      if (v === undefined && !value.optional) throw new Error(`Release env ${key} needs ${value.fromEnv} set in the environment.`);
      out[key] = v ?? "";
    } else throw new Error(`Release env ${key} must be a string or { "fromEnv": "NAME" }.`);
  }
  return out;
}

/**
 * Stage a compiled build plus allowlisted public files, check them, and publish atomically.
 * Throws (leaving any previous package untouched) when a check fails.
 */
export async function assemblePackage({
  target,
  compiledDir,
  publicDir,
  outDir,
  assets = [],
  /** Where the allowlist came from, for error messages. */
  assetsFrom = "the asset allowlist",
  maxFileBytes = 25 * 1024 * 1024,
  devMarker = "vgd:dev-only",
  forbidden = [],
  runtimeExtensions = DEFAULT_RUNTIME_EXTENSIONS,
  vercel = false,
  meta = {},
}) {
  if (!SAFE_NAME.test(target ?? "")) throw new Error(`Invalid package name: ${target}`);
  const runtimeFile = new RegExp(`\\.(${runtimeExtensions.map((e) => e.replace(/\W/g, "")).join("|")})$`, "i");
  const staging = join(outDir, `.${target}-staging-${process.pid}`);
  const published = join(outDir, target);
  const manifestPath = join(outDir, `${target}-manifest.json`);

  let viteManifest;
  try {
    viteManifest = JSON.parse(await readFile(join(compiledDir, ".vite/manifest.json"), "utf8"));
  } catch {
    throw new Error(`No Vite manifest in ${compiledDir}/.vite/manifest.json; the build did not run or did not finish.`);
  }
  if (!Object.values(viteManifest).some((entry) => entry.isEntry)) throw new Error("Vite produced no entrypoint.");
  const compiledFiles = (await walk(compiledDir)).filter((p) => !p.startsWith(".vite/")).sort();
  if (!compiledFiles.includes("index.html")) throw new Error("The build has no index.html.");

  // The public-asset allowlist: only what the game loads ships, and a stale entry fails loudly.
  const globs = assets.map((g) => ({ glob: g, re: globRegex(g) }));
  const publicAll = publicDir ? await walk(publicDir).catch(() => []) : [];
  const publicFiles = publicAll.filter((p) => globs.some(({ re }) => re.test(p))).sort();
  const unmatched = globs.filter(({ re }) => !publicFiles.some((p) => re.test(p))).map(({ glob }) => glob);
  if (unmatched.length) throw new Error(`${assetsFrom}: entries match nothing in ${publicDir}: ${unmatched.join(", ")}`);

  const inventory = new Map();
  const problems = [];
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  async function add(sourceBase, path, kind) {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((p) => !p || p === ".." || p.startsWith("."))) {
      throw new Error(`Invalid publishing path: ${path}`);
    }
    if (!runtimeFile.test(path)) {
      throw new Error(`Not a runtime file type: ${path}. If it should ship, set deploy/release.json "runtimeExtensions" to the allowed types plus its extension; ` +
        `the list replaces the allowed types (now ${runtimeExtensions.join(", ")}) rather than adding to them.`);
    }
    if (inventory.has(path)) throw new Error(`Duplicate publishing path (compiled and public): ${path}`);
    const src = join(sourceBase, path);
    const stat = await lstat(src);
    if (!stat.isFile() || !(await realpath(src)).startsWith(`${await realpath(sourceBase)}${sep}`)) throw new Error(`Unsafe publishing source (symlink or outside its directory): ${path}`);
    if (stat.size > maxFileBytes) problems.push(`${path} is ${(stat.size / 1024 / 1024).toFixed(1)} MiB, over the ${(maxFileBytes / 1024 / 1024).toFixed(1)} MiB per-file limit`);
    const dest = join(staging, path);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    inventory.set(path, { path, kind, bytes: stat.size, sha256: digest(await readFile(dest)) });
  }

  try {
    for (const path of compiledFiles) await add(compiledDir, path, "compiled");
    for (const path of publicFiles) await add(publicDir, path, "runtime");

    // HTML references: relative and present. A root-absolute URL works at an origin root and
    // breaks under every nested host path.
    for (const htmlPath of [...inventory.keys()].filter((p) => p.endsWith(".html"))) {
      const html = await readFile(join(staging, htmlPath), "utf8");
      const base = htmlPath.includes("/") ? htmlPath.slice(0, htmlPath.lastIndexOf("/") + 1) : "";
      for (const m of html.matchAll(/(?:src|href)="(?![a-z][a-z0-9+.-]*:|\/\/|#)(\.\/|\/)?([^"#?]*)(?:[?#][^"]*)?"/gi)) {
        if (m[1] === "/") problems.push(`${htmlPath}: root-absolute reference /${m[2]} breaks nested hosting`);
        else if (m[2] && !inventory.has(`${base}${m[2]}`)) problems.push(`${htmlPath}: references ${m[2]}, which is not in the package`);
      }
      if (/fonts\.(googleapis|gstatic)\.com/.test(html)) console.warn(`! ${htmlPath} links a third-party font service; self-host fonts (some hosts run games in cross-origin-isolated iframes).`);
    }
    // Runtime fetches in bundles must be relative too; a root-absolute path only fails on the host.
    const topDirs = new Set([...ALWAYS_RELATIVE_DIRS, ...[...inventory.keys()].filter((p) => p.includes("/")).map((p) => p.split("/")[0])]);
    const leak = new RegExp(`["'\`(]\\/(${[...topDirs].map((d) => d.replace(/[.+?^${}()|[\]\\-]/g, "\\$&")).join("|")})\\/`);
    for (const path of [...inventory.keys()].filter((p) => /\.(js|mjs|css)$/.test(p))) {
      const m = (await readFile(join(staging, path), "utf8")).match(leak);
      if (m) problems.push(`${path}: root-absolute runtime path ${m[0].slice(1)}…`);
    }
    // Dev-only code (tuning/debug panels) carries a marker string; none of it may ship.
    const needles = [...(devMarker ? [{ text: devMarker, why: "dev-only marker" }] : []), ...forbidden.map((text) => ({ text, why: "forbidden for this target" }))];
    for (const path of inventory.keys()) {
      const bytes = await readFile(join(staging, path));
      for (const { text, why } of needles) if (bytes.includes(text)) problems.push(`${path}: contains "${text}" (${why})`);
    }
    if (problems.length) throw new Error(`Package checks failed for ${target}:\n  ${problems.join("\n  ")}`);

    const hostingFiles = [];
    if (vercel) {
      // Only Vite's fingerprinted output is immutable; fixed-name models, audio, WASM and HTML revalidate.
      const immutable = [...inventory.values()]
        .filter((f) => f.kind === "compiled" && /^assets\/[^/]+-[\w-]{8,}\.[a-z0-9]+$/i.test(f.path))
        .map((f) => f.path)
        .sort();
      const config = {
        $schema: "https://openapi.vercel.sh/vercel.json",
        framework: null,
        headers: [
          { source: "/(.*)", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }, { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }] },
          ...immutable.map((p) => ({ source: `/${p}`, headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] })),
        ],
      };
      await writeFile(join(staging, "vercel.json"), `${JSON.stringify(config, null, 2)}\n`);
      hostingFiles.push("vercel.json");
    }

    const files = [...inventory.values()].sort((a, b) => a.path.localeCompare(b.path));
    const report = {
      releaseId: digest(JSON.stringify(files)).slice(0, 16),
      target,
      ...meta,
      runtimeFiles: files.length,
      runtimeBytes: files.reduce((sum, f) => sum + f.bytes, 0),
      hostingFiles,
      builtAt: new Date().toISOString(),
      files,
    };
    // Swap: the previous package stays intact until the new one has passed every check.
    await rm(published, { recursive: true, force: true });
    await rename(staging, published);
    await writeFile(manifestPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Re-hash an upload directory against its manifest; throws if anything changed since packaging. */
export async function verifyPackage(dir, manifestPath) {
  let report;
  try {
    report = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error(`No package manifest at ${manifestPath}; package the target first.`);
  }
  const expected = new Map(report.files.map((f) => [f.path, f.sha256]));
  const present = (await walk(dir).catch(() => [])).filter((p) => !report.hostingFiles.includes(p) && !p.startsWith(".vercel/"));
  const problems = [];
  for (const p of present) if (!expected.has(p)) problems.push(`unexpected ${p}`);
  for (const [p, sha] of expected) {
    try {
      if (digest(await readFile(join(dir, p))) !== sha) problems.push(`changed ${p}`);
    } catch {
      problems.push(`missing ${p}`);
    }
  }
  if (problems.length) throw new Error(`${dir} no longer matches ${manifestPath}; package again:\n  ${problems.join("\n  ")}`);
  return report;
}

/** verifyPackage() for a named target under this repo's release/ directory. */
export const verifyTarget = (target, root = ROOT) => {
  const { dir, manifest } = releasePaths(root, target);
  return verifyPackage(dir, manifest);
};

/**
 * Is a verified package the source as it stands now? A deploy script uploads whatever is in
 * release/<target>, so a package left over from an earlier commit would go out under a fresh
 * message. Pure: compare the package's recorded build id with the current one.
 */
export function stalePackage(report, current) {
  if (!report.buildId || !current.commit) return null; // no git: nothing to compare
  if (report.buildId === current.buildId) return null;
  return `release/${report.target} was packaged from ${report.buildId}, but the source is now ${current.buildId}. ` +
    `Run npm run package:${report.target} first (or pass --allow-stale to upload the older package on purpose).`;
}

/**
 * Was a package built with the shell-supplied target values (`{ "fromEnv": "NAME" }` in deploy/release.json) the shell gives
 * now? The commit can stay the same while one changes: a playtest server's URL baked into a package that is then uploaded with
 * the shell set for production. Pure: `target` is the target's config, `env` the shell; null when every such value matches.
 */
export function stalePackageEnv(report, target, env = process.env) {
  for (const [key, value] of Object.entries(target?.env ?? {})) {
    if (!value || typeof value !== "object" || typeof value.fromEnv !== "string") continue;
    const now = env[value.fromEnv];
    if (now === undefined && !value.optional) return `Release env ${key} needs ${value.fromEnv} set in the environment (as it was when release/${report.target} was packaged).`;
    if ((report.env?.[key] ?? "") !== (now ?? "")) {
      return `release/${report.target} was packaged with a different ${key} than ${value.fromEnv} gives now. ` +
        `Set ${value.fromEnv} as it was for packaging, or run npm run package:${report.target} again with the intended value ` +
        "(--allow-stale uploads the package as it is).";
    }
  }
  return null;
}

/**
 * Throw unless release/<target> was packaged from the current source (see stalePackage) and with the shell-supplied target values
 * the shell gives now (see stalePackageEnv). `--allow-stale` in `args` skips both.
 */
export async function assertPackageCurrent(report, args = [], root = ROOT) {
  if (args.includes("--allow-stale")) return;
  const active = loadActiveGame(root);
  const cfg = await loadReleaseConfig(root);
  const problem = stalePackage(report, await sourceIdentity(root, active.manifest.id, [...cfg.sourcePaths, active.dir]))
    ?? stalePackageEnv(report, cfg.targets[report.target]);
  if (problem) throw new Error(problem);
}

/**
 * Did a full smoke run pass on the source this package was built from? `receipt` is release/web-smoke.json (tests/smoke.mjs writes
 * it only after every renderer and session passed, and removes it at the start of every run). Smoke plays the web package; another
 * target's package is the same source with another adapter, so the match is on the source build id. Pure: null when it matches.
 */
export function smokeProblem(report, receipt) {
  const how = "Run npm run smoke on this source first (or pass --skip-smoke-check to upload without it, on purpose).";
  if (!receipt?.passed) return `No passing smoke run is recorded (release/web-smoke.json). ${how}`;
  if (receipt.buildId !== report.buildId) return `The last passing smoke run played ${receipt.buildId}, but release/${report.target} is ${report.buildId}. ${how}`;
  return null;
}

/** Throw unless a full smoke run passed on this package's source (see smokeProblem). `--skip-smoke-check` or `"requireSmoke": false` skips it. */
export async function assertSmoked(report, args = [], root = ROOT) {
  const cfg = await loadReleaseConfig(root);
  if (!cfg.requireSmoke) return;
  if (args.includes("--skip-smoke-check")) {
    console.warn(`! --skip-smoke-check: uploading ${report.buildId} without a passing smoke run.`);
    return;
  }
  let receipt = null;
  try {
    receipt = JSON.parse(await readFile(releasePaths(root, "web").smoke, "utf8"));
  } catch {}
  const problem = smokeProblem(report, receipt);
  if (problem) throw new Error(problem);
  console.log(`Smoke passed on ${receipt.buildId} (${receipt.renderers.join(", ")}; ${receipt.sessions.join(", ")}) at ${receipt.passedAt}.`);
}

/** The record a full, passing smoke run leaves for the package it played (release/web-smoke.json). */
export const smokeReceipt = (report, run) => ({
  passed: true,
  target: report.target,
  gameId: report.gameId,
  buildId: report.buildId,
  releaseId: report.releaseId,
  sourceCommit: report.sourceCommit,
  sourceDirty: report.sourceDirty,
  renderers: run.renderers,
  sessions: run.sessions,
  passedAt: new Date().toISOString(),
});

/** Zip an upload directory beside it (portals that take a zip): <local time>-<target>-<build id><suffix>.zip. */
export function zipPackage(report, { root = ROOT, suffix = "" } = {}) {
  const pad = (n) => String(n).padStart(2, "0");
  const t = new Date(report.builtAt);
  const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
  const name = `${stamp}-${report.target}-${report.buildId}${suffix}.zip`;
  const { dir } = releasePaths(root, report.target);
  const zip = spawnSync("zip", ["-qr", join(root, "release", name), "."], { cwd: dir, stdio: "inherit" });
  if (zip.error || zip.status !== 0) {
    console.warn(`! zip failed or is not installed: upload release/${report.target} as a folder, or zip it yourself.`);
    return null;
  }
  return `release/${name}`;
}

/**
 * The whole release of the active game for one target from deploy/release.json.
 * `overrides.env` adds VITE_* values (e.g. VITE_PLATFORM_ADS for an ads build);
 * `overrides.zipSuffix` tags the zip.
 */
export async function packageTarget(name, overrides = {}) {
  // A preflight that runs npm run smoke (or test:graphics) would package inside its own packaging, without end.
  if (process.env[STEP_ENV]) {
    throw new Error(`Packaging started inside the ${process.env[STEP_ENV]} step, which would recurse. Keep commands that package ` +
      "(npm run smoke, test:graphics) out of preflight and prebuild: uploads already require a passing smoke run (docs/release.md).");
  }
  const root = ROOT;
  const active = loadActiveGame(root);
  const game = active.manifest;
  const cfg = await loadReleaseConfig(root);
  const t = targetConfig(cfg, name);

  runSteps(cfg.preflight, { root, target: name, kind: "preflight" });
  runSteps(cfg.prebuild, { root, target: name, kind: "prebuild" });

  // The build id covers the engine's source paths and the whole active game folder.
  const source = await sourceIdentity(root, game.id, [...cfg.sourcePaths, active.dir]);
  const env = { ...resolveEnv(t.env), ...resolveEnv(overrides.env) };
  const define = Object.fromEntries(
    Object.entries({ ...env, VITE_BUILD_ID: source.buildId, VITE_RELEASE: name }).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]),
  );
  const compiledDir = join(root, "dist", `release-${name}`);
  const { build } = await import("vite");
  // configFile: false keeps dev-only pages (preview.html, gym pages) and dev plugins out of the
  // release; envDir: false keeps local .env files out, so deploy/release.json alone sets VITE_*.
  // The active game's alias, identity and title come from the same helper vite.config.ts uses, and so do
  // its own plugins (game.json "vite"; one marked `apply: "serve"` stays out of this build).
  const g = viteGameConfig(active, root);
  const own = await gameVitePlugins(active, { command: "build", mode: "production" });
  await build({
    root,
    configFile: false,
    envDir: false,
    mode: "production",
    base: "./",
    logLevel: "warn",
    // The game's web root, so HTML references to public files (favicon.svg) stay as they are;
    // copyPublicDir is off: only the allowlist below ships from it.
    publicDir: g.publicDir,
    resolve: g.resolve,
    plugins: [...g.plugins, ...own],
    define: { ...g.define, ...define },
    build: {
      target: "es2022",
      outDir: compiledDir,
      emptyOutDir: true,
      copyPublicDir: false,
      manifest: true,
      sourcemap: false,
      rollupOptions: { input: { main: join(root, cfg.entry) } },
    },
  });

  const report = await assemblePackage({
    target: name,
    compiledDir,
    publicDir: active.publicDir,
    outDir: join(root, "release"),
    assets: [...game.release.assets, ...(t.assets ?? [])],
    assetsFrom: `${active.dir}/game.json "release.assets"${t.assets ? ` + deploy/release.json targets.${name}.assets` : ""}`,
    maxFileBytes: t.maxFileBytes ?? cfg.maxFileBytes,
    devMarker: cfg.devMarker,
    forbidden: [...cfg.forbidden, ...(t.forbidden ?? [])],
    runtimeExtensions: cfg.runtimeExtensions.length ? cfg.runtimeExtensions : DEFAULT_RUNTIME_EXTENSIONS,
    vercel: !!t.vercel,
    meta: { gameId: game.id, gameDir: active.dir, buildId: source.buildId, sourceCommit: source.commit, sourceDirty: source.dirty, platform: env.VITE_PLATFORM, env },
  });
  const zip = t.zip ? zipPackage(report, { root, suffix: overrides.zipSuffix ?? "" }) : null;

  console.log(`\n${name} package of ${active.dir}/ ${report.releaseId} (${report.buildId}): ${report.runtimeFiles} runtime files, ${(report.runtimeBytes / 1024 / 1024).toFixed(2)} MiB${report.hostingFiles.length ? ` + ${report.hostingFiles.join(", ")}` : ""}.`);
  console.log(`Upload directory: release/${name}`);
  console.log(`Review manifest:  release/${name}-manifest.json (not uploaded)`);
  if (zip) console.log(`Zip:              ${zip}`);
  console.log(`Platform adapter: ${env.VITE_PLATFORM}${env.VITE_PLATFORM_ADS === "1" ? " (ads on)" : ""}.`);
  if (source.dirty) console.log("! Built from uncommitted source (the build id ends in -d<hash>).");
  return { ...report, zip };
}
