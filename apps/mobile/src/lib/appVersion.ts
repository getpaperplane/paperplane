import * as Application from "expo-application";
import Constants from "expo-constants";
import * as RuntimePredicate from "effect/Predicate";

/** The running bundle's release label, or the native marketing version for source/store builds. */
export function readAppVersion(): string {
  const value = Constants.expoConfig?.extra?.releaseVersion;
  const releaseVersion = RuntimePredicate.isString(value) ? value.trim() : undefined;
  return (
    releaseVersion ||
    Application.nativeApplicationVersion ||
    Constants.expoConfig?.version ||
    "0.0.0"
  );
}

/** Read the installed binary, not the config that Metro or an OTA update can replace. */
export function readNativeBuildNumber(): string | undefined {
  return Application.nativeBuildVersion ?? undefined;
}
