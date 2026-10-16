// One-time postinstall: approve the scriptc native binary install and
// rebuild it against the local Node toolchain. scriptc is the only
// package with native bindings, so this stays a single-purpose script.
import { execSync } from "node:child_process";

const step = (cmd) => {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

step("npm install --no-fund --no-audit");
step("npm rebuild scriptc");