import * as Redacted from "effect/Redacted";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { LinuxSetupAuthorizationDialog } from "./LinuxSetupAuthorizationDialog";

vi.mock("../ui/dialog", () => {
  const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Container,
    DialogPopup: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogDescription: Container,
    DialogPanel: Container,
    DialogFooter: Container,
  };
});
vi.mock("../ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("../ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("clears the password before awaiting authorization, blocks duplicate submission, and wipes a rejected credential", async () => {
  let finish: (value: string | null) => void = () => {
    throw new Error("Authorization completion is not initialized.");
  };
  const completion = new Promise<string | null>((resolve) => {
    finish = resolve;
  });
  const credentials: Redacted.Redacted<string>[] = [];
  const authorize = vi.fn((secret: Redacted.Redacted<string>) => {
    credentials.push(secret);
    return completion;
  });
  const close = vi.fn();
  await act(() => {
    renderer = create(
      <LinuxSetupAuthorizationDialog
        environmentLabel="Remote host"
        onAuthorize={authorize}
        onClose={close}
      />,
    );
  });
  await act(() =>
    renderer.root.findByType("input").props.onChange({ target: { value: "fixture-password" } }),
  );
  await act(() => {
    renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
    renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  expect(renderer.root.findByType("input").props.value).toBe("");
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(credentials.map((secret) => Redacted.value(secret))).toEqual(["fixture-password"]);
  await act(async () => {
    finish("The host rejected that password.");
    await completion;
  });
  expect(() => credentials.map((secret) => Redacted.value(secret))).toThrow();
  expect(renderer.root.findByProps({ role: "alert" }).children).toContain(
    "The host rejected that password.",
  );
  expect(close).not.toHaveBeenCalled();
});

it("wipes credentials after successful authorization", async () => {
  const credentials: Redacted.Redacted<string>[] = [];
  const close = vi.fn();
  await act(() => {
    renderer = create(
      <LinuxSetupAuthorizationDialog
        environmentLabel="Remote host"
        onClose={close}
        onAuthorize={async (secret) => {
          credentials.push(secret);
          return null;
        }}
      />,
    );
  });
  await act(() =>
    renderer.root.findByType("input").props.onChange({ target: { value: "fixture-password" } }),
  );
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(() => credentials.map((secret) => Redacted.value(secret))).toThrow();
});
