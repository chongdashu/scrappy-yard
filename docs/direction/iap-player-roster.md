# IAP player roster — alternate runner skins

Date: 2026-11-05 (HKT). Owner asked for 5 alternate characters in the raccoon's style, to sell as in-app purchases.
Every skin is a drop-in swap for `char_raccoon_player`: same pipeline (fal turnaround → Tripo multiview P1 → Tripo rig v1.0 biped → retarget `biped:idle/run/jump/jump_down` → Blender normalise), same 1.10 m height, same clip names (`idle`, `run`, `jump`, `land`), same bone names (Hip, L_Foot …).

| id | name | bio | sheet | mesh | rig | glb | wired |
|---|---|---|---|---|---|---|---|
| `char_raccoon_player` | Scrappy Raccoon (free) | The original yard runner. | ✓ | ✓ | ✓ | ✓ | ✓ default |
| `char_fox_player` | Scrap Fox | Copper-furred mechanic who can fix anything with a wrench and a grin. | ✓ | ✓ | ✓ | ✓ | ✓ |
| `char_cat_player` | Alley Cat | Scrappy tabby in a torn vest; lands on her feet every time. | ✓ | ✓ | ✓ | ✓ | ✓ |
| `char_badger_player` | Bandit Badger | Hard-knuckle hauler in a hazard bandana; nothing blocks his lane. | ✓ | ✓ | ✓ | ✓ | ✓ |
| `char_possum_player` | Yard Possum | Lanky welder with a belt full of gadgets and a tail full of tricks. | ✓ | ✓ | ✓ | ✓ | ✓ |
| `char_otter_player` | Junk Otter | Oil-stained scarf, yellow rubber boots, always splashing through. | ✓ | ✓ | ✓ | ✓ | ✓ |

## Files (per `<id>`)
- Prompt: `out/fal/<id>/prompt-turnaround.txt` (raccoon prompt with the subject block swapped; run record in `out/fal/<id>/run-1/`).
- Turnaround: `share/media/kickoff/<id>-turnaround.png`; review render `share/media/kickoff/<id>-review.png`.
- Views (front / left / back used; 3/4 kept): `experiments/tripo/2026-11-05-<id with dashes>/views/`, plus `*-result.json` / `*-stderr.log` per Tripo step.
- Tripo downloads (untouched): `assets/source/tripo/<id>/tripo-out/tripo-out/{front-*,rig-*,retarget-*}/`, `job.json`.
- Blender: `assets/scripts/normalize_char_skin.py` (generic copy of the raccoon script; `CHAR_ID=<id> SRC_GLB=<retarget model.glb> blender -b --python …`) → `assets/blender/characters/<id>.blend`, `game/public/assets/characters/<id>.glb`, report `out/blender/reimport-<id>.txt`.
- Material: one `mat_<species>_body`. The raccoon's blue-lens emissive split finds no faces on these palettes (green/yellow lenses), so it is skipped — add a per-skin lens colour rule if glowing goggles are wanted.

## Spend
| item | count | cost |
|---|---|---|
| fal GPT Image 2.5 Flare t2i, landscape_4_3, high | 5 | 5 × ~$0.0385 = **~$0.19** |
| Tripo multiview P1 (face_limit 10k, PBR) | 5 × 50 | 250 cr |
| Tripo rig v2.5 (CLI default — wrong rig, retarget rejected; unused) | 5 × 25 | 125 cr (wasted) |
| Tripo rig v1.0 biped (`-p model=rig-v1.0`, matches raccoon) | 5 × 25 | 125 cr |
| Tripo retarget idle/run/jump/jump_down | 5 × 40 | 200 cr |
| **Tripo total** | | **700 cr** (balance 2210 → 1510) |

Lesson: the Tripo CLI now defaults `anim rig` to v2.5; the raccoon's `preset:biped:*` clips and the normaliser's bone names need `-p model=rig-v1.0`.

## Swap wiring (in game)
- `game/src/skins.ts`: roster (`SKINS`: id, key, name, bio, sku, priceUsd), `currentSkin()` (`?skin=` → `localStorage["scrappy.skin"]` → raccoon), `setSkin()`, `nextSkin()`, `isOwned()` stub.
- `game/src/assets.ts`: one character entry per skin.
- `game/src/game.ts`: Play and `?scene=character` load `currentSkin().id`.
- `game/src/menu-skin.ts`: Skin chip (cycle owned / buy locked).
- `game/src/iap.ts`: host payments adapter.

Preview: `/?skin=fox` (DEV any; prod if owned). Published builds use owned selection + raccoon default.


## Selection status (2026-11-05 HKT, IAP wired)

- Menu "Skin: …" chip restored (`menu-skin.ts`): owned → cycle/select; locked → `$1.99` + buy.
- `UNLOCK_ALL = false`; `isOwned()` = free raccoon ∪ Convex/local/Wavedash entitlements.
- `currentSkin()` reads `localStorage["scrappy.skin"]` when owned; DEV `?skin=` still works for QA.
- Web/Vercel → DodoPayments checkout (`convex/dodo.createSkinCheckout`); grant only on webhook `payment.succeeded`.
- Wavedash → `platform.paid` (`game.json` `platform.wavedash.paidContent: true`); content ids = sku strings.
- Return URL `?unlock=<sku>` refreshes entitlements only (never fulfills alone).

## Convex / Dodo env (prod + dev)

```bash
npx convex env set DODO_PAYMENTS_API_KEY <key>          # checkoutSessions.create
npx convex env set DODO_PAYMENTS_WEBHOOK_KEY <whsec_…>  # webhooks.unwrap
npx convex env set DODO_PAYMENTS_ENVIRONMENT live_mode  # optional; default live_mode (omit or test_mode)
```

Webhook URL (register in Dodo Dashboard → Developer → Webhooks, event `payment.succeeded`):

- Prod: `https://rugged-hedgehog-932.convex.site/dodo-webhook`
- Dev:  `https://artful-fennec-528.convex.site/dodo-webhook`

Metadata on checkout: `{ app: "scrappy-yard", sku, player_id }` (`player_id` = `players.guestId`).

## DodoPayments products (2026-11-05 HKT)

Live one-time USD $1.99 (`digital_products`). Metadata: `app=scrappy-yard`, `sku=<sku>`, `environment=live`.

| sku | name | product_id |
|---|---|---|
| `skin_fox` | Scrappy Yard — Scrap Fox | `pdt_0NrHHCiTcfac8OftVUWfQ` |
| `skin_cat` | Scrappy Yard — Alley Cat | `pdt_0NrHHCmyNfPlsOiSLfDlh` |
| `skin_badger` | Scrappy Yard — Bandit Badger | `pdt_0NrHHCrUe0oyGUeqpDxIW` |
| `skin_possum` | Scrappy Yard — Yard Possum | `pdt_0NrHHCvSBl0rcpKKmo1eB` |
| `skin_otter` | Scrappy Yard — Junk Otter | `pdt_0NrHHCye7xJb9L0b68kl9` |

Host adapter (owner, 2026-11-05): **Vercel/web → DodoPayments**; **Wavedash → portal IAP** (`platform.paid` / `triggerPaywall` with the same content ids as `sku`).
