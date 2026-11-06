# Reusable asset contract

Use this contract before multiplying assets or binding a rig. Replace every
`TBD` with a measured value, an explicit proposal, or `N/A`. Keep those states
distinct: **measured** comes from a source/export/runtime check; **proposed** is
a starting choice awaiting a check.

## Contract header

| Field | Value |
| --- | --- |
| Game / slice | TBD |
| Contract version | TBD |
| Owner | TBD |
| Runtime format and loader | TBD |
| Authoring tool/version | TBD |
| Status | Proposed / In review / Accepted |

## Source boundaries

Keep reusable characters, props, environment kits, interactables, and layout
scenes in separate source boundaries when they have different ownership or
iteration needs. Record the actual paths here:

```text
assets/
  blender/
    characters/<asset>.blend
    props/<asset>.blend
    environment/<kit>.blend
    scenes/<layout>.blend
```

| Source or library | Owns | Runtime exports | Owner | Status |
| --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | Proposed |

Use one-way dependencies from source libraries to layout/review scenes. Record
whether a link, append, or generated input is authoritative.

Generators and tools (teaser and capture scripts, audio, texture and mesh
generators) write only to their own output paths, such as `out/<tool>/`, never
over a shipped runtime asset. Promoting a result into `public/assets/` is a
deliberate copy with its own commit and hash check. A teaser music script that
wrote to the game's own music path replaced a shipped track in two commits
before anyone noticed.

## Shared conventions

| Concern | Contract value | Evidence / status |
| --- | --- | --- |
| Units | TBD | Proposed / measured |
| Up axis and forward axis | TBD | Proposed / measured |
| Export transform policy | TBD | Proposed / measured |
| Character origin / prop pivot | TBD | Proposed / measured |
| Grid or placement increment | TBD | Proposed / measured |
| Stable asset ID rule | TBD | Proposed / measured |

Record measured dimensions for representative assets:

| Asset ID | Intended use | Dimensions | Pivot/origin | Measured from | Status |
| --- | --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | Source / export / runtime | Proposed |

## Art set

Decide how generated or bought assets will match before buying many of them.
Record one row per kind of asset.

| Asset kind | Generator and preset | Size or resolution setting | Target texels per metre | Measured texels per metre | Reference | Status |
| --- | --- | --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD | TBD | Proposed |

- Keep one style family for the whole game, plus its kit or scene variant for
  ground, unless a comparison gives a reason to mix.
- Choose each kind's setting by the texel density it gives at the asset's real
  size, so things seen side by side have pixels of about the same size.
  Measure density after scaling: a generator's size setting is often a paint
  budget, not a triangle count or atlas size. In one game, small props at
  size 32 landed at 14–26.5 texels per metre beside buildings at size 128 at
  8.4–21.4. A bench planned at 64 would have doubled its density, so it was
  bought at 32.
- Plan small readable marks (emblems, badges, numbers) as textures on simple
  geometry. A 3D generator's texel budget smeared a kiosk's emblem and a
  parcel's sticker into blobs; a 32-pixel 2D emblem on a board read clearly.
- Send one object per reference: crop it from a style sheet, and end the prompt
  with what to leave out. Objects not on a sheet get text only.
- Normalise every download to this contract's units, forward axis and pivot
  with a script, then check what the player meets: head height under awnings,
  counter height, which axis is the length. Keep the provider original and
  make fixes as scripts on it, so the set rebuilds without paying again.
- Ask for doors, gates, levers and other moving parts as separate objects. A
  generated mesh fuses them to the walls, is often non-manifold and shares one
  packed material, so neither a Boolean cut nor a material tint can separate
  them afterwards.
- Record per asset: prompt, preset, setting, mode, reference, cost, job ID,
  measured size and density.

## Collections, materials, and exports

- Give each export a stable asset ID and explicit export collection.
- Keep references, lights, cameras, controls, and review-only geometry out of runtime exports.
- Record material groups, texture dependencies, supported extensions, and whether colliders are authored or generated.
- Store export manifests with source path, collection, output path, clip names, dimensions, and hashes.
- Measure exported vertices, primitives/draws, skinning, and representative frame time before setting a device budget.

| Asset ID | Collection | Output path | Materials/textures | Collider | Clip list | Hash/status |
| --- | --- | --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | TBD | TBD | Proposed |

Record each runtime material's alpha mode and kind. The engine reads glTF
`alphaMode`/`alphaCutoff` (`OPAQUE`, `MASK` cut-out, `BLEND` translucent pass)
and the material custom property `vgd_kind` (`default`, `foliage`, `liquid`),
exported to `extras` with Blender's *Include → Custom Properties*; see
[Assets](../starter.md#assets) and
[Materials and the translucent pass](../starter.md#materials-and-the-translucent-pass).

Record each textured material's filtering too: nearest (hard texels, for
pixel art) or linear, and whether it is mipmapped. The engine samples each
texture with its glTF sampler. Only the minification filter decides mipmaps:
NEAREST magnification with a mipmapped minification filter (what Blender's
*Closest* interpolation exports) still averages small texels together at a
distance, while a non-mipmapped one keeps them crisp but shimmers. Check the
exported `samplers`, not the Blender node setting alone; see
[Texture sampling](../starter.md#texture-sampling).

| Material | Alpha mode (cutoff) | Kind | Textures (alpha?) | Filtering (mag / min, mipmaps, wrap) | Shadows / ink expectation | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| TBD | OPAQUE / MASK (0.5) / BLEND | default / foliage / liquid | TBD | nearest / linear; mipmaps yes / no; repeat / clamp | BLEND: no ink, no cast shadow | Proposed |

## Sockets, clips, and runtime data

Name sockets and attachment points in the contract, then verify orientation
with an asymmetric test object. Names alone do not implement attachment logic.
Attach through the socket's full transform (rotation as well as translation),
sampled after that frame's pose update. A translation-only offset, or a socket
read before the pose updates, leaves a held item off the hand and a frame late;
one game drew a carried item 38 cm in front of the hand. Check this in a focused
socket studio ([`?scene=`](../starter.md#test-hooks)), not in a full round.

| Socket / marker | Parent asset | Position/orientation | Runtime meaning | Evidence |
| --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | Proposed |

For rigged assets, record rest pose, rig identity, clip names, loop/one-shot,
duration, stride, contact events, and attachment policy. For each looping clip
also record the largest joint difference between its first and last frames
and the hip drift over one cycle. Keep animation and gameplay authority
separate: the game state decides when an interaction succeeds; animation
presents it.

## Acceptance

Before production expansion, one representative asset must be exported,
reimported in a clean process, loaded by the target runtime, and checked for
scale, axes, materials, sockets, clips, collision, and camera readability.
Link the evidence paths here:

| Check | Evidence path | Result | Date |
| --- | --- | --- | --- |
| Export/reimport | TBD | Pending | TBD |
| Runtime load | TBD | Pending | TBD |
| Socket studio: asymmetric object on every socket, each clip, rotation and translation, after the frame's pose update | TBD | Pending | TBD |
| Generated model: moving parts (doors, gates, levers) are separate objects; fixes are a rerunnable script on the untouched provider download | TBD | Pending | TBD |
| Landmark scale: the main landmark fits the brief's player count, inside and out, at the gameplay camera | TBD | Pending | TBD |
| Looping clips: first-to-last pose difference and hip drift measured; each seam or drift fixed or listed as a gap | TBD | Pending | TBD |
| Every clip watched in the engine at game speed | TBD | Pending | TBD |
| Visual and interaction review | TBD | Pending | TBD |
