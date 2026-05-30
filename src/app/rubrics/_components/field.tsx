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
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
        {label}
        {optional && (
          <span className="ml-1.5 text-xs font-normal text-zinc-500">
            · optional
          </span>
        )}
      </label>
      {children}
    </div>
  );
}
