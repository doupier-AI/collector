import type { CaptureService } from "./service.js";

export interface WorkflowSchedulerOptions {
  /** 近期整理工作流轮询间隔（毫秒），默认 5000ms */
  recentIntervalMs?: number;
  /** 专题文档工作流轮询间隔（毫秒），默认 5000ms */
  docIntervalMs?: number;
  /** 回收站清理间隔（毫秒），默认 24 小时 */
  trashCleanupIntervalMs?: number;
  /** 回收站保留天数，默认 30 天 */
  trashRetentionDays?: number;
}

/**
 * 工作流调度器守护进程
 * 
 * 定期轮询并执行处于 queued 状态的 WorkflowRun，确保工作流自动推进。
 * 支持优雅关闭，不影响现有测试环境配置。
 */
export class WorkflowScheduler {
  private recentIntervalId: NodeJS.Timeout | null = null;
  private docIntervalId: NodeJS.Timeout | null = null;
  private trashCleanupIntervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly service: CaptureService,
    private readonly options: WorkflowSchedulerOptions = {}
  ) {}

  /**
   * 启动调度器
   * 
   * 创建两个独立的定时器：
   * - 每 N 秒执行一次近期整理工作流
   * - 每 M 秒执行一次专题文档工作流
   */
  start(): void {
    if (this.isRunning) {
      console.log("[WorkflowScheduler] Already running, skipping start");
      return;
    }

    this.isRunning = true;
    const recentIntervalMs = this.options.recentIntervalMs ?? 5000;
    const docIntervalMs = this.options.docIntervalMs ?? 5000;
    const trashCleanupIntervalMs = this.options.trashCleanupIntervalMs ?? (24 * 60 * 60 * 1000); // 24 hours
    const trashRetentionDays = this.options.trashRetentionDays ?? 30;

    console.log(`[WorkflowScheduler] Starting with intervals: recent=${recentIntervalMs}ms, doc=${docIntervalMs}ms, trashCleanup=${trashCleanupIntervalMs}ms`);

    // 立即执行一次，然后开始定时轮询
    this.pollRecentOrganization().catch((err) => {
      console.error("[WorkflowScheduler] Initial recent organization poll failed:", err);
    });
    this.pollTopicDocumentRuns().catch((err) => {
      console.error("[WorkflowScheduler] Initial topic document poll failed:", err);
    });
    this.pollTrashCleanup(trashRetentionDays).catch((err) => {
      console.error("[WorkflowScheduler] Initial trash cleanup failed:", err);
    });

    // 设置定时器
    this.recentIntervalId = setInterval(() => {
      this.pollRecentOrganization().catch((err) => {
        console.error("[WorkflowScheduler] Recent organization poll failed:", err);
      });
    }, recentIntervalMs);

    this.docIntervalId = setInterval(() => {
      this.pollTopicDocumentRuns().catch((err) => {
        console.error("[WorkflowScheduler] Topic document poll failed:", err);
      });
    }, docIntervalMs);

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
   * 清除所有定时器，确保资源释放
   */
  stop(): void {
    if (!this.isRunning) {
      console.log("[WorkflowScheduler] Not running, skipping stop");
      return;
    }

    console.log("[WorkflowScheduler] Stopping...");

    if (this.recentIntervalId) {
      clearInterval(this.recentIntervalId);
      this.recentIntervalId = null;
    }

    if (this.docIntervalId) {
      clearInterval(this.docIntervalId);
      this.docIntervalId = null;
    }

    if (this.trashCleanupIntervalId) {
      clearInterval(this.trashCleanupIntervalId);
      this.trashCleanupIntervalId = null;
    }

    this.isRunning = false;
    console.log("[WorkflowScheduler] Stopped successfully");
  }

  /**
   * 轮询并执行近期整理工作流
   * 
   * 每次最多处理 10 个步骤，避免单次轮询耗时过长
   */
  private async pollRecentOrganization(): Promise<void> {
    try {
      const completedCount = await this.service.resumeRecentOrganizationRuns(10);
      if (completedCount > 0) {
        console.log(`[WorkflowScheduler] Completed ${completedCount} recent organization step(s)`);
      }
    } catch (err) {
      // 错误不中断调度器运行，仅记录日志
      console.error("[WorkflowScheduler] Error in recent organization poll:", err);
    }
  }

  /**
   * 轮询并执行专题文档工作流
   */
  private async pollTopicDocumentRuns(): Promise<void> {
    try {
      const completedCount = await this.service.resumeTopicDocumentRuns();
      if (completedCount > 0) {
        console.log(`[WorkflowScheduler] Completed ${completedCount} topic document step(s)`);
      }
    } catch (err) {
      // 错误不中断调度器运行，仅记录日志
      console.error("[WorkflowScheduler] Error in topic document poll:", err);
    }
  }

  /**
   * 轮询并执行回收站清理
   * 
   * 每天检查一次，永久删除超过保留期的材料
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
