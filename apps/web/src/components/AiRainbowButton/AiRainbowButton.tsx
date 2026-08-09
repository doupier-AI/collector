import type { ReactNode } from "react";

interface AiRainbowButtonProps {
  /** 语义标签与可见文本（作为按钮内容渲染）。 */
  children: ReactNode;
  /** 无障碍标签；缺省取可见文本。 */
  label?: string;
  type?: "submit" | "button";
  onClick?: () => void;
  disabled?: boolean;
  /** small：更紧凑的行内版本；默认为主按钮尺寸。 */
  size?: "default" | "small";
}

/**
 * 彩虹渐变 AI 签名按钮：流动彩虹渐变 + 辉光 + 点击弹性。
 * 只用于最需要吸引注意力的 AI 功能入口（开始页「开始研究」），其余按钮保持朴素。
 * reduced-motion 下关闭流动动画，保留渐变与弹性。
 */
export function AiRainbowButton({
  children,
  label,
  type = "button",
  onClick,
  disabled = false,
  size = "default",
}: AiRainbowButtonProps) {
  const text = typeof children === "string" ? children : undefined;
  return (
    <button
      type={type}
      className={`ai-rainbow-button ai-rainbow-button--${size}`}
      aria-label={label ?? text}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="ai-rainbow-button__tint" aria-hidden="true" />
      <span className="ai-rainbow-button__content">{children}</span>
    </button>
  );
}
