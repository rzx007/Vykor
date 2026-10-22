import { randomUUID } from "node:crypto";
import {
  rename as renameFile,
  rm as removeFile,
  writeFile,
} from "node:fs/promises";

export interface AtomicJsonWriteOperations {
  writeFile(path: string, content: string, encoding: "utf8"): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  rm(path: string, options: { force: boolean }): Promise<unknown>;
}

const nodeFileOperations: AtomicJsonWriteOperations = {
  writeFile,
  rename: renameFile,
  rm: removeFile,
};

export async function writeJsonFileAtomically(
  targetPath: string,
  value: unknown,
  operations: AtomicJsonWriteOperations = nodeFileOperations,
): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await operations.writeFile(
      temporaryPath,
      JSON.stringify(value, null, 2),
      "utf8",
    );
    await operations.rename(temporaryPath, targetPath);
  } catch (error) {
    await operations.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
