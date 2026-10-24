import type { Plugin } from "vite-plus";
import { buildRoveProjectFileJsonSchema } from "@getpaperplane/shared/roveProjectFile";

export function projectFileSchemaPlugin(): Plugin {
  const source = `${JSON.stringify(buildRoveProjectFileJsonSchema(), null, 2)}\n`;
  return {
    name: "rove-project-file-schema",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== "GET" || request.url?.split("?")[0] !== "/schema/paperplane.json") {
          next();
          return;
        }
        response.setHeader("Content-Type", "application/schema+json");
        response.end(source);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "schema/paperplane.json", source });
    },
  };
}
