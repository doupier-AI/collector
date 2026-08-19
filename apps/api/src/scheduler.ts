import type { CaptureService } from "./service.js";

export interface WorkflowSchedulerOptions {
  /** 回收站清理间隔（毫秒），默认 24 小时 */
  trashCleanupIntervalMs?: number;
  /** 回收站保留天数，默认 30 天 */
  trashRetentionDays?: number;
}

/**
 * 回收站清理调度器守护进程
 *
 * 定期执行回收站清理，永久删除超过保留期的软删除会话。
 * 支持优雅关闭，不影响现有测试环境配置。
 */
export class WorkflowScheduler {
  private trashCleanupIntervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly service: CaptureService,
    private readonly options: WorkflowSchedulerOptions = {}
  ) {}

  /**
   * 启动调度器
   *
   * 立即执行一次回收站清理，之后按间隔定时轮询。
   */
  start(): void {
    if (this.isRunning) {
      console.log("[WorkflowScheduler] Already running, skipping start");
      return;
    }

    this.isRunning = true;
    const trashCleanupIntervalMs = this.options.trashCleanupIntervalMs ?? (24 * 60 * 60 * 1000); // 24 hours
    const trashRetentionDays = this.options.trashRetentionDays ?? 30;

    console.log(`[WorkflowScheduler] Starting with intervals: trashCleanup=${trashCleanupIntervalMs}ms`);

    // 立即执行一次，然后开始定时轮询
    this.pollTrashCleanup(trashRetentionDays).catch((err) => {
      console.error("[WorkflowScheduler] Initial trash cleanup failed:", err);
    });

    this.trashCleanupIntervalId = setInterval(() => {
      this.pollTrashCleanup(trashRetentionDays).catch((err) => {
        console.error("[WorkflowScheduler] Trash cleanup failed:", err);
      });
    }, trashCleanupIntervalMs);

    console.log("[WorkflowScheduler] Started successfully");
  }

  /**
   * 停止调度器
   *
   * 清除定时器，确保资源释放
   */
  stop(): void {
    if (!this.isRunning) {
      console.log("[WorkflowScheduler] Not running, skipping stop");
      return;
    }

    console.log("[WorkflowScheduler] Stopping...");

    if (this.trashCleanupIntervalId) {
      clearInterval(this.trashCleanupIntervalId);
      this.trashCleanupIntervalId = null;
    }

    this.isRunning = false;
    console.log("[WorkflowScheduler] Stopped successfully");
  }

  /**
   * 轮询并执行回收站清理
   *
   * 每天检查一次，永久删除超过保留期的软删除会话
   */
  private async pollTrashCleanup(retentionDays: number): Promise<void> {
    try {
      const deletedCount = await this.service.cleanupTrash(retentionDays);
      if (deletedCount > 0) {
        console.log(`[WorkflowScheduler] Trash cleanup: permanently deleted ${deletedCount} items older than ${retentionDays} days`);
      }
    } catch (err) {
      console.error("[WorkflowScheduler] Error in trash cleanup:", err);
    }
  }
}
