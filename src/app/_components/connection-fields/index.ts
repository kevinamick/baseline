// Shared connection-create form: the field state model, validation, payload builder, and the
// form UI. Imported by the schedule wizard, the Add Connection dialog, and the optimization
// wizard's inline agent form so all three collect a Connection identically.
export {
  type ConnectionDraft,
  CONNECTION_DRAFT_DEFAULTS,
  connectionDraftError,
  buildConnectionPayload,
} from "./draft";
export { useConnectionDraft, type UseConnectionDraft } from "./use-connection-draft";
export {
  ConnectionFields,
  EncryptionCallout,
  ManagedUpgradeNote,
  useConnTypeLabels,
} from "./connection-fields";
