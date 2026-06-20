const fs = require('fs');
const path = 'apps/desktop-capture/src/main.ts';
let content = fs.readFileSync(path, 'utf8');

// 查找并替换 loadDeepSeekKey 函数
const startMarker = 'async function loadDeepSeekKey(): Promise<string | undefined> {';
const endMarker = '}\nasync function saveDeepSeekKey';

const startIndex = content.indexOf(startMarker);
if (startIndex === -1) {
  console.error('Could not find loadDeepSeekKey function');
  process.exit(1);
}

const endIndex = content.indexOf(endMarker, startIndex);
if (endIndex === -1) {
  console.error('Could not find end of loadDeepSeekKey function');
  process.exit(1);
}

const newFunction = \sync function loadDeepSeekKey(): Promise<string | undefined> {
  const path = join(app.getPath("userData"), "deepseek-key.bin");
  try {
    const fileData = await readFile(path);
    const isEncryptionAvailable = safeStorage.isEncryptionAvailable();
    
    // Detect file format: encrypted files are binary, plaintext is UTF-8 text
    let isEncryptedFile = false;
    try {
      const textContent = fileData.toString('utf8');
      // If it looks like an API key (starts with sk- or reasonable length), it's plaintext
      if (textContent.startsWith('sk-') || (textContent.length > 10 && textContent.length < 200 && /^[a-zA-Z0-9._-]+$/s.test(textContent))) {
        isEncryptedFile = false;
      } else {
        isEncryptedFile = true;
      }
    } catch {
      // Cannot convert to UTF-8, must be encrypted binary
      isEncryptedFile = true;
    }
    
    console.log('[Main] loadDeepSeekKey: encryption available:', isEncryptionAvailable, 'file appears encrypted:', isEncryptedFile);
    
    // Case 1: File is encrypted and safeStorage is available - normal decryption
    if (isEncryptedFile && isEncryptionAvailable) {
      const decrypted = safeStorage.decryptString(fileData);
      console.log('[Main] Successfully decrypted key, length:', decrypted.length);
      return decrypted;
    }
    
    // Case 2: File is plaintext and safeStorage is unavailable - read directly
    if (!isEncryptedFile && !isEncryptionAvailable) {
      console.warn('[Main] Reading plaintext key (safeStorage unavailable)');
      return fileData.toString('utf8');
    }
    
    // Case 3: File is encrypted but safeStorage is unavailable - cannot load
    if (isEncryptedFile && !isEncryptionAvailable) {
      console.error('[Main] CRITICAL: Encrypted file found but safeStorage unavailable!');
      console.error('[Main] Please re-enter your API key to save it in plaintext mode.');
      return undefined;
    }
    
    // Case 4: File is plaintext but safeStorage is available - migrate to encrypted
    if (!isEncryptedFile && isEncryptionAvailable) {
      console.log('[Main] Migrating plaintext key to encrypted format');
      const plaintext = fileData.toString('utf8');
      await writeFile(path, safeStorage.encryptString(plaintext));
      console.log('[Main] Migration complete');
      return plaintext;
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.log('[Main] deepseek-key.bin not found');
      return undefined;
    }
    console.error('[Main] Failed to load DeepSeek key:', err.message);
    return undefined;
  }
}
\;

content = content.substring(0, startIndex) + newFunction + content.substring(endIndex + 1);
fs.writeFileSync(path, content, 'utf8');
console.log('loadDeepSeekKey function updated successfully');
