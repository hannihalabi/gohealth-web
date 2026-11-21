import { useState } from "react";
import type { Choice } from "@/lib/registration-options";

const other = "__other__";

export function PresetField({
  label,
  value,
  onChange,
  options,
  placeholder = "Välj ett alternativ",
  otherLabel = "Annat alternativ",
  maxLength,
  required = true,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly Choice[];
  placeholder?: string;
  otherLabel?: string;
  maxLength: number;
  required?: boolean;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const usingOther = custom || (value !== "" && !options.some(
    (option) => (typeof option === "string" ? option : option.value) === value,
  ));

  return (
    <div>
      <label>
        {label}
        <select
          value={usingOther ? other : value}
          required={required}
          disabled={disabled}
          onChange={(event) => {
            const selected = event.target.value;
            setCustom(selected === other);
            onChange(selected === other ? "" : selected);
          }}
        >
          <option value="" disabled={required}>{placeholder}</option>
          {options.map((option) => {
            const { value, label } = typeof option === "string" ? { value: option, label: option } : option;
            return <option key={value} value={value}>{label}</option>;
          })}
          <option value={other}>{otherLabel}</option>
        </select>
      </label>
      {usingOther && (
        <label>
          {label} enligt underlaget
          <input value={value} maxLength={maxLength} required={required} disabled={disabled}
            onChange={(event) => onChange(event.target.value)} />
        </label>
      )}
    </div>
  );
}
