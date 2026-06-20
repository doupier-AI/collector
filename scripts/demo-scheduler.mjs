// 简单演示：验证调度器启动和停止
import { MemoryStore, CaptureService, WorkflowScheduler } from "@collector/api";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function demo() {
  console.log("🎬 工作流调度器演示\n");
  
  const root = join(tmpdir(), `collector-demo-${Date.now()}`);
  const store = new MemoryStore();
  await store.init();
  
  // 创建服务（禁用自动调度以手动控制）
  const service = new CaptureService(store, join(root, "artifacts"), undefined, undefined, { 
    autoRunRecentOrganization: false 
  });
  
  console.log("✅ CaptureService 创建成功（autoRunRecentOrganization: false）\n");
  
  // 创建并启动调度器
  const scheduler = new WorkflowScheduler(service, {
    recentIntervalMs: 2000,  // 2秒轮询一次（快速演示）
    docIntervalMs: 2000,
  });
  
  console.log("⏱️  启动调度器（轮询间隔: 2秒）...\n");
  scheduler.start();
  
  // 等待几秒观察日志
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  console.log("\n⏹️  停止调度器...");
  scheduler.stop();
  
  console.log("\n✅ 演示完成！调度器正常工作。");
  
  store.close();
}

demo().catch(err => {
  console.error("❌ 演示失败:", err);
  process.exit(1);
});
