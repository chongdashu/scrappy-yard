// Your own static host (Vercel by default): release/web plus vercel.json cache headers.
//   npm run package:web
import { packageTarget } from "./lib/package-game.mjs";

await packageTarget("web");
