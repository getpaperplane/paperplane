import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { prepareDesktopStorageMigration } from "@getpaperplane/shared/homeMigration";
import { readChromiumLocalStorage } from "./chromiumLocalStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/** Supplies converted preferences and drafts to the preload before it reads storage. */
export class DesktopLegacyLocalStorage extends Context.Service<
  DesktopLegacyLocalStorage,
  {
    readonly load: (userDataPath: string) => Effect.Effect<void>;
    readonly take: Effect.Effect<Option.Option<Readonly<Record<string, string>>>>;
    readonly complete: Effect.Effect<void>;
  }
>()("@getpaperplane/desktop/app/DesktopLegacyLocalStorage") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const items = yield* Ref.make(Option.none<Readonly<Record<string, string>>>());
  const completion = yield* Ref.make(Effect.void);
  const load = Effect.fn("desktop.legacyLocalStorage.load")(function* (userDataPath: string) {
    const prepared = yield* prepareDesktopStorageMigration({
      userDataPath,
      appDataDirectory: environment.appDataDirectory,
      development: environment.isDevelopment,
      read: (directory, origin) =>
        readChromiumLocalStorage(directory, origin).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning(
          "Could not read previous desktop storage; will retry next launch.",
          cause,
        ).pipe(Effect.as(undefined)),
      ),
    );
    if (prepared === undefined) return;
    yield* Ref.set(items, Option.some(prepared.items));
    yield* Ref.set(completion, prepared.complete);
  });
  return DesktopLegacyLocalStorage.of({
    load,
    take: Ref.getAndSet(items, Option.none()),
    complete: Ref.get(completion).pipe(Effect.flatten),
  });
});

export const layer = Layer.effect(DesktopLegacyLocalStorage, make);
