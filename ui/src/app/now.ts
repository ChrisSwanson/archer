/**
 * The time, as state that moves on by itself, for text that says how long ago
 * something was ("2 min ago"). Ticks only while `active`.
 */
import { useEffect, useState } from "react";

export const NOW_TICK_MS = 30_000;

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
