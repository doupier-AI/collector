import { useCallback, useEffect, useId, useRef, useState } from "react";

export const THEME_STORAGE_KEY = "collector:theme-preference:v1";

export type ThemePreference = "light" | "dark" | "system";

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function readThemePreference(storage: Pick<Storage, "getItem"> = localStorage): ThemePreference {
  try {
    const saved = storage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

export function applyThemePreference(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.theme = preference;
}

/** 在 React 挂载前恢复主题，避免应用先按错误主题完成首帧。 */
export function initializeThemePreference(): ThemePreference {
  const preference = readThemePreference();
  applyThemePreference(preference);
  return preference;
}

function persistThemePreference(preference: ThemePreference): void {
  applyThemePreference(preference);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // 存储不可用时仍保留本次页面内选择；不让增强能力阻断界面。
  }
}

function useThemePreference(): readonly [ThemePreference, (preference: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);

  useEffect(() => {
    persistThemePreference(preference);
  }, [preference]);

  return [preference, setPreference] as const;
}

function ThemeGlyph({ preference }: { preference: ThemePreference }) {
  if (preference === "light") {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="3.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M10 2v2M10 16v2M2 10h2M16 10h2M4.35 4.35l1.4 1.4M14.25 14.25l1.4 1.4M15.65 4.35l-1.4 1.4M5.75 14.25l-1.4 1.4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (preference === "dark") {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path
          d="M10 2.75a7.25 7.25 0 1 0 7.25 7.25A5.5 5.5 0 0 1 10 2.75Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="2.5" y="3.25" width="15" height="11" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 17h6M10 14.25V17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function ThemeSwitcher({ variant }: { variant: "rail" | "detail" }) {
  const [preference, setPreference] = useThemePreference();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const radioRefs = useRef<Partial<Record<ThemePreference, HTMLInputElement>>>({});
  const groupId = useId();
  const currentLabel = THEME_OPTIONS.find((option) => option.value === preference)?.label ?? "跟随系统";

  useEffect(() => {
    if (!open) return;
    radioRefs.current[preference]?.focus();

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open, preference]);

  const selectTheme = useCallback((nextPreference: ThemePreference) => {
    setPreference(nextPreference);
    setOpen(false);
    triggerRef.current?.focus();
  }, [setPreference]);

  const closeWithFocusReturn = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  return (
    <div ref={rootRef} className={`theme-switcher theme-switcher--${variant}`}>
      <button
        ref={triggerRef}
        type="button"
        className={variant === "rail" ? "side-rail__button" : "side-detail__settings theme-switcher__trigger"}
        aria-label={`主题：${currentLabel}`}
        aria-expanded={open}
        aria-controls={open ? groupId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <ThemeGlyph preference={preference} />
        {variant === "detail" ? (
          <>
            <span>主题</span>
            <span className="theme-switcher__value">{currentLabel}</span>
          </>
        ) : null}
      </button>

      {open ? (
        <div
          id={groupId}
          className="theme-switcher__popover"
          role="radiogroup"
          aria-label="选择主题"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closeWithFocusReturn();
          }}
        >
          {THEME_OPTIONS.map((option) => (
            <label key={option.value} className="theme-switcher__option">
              <input
                ref={(element) => {
                  radioRefs.current[option.value] = element ?? undefined;
                }}
                type="radio"
                name={groupId}
                value={option.value}
                checked={preference === option.value}
                onChange={() => selectTheme(option.value)}
              />
              <ThemeGlyph preference={option.value} />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
