import { expect, test } from "@playwright/test";
import { fetchFixtureRoute } from "./helpers";

test("fixture route forwarding retries one transient connection reset", async () => {
  let attempts = 0;
  const expected = { status: 200 };
  const actual = await fetchFixtureRoute({
    async fetch() {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      }
      return expected;
    },
  });

  expect(actual).toBe(expected);
  expect(attempts).toBe(2);
});

test("fixture route forwarding does not retry a permanent failure", async () => {
  let attempts = 0;
  const failure = Object.assign(new Error("invalid fixture response"), { code: "EINVAL" });

  await expect(fetchFixtureRoute({
    async fetch() {
      attempts += 1;
      throw failure;
    },
  })).rejects.toBe(failure);
  expect(attempts).toBe(1);
});

test("fixture route forwarding surfaces a second transient failure", async () => {
  let attempts = 0;
  const failure = new Error("route.fetch: read ECONNRESET");

  await expect(fetchFixtureRoute({
    async fetch() {
      attempts += 1;
      throw failure;
    },
  })).rejects.toBe(failure);
  expect(attempts).toBe(2);
});
