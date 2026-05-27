"use client";

import { useState } from "react";
import { RubricsPanel } from "./rubrics-panel";
import { RunsPanel } from "./runs-panel";
import type { RubricSummary } from "@/types/rubric";

interface Props {
  rubrics: RubricSummary[];
}

export function RubricsLayout({ rubrics }: Props) {
  const [selectedRubricId, setSelectedRubricId] = useState<string | null>(null);

  return (
    <div
      className="flex flex-1 overflow-hidden gap-3 min-h-0"
      onClick={() => setSelectedRubricId(null)}
    >
      <RubricsPanel
        rubrics={rubrics}
        selectedId={selectedRubricId}
        onSelect={setSelectedRubricId}
      />
      <RunsPanel selectedRubricId={selectedRubricId} rubrics={rubrics} />
    </div>
  );
}
