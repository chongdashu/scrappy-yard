// Upload the frozen release/wavedash package as a new, unpublished Wavedash build and record
// the returned build ID and playtest URL in deploy/wavedash/deployment.json.
//   npm run package:wavedash && npm run wavedash:push -- -m "What changed"
// It does not build: it refuses a package that was made from other source or shell values than
// the current ones (--allow-stale uploads an older package on purpose), and one whose source has
// no passing `npm run smoke` (--skip-smoke-check).
// Needs wavedash.toml (copy wavedash.toml.example; `wavedash project create` gives the
// game_id) and a logged-in CLI (`wavedash auth login`). Uploads are immutable; if the result
// is unclear, check the Developer Portal's build history before pushing again.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertPackageCurrent, assertSmoked, verifyTarget } from "./lib/package-game.mjs";
import { ROOT, SAFE_NAME, argValue, assertNotUnderTest, loadGameConfig, loadReleaseConfig, readReceipt, releasePaths, writeReceipt } from "./lib/release-config.mjs";

assertNotUnderTest("wavedash-push");
const args = process.argv.slice(2);
const target = argValue(args, "--target") ?? "wavedash";
if (!SAFE_NAME.test(target)) throw new Error(`Invalid target: ${target}`);
const game = await loadGameConfig();
const release = await loadReleaseConfig();

const tomlPath = join(ROOT, argValue(args, "--config") ?? "wavedash.toml");
let toml;
try {
  toml = await readFile(tomlPath, "utf8");
} catch {
  throw new Error(`${tomlPath} not found. Copy wavedash.toml.example to wavedash.toml and set game_id (wavedash project create prints it).`);
}
const field = (name) => toml.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
const gameId = field("game_id");
if (!gameId || /REPLACE|TODO|^<.*>$/i.test(gameId)) throw new Error(`Set game_id in ${tomlPath} (wavedash project create prints it).`);
const uploadDir = field("upload_dir");
const expectedDir = releasePaths(ROOT, target).dir;
if (!uploadDir || resolve(ROOT, uploadDir) !== expectedDir) {
  throw new Error(`upload_dir in ${tomlPath} is ${JSON.stringify(uploadDir)}; it must point at ./release/${target} so the verified package is what uploads.`);
}

const report = await verifyTarget(target);
await assertPackageCurrent(report, args);
await assertSmoked(report, args);
const message = argValue(args, "-m") ?? `Release ${report.releaseId} (${report.buildId})`;
const run = spawnSync("wavedash", ["build", "push", "-c", tomlPath, "-m", message], { cwd: ROOT, encoding: "utf8" });
if (run.error) throw new Error(`Could not run the Wavedash CLI (${run.error.message}); install it and run wavedash auth login.`);
const output = `${run.stdout}\n${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
process.stdout.write(output);
if (run.status !== 0) throw new Error("wavedash build push failed; check the portal's build history before retrying. Nothing was recorded.");
const playtestUrl = output.match(/https:\/\/wavedash\.com\/playtest\/\S+/)?.[0] ?? null;
const buildId = output.match(/build[^\n]*?\b([a-z0-9]{32})\b/i)?.[1] ?? null;

const previous = (await readReceipt(ROOT, target)) ?? {};
const receipt = {
  ...previous,
  platform: "wavedash",
  target,
  gameId,
  gameTitle: game.title,
  publicUrl: release.targets[target]?.publicUrl ?? previous.publicUrl ?? null,
  latestUpload: {
    buildId,
    playtestUrl,
    message,
    uploadedAt: new Date().toISOString(),
    releaseId: report.releaseId,
    buildLabel: report.buildId,
    sourceCommit: report.sourceCommit,
    sourceDirty: report.sourceDirty,
    runtimeFiles: report.runtimeFiles,
    runtimeBytes: report.runtimeBytes,
    published: false,
  },
};
const path = await writeReceipt(ROOT, target, receipt);
console.log(`\nRecorded in ${path}: build ${buildId ?? "(ID not parsed; see the output above)"}, playtest ${playtestUrl ?? "(not parsed)"}`);
