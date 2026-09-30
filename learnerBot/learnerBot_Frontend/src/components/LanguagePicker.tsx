import { LANGUAGE_OPTIONS, MAX_STT_LANGUAGES } from '../utils/deploymentPrompt';

interface LanguagePickerProps {
  selected: string[];
  onChange: (next: string[]) => void;
  compact?: boolean;
  disabled?: boolean;
}

// Shared multi-select used by the first-login LanguageSetup page, SettingsSidebar
// (the persistent default), and the per-recording overrides on Design/CreateProfile.
// Supports picking more than one language for mixed-language speakers — the first
// selected becomes Google STT's primary language_code, the rest become
// alternative_language_codes (capped at MAX_STT_LANGUAGES).
export default function LanguagePicker({ selected, onChange, compact, disabled }: LanguagePickerProps) {
  const toggle = (code: string) => {
    if (disabled) return;
    if (selected.includes(code)) {
      if (selected.length === 1) return; // always keep at least one language selected
      onChange(selected.filter((c) => c !== code));
    } else {
      if (selected.length >= MAX_STT_LANGUAGES) return;
      onChange([...selected, code]);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      {LANGUAGE_OPTIONS.map((option) => {
        const isSelected = selected.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => toggle(option.id)}
            disabled={disabled}
            className={`flex items-center gap-1.5 rounded-lg border font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
              compact ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm'
            } ${
              isSelected
                ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                : 'border-slate-200 bg-slate-50 text-slate-400'
            }`}
          >
            {option.label}
            {isSelected && <span className="text-indigo-400 font-bold">×</span>}
          </button>
        );
      })}
    </div>
  );
}
