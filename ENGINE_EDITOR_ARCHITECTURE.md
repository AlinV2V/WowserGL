# WowserGL Studio Engine / Editor Architecture

WowserGL Studio is an authoring environment for the VanillaGL / CleanClientMMO world stack. It deliberately separates **editor authority** from **game-runtime authority** so the editor can provide Unity-style tools without claiming that an editor-only preview implementation is automatically identical to the production client.

## Engine hosts

Studio has two engine hosts:

```text
                       WowserGL Studio
                            │
              ┌─────────────┴─────────────┐
              │                           │
       Studio Scene Host          CleanClientMMO Runtime
       authoring authority         rendering/game authority
              │                           │
     selection / gizmos / UI       actual game renderer
     component authoring           animation / gameplay
     debug views / previews        production streaming
     world patch creation          runtime collision
              │                           │
              └────── Live Bridge ────────┘
```

The **Scene** tab is optimized for editing, selection and visualization. The **Game** tab embeds the actual CleanClientMMO dev client and connects it through `studioBridge`. Runtime rendering remains authoritative there.

## Scene model

Three.js objects are renderer objects, not the editor data model. `SceneComponentModel` gives each registered editor record a typed entity with stable metadata and components.

Core/render components:
- `EditorMetadata`
- `Renderable`
- `M2Renderer`
- `WmoRenderer`
- `Collision`

Gameplay/world components:
- `CreatureSpawn`
- `GameObjectSpawn`
- `AreaTrigger`
- `Path`
- `Portal`

Effects/scripting components:
- `Light`
- `ParticleEmitter`
- `AudioSource`
- `Script`
- `PrefabInstance`

Component edits participate in the editor history, project serialization, validation and dependency graph rather than being loose `userData` controls.

## Project workspace

The v2 workspace is a versioned `wowsergl-studio-project` document. It stores:
- stable source bindings for existing world objects
- component/entity data
- layers and lock/visibility state
- scene camera bookmarks
- reusable prefab definitions
- project settings

Workspace autosave and crash recovery use browser storage. A portable `.wowsergl.json` workspace can also be exported/imported. The existing `custom_map_patch.json` / live-project path remains the client-world override format; the workspace augments it with editor-only authoring metadata.

### Prefabs

A prefab definition stores a source asset plus component configuration. Instances keep a `PrefabInstance` link and support:
- Place
- duplicate while retaining component/prefab state
- Apply instance overrides to prefab
- Revert instance to prefab
- Unpack

## Hierarchy

The Hierarchy supports editor parent-child relationships through `parentId`. Dragging one scene entity onto another reparents it while preserving world transform. Reparent/unparent operations are undoable and hierarchy cycles are rejected/validated.

## Asset pipeline

Studio consumes the same CleanClient bake contracts rather than packaging proprietary assets:
- terrain tiles and indexes
- M2 doodad manifests
- WMO binary/meta data
- creature display bakes
- texture asset catalogs including KTX2/WebP/source variants
- sound manifest metadata
- Meshopt sidecars

`tools/index-cleanclient-assets.mjs` builds `studio-asset-index.json` from a local CleanClient/VanillaGL `public` directory. The Content Browser can then search the whole indexed client rather than only assets found in the open tile.

The indexer has a deterministic synthetic integration fixture (`npm run test:asset-index`) covering M2, WMO, creature, texture and audio entries.

## Rendering and world fidelity

The Scene host uses CleanClient-compatible bake data and editor-oriented rendering:
- authentic terrain texture-array / chunk-map / splat / shadow material path
- KTX2/Basis optimized texture routing with browser fallback
- Meshopt runtime decoding
- WMO binary hydration
- inner terrain heights, holes and normals
- camera-centered 3×3 tile neighborhood streaming

The Game host is the final visual/runtime authority.

## Live bridge

The local bridge binds to `127.0.0.1` by default. CleanClientMMO only installs its receiver for sessions explicitly launched with `?studioBridge=<url>`.

Live commands include transforms, material overrides, object spawn/delete, environment changes and project application. Runtime acknowledgements/state flow back to Studio, making the relationship two-way rather than a fire-and-forget exporter.

## WoW authoring

Studio adds game-specific authoring rather than treating the world as generic meshes:
- Creature and GameObject server components
- creature idle/random/waypoint movement authoring
- visible wander-radius visualization
- waypoint handles that can be added, moved and Shift-click deleted
- trigger-volume visualization
- light-radius visualization
- collision debug bounds
- portal debug direction
- component-driven vMaNGOS SQL export

The SQL exporter requires real `creature_template` / `gameobject_template` IDs. It never invents server template identities from an M2/WMO path.

## Diagnostics

The editor includes:
- WebGL/Three.js profiler history
- average/P50/P95 frame timing
- draw call / triangle / resource counts
- heavy-renderable list
- exportable profile/frame captures
- wireframe, unlit and overdraw views
- bounds and terrain-wire views
- selected material/shader inputs
- entity/component/material/texture dependency graph
- scene validation with clickable issues

Profiler values describe the Studio Scene host unless explicitly observed inside the CleanClient Game host.

## Plugin surface

`StudioPluginHost` exposes a browser extension seam. Plugins can register:
- commands
- validators
- custom bottom tool tabs

The runtime object is exposed under `globalThis.VanillaGLStudio` for local tooling. Plugin code should use the registered APIs rather than reaching directly into arbitrary DOM elements whenever possible.

## Validation / CI

`npm run verify:engine` is the required editor gate. It runs:
1. architecture-contract assertions
2. synthetic CleanClient asset-index integration test
3. JavaScript/TypeScript checks
4. production Vite build

The contract test exists to prevent major editor subsystems from becoming decorative UI that is no longer wired into the project/runtime model.

## Longer-term shared-core direction

The current architecture intentionally uses the CleanClient Game host for final runtime authority. A later cross-repository refactor can extract production systems into packages such as:

```text
@vanillagl/assets
@vanillagl/world
@vanillagl/rendering
@vanillagl/collision
@vanillagl/animation
```

Both CleanClientMMO and the Studio Scene host can then instantiate even more of the exact same implementation. That extraction is a coordinated VanillaGL/CleanClientMMO refactor and is not required for Studio to remain honest about which host is authoritative today.
