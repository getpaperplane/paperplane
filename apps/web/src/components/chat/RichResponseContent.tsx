/* eslint-disable react/no-array-index-key -- Rich payloads are published atomically; fixed block and cell positions preserve disclosure state. */
import { memo, useState } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import type { EnvironmentId, ScopedThreadRef } from "@rove-code/contracts";
import type { RichResponse, RichResponseBlock } from "@rove-code/contracts/rich-response";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import "./RichResponseContent.css";

function FollowUpChoice({ label, prompt }: { label: string; prompt: string }) {
  const [copyFailed, setCopyFailed] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => setCopyFailed(false),
    onError: () => setCopyFailed(true),
  });
  return (
    <div className="space-y-1">
      <Button
        variant="outline"
        size="sm-multiline"
        aria-label={`Copy follow-up: ${label}`}
        onClick={() => copyToClipboard(prompt)}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
        {isCopied ? "Copied" : label}
      </Button>
      {copyFailed ? (
        <p role="alert" className="text-xs text-destructive">
          Could not copy. Try again.
        </p>
      ) : null}
    </div>
  );
}

/** Replies from before interactive pages; open, so reading them takes no extra step. */
function RichDetails({ block }: { block: Extract<RichResponseBlock, { type: "details" }> }) {
  return (
    <details open className="rounded-lg border border-border/70">
      <summary className="cursor-pointer rounded-lg px-3 py-2 font-medium focus-visible:outline-2 focus-visible:outline-ring">
        {block.title}
      </summary>
      <p className="whitespace-pre-wrap break-words border-t border-border/50 px-3 py-2">
        {block.text}
      </p>
    </details>
  );
}

export const RichResponseContent = memo(function RichResponseContent({
  response,
  environmentId,
  threadRef,
}: {
  response: RichResponse;
  environmentId: EnvironmentId | null;
  threadRef: ScopedThreadRef | undefined;
}) {
  return (
    <div className="my-3 flex min-w-0 flex-col gap-4 text-sm leading-relaxed" data-rich-response="">
      {response.blocks.map((block, index) => {
        switch (block.type) {
          case "text":
            return (
              <p key={index} className="whitespace-pre-wrap break-words">
                {block.text}
              </p>
            );
          case "table":
            return (
              <div
                key={index}
                className="min-w-0 overflow-x-auto rounded-lg border border-border/70"
                tabIndex={0}
                role="region"
                aria-label={block.title}
              >
                <table className="w-full border-collapse text-left">
                  <caption className="border-b border-border/70 px-3 py-2 text-left font-medium">
                    {block.title}
                  </caption>
                  <thead className="bg-muted/40">
                    <tr>
                      {block.columns.map((column, columnIndex) => (
                        <th key={columnIndex} scope="col" className="px-3 py-2 font-medium">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-t border-border/50">
                        {row.map((cell, columnIndex) => (
                          <td
                            key={columnIndex}
                            className="min-w-28 whitespace-pre-wrap break-words px-3 py-2 align-top"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "details":
            return <RichDetails key={index} block={block} />;
          case "html":
            return environmentId === null ? (
              <p key={index} className="text-muted-foreground text-xs">
                {block.title} (interactive page) is unavailable without its environment.
              </p>
            ) : (
              <HtmlRenderFrame
                key={block.attachmentId}
                environmentId={environmentId}
                threadRef={threadRef}
                block={block}
              />
            );
          case "choices":
            return (
              <section key={index} aria-label={block.title} className="flex flex-col gap-2">
                <p className="font-medium">{block.title}</p>
                <p className="text-xs text-muted-foreground">
                  Copy a follow-up to edit and send yourself.
                </p>
                <div className="flex flex-wrap gap-2">
                  {block.options.map((option, optionIndex) => (
                    <FollowUpChoice key={optionIndex} {...option} />
                  ))}
                </div>
              </section>
            );
        }
      })}
    </div>
  );
});
