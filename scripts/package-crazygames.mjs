// CrazyGames: the CrazyGames adapter, no first-party analytics, no custom fullscreen, and a
// timestamped zip beside release/crazygames for the Developer Portal's upload form.
// Basic Launch builds have no ads (CrazyGames disables them there); pass --ads for a Full
// Launch build whose adapter offers ads.
//   npm run package:crazygames            # Basic Launch
//   npm run package:crazygames -- --ads   # Full Launch
import { packageTarget } from "./lib/package-game.mjs";

const ads = process.argv.includes("--ads");
await packageTarget("crazygames", { env: { VITE_PLATFORM_ADS: ads ? "1" : "" }, zipSuffix: ads ? "-ads" : "" });
