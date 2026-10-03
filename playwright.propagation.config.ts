import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// Propagação entre sessões pelo listener: suíte À PARTE (npm run test:e2e:propagation), timeout padrão do Playwright,
// sem folga. Resultado registrado separadamente do comportamento da interface (tests/e2e/wallet.spec.ts).
export default defineConfig({ ...base, testIgnore: undefined, testMatch: "**/*.propagation.spec.ts" });
