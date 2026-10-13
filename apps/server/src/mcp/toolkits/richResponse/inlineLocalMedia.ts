import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

/** Total bytes a page may embed; data URIs grow them by a third again. */
export const HTML_RENDER_MAX_EMBEDDED_BYTES = 24 * 1024 * 1024;

const MEDIA_MIME_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
} satisfies Record<string, string>;

const EXTENSIONS = Object.keys(MEDIA_MIME_TYPES).join("|");
// An absolute POSIX or Windows path (optionally a file:// URL) ending in a
// media extension, quoted anywhere in the page (attributes, CSS, scripts) or
// unquoted inside CSS url(). A query or fragment after the name is dropped.
const PATH = `(?:file:\\/\\/)?(?:\\/|[A-Za-z]:[\\\\/])[^"'\`<>()\\n]*?\\.(?:${EXTENSIONS})(?:[?#][^"'\`<>()\\s]*)?`;
const QUOTED_PATH = new RegExp(`(["'\`])(${PATH})\\1`, "gi");
const CSS_URL_PATH = new RegExp(`url\\(\\s*(${PATH})\\s*\\)`, "gi");

export class HtmlRenderMediaTooLargeError extends Schema.TaggedError<HtmlRenderMediaTooLargeError>()(
  "HtmlRenderMediaTooLargeError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Embedding ${this.path} takes the page's local media past ${HTML_RENDER_MAX_EMBEDDED_BYTES / 1024 / 1024} MB. Use smaller or fewer files, such as compressed images or a shorter clip.`;
  }
}

function filePathOf(reference: string): string {
  const withoutSuffix = reference.replace(/[?#].*$/, "");
  if (!/^file:\/\//i.test(withoutSuffix)) return withoutSuffix;
  try {
    return decodeURIComponent(withoutSuffix.replace(/^file:\/\//i, ""));
  } catch {
    return withoutSuffix.replace(/^file:\/\//i, "");
  }
}

function mimeTypeOf(filePath: string): string | undefined {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  return Object.hasOwn(MEDIA_MIME_TYPES, extension)
    ? MEDIA_MIME_TYPES[extension as keyof typeof MEDIA_MIME_TYPES]
    : undefined;
}

/**
 * Replaces absolute local media paths in a page with data URIs, so the page
 * keeps working after the files move and never asks the client to read the
 * host's disk. Paths that do not resolve to a readable file stay as written
 * and are returned in `missing`.
 */
export const inlineLocalMedia = Effect.fn("HtmlRender.inlineLocalMedia")(function* (html: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const references = new Set<string>();
  for (const match of html.matchAll(QUOTED_PATH)) references.add(match[2]!);
  for (const match of html.matchAll(CSS_URL_PATH)) references.add(match[1]!);

  const dataUris = new Map<string, string>();
  const missing: string[] = [];
  let embeddedBytes = 0;
  for (const reference of references) {
    const filePath = filePathOf(reference);
    const mimeType = mimeTypeOf(filePath);
    if (!mimeType) continue;
    const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") {
      missing.push(filePath);
      continue;
    }
    // Check the size before reading so one huge file is never loaded.
    embeddedBytes += Number(info.value.size);
    if (embeddedBytes > HTML_RENDER_MAX_EMBEDDED_BYTES) {
      return yield* new HtmlRenderMediaTooLargeError({ path: filePath });
    }
    const bytes = yield* fileSystem.readFile(filePath).pipe(Effect.option);
    if (bytes._tag === "None") {
      missing.push(filePath);
      continue;
    }
    dataUris.set(
      reference,
      `data:${mimeType};base64,${Buffer.from(bytes.value).toString("base64")}`,
    );
  }

  const inlined = html
    .replace(QUOTED_PATH, (match, quote: string, reference: string) => {
      const uri = dataUris.get(reference);
      return uri === undefined ? match : `${quote}${uri}${quote}`;
    })
    .replace(CSS_URL_PATH, (match, reference: string) => {
      const uri = dataUris.get(reference);
      return uri === undefined ? match : `url("${uri}")`;
    });
  return { html: inlined, missing, embedded: dataUris.size };
});
