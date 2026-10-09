import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from './api';

/** Placeholder shell: later tasks replace it with sign-in and the question screens. */
export function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });

  return (
    <main>
      <h1>human-msg</h1>
      {me.isPending && <p>…</p>}
      {me.isError && (
        <p data-testid="status">
          {me.error instanceof ApiError && me.error.status === 401
            ? 'not signed in'
            : 'server unavailable'}
        </p>
      )}
      {me.data && <p data-testid="status">signed in as {me.data.alias}</p>}
    </main>
  );
}
