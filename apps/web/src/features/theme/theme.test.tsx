import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  ThemeSwitcher,
  initializeThemePreference,
  readThemePreference,
} from "./theme";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("主题偏好", () => {
  it("无保存值或保存值无效时默认跟随系统", () => {
    expect(readThemePreference()).toBe("system");

    localStorage.setItem(THEME_STORAGE_KEY, "invalid");
    expect(initializeThemePreference()).toBe("system");
    expect(document.documentElement).toHaveAttribute("data-theme", "system");
  });

  it("初始化时恢复已保存选择并立刻写到根元素", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");

    expect(initializeThemePreference()).toBe("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });
});

describe("ThemeSwitcher", () => {
  it("三态切换会更新当前态、根元素和持久化选择", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitcher variant="detail" />);

    const trigger = screen.getByRole("button", { name: "主题：跟随系统" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("跟随系统")).toBeInTheDocument();

    await user.click(trigger);
    const group = screen.getByRole("radiogroup", { name: "选择主题" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "跟随系统" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "深色" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "主题：深色" })).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: "主题：深色" }));
    await user.click(screen.getByRole("radio", { name: "浅色" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("Escape 关闭选择器并把焦点还给入口", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitcher variant="rail" />);

    const trigger = screen.getByRole("button", { name: "主题：跟随系统" });
    await user.click(trigger);
    expect(screen.getByRole("radiogroup", { name: "选择主题" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("radiogroup", { name: "选择主题" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
