import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Components of one test must not outlive it
afterEach(() => cleanup());
