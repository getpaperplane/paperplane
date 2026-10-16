import { SourceControlProviderKind } from "@rove-code/contracts";
import { assert, it } from "@effect/vitest";

import * as AzureDevOpsCli from "@rove-code/source-control-azure-devops/server/AzureDevOpsCli";
import * as BitbucketApi from "@rove-code/source-control-bitbucket/server/BitbucketApi";
import * as GitHubRest from "@rove-code/source-control-github/server/GitHubRest";
import * as GitHubRequestPolicy from "@rove-code/source-control-github/server/GitHubRequestPolicy";
import * as SourceControlRateLimit from "@rove-code/source-control-core/server/SourceControlRateLimit";
import * as GitLabCli from "@rove-code/source-control-gitlab/server/GitLabCli";
import { azureDevOpsProviderFailure } from "@rove-code/source-control-azure-devops/server/AzureDevOpsPullRequestProvider";
import { bitbucketProviderFailure } from "@rove-code/source-control-bitbucket/server/BitbucketPullRequestProvider";
import { gitHubProviderFailure } from "@rove-code/source-control-github/server/GitHubPullRequestProvider";
import { gitLabProviderFailure } from "@rove-code/source-control-gitlab/server/GitLabPullRequestProvider";

const cause = new Error("redacted provider failure");

it("classifies rate limits from every pull-request provider", () => {
  assert.deepStrictEqual(
    gitHubProviderFailure(
      new GitHubRequestPolicy.GitHubApiRateLimitError({ host: "github.com", operation: "execute" }),
    ),
    { reason: "rate-limited" },
  );
  assert.deepStrictEqual(
    gitLabProviderFailure(
      new GitLabCli.GitLabCliRateLimitError({
        operation: "execute",
        command: "glab",
        cwd: "/repo",
        cause,
      }),
    ),
    { reason: "rate-limited" },
  );
  assert.deepStrictEqual(
    azureDevOpsProviderFailure(
      new AzureDevOpsCli.AzureDevOpsCliRateLimitError({
        operation: "execute",
        command: "az",
        cwd: "/repo",
        argumentCount: 1,
        cause,
      }),
    ),
    { reason: "rate-limited" },
  );
  assert.deepStrictEqual(
    bitbucketProviderFailure(
      new BitbucketApi.BitbucketResponseError({
        operation: "request",
        status: 429,
        responseBodyLength: 0,
        retryAt: 120_000,
      }),
    ),
    { reason: "rate-limited", retryAt: 120_000 },
  );
});

it("keeps GitHub's exact retry time", () => {
  assert.deepStrictEqual(
    gitHubProviderFailure(
      new SourceControlRateLimit.SourceControlRateLimitPausedError({
        provider: SourceControlProviderKind.make("github"),
        host: "github.com",
        retryAt: 1_786_802_400_000,
      }),
    ),
    { reason: "rate-limited", retryAt: 1_786_802_400_000 },
  );
});
