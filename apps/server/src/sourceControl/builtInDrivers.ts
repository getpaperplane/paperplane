/**
 * The source control drivers this build ships with. Both registries, repository operations and
 * pull requests, iterate this list; a host with no driver here shows up as unsupported.
 *
 * Adding a host means writing its `@getpaperplane/source-control-<host>` package, adding its driver
 * here, and providing its services' layers in `layer` below.
 *
 * @module sourceControl/builtInDrivers
 */
import * as AzureDevOpsCli from "@getpaperplane/source-control-azure-devops/server/AzureDevOpsCli";
import * as AzureDevOpsPullRequestCli from "@getpaperplane/source-control-azure-devops/server/AzureDevOpsPullRequestCli";
import * as AzureDevOpsDriver from "@getpaperplane/source-control-azure-devops/server/driver";
import * as BitbucketApi from "@getpaperplane/source-control-bitbucket/server/BitbucketApi";
import * as BitbucketPullRequestApi from "@getpaperplane/source-control-bitbucket/server/BitbucketPullRequestApi";
import * as BitbucketDriver from "@getpaperplane/source-control-bitbucket/server/driver";
import * as ForgejoCli from "@getpaperplane/source-control-forgejo/server/ForgejoCli";
import * as ForgejoDriver from "@getpaperplane/source-control-forgejo/server/driver";
import * as GitCafeApi from "@getpaperplane/source-control-gitcafe/server/GitCafeApi";
import * as GitCafeCredentials from "@getpaperplane/source-control-gitcafe/server/GitCafeCredentials";
import * as GitCafeDriver from "@getpaperplane/source-control-gitcafe/server/driver";
import * as GitHubRest from "@getpaperplane/source-control-github/server/GitHubRest";
import * as GitHubPullRequestApi from "@getpaperplane/source-control-github/server/GitHubPullRequestApi";
import * as GitHubDriver from "@getpaperplane/source-control-github/server/driver";
import * as GitLabCli from "@getpaperplane/source-control-gitlab/server/GitLabCli";
import * as GitLabPullRequestCli from "@getpaperplane/source-control-gitlab/server/GitLabPullRequestCli";
import * as GitLabDriver from "@getpaperplane/source-control-gitlab/server/driver";
import type { SourceControlDriver } from "@getpaperplane/source-control-core/server/driver";
import * as Layer from "effect/Layer";

import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";

const drivers = [
  GitHubDriver.driver,
  GitLabDriver.driver,
  AzureDevOpsDriver.driver,
  BitbucketDriver.driver,
  ForgejoDriver.driver,
  GitCafeDriver.driver,
];

/** Every service a built-in driver's `make` needs; the server's layers must provide them all. */
export type BuiltInSourceControlDriversEnv =
  (typeof drivers)[number] extends SourceControlDriver<infer R> ? R : never;

/** Ordered as the hosts appear in discovery. */
export const BUILT_IN_SOURCE_CONTROL_DRIVERS: ReadonlyArray<
  SourceControlDriver<BuiltInSourceControlDriversEnv>
> = drivers;

/** The services the built-in drivers' packages own, plus the host port they all run against. */
export const layer = Layer.mergeAll(
  // `GitHubRest.layerWithDependencies` carries the quota reserve and rate-limit pause every GitHub
  // reader shares, so the server builds it once, here.
  GitHubPullRequestApi.layer.pipe(Layer.provideMerge(GitHubRest.layerWithDependencies)),
  AzureDevOpsPullRequestCli.layer.pipe(Layer.provideMerge(AzureDevOpsCli.layer)),
  BitbucketPullRequestApi.layer.pipe(Layer.provideMerge(BitbucketApi.layer)),
  ForgejoCli.layer,
  GitCafeApi.layer.pipe(Layer.provideMerge(GitCafeCredentials.layer)),
  GitLabPullRequestCli.layer.pipe(Layer.provideMerge(GitLabCli.layer)),
).pipe(Layer.provideMerge(ServerSourceControlHost.layer));
