import { useEffect, useState } from "react";
import { AppState } from "react-native";

/** One deadline timer; foregrounding also checks time elapsed while suspended. */
export function useCompactionDue(dueAt: number | null): boolean {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (dueAt === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (timer !== undefined) clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      if (current < dueAt) timer = setTimeout(check, Math.min(dueAt - current, 2147483647));
    };
    check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      subscription.remove();
    };
  }, [dueAt]);
  return dueAt !== null && now >= dueAt;
}
