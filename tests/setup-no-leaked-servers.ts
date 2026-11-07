import { afterEach } from "vitest";
import { serversStillListening } from "./net-guard.ts";

// Loaded for every test file (see vitest.config.ts). A test that opens a server and does not close it, for example
// because an assertion threw before the close line, now fails by name instead of silently holding a port in 4600-4699
// that a later test in the same file, or another file running at the same time, trips over. The first failure names
// the test that leaked; the tests after it in the same file fail too, because the leaked server is still there.
afterEach(async () => {
  const n = await serversStillListening();
  if (n > 0) {
    throw new Error(`${n} server(s) still listening after this test. Close every server in a finally block or in afterEach, so it is closed even when an assertion fails.`);
  }
});
