import { createFileRoute } from "@tanstack/react-router";

import { SkillsSettings } from "../components/settings/SkillsSettings";

function SettingsSkillsRoute() {
  return <SkillsSettings />;
}

export const Route = createFileRoute("/settings/skills")({
  component: SettingsSkillsRoute,
});
