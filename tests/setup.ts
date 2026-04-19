/**
 * Global test setup: resolve `bash` for Node's spawn on Windows.
 *
 * On Linux/macOS, /bin/bash and /usr/bin/bash are canonical and
 * resolveBashPath() in src/exec/run.ts picks them up at module load. On
 * Windows, Node's spawn does not understand MSYS paths like /usr/bin/bash —
 * it needs a native Windows path (Git for Windows installs at one of two
 * canonical locations). We probe for those and set A2E_BASH_PATH so the
 * production resolver takes the env override.
 *
 * If bash can't be found, the test keeps running but any test that needs
 * subprocess exec will fail with spawn ENOENT. Those tests are already
 * guarded by `process.env.A2E_BASH_PATH` presence in their describe blocks.
 */

import * as fs from "node:fs";

if (process.platform === "win32" && !process.env.A2E_BASH_PATH) {
  const candidates = [
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/bash.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
    "C:/msys64/usr/bin/bash.exe",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      process.env.A2E_BASH_PATH = p;
      break;
    }
  }
}
