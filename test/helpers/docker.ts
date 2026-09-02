import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let cached: boolean | null = null;

export async function isDockerAvailable(): Promise<boolean> {
  if (cached !== null) return cached;
  try {
    await execFileAsync("docker", ["info"]);
    cached = true;
  } catch {
    cached = false;
  }
  return cached;
}
