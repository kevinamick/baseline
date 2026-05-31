"use client";

export function Field({
  label,
  htmlFor,
  optional,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  optional?: boolean;
  error?: string | string[];
  children: React.ReactNode;
}) {
  const errorText = Array.isArray(error) ? error[0] : error;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
        {optional && (
          <span className="ml-1.5 text-xs font-normal text-zinc-500">
            · optional
          </span>
        )}
      </label>
      {children}
      {errorText && (
        <p className="text-xs text-red-600 dark:text-red-400">{errorText}</p>
      )}
    </div>
  );
}
