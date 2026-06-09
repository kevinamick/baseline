// One editable instance/input row in a wizard's manual editor (UI shape: every field a
// string, blanks for the optional columns). Cleaned to userInput/expectedOutput/
// retrievalContext (optional fields → null) at submit. Shared by the schedules and
// optimization wizards' InstanceRowsEditor and the CSV/JSON instance parsers.
export interface InstanceRow {
  userInput: string;
  expectedOutput: string;
  retrievalContext: string;
}
