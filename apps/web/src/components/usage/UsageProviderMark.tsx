import type { UsageProviderKind } from "@rove-code/contracts";

import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { PROVIDER_PRESENTATION } from "./usageProviders";

/** Brand mark for the harness a row belongs to. */
export function UsageProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const { driverKind, label } = PROVIDER_PRESENTATION[provider];
  return (
    <ProviderInstanceIcon
      driverKind={driverKind}
      displayName={label}
      className={cn("shrink-0", className)}
    />
  );
}
