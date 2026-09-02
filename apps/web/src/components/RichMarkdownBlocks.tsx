import { isValidElement, useEffect, useId, useMemo, useState, type ReactNode } from "react";

const SUPPORTED_LANGUAGES = new Set([
  "javascript", "js", "typescript", "ts", "json", "python", "py", "shell", "sh", "bash",
  "sql", "css", "html", "markdown", "md", "yaml", "yml",
]);
const MERMAID_MAX_CHARACTERS = 20_000;
const MERMAID_MAX_LINES = 300;
const MERMAID_UNSAFE = /(?:<\/?[a-z]|\bclick\b|\bhref\b|javascript:|https?:\/\/|%%\s*\{\s*init|\bimage\b)/i;

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  return nodeText(node.props.children);
}

function languageFrom(node: ReactNode): string {
  if (!isValidElement<{ className?: string }>(node)) return "text";
  return node.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase() ?? "text";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ text, label = "复制代码" }: { text: string; label?: string }) {
  const [feedback, setFeedback] = useState<"idle" | "copied" | "failed">("idle");
  const accessibleLabel = feedback === "copied" ? "已复制" : feedback === "failed" ? "复制失败" : label;
  return (
    <button
      type="button"
      className="markdown-code-action"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      data-feedback={feedback}
      onClick={() => void copyText(text).then((ok) => {
        setFeedback(ok ? "copied" : "failed");
        window.setTimeout(() => setFeedback("idle"), 1_500);
      })}
    >
      <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <rect x="6" y="6" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" />
        <path d="M4.5 12.5h-1V3.5h9v1" fill="none" stroke="currentColor" />
      </svg>
    </button>
  );
}

function highlightedSource(source: string, language: string): ReactNode {
  if (!SUPPORTED_LANGUAGES.has(language)) return source;
  const pattern = /(\/\/[^\n]*|#[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|class|interface|type|import|export|from|if|else|for|while|async|await|def|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|TABLE|true|false|null|None)\b|\b\d+(?:\.\d+)?\b)/g;
  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) pieces.push(source.slice(cursor, start));
    const value = match[0];
    const kind = /^(?:\/\/|#|--|\/\*)/.test(value) ? "comment"
      : /^(?:"|'|`)/.test(value) ? "string"
        : /^\d/.test(value) ? "number" : "keyword";
    pieces.push(<span className={`syntax-token syntax-token--${kind}`} key={`${start}-${kind}`}>{value}</span>);
    cursor = start + value.length;
  }
  if (cursor < source.length) pieces.push(source.slice(cursor));
  return pieces;
}

export function MarkdownPre({ children, className, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  // The shared Markdown projection uses a semantic <pre> wrapper for malformed
  // display math. Preserve that node instead of decorating it as a fenced code
  // block so its stable source/fallback contract remains observable.
  if (className?.split(/\s+/).includes("math-source-fallback")) {
    return <pre {...props} className={className}>{children}</pre>;
  }
  const language = languageFrom(children);
  const source = nodeText(children).replace(/\n$/, "");
  if (language === "mermaid") return <MermaidBlock source={source} />;
  return (
    <div className="markdown-code-block" data-language={language || "text"}>
      <div className="markdown-code-toolbar" data-markdown-decoration="true">
        <span className="markdown-code-language">{language || "text"}</span>
        <CopyButton text={source} />
      </div>
      <pre tabIndex={0}><code className={language === "text" ? undefined : `language-${language}`}>{highlightedSource(source, language)}</code></pre>
    </div>
  );
}

function validateMermaid(source: string): string | undefined {
  if (!source.trim()) return "图表源码为空";
  if (source.length > MERMAID_MAX_CHARACTERS) return "图表源码过长";
  if (source.split("\n").length > MERMAID_MAX_LINES) return "图表复杂度超过限制";
  if (MERMAID_UNSAFE.test(source)) return "图表包含不允许的 HTML、链接、点击或外部资源指令";
  return undefined;
}

function sanitizeMermaidSvg(svg: string): string | undefined {
  const documentNode = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (documentNode.querySelector("parsererror")) return undefined;
  documentNode.querySelectorAll("script, foreignObject, a, image, style").forEach((node) => node.remove());
  for (const element of documentNode.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on") || name === "href" || name === "xlink:href" || value.includes("javascript:") || /url\s*\(\s*https?:/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  const root = documentNode.documentElement;
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", "Mermaid 图表");
  root.removeAttribute("style");
  return new XMLSerializer().serializeToString(root);
}

function MermaidBlock({ source }: { source: string }) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const validationError = useMemo(() => validateMermaid(source), [source]);
  const [svg, setSvg] = useState<string>();
  const [renderError, setRenderError] = useState<string>();
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(undefined);
    setRenderError(validationError);
    if (validationError) return () => { cancelled = true; };
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
        maxTextSize: MERMAID_MAX_CHARACTERS,
        flowchart: { htmlLabels: false, useMaxWidth: true },
      });
      const rendered = await mermaid.render(`collector-mermaid-${reactId}`, source);
      const sanitized = sanitizeMermaidSvg(rendered.svg);
      if (!sanitized) throw new Error("unsafe_svg");
      if (!cancelled) setSvg(sanitized);
    }).catch(() => {
      if (!cancelled) setRenderError("图表语法无效或渲染失败");
    });
    return () => { cancelled = true; };
  }, [reactId, source, validationError]);

  if (renderError) {
    return (
      <div className="markdown-mermaid markdown-mermaid--fallback">
        <p className="markdown-mermaid__error" data-markdown-decoration="true">{renderError}，已显示原始代码。</p>
        <MarkdownPre><code>{source}</code></MarkdownPre>
      </div>
    );
  }

  return (
    <figure className="markdown-mermaid">
      <div className="markdown-mermaid__toolbar" data-markdown-decoration="true">
        <button type="button" onClick={() => setShowSource((value) => !value)} aria-expanded={showSource}>
          {showSource ? "查看图表" : "查看源码"}
        </button>
        <CopyButton text={source} label="复制 Mermaid 源码" />
      </div>
      {showSource ? <pre tabIndex={0}><code className="language-mermaid">{source}</code></pre> : null}
      <div
        className="markdown-mermaid__diagram"
        data-markdown-decoration="true"
        aria-busy={!svg}
        // SVG is generated from locally parsed source, then stripped of active/external nodes and attributes.
        dangerouslySetInnerHTML={{ __html: svg ?? "" }}
      />
      {!showSource ? <span className="markdown-mermaid__source-truth" aria-hidden="true">{source}</span> : null}
    </figure>
  );
}

export function MarkdownTable({ children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="markdown-table-scroll" role="region" aria-label="可横向滚动的表格" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  );
}

export function MarkdownCell({ children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  const numeric = /^\s*[+-]?(?:\d[\d,.]*)(?:%|[a-zA-Z¥€£元])?\s*$/.test(nodeText(children));
  return <td {...props} className={`${props.className ?? ""}${numeric ? " markdown-table__numeric" : ""}`.trim()}>{children}</td>;
}
