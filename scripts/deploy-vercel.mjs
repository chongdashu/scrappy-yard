// Deploy a frozen package to Vercel and record a receipt in deploy/<target>/deployment.json.
//   npm run package:web && npm run deploy:web [-- --preview] [-- --target <name>]
// Project identity comes from deploy/<target>/project.json (copy project.example.json) or the
// environment (VERCEL_ORG_ID, VERCEL_PROJECT_ID, optional VERCEL_SCOPE, VERCEL_PROJECT_NAME,
// VERCEL_DOMAIN). Those are identifiers, not credentials: the Vercel CLI uses its own login.
// Without them the CLI would link or create a project on its own, so this script refuses.
// Like wavedash:push, it refuses a stale package (--allow-stale) and one whose source has no
// passing `npm run smoke` (--skip-smoke-check).
import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertPackageCurrent, assertSmoked, verifyTarget } from "./lib/package-game.mjs";
import { ROOT, SAFE_NAME, argValue, assertNotUnderTest, loadGameConfig, releasePaths, writeReceipt } from "./lib/release-config.mjs";

assertNotUnderTest("deploy-vercel");
const args = process.argv.slice(2);
const target = argValue(args, "--target") ?? "web";
if (!SAFE_NAME.test(target)) throw new Error(`Invalid target: ${target}`);
const preview = args.includes("--preview");
const game = await loadGameConfig();

let file = {};
const projectFile = join(ROOT, "deploy", target, "project.json");
try {
  file = JSON.parse(await readFile(projectFile, "utf8"));
} catch {}
const project = {
  orgId: process.env.VERCEL_ORG_ID ?? file.orgId,
  projectId: process.env.VERCEL_PROJECT_ID ?? file.projectId,
  scope: process.env.VERCEL_SCOPE ?? file.scope,
  projectName: process.env.VERCEL_PROJECT_NAME ?? file.projectName ?? game.id,
  domain: process.env.VERCEL_DOMAIN ?? file.domain,
};
const placeholder = (v) => !v || /^<.*>$|REPLACE|TODO/i.test(v);
if (placeholder(project.orgId) || placeholder(project.projectId)) {
  throw new Error(
    `No Vercel project for target "${target}". Create one (vercel project add <name>), then either copy\n` +
      `  deploy/${target}/project.example.json → deploy/${target}/project.json and fill orgId/projectId\n` +
      `  (vercel project inspect <name> shows them), or set VERCEL_ORG_ID and VERCEL_PROJECT_ID.`,
  );
}

const report = await verifyTarget(target);
await assertPackageCurrent(report, args);
await assertSmoked(report, args);
const { dir } = releasePaths(ROOT, target);
// `vercel link` droppings must not ride along in the upload.
const clean = async () => {
  for (const stray of [".vercel", ".gitignore"]) await rm(join(dir, stray), { recursive: true, force: true });
};
await clean();

const env = { ...process.env, VERCEL_ORG_ID: project.orgId, VERCEL_PROJECT_ID: project.projectId };
const cliArgs = ["deploy", dir, "--yes", ...(project.scope ? ["--scope", project.scope] : []), ...(preview ? [] : ["--prod"])];
console.log(`Deploying ${target} release ${report.releaseId} (${report.buildId}) to Vercel ${preview ? "preview" : "production"}…`);
const run = spawnSync("vercel", cliArgs, { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
await clean();
if (run.error) throw new Error(`Could not run the Vercel CLI (${run.error.message}); install it with npm i -g vercel and log in.`);
if (run.status !== 0) throw new Error("vercel deploy failed; nothing was recorded.");
const deploymentUrl = run.stdout.trim().split(/\s+/).filter((s) => s.startsWith("https://")).at(-1);
if (!deploymentUrl) throw new Error(`Could not read the deployment URL from: ${run.stdout}`);

const receipt = {
  platform: "vercel",
  target,
  project: project.projectName,
  scope: project.scope ?? null,
  environment: preview ? "preview" : "production",
  deploymentUrl,
  url: !preview && project.domain ? `https://${project.domain}/` : deploymentUrl,
  deployedAt: new Date().toISOString(),
  releaseId: report.releaseId,
  buildId: report.buildId,
  sourceCommit: report.sourceCommit,
  sourceDirty: report.sourceDirty,
  platformAdapter: report.platform,
  runtimeFiles: report.runtimeFiles,
  runtimeBytes: report.runtimeBytes,
};
// Previews are not "what's live": print them, record only production.
if (!preview) console.log(`Recorded in ${await writeReceipt(ROOT, target, receipt)}`);
console.log(JSON.stringify(receipt, null, 2));
