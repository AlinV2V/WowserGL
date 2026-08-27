import './styles.css';
import { EditorApp } from './editor-app';
import { installEngineEditorFoundation } from './engine/editor-foundation';
import { initializeMeshoptRuntime } from './meshopt-runtime';
import { initializeOptimizedTextureLoader } from './optimized-texture-loader';
import { installStudioRefinements } from './studio-refinements';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root');

await Promise.all([
  initializeMeshoptRuntime(),
  initializeOptimizedTextureLoader(),
]);

const app = new EditorApp(root);
installStudioRefinements(app, root);
installEngineEditorFoundation(app, root);
