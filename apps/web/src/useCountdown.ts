import { useEffect, useState } from 'react';

/** Seconds left until `deadline` (an ISO time), counted down every second; never below zero. */
export function useCountdown(deadline: string): number {
  const target = Date.parse(deadline);
  const left = () => Math.max(0, Math.ceil((target - Date.now()) / 1000));
  const [seconds, setSeconds] = useState(left);

  useEffect(() => {
    setSeconds(left());
    const timer = setInterval(() => {
      const next = left();
      setSeconds(next);
      if (next === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [target]);

  return seconds;
}

/** 125 → "2:05". */
export function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
