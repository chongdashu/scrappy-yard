// One-shot JWT keypair for @convex-dev/auth. Prints env lines for `npx convex env set`.
// Do not commit the output.
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
const publicKey = await exportJWK(keys.publicKey);
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });
const pk = privateKey.trimEnd().replace(/\n/g, " ");
process.stdout.write(`JWT_PRIVATE_KEY=${pk}\n`);
process.stdout.write(`JWKS=${jwks}\n`);
