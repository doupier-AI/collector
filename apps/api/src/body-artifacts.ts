import {
  deriveBodyVersion,
  deriveFragmentsFromBlocks,
  deriveFragmentsFromSlices,
  resolveFragmentExcerpt,
  type ResearchBodyVersionRecord,
  type ResearchCitationRecord,
  type ResearchSemanticFragmentRecord,
  type ResearchSliceRecord,
} from "@collector/capture-contracts";

/**
 * #39：正文版本与语义片段的确定性获取助手。
 *
 * 生成回填、惰性派生、研究上下文组装与融合相似性扫描共享同一套"先查库、缺失则
 * 按正文确定性派生"的逻辑：同一消息与同一正文无论经哪条路径都得到同一版本与
 * 片段标识（ID 由内容与序号决定，幂等），保证引用在各消费方之间一致。
 * 缺失路径只在内存派生，不写库；持久化仍由生成收尾与惰性/启动回填负责。
 */

export interface MessageBodyArtifactsInput {
  nodeId: string;
  message: { id: string; content: string; createdAt?: string };
  slices?: readonly ResearchSliceRecord[];
  citations?: readonly ResearchCitationRecord[];
}

export interface MessageBodyArtifacts {
  version: ResearchBodyVersionRecord;
  fragments: ResearchSemanticFragmentRecord[];
  /** 版本是否来自持久化（false 表示本次调用在内存确定性派生）。 */
  persisted: boolean;
}

/**
 * 纯函数派生：按"有正式切片→正式片段，否则按块临时片段"的规则产出正文版本与片段。
 * 与持久化路径使用同一契约函数，因此 ID 与范围逐次一致。
 */
export function deriveMessageBodyArtifacts(input: MessageBodyArtifactsInput): {
  version: ResearchBodyVersionRecord;
  fragments: ResearchSemanticFragmentRecord[];
} {
  const version = deriveBodyVersion({
    messageId: input.message.id,
    nodeId: input.nodeId,
    content: input.message.content,
    origin: "backfill",
    createdAt: input.message.createdAt ?? new Date(0).toISOString(),
  });
  const slices = input.slices ?? [];
  const hasFormal = slices.length > 0 && slices.every((slice) => !slice.isProvisional);
  const citations = [...(input.citations ?? [])];
  const fragments = hasFormal
    ? deriveFragmentsFromSlices(version, [...slices], citations)
    : deriveFragmentsFromBlocks(version, citations);
  return { version, fragments };
}

export interface BodyArtifactsStoreLookup {
  getBodyVersionForMessage(messageId: string): ResearchBodyVersionRecord | undefined;
  listFragmentsByBodyVersion(bodyVersionId: string): ResearchSemanticFragmentRecord[];
}

/**
 * 先查持久化版本与片段；缺失时在内存确定性派生（不写库）。
 * 已持久化但片段为空的版本同样走内存重派生，保持读取方永远拿到可用引用。
 */
export function getOrDeriveMessageBodyArtifacts(
  store: BodyArtifactsStoreLookup,
  input: MessageBodyArtifactsInput,
): MessageBodyArtifacts {
  const persistedVersion = store.getBodyVersionForMessage(input.message.id);
  if (persistedVersion) {
    const persistedFragments = store.listFragmentsByBodyVersion(persistedVersion.id);
    if (persistedFragments.length > 0) {
      return { version: persistedVersion, fragments: persistedFragments, persisted: true };
    }
    const derived = deriveMessageBodyArtifacts(input);
    return { version: persistedVersion, fragments: derived.fragments, persisted: true };
  }
  const derived = deriveMessageBodyArtifacts(input);
  return { ...derived, persisted: false };
}

/**
 * 为一个片段找到对应切片：#43 收缩后切片不再携带正文副本，片段↔切片一律按
 * 消息内数组下标（片段 ordinal）序数对齐——切片与片段同源于正文的确定性派生，
 * 序数对齐即同源对齐，不再做正文内容相等回退（内容相等匹配正是"两套事实来源"的载体）。
 * 返回 undefined 表示该下标无切片（临时片段可能没有对应切片）。
 */
export function matchSliceForFragment(
  fragment: ResearchSemanticFragmentRecord,
  messageSlices: readonly ResearchSliceRecord[],
): ResearchSliceRecord | undefined {
  return messageSlices[fragment.ordinal];
}

/** 安全解析片段摘录：任何一致性错误返回 undefined，绝不静默关联到其他文本。 */
export function tryResolveFragmentExcerpt(
  version: ResearchBodyVersionRecord,
  fragment: ResearchSemanticFragmentRecord,
): string | undefined {
  try {
    return resolveFragmentExcerpt(version, fragment);
  } catch {
    return undefined;
  }
}
