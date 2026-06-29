"use client";

import { useCallback, useState } from "react";
import type { ModuleRow } from "@/app/_components/modules-editor";
import {
  CONN_TYPE,
  type ConnType,
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_QUERY_TEMPLATE,
} from "@/lib/connections/wizard-constants";
import { extractPromptRefs } from "@/lib/optimization/prompt-refs";
import {
  CONNECTION_DRAFT_DEFAULTS,
  type ConnectionDraft,
} from "./draft";

export interface UseConnectionDraft {
  draft: ConnectionDraft;
  /** Merge a partial update into the draft (most inputs). */
  update: (patch: Partial<ConnectionDraft>) => void;
  /** A functional setter for the Modules rows — matches ModulesEditor's onModulesChange. */
  setModules: React.Dispatch<React.SetStateAction<ModuleRow[]>>;
  /** ModulesEditor's onRequestTemplateChange. */
  setRequestTemplate: (v: string) => void;
  /** Switch the connection type, applying the Module-clear + template-swap side effects. */
  setConnType: (ct: ConnType) => void;
}

// Owns the connection-create form state and the one piece of cross-field behaviour that switching
// type triggers. Construct with overrides for the optimization wizard's seeded agent (a
// {{prompt:system}} template + a mandatory `system` Module).
export function useConnectionDraft(
  init?: Partial<ConnectionDraft>,
): UseConnectionDraft {
  const [draft, setDraft] = useState<ConnectionDraft>({
    ...CONNECTION_DRAFT_DEFAULTS,
    ...init,
  });

  const update = useCallback(
    (patch: Partial<ConnectionDraft>) => setDraft((d) => ({ ...d, ...patch })),
    [],
  );

  const setModules = useCallback<React.Dispatch<React.SetStateAction<ModuleRow[]>>>(
    (action) =>
      setDraft((d) => ({
        ...d,
        modules:
          typeof action === "function"
            ? (action as (prev: ModuleRow[]) => ModuleRow[])(d.modules)
            : action,
      })),
    [],
  );

  const setRequestTemplate = useCallback(
    (v: string) => setDraft((d) => ({ ...d, requestTemplate: v })),
    [],
  );

  const setConnType = useCallback(
    (ct: ConnType) =>
      setDraft((d) => {
        // Modules are agent-only. Clear them on a switch away so they can't silently survive and
        // reappear (or ship {{prompt:*}} refs into a dataset's query template).
        const modules = ct === CONN_TYPE.agent ? d.modules : [];
        // Swap the template default to match the type, unless the user already customized it
        // (custom = query params; agent = request body). A template carrying {{prompt:*}} Module
        // refs must never become a dataset query template — those literals would be sent verbatim
        // to the customer's API — so reset it too.
        let requestTemplate = d.requestTemplate;
        if (
          ct === CONN_TYPE.customDataset &&
          (requestTemplate === DEFAULT_AGENT_TEMPLATE ||
            extractPromptRefs(requestTemplate).length > 0)
        ) {
          requestTemplate = DEFAULT_QUERY_TEMPLATE;
        } else if (
          ct === CONN_TYPE.agent &&
          requestTemplate === DEFAULT_QUERY_TEMPLATE
        ) {
          requestTemplate = DEFAULT_AGENT_TEMPLATE;
        }
        return { ...d, connType: ct, modules, requestTemplate };
      }),
    [],
  );

  return { draft, update, setModules, setRequestTemplate, setConnType };
}
