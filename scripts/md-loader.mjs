// Node loader so tsx scripts can import the bundled .md docs the way wrangler's Text rule does.
import { register } from "node:module";
register(new URL("./md-loader-hooks.mjs", import.meta.url));
