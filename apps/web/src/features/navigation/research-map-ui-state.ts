/** 当前挂载的研究图谱界面状态；不写入 URL、History State 或任何持久化介质。 */
export interface MapSearchScene {
  query: string;
  selectedNodeId?: string;
}

export type MapAssociationCandidateScene = { kind: "all" } | { kind: "node"; nodeId: string };
