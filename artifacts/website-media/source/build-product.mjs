import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here=dirname(fileURLToPath(import.meta.url));
const repo=resolve(here,"../../..");
const req=createRequire(resolve(repo,"apps/desktop/package.json"));
const {build}=await import(pathToFileURL(req.resolve("vite")).href);
const {default:react}=await import(pathToFileURL(req.resolve("@vitejs/plugin-react")).href);
const {default:tailwind}=await import(pathToFileURL(req.resolve("@tailwindcss/vite")).href);
await build({
  root:resolve(here,"product"),base:"./",configFile:false,plugins:[react(),tailwind()],
  worker:{format:"es"},
  resolve:{alias:{"react":resolve(repo,"apps/desktop/node_modules/react"),"react-dom":resolve(repo,"apps/desktop/node_modules/react-dom"),"@renderer":resolve(repo,"apps/desktop/src/renderer/src"),"@shared":resolve(repo,"apps/desktop/src/shared"),"@main":resolve(repo,"apps/desktop/src/main")}},
  build:{outDir:resolve(here,"../product-renderer"),emptyOutDir:true,target:"esnext",minify:true,chunkSizeWarningLimit:7000}
});

