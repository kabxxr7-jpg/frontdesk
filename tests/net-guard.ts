import { setImmediate as nextTurn } from "node:timers/promises";

/** How many TCP servers this process is listening on right now. */
export function listeningServerCount(): number {
  return process.getActiveResourcesInfo().filter((name) => name === "TCPServerWrap").length;
}

/**
 * A server that has just been closed stays in the list for a moment: its handle is released one or two turns of the
 * event loop after the "close" callback. This waits up to `turns` turns and returns what is still listening.
 */
export async function serversStillListening(turns = 6): Promise<number> {
  let count = listeningServerCount();
  for (let i = 0; i < turns && count > 0; i += 1) {
    await nextTurn();
    count = listeningServerCount();
  }
  return count;
}
