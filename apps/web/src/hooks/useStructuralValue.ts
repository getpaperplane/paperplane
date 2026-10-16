import { useRef } from "react";

/** Equality for plain data: primitives, arrays, and plain objects compare by
    content; anything else (class instances, functions) by identity. */
export function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => structurallyEqual(item, right[index]))
    );
  }
  if (Array.isArray(right)) return false;
  const prototype = Object.getPrototypeOf(left);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getPrototypeOf(right) !== prototype
  ) {
    return false;
  }
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  // SAFETY: both values are plain objects (checked above), so string keys index them.
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) &&
      structurallyEqual(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
      ),
  );
}

/**
 * Returns the previous value while the new one is structurally equal, so a
 * memoized child does not re-render when a parent rebuilds equal data from a
 * projection that changed elsewhere, as every streamed delta does.
 */
export function useStructuralValue<T>(value: T): T {
  const previous = useRef(value);
  if (!structurallyEqual(previous.current, value)) previous.current = value;
  return previous.current;
}
