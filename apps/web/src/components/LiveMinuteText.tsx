import { useNowMinute } from "../hooks/useNowMinute";

/** Text that reads the clock, such as "5m ago". It re-renders on the shared
    minute tick by itself, so its parent does not have to. */
export function LiveMinuteText(props: { readonly text: () => string }) {
  useNowMinute();
  return props.text();
}
