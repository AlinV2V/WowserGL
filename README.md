# VanillaGL Studio / WowserGL

VanillaGL Studio is a web-native WoW world/engine editor for VanillaGL / CleanClientMMO. It uses a Unity-style workflow while keeping the original extracted/baked game data immutable.

The editor has two explicit hosts:

- **Scene** — authoring host for selection, transforms, components, world tools and debug views.
- **Game** — the actual CleanClientMMO client embedded as the authoritative rendering/gameplay runtime and connected through the local Studio bridge.

See [ENGINE_EDITOR_ARCHITECTURE.md](ENGINE_EDITOR_ARCHITECTURE.md) for the full design.

## Run

```bash
npm install
npm run dev
```

This starts:

- Studio: `http://localhost:5180`
- live bridge: `ws://127.0.0.1:5191`

By default Studio proxies CleanClient/VanillaGL assets from `http://localhost:5173`.

Open a tile directly:

```text
http://localhost:5180/?tile=Azeroth_30_49&map=0
```

If the VanillaGL checkout is beside WowserGL, `npm run dev` also reuses/builds the global Studio content index when available. You can force a rebuild with:

```bash
npm run index:assets
```

Set a different local CleanClient public directory with `CLEANCLIENT_PUBLIC_DIR` / `VANILLAGL_PUBLIC_DIR`, or a different dev-server proxy origin with `VANILLAGL_ASSET_ORIGIN`.

## Authoring workflow

There are three levels of world editing:

1. **Preview** — edit the Studio Scene locally.
2. **Push / Live Sync** — send the transform, material, spawn/delete or environment override into the running CleanClientMMO scene.
3. **Save** — persist the client override project plus Studio workspace metadata.

The original WoW `.ADT`, `.WMO`, `.M2` and MPQ data are not rewritten.

Useful shortcuts:

- `W` / `E` / `R` — Move / Rotate / Scale
- `F` — frame selected
- `Ctrl+D` — duplicate with component/prefab state
- `Delete` — remove
- `Ctrl+Z` / `Ctrl+Y` — undo / redo
- `Ctrl+S` — save scene patch + Studio workspace
- `Ctrl+Shift+S` — export portable workspace
- `Esc` — cancel active path tool / restore maximized Game view

## Editor systems

Studio now includes:

- searchable nested Hierarchy with drag-to-parent/unparent
- multi-object Shift/marquee selection and cluster transforms
- component-based Inspector
- Project asset palette with rendered thumbnails
- global Content Browser across indexed M2/WMO/creature/texture/audio assets
- Favorites and Recent content filters
- texture/audio preview
- drag-to-terrain spawning
- prefab create/place/apply/revert/unpack workflow
- layers, camera bookmarks, autosave and crash recovery
- portable `.wowsergl.json` project workspace
- 3×3 camera-centered world streaming
- Scene/Game tabs with CleanClient connection/error status
- live bridge acknowledgements/runtime state
- client patch import/export
- vMaNGOS server-authoring SQL export
- extension/plugin API

## WoW-specific components/tools

The entity model supports:

- `M2Renderer`
- `WmoRenderer`
- `Collision`
- `CreatureSpawn`
- `GameObjectSpawn`
- `AreaTrigger`
- `Path`
- `Portal`
- `Light`
- `ParticleEmitter`
- `AudioSource`
- `Script`
- `PrefabInstance`

WoW authoring tools include waypoint handles, creature idle/random/waypoint movement, wander radius visualization, trigger volumes, light radius visualization, collision bounds and portal direction debug helpers.

Server export requires real vMaNGOS `creature_template.entry` / `gameobject_template.entry` values. Studio does not guess server template IDs from client model paths.

## Asset/render fidelity

Studio consumes the current CleanClient baked world contracts, including:

- `/terrain/index.json`
- `/terrain/tiles/<tileKey>`
- `meta.json`, `heights.f32`, `heights_inner.f32`, `holes.bin`, `normals.f32`
- `doodads.json` / `wmo_doodads.json`
- `wmos.meta.json` + `wmos.bin` (`wow-browser-wmo-bin-v1`)
- WMO JSON fallback
- terrain `tex_array.png`, `chunk_map.bin`, `splat_atlas.png`, `shadow_atlas.png`
- texture catalogs with KTX2/Basis and WebP/source fallbacks
- Meshopt JSON sidecars
- baked creature displays
- sound manifest metadata

When a complete terrain shader bake is present, the Scene viewport uses the authored texture-array/splat/shadow path rather than the old flat-green Lambert preview. `ground.png` remains a fallback for incomplete/legacy tile bakes.

The **Game** tab remains the final authority for production CleanClient rendering, animation, gameplay, collision and streaming behavior.

## Live material example

Select an M2/WMO, open **Renderer / Materials**, choose a material slot and change its tint or texture override.

Use:

- **Apply Preview** for Studio only
- **Push to Game** for the connected CleanClient runtime
- **Live Sync** for automatic pushes
- **Save Project** to persist the override without modifying the original asset

## Diagnostics

The bottom engine tools include:

- renderer profiler with history, average and P95 frame time
- draw calls / triangles / GPU resource counts
- heaviest renderables
- profile/frame JSON export
- wireframe / unlit / overdraw debug views
- bounds and terrain-wire views
- material/shader input inspection
- entity → component → geometry → material → texture dependency graph
- scene validation with clickable issues

Profiler numbers describe the Studio Scene host; use the Game host for authoritative runtime performance.

## Verification

The full editor gate is:

```bash
npm run verify:engine
```

It runs:

1. architecture contract assertions
2. a deterministic synthetic CleanClient asset-index test covering M2/WMO/creature/texture/audio
3. JavaScript + TypeScript checks
4. the production Vite build

Individual commands remain available:

```bash
npm run typecheck
npm run build
npm run test:engine-contracts
npm run test:asset-index
```

No Blizzard game assets are bundled in this repository. Studio consumes assets supplied by the developer's local extraction/bake pipeline.
