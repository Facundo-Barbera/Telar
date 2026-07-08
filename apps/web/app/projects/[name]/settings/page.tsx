"use client";

import { use } from "react";
import { ProjectSettings } from "@/components/projects/settings-view";

export default function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = use(params);
  return <ProjectSettings name={name} />;
}
