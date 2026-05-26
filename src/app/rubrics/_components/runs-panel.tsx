export function RunsPanel() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-sm">
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <h2 className="text-sm font-semibold">Eval runs</h2>
      </div>
      <div className="flex-1 overflow-y-auto flex items-center justify-center">
        <p className="text-sm text-zinc-400">No runs yet</p>
      </div>
    </div>
  );
}
