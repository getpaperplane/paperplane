import * as Redacted from "effect/Redacted";
import { useId, useRef, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

export function LinuxSetupAuthorizationDialog(props: {
  readonly environmentLabel: string;
  readonly onAuthorize: (authorization: Redacted.Redacted<string>) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const passwordId = useId();
  const errorId = useId();
  const formId = useId();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current || password.length === 0) return;
    inFlight.current = true;
    const authorization = Redacted.make(password);
    setPassword("");
    setError(null);
    setPending(true);
    try {
      const failure = await props.onAuthorize(authorization);
      if (failure === null) props.onClose();
      else setError(failure);
    } catch {
      setError(
        "Could not complete authorization. Check the connection to this environment and try again.",
      );
    } finally {
      Redacted.wipeUnsafe(authorization);
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !inFlight.current) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Authorize Linux setup</DialogTitle>
          <DialogDescription>
            Enter the administrator password for the account running Paperplane on{" "}
            {props.environmentLabel}. Paperplane uses it once to install the required packages and
            does not save it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-2">
              <label htmlFor={passwordId} className="text-sm font-medium">
                Administrator password
              </label>
              <Input
                id={passwordId}
                type="password"
                autoComplete="off"
                autoFocus
                value={password}
                maxLength={1024}
                disabled={pending}
                spellCheck={false}
                aria-invalid={error !== null}
                aria-describedby={error ? errorId : undefined}
                onChange={(event) => setPassword(event.target.value)}
              />
              {error ? (
                <p id={errorId} role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={pending || password.length === 0}>
            {pending ? "Installing…" : "Authorize and install"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
