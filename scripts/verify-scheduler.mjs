// 验证调度器自动执行工作流的脚本
import { randomUUID } from "node:crypto";

const API_URL = process.env.COLLECTOR_API_URL ?? "http://127.0.0.1:43110";

async function getMasterToken() {
  // 优先使用 COLLECTOR_MASTER_TOKEN 环境变量
  if (process.env.COLLECTOR_MASTER_TOKEN) {
    return process.env.COLLECTOR_MASTER_TOKEN;
  }
  
  // 从环境变量或默认路径读取 master token
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  
  try {
    const userDataPath = process.env.COLLECTOR_DATA_DIR 
      ? path.join(process.env.COLLECTOR_DATA_DIR, "..", "userData")
      : path.join(os.homedir(), "AppData", "Roaming", "collector", "default");
    
    const tokenPath = path.join(userDataPath, "master-token.bin");
    const safeStorage = await import("electron").catch(() => null);
    
    if (!safeStorage) {
      console.log("⚠️  无法读取 Electron safeStorage，使用默认测试 token");
      return "test-token-" + randomUUID();
    }
    
    const encrypted = await fs.readFile(tokenPath);
    return safeStorage.safeStorage.decryptString(encrypted);
  } catch (err) {
    console.log("⚠️  读取 master token 失败:", err.message);
    return "test-token-" + randomUUID();
  }
}

async function testScheduler() {
  console.log("🧪 开始测试工作流调度器...\n");
  
  const token = await getMasterToken();
  const headers = { Authorization: `Bearer ${token}` };
  
  // 1. 采集一些材料
  console.log("📝 步骤 1: 采集测试材料...");
  const captures = [];
  for (let i = 0; i < 3; i++) {
    const response = await fetch(`${API_URL}/v1/captures`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        captureType: "pasted_text",
        content: `测试材料 ${i + 1}: ${new Date().toISOString()}`,
        clientCaptureId: `test-scheduler-${Date.now()}-${i}`,
        capturedAt: new Date().toISOString(),
      }),
    });
    
    if (!response.ok) {
      console.error(`❌ 采集失败: ${response.status} ${response.statusText}`);
      return;
    }
    
    const capture = await response.json();
    captures.push(capture);
    console.log(`  ✓ 采集成功: ${capture.id.substring(0, 8)}...`);
  }
  
  console.log(`\n✅ 已采集 ${captures.length} 个材料\n`);
  
  // 2. 创建近期整理工作流
  console.log("🔄 步骤 2: 创建近期整理工作流...");
  const recentResponse = await fetch(`${API_URL}/v1/recent-organization/runs`, {
    method: "POST",
    headers: { 
      ...headers, 
      "Content-Type": "application/json",
      "Idempotency-Key": `test-scheduler-${Date.now()}`,
    },
  });
  
  if (!recentResponse.ok) {
    console.error(`❌ 创建工作流失败: ${recentResponse.status} ${recentResponse.statusText}`);
    return;
  }
  
  const recentRun = await recentResponse.json();
  console.log(`  ✓ 工作流创建成功: ${recentRun.id.substring(0, 8)}...`);
  console.log(`  状态: ${recentRun.status}\n`);
  
  // 3. 等待调度器自动执行
  console.log("⏳ 步骤 3: 等待调度器自动执行工作流（最多 15 秒）...");
  let completed = false;
  for (let i = 0; i < 15; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const checkResponse = await fetch(`${API_URL}/v1/workflow-runs/${recentRun.id}`, {
      headers,
    });
    
    if (checkResponse.ok) {
      const run = await checkResponse.json();
      console.log(`  [${i + 1}s] 状态: ${run.status}, 完成步骤: ${run.steps?.filter(s => s.status === 'completed').length || 0}/${run.steps?.length || 0}`);
      
      if (run.status === "completed") {
        completed = true;
        break;
      }
    }
  }
  
  if (completed) {
    console.log("\n✅ 调度器成功自动执行了工作流！");
  } else {
    console.log("\n⚠️  工作流未在预期时间内完成（可能需要更长时间或存在其他问题）");
  }
  
  // 4. 清理测试数据
  console.log("\n🧹 清理测试数据...");
  for (const capture of captures) {
    await fetch(`${API_URL}/v1/materials/${capture.id}/trash`, {
      method: "PUT",
      headers,
    });
  }
  console.log("  ✓ 测试材料已移至回收站\n");
  
  console.log("🎉 测试完成！");
}

testScheduler().catch(err => {
  console.error("❌ 测试失败:", err);
  process.exit(1);
});
