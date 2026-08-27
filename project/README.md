# Live project store

`npm run dev` starts the local Studio bridge. **Save Project** writes the current non-destructive live-authoring state to `live-project.json` in this directory.

The file can be committed when you want a particular world override set to become part of the project, or removed to return to the untouched baked VanillaGL world.

The bridge never rewrites source M2, WMO or ADT data.
