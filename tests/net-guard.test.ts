import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { listeningServerCount, serversStillListening } from "./net-guard.ts";

const open = (s: Server): Promise<void> => new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
const shut = (s: Server): Promise<void> => new Promise((resolve) => s.close(() => resolve()));

// The guard in tests/setup-no-leaked-servers.ts is only as good as its count, so the count is tested here.
describe("the check for servers that were left open", () => {
  it("counts a listening server, still sees it right after close() was called, and sees it gone a moment later", async () => {
    const before = listeningServerCount();
    const s = createServer();
    await open(s);
    expect(listeningServerCount()).toBe(before + 1);
    await shut(s);
    expect(await serversStillListening()).toBe(before);
  });

  it("reports a server that is never closed, and counts two of them as two", async () => {
    const before = listeningServerCount();
    const a = createServer();
    const b = createServer();
    try {
      await open(a);
      await open(b);
      expect(await serversStillListening(2)).toBe(before + 2);
    } finally {
      await shut(a);
      await shut(b);
    }
    expect(await serversStillListening()).toBe(before);
  });

  it("does not count a server that never started listening", async () => {
    const before = listeningServerCount();
    const s = createServer();
    expect(listeningServerCount()).toBe(before);
    s.close();
  });
});
