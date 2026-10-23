import {
  createContext,
  use,
  useImperativeHandle,
  useLayoutEffect,
  type ReactNode,
  type ComponentProps,
  type Ref,
} from "react";
import { useThreadFind } from "./useThreadFind";
import { ThreadFindBar } from "./ThreadFindBar";
import { ChatCanvas } from "./ChatCanvas";
import type { ScopedThreadRef } from "@rove-code/contracts";
import { useThreadProjection } from "../../state/entities";

type FindOptions = Omit<Parameters<typeof useThreadFind>[0], "content"> & {
  content?: Parameters<typeof useThreadFind>[0]["content"];
  contentThreadRef?: ScopedThreadRef | null;
};

type Find = ReturnType<typeof useThreadFind>;
export type ThreadFindControls = Pick<Find, "open" | "close">;
export const ThreadFindTimelineContext = createContext<Find["timelineProps"] | null>(null);
const ThreadFindBarContext = createContext<Find["barProps"] | null>(null);

export function ThreadFindCanvas({
  findOptions,
  controlsRef,
  onOpenChange,
  ...canvasProps
}: ComponentProps<typeof ChatCanvas> & {
  findOptions: FindOptions;
  controlsRef: Ref<ThreadFindControls>;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ThreadFindProvider {...findOptions} controlsRef={controlsRef} onOpenChange={onOpenChange}>
      <ChatCanvas {...canvasProps} />
    </ThreadFindProvider>
  );
}

/** Owns search updates below the chat view so cycling does not rerender the composer and panels. */
export function ThreadFindProvider({
  controlsRef,
  onOpenChange,
  children,
  contentThreadRef,
  ...options
}: FindOptions & {
  controlsRef: Ref<ThreadFindControls>;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const connected = useThreadProjection(contentThreadRef ?? null);
  const find = useThreadFind(
    contentThreadRef === undefined
      ? { ...options, content: options.content }
      : {
          ...options,
          content: connected?.projection,
          // A held paint from another thread is never searchable as this thread.
          enabled: options.enabled && connected !== null,
        },
  );
  useImperativeHandle(controlsRef, () => ({ open: find.open, close: find.close }), [
    find.open,
    find.close,
  ]);
  // Before paint, so the details card makes room in the same frame the bar appears.
  useLayoutEffect(() => onOpenChange(find.isOpen), [find.isOpen, onOpenChange]);
  return (
    <ThreadFindBarContext value={find.barProps}>
      <ThreadFindTimelineContext value={find.timelineProps}>{children}</ThreadFindTimelineContext>
    </ThreadFindBarContext>
  );
}

export function ThreadFind({ onClose }: { onClose: () => void }) {
  const bar = use(ThreadFindBarContext);
  if (!bar) return null;
  return (
    <ThreadFindBar
      {...bar}
      onClose={() => {
        bar.onClose();
        onClose();
      }}
    />
  );
}
