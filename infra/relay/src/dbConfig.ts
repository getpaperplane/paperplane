export function relayNeonBranchConfig(stage: string, projectId: string, productionBranch: string) {
  const project = { projectId };
  if (stage === "prod") {
    return { project, name: productionBranch };
  }
  return {
    project,
    name: `${productionBranch}-${stage}`,
    parentBranch: { name: productionBranch },
    // Keep applied migration history with the forked schema. A schema-only
    // fork empties the history and would replay CREATE TABLE migrations.
    initSource: "parent-data" as const,
    endpoints: [
      {
        type: "read_write" as const,
        autoscalingLimitMinCu: 0.25,
        autoscalingLimitMaxCu: 0.25,
      },
    ],
  };
}
