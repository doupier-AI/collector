/**
 * AI 配置功能诊断脚本
 */

import { app, safeStorage } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function diagnose() {
  console.log('=== Collector AI 配置诊断报告 ===\n');
  
  // 1. 检查 safeStorage 状态
  console.log('1. safeStorage 状态检查:');
  const isEncryptionAvailable = safeStorage.isEncryptionAvailable();
  console.log('   - 加密是否可用:', isEncryptionAvailable);
  
  if (!isEncryptionAvailable) {
    console.log('   ❌ 致命错误: safeStorage 不可用！');
    return;
  }
  
  // 2. 测试加密/解密功能
  console.log('\n2. 加密/解密功能测试:');
  try {
    const testString = 'test-api-key-12345';
    const encrypted = safeStorage.encryptString(testString);
    console.log('   - 加密成功:', encrypted.length, 'bytes');
    
    const decrypted = safeStorage.decryptString(encrypted);
    console.log('   - 解密成功:', decrypted === testString ? '✓' : '✗');
  } catch (error) {
    console.log('   ❌ 加密/解密失败:', error.message);
    return;
  }
  
  // 3. 检查 deepseek-key.bin 文件
  console.log('\n3. DeepSeek API Key 文件检查:');
  const userDataPath = app.getPath('userData');
  const keyFilePath = join(userDataPath, 'deepseek-key.bin');
  try {
    const keyData = await readFile(keyFilePath);
    console.log('   - 文件存在: ✓');
    console.log('   - 文件大小:', keyData.length, 'bytes');
    
    try {
      const decryptedKey = safeStorage.decryptString(keyData);
      console.log('   - 解密成功: ✓');
      console.log('   - Key 长度:', decryptedKey.length, '字符');
    } catch (decryptError) {
      console.log('   ❌ 解密失败:', decryptError.message);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('   - 文件不存在');
    } else {
      console.log('   ❌ 读取失败:', error.message);
    }
  }
  
  console.log('\n=== 诊断完成 ===');
}

app.whenReady().then(() => {
  diagnose().finally(() => {
    setTimeout(() => app.quit(), 1000);
  });
}).catch(error => {
  console.error('诊断失败:', error);
  app.exit(1);
});
