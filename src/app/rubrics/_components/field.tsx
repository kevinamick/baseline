"use client";

export function Field({
  label,
  htmlFor,
  optional,
  children,
}: {
  label: string;
  htmlFor: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
        {optional && (
          <span className="ml-1.5 text-xs font-normal text-zinc-400">(optional)</span>
        )}
      </label>
      {children}
    </div>
  );
}
