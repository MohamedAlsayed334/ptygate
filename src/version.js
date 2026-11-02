import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

// Single source of truth for the app version: package.json.
export const NAME = "ptygate";
export const VERSION = pkg.version;
export const PROTOCOL = 1;
