import { spawn } from "node:child_process";

export function runCommand(command, { cwd, env = {}, timeoutMs = 600_000 } = {}) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new TypeError("Command must be a non-empty array of argument strings");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error(`Command timed out after ${timeoutMs}ms`);
      error.code = "COMMAND_TIMEOUT";
      reject(error);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      else {
        const error = new Error(`Command failed (${code ?? signal}): ${Buffer.concat(stderr).toString("utf8").slice(-2_000)}`);
        error.code = "COMMAND_FAILED";
        reject(error);
      }
    });
  });
}
