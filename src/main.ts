import '@xterm/xterm/css/xterm.css';
import './style.css';
import { initApp } from './app';

const root = document.getElementById('app')!;
initApp(root).catch(console.error);
