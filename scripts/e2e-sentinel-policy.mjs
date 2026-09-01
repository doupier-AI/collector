export function classifySentinelRun(firstExitCode, rerunExitCode) {
  if (firstExitCode === 0) {
    return { classification: "stable", exitCode: 0 };
  }
  return {
    classification: rerunExitCode === 0 ? "flaky" : "persistent",
    // 首次失败是门禁事实；重跑只分类，永远不能把它改写成绿色。
    exitCode: firstExitCode ?? 1,
  };
}
