// Experimento dirigido no CI (GitHub Actions) do atraso de listener: UMA rodada por execução, contra a homologação
// (cantina-escolar-hml), reaproveitando a página mínima de `main.ts` (mesmo Web SDK do projeto, sem código da aplicação) e o
// formato de medição de `run.ts`. Escreve APÓS `DIAG_WRITE_AFTER_MS` contados da INSCRIÇÃO do listener (e não do 1º snapshot).
//
// Autorização restrita: conta fictícia PRÓPRIA do diagnóstico, sem perfil em `users/` (não acessa nada do app) e sem Rules
// ampliadas — ela só lê o próprio `foundationProbes/{uid}` (regra existente); a escrita é pelo Admin SDK nesse mesmo
// documento (campo `n`), apagado ao fim da rodada. Nenhuma carteira, pagamento ou crédito é tocado. Credenciais vêm só de
// variáveis de ambiente (secrets do GitHub); nada delas é impresso nem gravado: os resultados contêm tempos, nomes de
// parâmetros e IPs públicos do Google.
//
// Variáveis: DIAG_PROJECT_ID (deve ser cantina-escolar-hml), DIAG_API_KEY, DIAG_APP_ID, DIAG_EMAIL, DIAG_PASSWORD,
// DIAG_SA_B64 (conta de serviço, base64), DIAG_WRITE_AFTER_MS (2000|10000|35000), DIAG_ROUND, DIAG_OUT (diretório).
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cert, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { chromium } from "@playwright/test";

const ALLOWED_PROJECT = "cantina-escolar-hml";
const ALLOWED_DELAYS = [2000, 10000, 35000];
const WINDOW_MS = 60_000; // janela de MEDIÇÃO (não é asserção): até 60 s para observar a entrega

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`variável ausente: ${name}`);
  return value;
};

/** Nunca imprime o erro bruto: pode carregar trechos de credencial. */
const safeError = (error: unknown): string => {
  const e = error as { name?: string; code?: string | number };
  return `${e?.name ?? "Error"}${e?.code !== undefined ? ` (${String(e.code)})` : ""}`;
};

const projectId = need("DIAG_PROJECT_ID");
const email = need("DIAG_EMAIL");
const delayMs = Number(need("DIAG_WRITE_AFTER_MS"));
const round = Number(need("DIAG_ROUND"));
const outDir = process.env.DIAG_OUT ?? "diag-out";
if (projectId !== ALLOWED_PROJECT) throw new Error("destino não autorizado: só a homologação cantina-escolar-hml.");
if (!/^listener-diag@hml\.example\.test$/.test(email)) throw new Error("conta não autorizada: só a conta fictícia do diagnóstico.");
if (!ALLOWED_DELAYS.includes(delayMs)) throw new Error("intervalo não previsto (2, 10 ou 35 s).");
for (const host of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"]) if (process.env[host]) throw new Error(`${host} definido: o experimento é contra a homologação real.`);

const serviceAccount = JSON.parse(Buffer.from(need("DIAG_SA_B64"), "base64").toString("utf8")) as { project_id?: string; client_email?: string; private_key?: string };
if (serviceAccount.project_id !== ALLOWED_PROJECT) throw new Error("conta de serviço de outro projeto: abortado.");
const adminApp = initializeApp({ credential: cert(serviceAccount as never), projectId });
const db = getFirestore(adminApp);

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = join(here, "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("Rode antes: npx vite build -c tools/listener-repro/vite.config.ts");
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer((req, res) => {
  const path = join(dist, (req.url ?? "/").split("?")[0] === "/" ? "index.html" : (req.url ?? "").split("?")[0]!);
  if (!path.startsWith(dist) || !existsSync(path)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(res);
});
await new Promise<void>((resolve) => server.listen(4173, "127.0.0.1", resolve));

/** Remove do texto qualquer coisa que pareça credencial ou identificador. */
const sanitize = (text: string, uid: string): string =>
  text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer <redacted>")
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "<jwt>")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "<apikey>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replaceAll(uid || "<sem-uid>", "<uid>")
    .slice(0, 300);

const browser = await chromium.launch();
const browserVersion = browser.version();
const context = await browser.newContext();
const page = await context.newPage();

type Net = { kind: string; start: number; end: number | null; status: number | null; aid: string | null; bytes: number | null };
const net: Net[] = [];
const kindOf = (url: string) => (url.includes("TYPE=xmlhttp") ? "BACK" : url.includes("TYPE=terminate") ? "TERMINATE" : "FWD");
const aidOf = (url: string) => /[?&]AID=([^&]+)/.exec(url)?.[1] ?? null;
page.on("requestfinished", async (request) => {
  if (!request.url().includes("Listen/channel")) return;
  const t = request.timing();
  const sizes = await request.sizes().catch(() => null);
  net.push({ kind: kindOf(request.url()), start: Math.round(t.startTime), end: t.responseEnd >= 0 ? Math.round(t.startTime + t.responseEnd) : null, status: (await request.response())?.status() ?? null, aid: aidOf(request.url()), bytes: sizes?.responseBodySize ?? null });
});
const starts: { kind: string; at: number; params: string; method: string }[] = [];
page.on("request", (request) => {
  if (!request.url().includes("Listen/channel")) return;
  const params = [...new Set(new URL(request.url()).searchParams.keys())].filter((k) => k !== "zx" && k !== "t").sort().join(",");
  starts.push({ kind: kindOf(request.url()), at: Date.now(), params, method: request.method() });
});
const failed: { kind: string; at: number }[] = [];
page.on("requestfailed", (request) => {
  if (request.url().includes("Listen/channel")) failed.push({ kind: kindOf(request.url()), at: Date.now() });
});
const servers: { kind: string; ip: string }[] = [];
page.on("response", async (response) => {
  if (!response.url().includes("Listen/channel")) return;
  const addr = await response.serverAddr().catch(() => null);
  servers.push({ kind: kindOf(response.url()), ip: addr?.ipAddress ?? "?" });
});
// Camada de rede (CDP): instante de chegada de cada bloco de bytes do GET de retorno, antes do JavaScript do SDK.
const chunks: { at: number; bytes: number }[] = [];
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
const back = new Map<string, { wall: number; ts: number }>();
cdp.on("Network.requestWillBeSent", (e) => {
  if (e.request.url.includes("Listen/channel") && e.request.url.includes("TYPE=xmlhttp")) back.set(e.requestId, { wall: e.wallTime * 1000, ts: e.timestamp });
});
cdp.on("Network.dataReceived", (e) => {
  const b = back.get(e.requestId);
  if (b) chunks.push({ at: Math.round(b.wall + (e.timestamp - b.ts) * 1000), bytes: e.dataLength });
});
// Avisos/erros do próprio SDK no console (ex.: "Could not reach Cloud Firestore backend"): reconexões observáveis.
const consoleLines: { at: number; type: string; text: string }[] = [];
page.on("console", (message) => {
  if (message.type() === "warning" || message.type() === "error") consoleLines.push({ at: Date.now(), type: message.type(), text: message.text() });
});
const pageErrors: { at: number; text: string }[] = [];
page.on("pageerror", (error) => pageErrors.push({ at: Date.now(), text: error.name }));

type Mark = { at: number; ev: string; data?: Record<string, unknown> };
const marks = async () => (await page.evaluate(() => window.__marks)) as Mark[];
const waitFor = async (predicate: (m: Mark) => boolean, windowMs: number): Promise<Mark | null> => {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const found = (await marks()).find(predicate);
    if (found || Date.now() > deadline) return found ?? null;
    await new Promise((r) => setTimeout(r, 100));
  }
};

let uid = "";
let result: Record<string, unknown>;
try {
  // Estado inicial conhecido ANTES da inscrição: documento inexistente (a limpeza não pode gerar snapshot na medição).
  const expectedUid = (await getAuth(adminApp).getUserByEmail(email)).uid;
  await db.doc(`foundationProbes/${expectedUid}`).delete();
  await page.goto("http://127.0.0.1:4173/");
  uid = await page.evaluate((cfg) => window.__start(cfg), {
    firebase: { apiKey: need("DIAG_API_KEY"), authDomain: `${projectId}.firebaseapp.com`, projectId, appId: need("DIAG_APP_ID") },
    email,
    password: need("DIAG_PASSWORD"),
    listeners: ["probe"] as never,
    sdkDebug: false,
    transport: "default" as never,
    churn: false,
    firestoreBeforeAuth: false,
    staggerMs: 0,
    burstAfterMs: 0,
  });
  if (uid !== expectedUid) throw new Error("uid de login diferente do esperado");
  const probe = db.doc(`foundationProbes/${uid}`);

  const subscribe = (await waitFor((m) => m.ev === "subscribe:probe", 10_000)) as Mark;
  const firstServer = await waitFor((m) => m.ev === "snapshot:probe" && m.data?.fromCache === false, WINDOW_MS);
  // Escrita no instante pedido, contado da INSCRIÇÃO.
  const wait = subscribe.at + delayMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const n = (Date.now() % 1_000_000) + 1;
  const commitStart = Date.now();
  await probe.set({ n }, { merge: true });
  const commitEnd = Date.now();
  const updated = await waitFor((m) => m.at >= commitStart && m.ev === "snapshot:probe" && m.data?.n === n, WINDOW_MS);
  const all = await marks();
  const rendered = updated ? all.find((m) => m.ev === "render:probe" && m.at >= updated.at) : null;
  await probe.delete().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 500));

  const at = (ev: string) => all.find((m) => m.ev === ev)?.at ?? null;
  const channelOpen = net.length ? Math.min(...net.map((r) => r.start)) : null;
  const requestStart0 = starts[0]?.at ?? 0;
  const commitToSnapshotMs = updated ? updated.at - commitEnd : null;
  result = {
    round,
    writeAfterSubscribeTargetMs: delayMs,
    writeAfterSubscribeMs: commitStart - subscribe.at,
    authMs: (at("auth:ready") ?? 0) - (at("auth:start") ?? 0),
    subscribeToFirstSnapshotMs: firstServer ? firstServer.at - subscribe.at : null,
    firstSnapshotFromCache: all.filter((m) => m.ev === "snapshot:probe").map((m) => ({ afterSubscribeMs: m.at - subscribe.at, fromCache: m.data?.fromCache ?? null, n: m.data?.n ?? null })),
    writeAfterFirstSnapshotMs: firstServer ? commitStart - firstServer.at : null,
    commitMs: commitEnd - commitStart,
    commitConfirmedAfterSubscribeMs: commitEnd - subscribe.at,
    commitToSnapshotMs,
    newValueSnapshot: updated ? { afterSubscribeMs: updated.at - subscribe.at, fromCache: updated.data?.fromCache ?? null } : null,
    snapshotToRenderMs: updated && rendered ? rendered.at - updated.at : null,
    subscribeToDeliveryMs: updated ? updated.at - subscribe.at : null,
    channelOpenToDeliveryMs: updated && channelOpen !== null ? updated.at - requestStart0 : null,
    slow: commitToSnapshotMs === null || commitToSnapshotMs > 5000,
    delivered: updated !== null,
    requestStarts: starts.map((s) => ({ ...s, at: s.at - requestStart0 })),
    listenRequests: [...net].sort((a, b) => a.start - b.start).map((r) => ({ ...r, start: r.start - (channelOpen ?? r.start), end: r.end === null ? null : r.end - (channelOpen ?? r.start) })),
    failedRequests: failed.map((f) => ({ ...f, at: f.at - subscribe.at })),
    backchannelChunks: chunks.map((c) => ({ afterCommitMs: c.at - commitEnd, afterSubscribeMs: c.at - subscribe.at, bytes: c.bytes })),
    channelServers: servers,
    errors: all.filter((m) => m.ev.startsWith("error:")).map((m) => `${m.ev}=${String(m.data)}`),
    console: consoleLines.map((c) => ({ afterSubscribeMs: c.at - subscribe.at, type: c.type, text: sanitize(c.text, uid) })),
    pageErrors: pageErrors.map((p) => ({ afterSubscribeMs: p.at - subscribe.at, text: sanitize(p.text, uid) })),
    marks: all.map((m) => ({ afterSubscribeMs: m.at - subscribe.at, ev: m.ev, data: m.data })),
  };
} catch (error) {
  // Falha de infraestrutura (login, credencial, rede do runner): NÃO é resultado de latência; registrada sem detalhe bruto.
  console.log(`FALHA DE INFRAESTRUTURA na rodada ${round} (${delayMs / 1000} s): ${safeError(error)}`);
  await browser.close().catch(() => undefined);
  server.close();
  process.exit(1);
}

await browser.close();
server.close();

mkdirSync(outDir, { recursive: true });
const environment = {
  runner: { os: process.platform, arch: process.arch, imageOs: process.env.ImageOS ?? null, node: process.version, githubRunId: process.env.GITHUB_RUN_ID ?? null, githubJob: process.env.GITHUB_JOB ?? null },
  browser: `chromium ${browserVersion}`,
  firebaseSdk: (JSON.parse(readFileSync(join(here, "..", "..", "node_modules", "firebase", "package.json"), "utf8")) as { version: string }).version,
  playwright: (JSON.parse(readFileSync(join(here, "..", "..", "node_modules", "@playwright", "test", "package.json"), "utf8")) as { version: string }).version,
};
const file = join(outDir, `rodada-${delayMs / 1000}s-${round}.json`);
writeFileSync(file, JSON.stringify({ scenario: `CI-escrita-${delayMs / 1000}s`, measure: "probe", transport: "default", listeners: ["probe"], ...environment, at: new Date().toISOString(), run: result }, null, 1));

const r = result as { commitToSnapshotMs: number | null; subscribeToDeliveryMs: number | null; subscribeToFirstSnapshotMs: number | null; writeAfterSubscribeMs: number; slow: boolean };
const line = `escrita ${delayMs / 1000} s (real ${r.writeAfterSubscribeMs} ms) rodada ${round}: 1º snapshot ${r.subscribeToFirstSnapshotMs} ms após inscrição | commit→snapshot ${r.commitToSnapshotMs ?? "NÃO ENTREGUE (60 s)"} ms | inscrição→entrega ${r.subscribeToDeliveryMs} ms | ${r.slow ? "LENTA (> 5 s)" : "rápida"} | ${environment.browser}, firebase ${environment.firebaseSdk}`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
process.exit(0);
