import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  SemanticSearchCommand,
  SemanticSearchInstallationState,
  SemanticSearchProfile,
  SemanticSearchProfileInstallationView,
  SemanticSearchRuntimeState,
  SemanticSearchStatusView,
} from "@collector/capture-contracts";
import { useServices } from "../../app/services";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: SemanticSearchStatusView };

interface ProfileDefinition {
  profile: SemanticSearchProfile;
  name: string;
  description: string;
  download: string;
  disk: string;
  memory: string;
}

const PROFILES: ProfileDefinition[] = [
  {
    profile: "standard",
    name: "标准档",
    description: "BGE-M3 + 重排模型。更适合多语言、长内容和需要更细致排序的搜索。",
    download: "下载约 1.18 GB",
    disk: "安装时需要约 2.4 GB 临时磁盘空间",
    memory: "单次推理阶段实测峰值约 1.35 GB 内存",
  },
  {
    profile: "lightweight",
    name: "轻量档",
    description: "bge-small-zh-v1.5。占用更少，适合配置较低的电脑；不包含重排步骤。",
    download: "下载约 95 MB",
    disk: "安装时需要少量临时磁盘空间",
    memory: "单次推理实测约 266 MB 内存",
  },
];

function byteText(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`;
  return `${Math.max(0, Math.round(value / 1_000_000))} MB`;
}

function installationStateText(state: SemanticSearchInstallationState): string {
  switch (state) {
    case "not-installed": return "尚未下载";
    case "downloading": return "正在下载";
    case "installed": return "已下载";
    case "corrupt": return "文件需要重新下载";
    case "failed": return "下载未完成";
    default: return "状态未知";
  }
}

function runtimeStateText(state: SemanticSearchRuntimeState): string {
  switch (state) {
    case "model-missing": return "尚未选择可用的本地模型";
    case "model-downloading": return "正在下载本地模型";
    case "model-corrupt": return "本地模型文件需要重新下载";
    case "index-absent": return "等待建立搜索索引";
    case "index-stale": return "研究内容已变化，等待更新搜索索引";
    case "index-building": return "正在建立搜索索引";
    case "ready": return "语义搜索已准备好";
    case "resource-insufficient": return "这台电脑的可用资源暂时不足";
    case "failed": return "语义搜索暂时不可用";
  }
}

function runtimeNextStep(state: SemanticSearchRuntimeState): string | null {
  switch (state) {
    case "model-missing": return "请在下方选择一个档位并点击“下载并启用”。";
    case "model-corrupt": return "请在下方重新下载当前档位。";
    case "resource-insufficient": return "请关闭占用较大的程序后重试，或改用轻量档。";
    case "failed": return "请重试刚才的操作；若仍失败，可重新建立索引。";
    case "index-stale": return "下次搜索时会自动更新；也可以在下方立即重新建立。";
    default: return null;
  }
}

function profileInstallation(status: SemanticSearchStatusView, profile: SemanticSearchProfile): SemanticSearchProfileInstallationView {
  return status.installations.find((item) => item.profile === profile) ?? {
    profile,
    state: "not-installed",
    downloadedBytes: 0,
    totalBytes: 0,
    canCancel: false,
    canRetry: false,
  };
}

function ProfileCard({
  definition,
  installation,
  configured,
  busy,
  onCommand,
}: {
  definition: ProfileDefinition;
  installation: SemanticSearchProfileInstallationView;
  configured: boolean;
  busy: boolean;
  onCommand: (command: SemanticSearchCommand) => void;
}) {
  const progress = installation.totalBytes > 0
    ? Math.min(100, Math.round((installation.downloadedBytes / installation.totalBytes) * 100))
    : 0;
  const commandForDownload: SemanticSearchCommand = { type: "download-profile", profile: definition.profile };

  return (
    <section className="semantic-search-settings__profile" aria-label={definition.name}>
      <div className="semantic-search-settings__profile-heading">
        <div>
          <h2>{definition.name}</h2>
          <p>{definition.description}</p>
        </div>
        {configured ? <span className="semantic-search-settings__badge">当前使用</span> : null}
      </div>
      <ul className="semantic-search-settings__facts" aria-label={`${definition.name}资源说明`}>
        <li>{definition.download}</li>
        <li>{definition.disk}</li>
        <li>{definition.memory}</li>
      </ul>
      <p className="semantic-search-settings__installation" aria-live="polite">
        本地模型：{installationStateText(installation.state)}
      </p>
      {installation.errorCode === "model-source-unreachable" ? (
        <p className="settings-status settings-status--error" role="alert">
          无法连接模型下载源（hf-mirror.com / modelscope.cn / huggingface.co）。请检查网络，或在下方“下载代理”中配置代理后重试。
        </p>
      ) : null}
      {installation.state === "downloading" ? (
        <div className="semantic-search-settings__progress-wrap">
          <progress value={progress} max={100} aria-label={`${definition.name}下载进度`}>
            {progress}%
          </progress>
          <span>已下载 {byteText(installation.downloadedBytes)} / {byteText(installation.totalBytes)}（{progress}%）</span>
        </div>
      ) : null}
      <div className="settings-form__actions">
        {installation.state === "not-installed" ? (
          <button type="button" className="button button--primary" disabled={busy} onClick={() => onCommand(commandForDownload)}>
            下载并启用{definition.name}
          </button>
        ) : null}
        {installation.state === "downloading" && installation.canCancel ? (
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={() => onCommand({ type: "cancel-download", profile: definition.profile })}
          >
            取消{definition.name}下载
          </button>
        ) : null}
        {(installation.state === "failed" || installation.state === "corrupt") && installation.canRetry ? (
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={() => onCommand({ type: "retry-download", profile: definition.profile })}
          >
            重试下载{definition.name}
          </button>
        ) : null}
        {installation.state === "installed" && !configured ? (
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={() => onCommand({ type: "select-profile", profile: definition.profile })}
          >
            使用{definition.name}
          </button>
        ) : null}
        {installation.state === "installed" ? (
          <button
            type="button"
            className="button button--danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`删除${definition.name}的本地模型文件？之后需要重新下载才能使用。`)) {
                onCommand({ type: "delete-profile", profile: definition.profile });
              }
            }}
          >
            删除{definition.name}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** #67：独立管理本地检索模型；页面绝不在加载时下载或切换档位。 */
export function SemanticSearchSettingsPage() {
  const { api } = useServices();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [commandError, setCommandError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [proxyDraft, setProxyDraft] = useState("");

  const load = useCallback(async () => {
    if (!api.getSemanticSearchStatus) {
      setState({ kind: "error", message: "当前版本不支持语义搜索设置。请更新 Collector 后重试。" });
      return;
    }
    try {
      const status = await api.getSemanticSearchStatus();
      setState({ kind: "ready", status });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "读取语义搜索状态失败，请重试。" });
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const shouldPoll = state.kind === "ready" && (state.status.runtimeState === "model-downloading" || state.status.runtimeState === "index-building");
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => void load(), 1_000);
    return () => window.clearInterval(timer);
  }, [load, shouldPoll]);

  const profileCards = useMemo(
    () => state.kind === "ready" ? PROFILES.map((definition) => ({ definition, installation: profileInstallation(state.status, definition.profile) })) : [],
    [state],
  );

  const execute = useCallback(async (command: SemanticSearchCommand) => {
    if (!api.executeSemanticSearchCommand) {
      setCommandError("当前版本不支持此操作。请更新 Collector 后重试。");
      return;
    }
    setCommandError(null);
    setBusy(true);
    try {
      const next = await api.executeSemanticSearchCommand(command);
      setState({ kind: "ready", status: next });
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "操作没有完成，请检查网络或稍后重试。");
    } finally {
      setBusy(false);
    }
  }, [api]);

  if (state.kind === "loading") {
    return <main className="page" aria-label="语义搜索"><p className="settings-status">正在读取语义搜索设置…</p></main>;
  }

  if (state.kind === "error") {
    return (
      <main className="page" aria-label="语义搜索">
        <h1 className="page__title">语义搜索</h1>
        <p className="settings-status settings-status--error" role="alert">{state.message}</p>
        <button type="button" className="button button--secondary" onClick={() => void load()}>重新读取</button>
      </main>
    );
  }

  const status = state.status;

  return (
    <main className="page semantic-search-settings" aria-label="语义搜索">
      <header className="semantic-search-settings__header">
        <h1 className="page__title">语义搜索</h1>
        <p>
          全部在这台电脑上运行，不使用生成模型 API，也不会自动下载。只有你点击“下载并启用”后，才会联网下载对应的本地模型文件。
          本地检索本身免费，不会产生额外服务费用。
        未下载或索引尚未完成时，搜索会如实使用关键词匹配。
        </p>
      </header>

      <section className="semantic-search-settings__status" aria-label="当前状态" aria-live="polite">
        <h2>当前状态</h2>
        <p>{runtimeStateText(status.runtimeState)}</p>
        {runtimeNextStep(status.runtimeState) ? <p>{runtimeNextStep(status.runtimeState)}</p> : null}
        <p>当前档位：{status.configuredProfile === "standard" ? "标准档" : "轻量档"}</p>
        {status.indexProgress ? (
          <p>索引进度：{status.indexProgress.completedUnits} / {status.indexProgress.totalUnits}</p>
        ) : null}
        {status.errorCode ? <p className="settings-status settings-status--error" role="alert">出现了一个需要处理的问题（编号：{status.errorCode}）。请重试，仍未解决时可带上这个编号反馈。</p> : null}
      </section>

      <div className="semantic-search-settings__profiles">
        {profileCards.map(({ definition, installation }) => (
          <ProfileCard
            key={definition.profile}
            definition={definition}
            installation={installation}
            configured={status.configuredProfile === definition.profile}
            busy={busy}
            onCommand={(command) => void execute(command)}
          />
        ))}
      </div>

      <section className="semantic-search-settings__proxy" aria-label="下载代理">
        <h2>下载代理</h2>
        <p>仅用于下载本地模型文件，不影响聊天、搜索等其他联网功能。网络无法直连模型源时，可在这里填写本机代理地址。</p>
        <p aria-live="polite">
          当前状态：{state.status.downloadProxy?.configured
            ? `已配置（${state.status.downloadProxy.preview ?? "已隐藏"}）`
            : "未配置，直接连接模型源"}
        </p>
        <form
          className="semantic-search-settings__proxy-form"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = proxyDraft.trim();
            void execute({ type: "set-download-proxy", ...(trimmed ? { proxyUrl: trimmed } : {}) });
          }}
        >
          <label className="sr-only" htmlFor="semantic-download-proxy-input">下载代理地址</label>
          <input
            id="semantic-download-proxy-input"
            type="text"
            className="input"
            value={proxyDraft}
            placeholder="例如 http://127.0.0.1:7890"
            onChange={(event) => setProxyDraft(event.target.value)}
          />
          <button type="submit" className="button button--secondary" disabled={busy}>保存代理</button>
        </form>
        <p className="semantic-search-settings__proxy-hint">留空并点“保存代理”即可清除已配置的代理。</p>
      </section>

      <section className="semantic-search-settings__rebuild" aria-label="索引维护">
        <h2>索引维护</h2>
        <p>研究内容发生变化后会在下一次搜索时更新。若结果看起来不完整，可以手动重新建立索引。</p>
        <button type="button" className="button button--secondary" disabled={busy} onClick={() => void execute({ type: "rebuild-index" })}>
          重新建立索引
        </button>
      </section>
      {commandError ? <p className="settings-status settings-status--error" role="alert">{commandError}</p> : null}
    </main>
  );
}
