"use client";

import { useTranslations } from "next-intl";
import { InfoTooltip } from "@/app/_components/info-tooltip";

export function Field({
  label,
  htmlFor,
  optional,
  tooltip,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  optional?: boolean;
  tooltip?: string;
  error?: string | string[];
  children: React.ReactNode;
}) {
  const t = useTranslations("Common");
  const errorText = Array.isArray(error) ? error[0] : error;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
          {label}
          {optional && (
            <span className="ml-1.5 text-xs font-normal text-fg-3">
              {t("optional")}
            </span>
          )}
        </label>
        {tooltip && <InfoTooltip content={tooltip} />}
      </div>
      {children}
      {errorText && (
        <p className="text-xs text-danger-fg">{errorText}</p>
      )}
    </div>
  );
}
