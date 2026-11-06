// Build the active game's Rust crate to WebAssembly and copy it into that game's web root.
// Usage: node scripts/build-wasm.mjs   (npm run wasm; GAME_DIR picks another game)
//   <gameDir>/crate  →  cargo build --release --target wasm32-unknown-unknown  →  <gameDir>/public/wasm/sim.wasm
// Needs the toolchain pinned in rust-toolchain.toml (rustup installs it and the wasm32-unknown-unknown
// target on first use).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { ROOT, loadActiveGame } from "./lib/active-game.mjs";

const game = loadActiveGame();
const cargo = (args, opts = {}) => execFileSync("cargo", args, { cwd: ROOT, ...opts });

let meta;
try {
  meta = JSON.parse(cargo(["metadata", "--format-version", "1", "--no-deps"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
} catch {
  console.error("\ncargo metadata failed. Is Rust installed (https://rustup.rs)? The workspace is Cargo.toml at the project root.");
  process.exit(1);
}
// Match on paths relative to the workspace root (both from cargo, so the same spelling and case).
const want = `${game.dir}/crate/Cargo.toml`;
const pkg = meta.packages.find((p) => relative(meta.workspace_root, p.manifest_path).split(sep).join("/") === want);
if (!pkg) {
  console.error(`No crate at ${want} in the Cargo workspace. The active game (${game.dir}/) needs a crate/ folder; Cargo.toml's members glob picks it up.`);
  process.exit(1);
}
const lib = pkg.targets.find((t) => t.crate_types.includes("cdylib"));
if (!lib) {
  console.error(`${want} must build a cdylib: [lib] crate-type = ["cdylib", "rlib"].`);
  process.exit(1);
}

try {
  cargo(["build", "-p", pkg.name, "--release", "--target", "wasm32-unknown-unknown"], { stdio: "inherit" });
} catch {
  console.error("\ncargo build failed. Is Rust installed (https://rustup.rs) and the wasm target available?\n  rustup target add wasm32-unknown-unknown");
  process.exit(1);
}
const src = join(meta.target_directory, "wasm32-unknown-unknown/release", `${lib.name.replace(/-/g, "_")}.wasm`);
const dst = game.wasmPath;
mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);

// The module must stay import-free (src/wasm.ts instantiates it with {}).
const mod = new WebAssembly.Module(readFileSync(dst));
const imports = WebAssembly.Module.imports(mod);
if (imports.length) {
  console.error(`sim.wasm imports ${imports.map((i) => `${i.module}.${i.name}`).join(", ")}; the loader provides none.`);
  process.exit(1);
}
const exports = WebAssembly.Module.exports(mod).filter((e) => e.kind === "function").length;
console.log(`${pkg.name} → ${relative(ROOT, dst).split(sep).join("/")} (${(statSync(dst).size / 1024).toFixed(1)} KiB, ${exports} exported functions, no imports)`);
