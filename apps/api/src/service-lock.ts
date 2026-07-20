import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SERVICE_LOCK_FILE = "service.lock";
const SERVICE_LOCK_DATABASE = "service-lock.sqlite";

export interface ServiceLock {
  release(): Promise<void>;
}

interface ServiceLockState {
  instanceId: string;
  pid: number;
  runtimeVersion: string;
}

export async function acquireServiceLock(
  dataRoot: string,
  state: ServiceLockState,
): Promise<ServiceLock> {
  await mkdir(dataRoot, { recursive: true });
  const database = new DatabaseSync(join(dataRoot, SERVICE_LOCK_DATABASE));
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (error) {
    database.close();
    throw new Error("Collector data is already in use by another service. Close the existing Collector service before starting another one.", { cause: error });
  }

  const path = join(dataRoot, SERVICE_LOCK_FILE);
  try {
    await writeFile(path, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        database.exec("COMMIT");
      } finally {
        database.close();
      }
      const current = await readServiceLock(path);
      if (current?.instanceId === state.instanceId && current.pid === state.pid) {
        await rm(path, { force: true });
      }
    },
  };
}

async function readServiceLock(path: string): Promise<ServiceLockState | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<ServiceLockState>;
    if (
      typeof value.instanceId !== "string"
      || !Number.isSafeInteger(value.pid)
      || (value.pid ?? 0) <= 0
      || typeof value.runtimeVersion !== "string"
    ) return undefined;
    return value as ServiceLockState;
  } catch {
    return undefined;
  }
}

export function isServiceLockHeld(dataRoot: string): boolean {
  const database = new DatabaseSync(join(dataRoot, SERVICE_LOCK_DATABASE));
  database.exec("PRAGMA busy_timeout = 0;");
  try {
    database.exec("BEGIN EXCLUSIVE;");
    database.exec("ROLLBACK;");
    return false;
  } catch {
    return true;
  } finally {
    database.close();
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
