// Publish an uploaded Wavedash build and mark it live in deploy/wavedash/deployment.json.
//   npm run wavedash:publish -- <BUILD_ID> --title "v1.0" --summary "First release"
// Publishing is a separate, deliberate step from uploading: only publish a build that was
// played through its playtest link. `wavedash publish` refuses until the Developer Portal
// listing is complete (description, cover art, thumbnail video, tags, input methods, languages).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, SAFE_NAME, argValue, assertNotUnderTest, readReceipt, writeReceipt } from "./lib/release-config.mjs";

assertNotUnderTest("wavedash-publish");
const args = process.argv.slice(2);
const target = argValue(args, "--target") ?? "wavedash";
if (!SAFE_NAME.test(target)) throw new Error(`Invalid target: ${target}`);
const buildId = args[0];
if (!/^[a-z0-9]{16,64}$/.test(buildId ?? "")) throw new Error("Usage: npm run wavedash:publish -- <BUILD_ID> [--title ..] [--summary ..] (the ID wavedash:push recorded)");
// Pass through the CLI's release-note flags; drop ours.
const passthrough = [];
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--target" || args[i] === "--config") i++;
  else passthrough.push(args[i]);
}
const config = join(ROOT, argValue(args, "--config") ?? "wavedash.toml");
const run = spawnSync("wavedash", ["publish", buildId, "-c", config, "--yes", ...passthrough], { cwd: ROOT, stdio: "inherit" });
if (run.error) throw new Error(`Could not run the Wavedash CLI (${run.error.message}).`);
if (run.status !== 0) throw new Error("wavedash publish failed; nothing was recorded.");

const receipt = (await readReceipt(ROOT, target)) ?? { platform: "wavedash", target };
const upload = receipt.latestUpload?.buildId === buildId ? receipt.latestUpload : { buildId };
if (receipt.latestUpload?.buildId === buildId) receipt.latestUpload.published = true;
receipt.liveBuild = { ...upload, published: true, publishedAt: new Date().toISOString() };
const path = await writeReceipt(ROOT, target, receipt);
console.log(`Live: ${receipt.publicUrl ?? "(set targets.wavedash.publicUrl in deploy/release.json)"} (build ${buildId}); recorded in ${path}`);
