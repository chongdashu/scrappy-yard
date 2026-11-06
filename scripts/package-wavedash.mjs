// Wavedash uploads release/wavedash as an immutable build and serves index.html from its own
// per-build origin and path, so every URL in the package must be relative (the packager checks).
//   npm run package:wavedash
import { packageTarget } from "./lib/package-game.mjs";

await packageTarget("wavedash");
