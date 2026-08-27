import { execFileSync, spawnSync } from "node:child_process";

// Keep this guard itself neutral: derive the prohibited external-product term
// from ASCII bytes instead of writing that term into the public repository.
const prohibited = String.fromCharCode(103, 114, 111, 107);
const workingTreeScan = spawnSync("git", ["grep", "-I", "-n", "-i", "-e", prohibited, "--", "."], {
  encoding: "utf8",
});
if (workingTreeScan.status === 0) {
  process.stderr.write("Public language guard found a prohibited external-product term in the current tree.\n");
  process.exit(1);
}
if (workingTreeScan.status !== 1) {
  process.stderr.write("Public language guard could not inspect the current tree.\n");
  process.exit(1);
}

const commits = execFileSync("git", ["rev-list", "--all"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

for (const commit of commits) {
  const scan = spawnSync("git", ["grep", "-I", "-n", "-i", "-e", prohibited, commit, "--", "."], {
    encoding: "utf8",
  });
  if (scan.status === 0) {
    process.stderr.write("Public language guard found a prohibited external-product term in reachable history.\n");
    process.exit(1);
  }
  if (scan.status !== 1) {
    process.stderr.write("Public language guard could not inspect repository history.\n");
    process.exit(1);
  }
}

const subjects = execFileSync("git", ["log", "--all", "--format=%s"], { encoding: "utf8" });
if (subjects.toLowerCase().includes(prohibited)) {
  process.stderr.write("Public language guard found a prohibited external-product term in commit metadata.\n");
  process.exit(1);
}

process.stdout.write(`Public language guard passed across ${commits.length} reachable commit(s).\n`);
