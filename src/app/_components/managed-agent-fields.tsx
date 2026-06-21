"use client";

import { useTranslations } from "next-intl";
import { inputCls } from "@/app/_components/form-styles";
import { Field } from "@/app/[locale]/rubrics/_components/field";
import { TARGET_MODELS } from "@/lib/optimization/models";

// The inline "Paste a prompt" Managed Agent inputs (#293): just the prompt to optimize and the
// target model it runs on. Shared so the optimization wizard and the eval/schedule pickers
// (#294) collect a managed System identically — one namespace ("ManagedAgent"), one component.
export function ManagedAgentFields({
  prompt,
  setPrompt,
  targetModel,
  setTargetModel,
  idPrefix = "managed",
}: {
  prompt: string;
  setPrompt: (v: string) => void;
  targetModel: string;
  setTargetModel: (v: string) => void;
  idPrefix?: string;
}) {
  const t = useTranslations("ManagedAgent");
  return (
    <div className="flex flex-col gap-5">
      <Field label={t("promptLabel")} htmlFor={`${idPrefix}-prompt`}>
        <textarea
          id={`${idPrefix}-prompt`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("promptPlaceholder")}
          rows={6}
          className={`${inputCls} resize-y`}
        />
      </Field>
      <Field label={t("targetModelLabel")} htmlFor={`${idPrefix}-model`}>
        <select
          id={`${idPrefix}-model`}
          value={targetModel}
          onChange={(e) => setTargetModel(e.target.value)}
          className={inputCls}
        >
          {TARGET_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="-mt-2 text-xs text-fg-3">{t("hint")}</p>
    </div>
  );
}
