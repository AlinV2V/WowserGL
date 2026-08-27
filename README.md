# VanillaGL Studio / WowserGL

A web-native 3D world editor and engine sandbox for **VanillaGL**. The editor is a separate Vite/TypeScript workspace and does not import or rewrite VanillaGL gameplay systems.

## What is implemented

- Noclip flight camera: WASD, RMB look, Shift boost, mouse-wheel speed.
- Alt-held orbit/focus workflow plus orthographic top-down mode.
- Raycast selection for editable M2, WMO and registered entity roots.
- Three.js r176 `TransformControls`: W translate, E rotate, R scale.
- Translation and rotation snapping.
- Delete/Backspace, Ctrl+D, Ctrl+Z/Ctrl+Y and F-to-focus.
- Per-object bounding-box selection highlight.
- Searchable M2/WMO palette sourced from the loaded VanillaGL tile manifests.
- Click or drag/drop spawning onto terrain.
- Inspector for position, Euler rotation, scale, model path, triangle count and texture count.
- Align-to-ground, reset rotation and grid snap actions.
- Time-of-day, fog and rain/snow sandbox.
- Versioned `custom_map_patch.json` export/import.
- Individual editing proxy for VanillaGL `InstancedMesh` doodads carrying `userData.wowDoodad`.

## VanillaGL compatibility

WowserGL follows the bake/runtime conventions used by `AlinV2V/VanillaGL`:

- tile size: `533.33333`
- tile directory: `/terrain/tiles/<tileKey>`
- core terrain files: `meta.json` and `heights.f32`
- optional visual fallback: `ground.png`
- M2 manifests: `doodads.json` and `wmo_doodads.json`
- WMO JSON development fallback: `wmos.json`
- object transform fields: x/y/z, qx/qy/qz/qw and scalar `s`
- tile world placement: `(originX - TILE_HALF, originY - TILE_HALF, 0)`

The shipped VanillaGL client prefers its compact WMO binary path. WowserGL deliberately does **not** fork that decoder. For editor development tiles it consumes the existing `wmos.json` fallback; a production integration can inject/reuse VanillaGL's binary WMO loader without changing the editor UI or editing model.

Likewise, VanillaGL's production terrain shader is intentionally not copied into this repository. The editor loads `ground.png` when present and uses a neutral Lambert terrain fallback otherwise. This keeps the editor isolated while leaving a clean seam for the existing `terrain-shader.ts` adapter.

## Run

```bash
npm install
npm run dev
```

Studio runs on `http://localhost:5180`.

By default the Vite dev server proxies `/terrain`, `/textures`, and `/models` to a VanillaGL client/assets origin at `http://localhost:5173`.

To point it somewhere else:

```bash
VANILLAGL_ASSET_ORIGIN=http://localhost:5174 npm run dev
```

You can open a tile directly:

```text
http://localhost:5180/?tile=Azeroth_30_49&map=0
```

## Export format

Exports are world-space so patches remain independent of editor camera/render-origin rebasing:

```json
{
  "version": 1,
  "mapId": 0,
  "tileKey": "Azeroth_30_49",
  "customDoodads": [
    {
      "model": "World/Generic/Human/Passive Doodads/Benches/Bench01.m2",
      "position": [-9450.2, 83.1, 45.0],
      "rotation": [0, 0.707, 0, 0.707],
      "scale": 1
    }
  ],
  "customWmos": [],
  "deletedObjects": [],
  "modifiedObjects": []
}
```

Uniform scale is emitted as a number. Non-uniform scale is emitted as `[x, y, z]`.

## Integration boundary

The editor is intentionally standalone. Nothing under VanillaGL's `world.ts`, `simulation/`, `combat/`, or authentication stack is required or modified. For a future in-client `?mode=editor` integration, expose VanillaGL scene objects to `EditorObjectStore`; existing `wmoPick`, `wowDoodad`, and `editorEntity` metadata are recognized by the picker.

No Blizzard game assets are included in this repository. The editor only consumes assets supplied by a developer's local VanillaGL extraction/bake pipeline.
