// Builds the review scripts that run on the reviewed site (outside Next.js):
//   public/review-assets/openmarkup.js   the one script a site adds (see /setup.md)
//   public/review-assets/widget.js       the comment layer, loaded by openmarkup.js
//   public/review-assets/snap.js         screen-drawing code, loaded only when someone comments
// Runs automatically before next build (npm run build). Run by hand with: npm run build:review
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("public/review-assets", { recursive: true });
const opts = { bundle: true, format: "iife", minify: true, logLevel: "info" };
await build({ ...opts, entryPoints: ["src/review/frame/embed.ts"], outfile: "public/review-assets/openmarkup.js" });
await build({ ...opts, entryPoints: ["src/review/frame/widget.ts"], outfile: "public/review-assets/widget.js" });
await build({ ...opts, entryPoints: ["src/review/frame/snap.ts"], outfile: "public/review-assets/snap.js" });
