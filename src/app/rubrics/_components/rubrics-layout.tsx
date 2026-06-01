"use client";

import { useState } from "react";
import { RubricsPanel } from "./rubrics-panel";
import { RunsPanel } from "./runs-panel";
import type { RubricSummary } from "@/types/rubric";
import type { EmailGroup } from "@/types/email-group";

interface Props {
  rubrics: RubricSummary[];
  emailGroups: EmailGroup[];
  canWrite: boolean;
}

export function RubricsLayout({ rubrics, emailGroups, canWrite }: Props) {
  const [selectedRubricId, setSelectedRubricId] = useState<string | null>(null);

  function handleBackgroundClick(e: React.MouseEvent<HTMLDivElement>) {
    // Only deselect on direct clicks of the background container. Using `closest` on the
    // target is unreliable because descendants that re-render (e.g. dialog buttons that
    // remove themselves) detach from the DOM before the event bubbles here.
    if (e.target !== e.currentTarget) return;
    setSelectedRubricId(null);
  }

  return (
    <div
      className="flex min-h-0 flex-1 gap-4 overflow-hidden"
      onClick={handleBackgroundClick}
    >
      <RubricsPanel
        rubrics={rubrics}
        selectedId={selectedRubricId}
        onSelect={setSelectedRubricId}
        canWrite={canWrite}
      />
      <RunsPanel
        selectedRubricId={selectedRubricId}
        rubrics={rubrics}
        emailGroups={emailGroups}
        canWrite={canWrite}
      />
    </div>
  );
}
