import { useEffect, useState } from "react";

export const WAIT_MESSAGE_INTERVAL = 6000;

export function useWaitMessage(
  busy: boolean,
  messages: readonly string[]
): { key: number; text: string } {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!busy || messages.length === 0) return;
    setIndex(Math.floor(Math.random() * messages.length));
    const timer = setInterval(() => setIndex((i) => i + 1), WAIT_MESSAGE_INTERVAL);
    return () => clearInterval(timer);
  }, [busy, messages.length]);
  return { key: index, text: messages[index % messages.length] ?? "" };
}
