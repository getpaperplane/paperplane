import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import { readChromiumLocalStorage } from "./chromiumLocalStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/**
 * Carries the renderer's localStorage (prompt stash, unsent drafts, layout,
 * theme) over from the V1 desktop profile, which V2 replaced with its own
 * `rove-v2` profile. The V1 profile is only read, never opened by Chromium,
 * so this works while V1 is still running.
 *
 * `load` runs before the window opens; the preload takes the items once,
 * merges them into the new profile, and calls `complete`, which writes a
 * marker so later launches skip the read. A failed read or merge, or a window
 * that never completes, leaves no marker and retries next launch.
 */
export class DesktopLegacyLocalStorage extends Context.Service<
  DesktopLegacyLocalStorage,
  {
    readonly load: (userDataPath: string) => Effect.Effect<void>;
    readonly take: Effect.Effect<Option.Option<Readonly<Record<string, string>>>>;
    readonly complete: Effect.Effect<void>;
  }
>()("@rove-code/desktop/app/DesktopLegacyLocalStorage") {}

const MARKER_FILE_NAME = "v1-local-storage-imported";

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const items = yield* Ref.make(Option.none<Readonly<Record<string, string>>>());
  const markerPath = yield* Ref.make(Option.none<string>());

  /** Locate only this surface's V1 profile; never read an upstream or opposite-mode profile. */
  const findV1LocalStorage = Effect.gen(function* () {
    const name = environment.isDevelopment ? "rove-code-dev" : "rove-code";
    const directory = path.join(environment.appDataDirectory, name, "Local Storage", "leveldb");
    return yield* fs.readDirectory(directory).pipe(
      Effect.as(directory),
      Effect.orElseSucceed(() => null),
    );
  });

  const writeMarker = Effect.gen(function* () {
    const marker = yield* Ref.get(markerPath);
    if (Option.isNone(marker)) return;
    yield* fs
      .writeFileString(marker.value, "")
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not record the V1 Local Storage import", error),
        ),
      );
  });

  const load = Effect.fn("desktop.legacyLocalStorage.load")(function* (userDataPath: string) {
    const marker = path.join(userDataPath, MARKER_FILE_NAME);
    if (yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => true))) return;
    yield* Ref.set(markerPath, Option.some(marker));
    const directory = yield* findV1LocalStorage;
    if (directory === null) return yield* writeMarker;
    const origin = ElectronProtocol.getDesktopUrl(environment.isDevelopment).replace(/\/$/, "");
    const read = yield* readChromiumLocalStorage(directory, origin).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.tapError((error) =>
        Effect.logWarning("Could not read V1 Local Storage; will retry next launch", error),
      ),
      Effect.option,
    );
    if (Option.isNone(read)) return;
    yield* Effect.logInfo("V1 Local Storage ready to import", {
      directory,
      keys: read.value.size,
    });
    yield* Ref.set(items, Option.some(Object.fromEntries(read.value)));
  });

  return DesktopLegacyLocalStorage.of({
    load,
    // Taking clears the items, so a reload before `complete` cannot merge twice.
    take: Ref.getAndSet(items, Option.none()),
    complete: writeMarker,
  });
});

export const layer = Layer.effect(DesktopLegacyLocalStorage, make);
