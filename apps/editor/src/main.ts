import './styles.css';
import { EditorApp } from './editor-app';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app root');
new EditorApp(root);
