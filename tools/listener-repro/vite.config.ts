import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Empacota só a página da reprodução mínima (firebase do node_modules do projeto). Saída fora do build da aplicação.
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({ root, logLevel: "warn", build: { outDir: `${root}dist`, emptyOutDir: true, sourcemap: false } });
