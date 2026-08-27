import { DurableJournal, JournalLockError } from "../../src/storage/durableJournal";

const path = process.argv[2];
const mode = process.argv[3];
if (!path || !mode) throw new Error("journal path and mode are required");

try {
  const journal = await DurableJournal.open(path);
  if (mode === "attempt") {
    process.stdout.write("OPENED\n");
    await journal.close();
    process.exitCode = 2;
  } else {
    process.stdout.write("READY\n");
    await new Promise<void>(() => {
      setInterval(() => undefined, 1_000);
    });
  }
} catch (error) {
  if (error instanceof JournalLockError) {
    process.stdout.write("LOCKED\n");
  } else {
    throw error;
  }
}
