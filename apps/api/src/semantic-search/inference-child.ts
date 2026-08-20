import { env, pipeline } from "@huggingface/transformers";
import { validateSemanticInferenceRequest, type SemanticInferenceRequest } from "./inference-adapter.js";

type FeatureExtractionPipeline = {
  (texts: string[], options: { pooling: "cls"; normalize: true; padding: true; truncation: true }): Promise<{ tolist(): number[][] }>;
};

type PairClassifierPipeline = {
  tokenizer(text: string, options: { text_pair: string; padding: true; truncation: true }): Promise<Record<string, unknown>>;
  model(input: Record<string, unknown>): Promise<{ logits: { data: ArrayLike<number> } }>;
};

process.once("message", async (value: unknown) => {
  try {
    validateSemanticInferenceRequest(value);
    configureLocalModels(value.modelRoot);
    const result = value.operation === "embed" ? await embed(value) : await rerank(value);
    process.send?.({ ok: true, value: result });
  } catch (error) {
    process.send?.({ ok: false, errorCode: stableErrorCode(error) });
  } finally {
    process.disconnect?.();
    setImmediate(() => process.exit(0));
  }
});

function configureLocalModels(modelRoot: string): void {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  env.localModelPath = modelRoot;
}

async function embed(request: Extract<SemanticInferenceRequest, { operation: "embed" }>): Promise<number[][]> {
  const modelId = request.profile === "standard" ? "Xenova/bge-m3" : "Xenova/bge-small-zh-v1.5";
  const dtype = request.profile === "standard" ? "q8" : "fp32";
  const extractor = await pipeline("feature-extraction", modelId, { dtype }) as unknown as FeatureExtractionPipeline;
  const output = await extractor(request.texts, { pooling: "cls", normalize: true, padding: true, truncation: true });
  return output.tolist();
}

async function rerank(request: Extract<SemanticInferenceRequest, { operation: "rerank" }>): Promise<number[]> {
  // The public text-classification helper applies softmax to a single logit, which is always 1.
  // BGE reranking therefore sends query/document pairs through the tokenizer and uses sigmoid(logit).
  const classifier = await pipeline("text-classification", "onnx-community/bge-reranker-v2-m3-ONNX", { dtype: "q8" }) as unknown as PairClassifierPipeline;
  const scores: number[] = [];
  for (const passage of request.passages) {
    const input = await classifier.tokenizer(request.query, { text_pair: passage, padding: true, truncation: true });
    const output = await classifier.model(input);
    const logit = Number(output.logits.data[0]);
    if (!Number.isFinite(logit)) throw new Error("invalid-logit");
    scores.push(1 / (1 + Math.exp(-logit)));
  }
  return scores;
}

function stableErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "unknown";
  if (message.includes("no such file") || message.includes("not found")) return "model-files-missing";
  if (message.includes("out of memory") || message.includes("allocation")) return "resource-insufficient";
  if (message.includes("invalid-logit")) return "invalid-model-output";
  return "inference-failed";
}
