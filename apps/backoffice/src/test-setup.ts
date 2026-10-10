import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// The first render of Refine and antd in a test file is slow: wait longer than the default 1 s
configure({ asyncUtilTimeout: 5000 });

// Components of one test must not outlive it
afterEach(() => cleanup());

// Ant Design reads these from the browser; jsdom has no implementation. Every `min-width` query
// matches, so the layout is the desktop one (with the menu in view, not behind a button)
window.matchMedia ??= ((query: string) => ({
  matches: query.includes('min-width'),
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
