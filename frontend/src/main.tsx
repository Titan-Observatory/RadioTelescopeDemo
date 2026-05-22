import './styles/main.css';

import { createRoot } from 'react-dom/client';
import LiveShell from './LiveShell';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<LiveShell />);
}
