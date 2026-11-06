// Run one of the active game's own commands, declared in its game.json "commands"
// (name → [command, ...args], run from the game's folder).
//   npm run assets [-- args]        the "assets" command (e.g. rebuild GLBs with Blender)
//   npm run verify:assets           the "verifyAssets" command (e.g. check GLBs and sidecars)
//   npm run game -- <name> [args]   any declared command; no name lists them
// A game that declares no such command has nothing to run: this says so and exits 0.
import { spawnSync } from "node:child_process";
import { loadActiveGame } from "./lib/active-game.mjs";

const [name, ...args] = process.argv.slice(2);
const game = loadActiveGame();
const { commands, title } = game.manifest;
const where = `${game.dir}/game.json`;
const list = Object.keys(commands);

if (!name) {
  console.log(`${title} (${game.dir}/) declares ${list.length ? `these commands in ${where}: ${list.join(", ")}` : `no commands in ${where}`}.`);
  process.exit(0);
}
const run = commands[name];
if (!run) {
  console.log(`${title} (${game.dir}/) declares no "${name}" command, so there is nothing to run.`);
  console.log(`To add one, put it under "commands" in ${where}, e.g. "${name}": ["python3", "tools/${name}.py"] (runs from ${game.dir}/).`);
  if (list.length) console.log(`Declared: ${list.join(", ")}.`);
  process.exit(0);
}
console.log(`${game.dir}$ ${[...run, ...args].join(" ")}`);
const [cmd, ...rest] = run;
const r = spawnSync(cmd === "node" ? process.execPath : cmd, [...rest, ...args], { cwd: game.abs, stdio: "inherit" });
if (r.error) {
  console.error(`Could not run "${cmd}": ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
