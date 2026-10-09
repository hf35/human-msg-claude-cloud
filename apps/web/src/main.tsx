import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { ApiError } from './api/client';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A refusal (401, 4xx) is an answer, not a glitch: retrying only delays the screen
      retry: (count, error) => !(error instanceof ApiError && error.status !== 0) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
