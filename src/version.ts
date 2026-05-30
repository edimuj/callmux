import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/** Package version, read once from package.json at module load. */
export const VERSION: string = pkg.version;
