import { rm } from "node:fs/promises";

for (const path of ["dist-tests", ".collector-data"]) {
  await rm(new URL(`../${path}`, import.meta.url), { recursive: true, force: true });
}
