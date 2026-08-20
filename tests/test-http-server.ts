import type { Server } from "node:http";

// WHATWG Fetch blocks these ports even on loopback. Windows in this workspace allocates
// ephemeral ports from 2000 upward, so listen(0) can otherwise create a healthy server
// that every fetch-based test is forbidden to contact.
const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

export function isFetchSafePort(port: number): boolean {
  return Number.isSafeInteger(port) && port > 0 && port <= 65_535 && !FETCH_FORBIDDEN_PORTS.has(port);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

/** Bind an ephemeral loopback port that can actually be reached by the standard Fetch API. */
export async function listenOnFetchSafePort(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP server did not bind");
    if (isFetchSafePort(address.port)) return address.port;
    await closeServer(server);
  }
  throw new Error("Could not allocate a Fetch-safe loopback port after 20 attempts");
}
