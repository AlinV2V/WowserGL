# VanillaGL Studio / WowserGL

VanillaGL Studio is a web-native world editor and live-authoring sandbox for VanillaGL. It uses a Unity-style workflow: Hierarchy + Scene viewport + Project browser + Inspector + Console/Changes dock, while staying separate from normal gameplay code.

## Studio workflow

Studio has three levels of editing:

1. **Preview** — edit locally in the Studio scene.
2. **Push to Game** — apply the selected transform/material/environment change to a running VanillaGL client through the local live bridge.
3. **Save Project** — persist the non-destructive override project to `project/live-project.json` and browser local storage.

The original WoW M2/WMO/ADT assets are never rewritten. VanillaGL applies Studio overrides on top of its normal baked world.

## Unity-style tools

- Hierarchy with scene search, selection, modified-state markers and context actions.
- Scene viewport with WASD/RMB fly camera, Alt orbit, top view and transform gizmos.
- Project browser for M2/WMO assets with search, type filters and drag-to-spawn.
- Inspector component cards for Transform, VanillaGL metadata, live authoring and renderer/material overrides.
- W/E/R Move/Rotate/Scale controls with translation and angle snapping.
- Play/Stop-style runtime controls, Live Sync, Push All and Open Game.
- Bottom Console / Changes / Live Game dock.
- Material tint and texture override editing with per-instance or asset-wide scope.
- Time of day, fog and weather editing.
- Delete, duplicate, undo/redo and focus-selection hotkeys.
- Existing `custom_map_patch.json` import/export format remains supported by the serializer.

## VanillaGL asset compatibility

Studio consumes the current VanillaGL baked world conventions:

- tile size `533.33333`
- `/terrain/tiles/<tileKey>`
- `meta.json` + `heights.f32`
- `doodads.json` / `wmo_doodads.json`
- `wmos.meta.json` + `wmos.bin` (`wow-browser-wmo-bin-v1`)
- `wmos.json` development fallback
- x/y/z + quaternion + scale instance transforms
- tile placement at `(originX - TILE_HALF, originY - TILE_HALF, 0)`

Studio still uses `ground.png`/Lambert fallback for its own editing viewport when the full VanillaGL terrain shader is not exposed. The running game remains the authoritative high-fidelity renderer when using Live Sync.

## Run Studio + bridge

```bash
npm install
npm run dev
```

This starts:

- Studio: `http://localhost:5180`
- Live bridge: `ws://127.0.0.1:5191`

By default Studio proxies VanillaGL assets from `http://localhost:5173`.

To use another VanillaGL origin:

```bash
VANILLAGL_ASSET_ORIGIN=http://localhost:5174 npm run dev
```

The **Open Game** button launches VanillaGL with an explicit `studioBridge` query parameter. Only that opt-in game session installs the live-authoring runtime receiver; ordinary VanillaGL sessions stay unchanged.

You can also open a tile directly:

```text
http://localhost:5180/?tile=Azeroth_30_49&map=0
```

## Live material example

Select a WMO building or M2 object, open **Renderer / Materials**, choose a material, then change its tint or enter a browser-decodable custom texture override such as:

```text
/textures/custom/red_flag.png
```

Use **Apply Preview** to change Studio only, **Push to Game** to update the live VanillaGL scene, or enable **Live Sync** so edits are pushed automatically. **Save Project** makes the overrides persistent without touching the source WMO/M2. Registered VanillaGL texture assets can still use the project's normal optimized/KTX2 routing; arbitrary new custom files should use PNG/WebP unless they are added to that asset routing manifest.

## Architecture

```text
VanillaGL baked assets
        │
        ├──────────────► VanillaGL Studio viewport
        │                       │
        │                  authoring state
        │                       │
        │         ws://127.0.0.1:5191
        │                       │
        └──────────────► VanillaGL runtime
                                │
                         live override layer
```

The bridge is intentionally local and binds to `127.0.0.1` by default. It stores the current project in `project/live-project.json` and relays structured commands; it does not proxy realm authentication or gameplay network traffic.

## Build verification

```bash
npm run typecheck
npm run build
```

No Blizzard game assets are bundled in this repository. Studio only consumes assets supplied by the developer's local extraction/bake pipeline.
