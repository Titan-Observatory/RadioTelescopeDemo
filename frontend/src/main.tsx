import './styles/main.css';

import { createRoot } from 'react-dom/client';

// Build-time branch: VITE_DEPLOY_MODE is inlined as a literal during `vite
// build`, so Rollup drops the unreachable branch (and its entire import
// graph) from the produced bundle. The static deploy therefore has no
// reference to LiveShell, App, useQueueLease, aladin-lite, echarts, or any
// /api / /ws plumbing.
const root = document.getElementById('root');
if (root) {
  if (import.meta.env.VITE_DEPLOY_MODE === 'static') {
    void import('./PreLaunchPage').then(({ default: PreLaunchPage }) => {
      createRoot(root).render(<PreLaunchPage />);
    });
  } else {
    void import('./LiveShell').then(({ default: LiveShell }) => {
      createRoot(root).render(<LiveShell />);
    });
  }
}
