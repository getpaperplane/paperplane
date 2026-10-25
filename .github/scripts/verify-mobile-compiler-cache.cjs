// Run with ccache, CMake and a C++ compiler on PATH. Uses isolated temporary state.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const directory = mkdtempSync(join(tmpdir(), "paperplane-compiler-cache-"));
const env = {
  ...process.env,
  CCACHE_DIR: join(directory, "cache"),
  CCACHE_BASEDIR: directory,
  CCACHE_COMPILERCHECK: "content",
  CCACHE_SLOPPINESS: "pch_defines,time_macros",
  CMAKE_C_COMPILER_LAUNCHER: "ccache",
  CMAKE_CXX_COMPILER_LAUNCHER: "ccache",
};
const run = (command, args) => execFileSync(command, args, { env, encoding: "utf8" });
const stats = () =>
  Object.fromEntries(
    run("ccache", ["--print-stats"])
      .trim()
      .split("\n")
      .map((line) => {
        const [key, value] = line.split(/\s+/);
        return [key, Number(value)];
      }),
  );

try {
  for (const reactNativeLauncher of [false, true]) {
    const source = join(directory, reactNativeLauncher ? "react-native" : "library");
    const build = join(source, "build");
    mkdirSync(source);
    env.CCACHE_DIR = join(source, "cache");
    writeFileSync(
      join(source, "CMakeLists.txt"),
      `cmake_minimum_required(VERSION 3.22)
project(cache_probe LANGUAGES CXX)
${reactNativeLauncher ? "set_property(GLOBAL PROPERTY RULE_LAUNCH_COMPILE ccache)" : ""}
add_executable(cache_probe main.cpp)
target_compile_definitions(cache_probe PRIVATE OFFSET=\${OFFSET})
`,
    );
    const sourceText =
      '#include "value.h"\n#include <cstdio>\nint main() { std::printf("%d", VALUE + OFFSET); }\n';
    writeFileSync(join(source, "main.cpp"), sourceText);
    writeFileSync(join(source, "value.h"), "#define VALUE 42\n");
    const configure = (offset) => run("cmake", ["-S", source, "-B", build, `-DOFFSET=${offset}`]);
    const compile = () => run("cmake", ["--build", build, "--clean-first"]);
    const result = () => run(join(build, "cache_probe"), []);

    configure(0);
    run("ccache", ["--zero-stats"]);
    compile();
    assert.equal(result(), "42");
    assert.ok(stats().cache_miss > 0, "Cold compilation must populate the cache");
    compile();
    assert.equal(result(), "42");
    const warm = stats();
    assert.ok(
      warm.direct_cache_hit + warm.preprocessed_cache_hit > 0,
      "Clean rebuild must reuse compiler outputs",
    );

    writeFileSync(join(source, "value.h"), "#define VALUE 43\n");
    compile();
    assert.equal(result(), "43", "Header changes must invalidate compiler outputs");
    assert.ok(stats().cache_miss > warm.cache_miss);
    configure(2);
    compile();
    assert.equal(result(), "45", "Compiler flags must invalidate compiler outputs");
    writeFileSync(
      join(source, "main.cpp"),
      sourceText.replace("VALUE + OFFSET", "VALUE + OFFSET + 1"),
    );
    compile();
    assert.equal(result(), "46", "Source changes must invalidate compiler outputs");
    console.log(
      `${reactNativeLauncher ? "React Native" : "Library"}: cache hit on clean rebuild; header, flags and source changes rebuilt correctly`,
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
