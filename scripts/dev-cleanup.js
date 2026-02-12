/**
 * Pre-dev cleanup: kill stale Next.js processes and remove the Turbopack
 * lockfile so `next dev` can start cleanly.
 *
 * On Windows, Turbopack's lockfile gets restrictive ACLs that survive
 * process death. We must kill the owning process first, then remove it.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const lockPath = path.join(__dirname, "..", ".next", "dev", "lock");

// 1. Kill whatever is on port 3000
try {
  execSync("npx kill-port 3000", { stdio: "ignore" });
} catch {
  // nothing on port 3000 — that's fine
}

// 2. On Windows, also kill orphaned next-dev server processes that may
//    hold the Turbopack lockfile on a different port.
if (process.platform === "win32") {
  try {
    const out = execSync(
      'wmic process where "CommandLine like \'%next%dist%start-server%\'" get ProcessId /format:list',
      { encoding: "utf8" }
    );
    const pids = [...out.matchAll(/ProcessId=(\d+)/g)].map((m) => m[1]);
    for (const pid of pids) {
      try {
        execSync(`taskkill /f /pid ${pid}`, { stdio: "ignore" });
      } catch { /* already gone */ }
    }
  } catch { /* wmic not available or no matches */ }
}

// 3. Brief pause to let Windows release file handles
if (process.platform === "win32") {
  execSync("ping -n 2 127.0.0.1 >nul 2>&1", { stdio: "ignore" });
}

// 4. Remove the lockfile / dev dir
try {
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
  }
} catch {
  // If unlink fails, try removing the whole dev dir
  try {
    fs.rmSync(path.join(__dirname, "..", ".next", "dev"), { recursive: true, force: true });
  } catch {
    // Last resort on Windows: use cmd to force-remove
    if (process.platform === "win32") {
      try {
        execSync(`cmd /c "rd /s /q "${path.join(__dirname, "..", ".next", "dev")}"`, { stdio: "ignore" });
      } catch { /* give up — next dev will report the error */ }
    }
  }
}
