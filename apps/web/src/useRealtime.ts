import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { WsMessage } from '@human-msg/shared';
import { startRealtime, realtimeUrl, type RealtimeStatus } from './realtime';

/**
 * While mounted (the user is signed in) keeps the socket open and keeps the cached server state
 * fresh: every event, and every reconnection, makes the screen re-read what it shows.
 * Returns the connection status.
 */
export function useRealtime(onEvent?: (event: WsMessage['event']) => void): RealtimeStatus {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  // The latest handler without reconnecting the socket whenever the component re-renders
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const refresh = (...keys: string[]) =>
      Promise.all(keys.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));

    const connection = startRealtime({
      url: realtimeUrl(),
      onStatus: setStatus,
      // Events may have been missed while the socket was down: re-read everything
      onOpen: () => void refresh('me', 'state', 'history'),
      onMessage: ({ event }) => {
        // The event is only a nudge: the truth is on the server, so the screen asks for it again
        const answersChanged =
          event.type === 'answer.received' || event.type === 'question.expired';
        void refresh('me', 'state', ...(answersChanged ? ['history'] : []));
        handler.current?.(event);
      },
    });
    return () => connection.close();
  }, [queryClient]);

  return status;
}
