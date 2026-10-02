// Executor da reprodução mínima do atraso de listener (homologação). Uso (na raiz, após `npx vite build -c tools/listener-repro/vite.config.ts`):
//   node tools/listener-repro/run.ts --scenario nome --runs 6 --delay 2000 --listeners calendar,probe --measure calendar
//        [--browser chromium|chrome|msedge|firefox] [--transport default|forceLongPolling] [--debug] [--node]
// Mede, por execução: login pronto, inscrição, 1º snapshot do servidor, commit da escrita (Admin SDK), snapshot atualizado e
// renderização, além dos tempos das requisições do canal Listen. Grava só tempos e metadados sanitizados (sem token, e-mail,
// senha ou uid) em tools/listener-repro/results/. Escritas transitórias e fictícias: calendarDays com data distante (apagada
// em seguida) ou o campo `n` de foundationProbes/{uid da conta fixture}.
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.STAGING_TARGET = "staging";
const { loadTarget, bypassSecret } = await import("../../scripts/staging/target.ts");
const { admin, signIn } = await import("../../scripts/staging/admin.ts");
const PUBLISHED = "https://cantina-escolar-hml.vercel.app";
const { loadManifest } = await import("../../scripts/staging/fixtures.ts");
const { chromium, firefox } = await import("@playwright/test");

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const scenario = arg("scenario", "base");
const runs = Number(arg("runs", "3"));
const delay = Number(arg("delay", "2000"));
const listeners = arg("listeners", "calendar,probe").split(",");
const measure = arg("measure", "calendar") as "calendar" | "probe";
const browserName = arg("browser", "chromium");
const transport = arg("transport", "default");
const sdkDebug = flag("debug");
const churn = flag("churn");
/** Caminho da escrita: `admin` = set simples; `tx` = transação que lê users/{uid} e o dia (como o comando do app);
 *  `api` = a própria rota publicada do app (POST /api/school/calendar na URL de homologação, conta fixture admin). */
const writeMode = arg("write", "admin") as "admin" | "tx" | "api";
const firestoreBeforeAuth = flag("firestore-antes-do-login");
const staggerMs = Number(arg("stagger", "0"));
const burstAfterMs = Number(arg("burst", "0"));

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = join(here, "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("Rode antes: npx vite build -c tools/listener-repro/vite.config.ts");
const target = loadTarget();
const account = loadManifest(target)?.accounts.admin;
if (!account) throw new Error("manifesto de fixtures ausente (npm run staging:fixtures)");
const { db } = admin(target);
const env = target.serverEnv;
let cachedToken: string | null = null;
const apiToken = async () => (cachedToken ??= (await signIn(target, account.email, account.password)).idToken);

const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer((req, res) => {
  const path = join(dist, (req.url ?? "/").split("?")[0] === "/" ? "index.html" : (req.url ?? "").split("?")[0]!);
  if (!path.startsWith(dist) || !existsSync(path)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(res);
});
await new Promise<void>((resolve) => server.listen(4173, "127.0.0.1", resolve));

/** Remove do texto qualquer coisa que pareça credencial ou identificador (para logs do SDK em modo debug). */
const sanitize = (text: string, uid: string) =>
  text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer <redacted>")
    .replace(/"?(Authorization|X-Firebase-AppCheck|X-Goog-Api-Key|key)"?\s*[:=]\s*"?[^",&\s}]+/gi, "$1=<redacted>")
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "<jwt>")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "<apikey>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replaceAll(uid || "<sem-uid>", "<uid>");

/** --pin ipv4: todas as conexões ao Firestore no mesmo endereço IPv4 (hipótese H-E: canal dividido entre IPv4/IPv6 ou frontends). */
const pin = arg("pin", "none");
const { resolve4 } = await import("node:dns/promises");
const pinnedIp = pin === "ipv4" ? (await resolve4("firestore.googleapis.com"))[0]! : null;
const launch = () =>
  browserName === "firefox"
    ? firefox.launch(pin === "ipv4" ? { firefoxUserPrefs: { "network.dns.disableIPv6": true } } : {})
    : chromium.launch({
        ...(browserName === "chromium" ? {} : { channel: browserName }),
        ...(pinnedIp ? { args: [`--host-resolver-rules=MAP firestore.googleapis.com ${pinnedIp}`] } : {}),
      });
const browser = await launch();
const version = browser.version();
const results: Record<string, unknown>[] = [];

for (let run = 1; run <= runs; run++) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const net: { kind: string; start: number; end: number | null; status: number | null; aid: string | null; bytes: number | null }[] = [];
  const kindOf = (url: string) => (url.includes("TYPE=xmlhttp") ? "BACK" : url.includes("TYPE=terminate") ? "TERMINATE" : "FWD");
  const aidOf = (url: string) => /[?&]AID=([^&]+)/.exec(url)?.[1] ?? null;
  page.on("requestfinished", async (request) => {
    if (!request.url().includes("Listen/channel")) return;
    const t = request.timing();
    const sizes = await request.sizes().catch(() => null);
    net.push({ kind: kindOf(request.url()), start: Math.round(t.startTime), end: t.responseEnd >= 0 ? Math.round(t.startTime + t.responseEnd) : null, status: (await request.response())?.status() ?? null, aid: aidOf(request.url()), bytes: sizes?.responseBodySize ?? null });
  });
  // Início de TODA requisição do canal (o GET de retorno em streaming não termina durante a medição) e só os NOMES dos
  // parâmetros da URL (valores podem identificar a sessão).
  const starts: { kind: string; at: number; params: string; method: string }[] = [];
  page.on("request", (request) => {
    if (!request.url().includes("Listen/channel")) return;
    const params = [...new Set(new URL(request.url()).searchParams.keys())].filter((k) => k !== "zx" && k !== "t").sort().join(",");
    starts.push({ kind: kindOf(request.url()), at: Date.now(), params, method: request.method() });
  });
  page.on("requestfailed", (request) => {
    if (request.url().includes("Listen/channel")) net.push({ kind: `${kindOf(request.url())}-FAILED`, start: Math.round(request.timing().startTime), end: null, status: null, aid: aidOf(request.url()), bytes: null });
  });
  // Endereço do servidor de cada resposta do canal (família IPv4/IPv6): mostra se o mesmo canal usou conexões diferentes.
  const servers: { kind: string; ip: string }[] = [];
  page.on("response", async (response) => {
    if (!response.url().includes("Listen/channel")) return;
    const addr = await response.serverAddr().catch(() => null);
    servers.push({ kind: kindOf(response.url()), ip: addr?.ipAddress ?? "?" });
  });
  // --cdp (Chromium): instante de chegada de cada bloco de bytes do GET de retorno (camada de rede, antes do JavaScript).
  const chunks: { at: number; bytes: number }[] = [];
  if (flag("cdp") && browserName !== "firefox") {
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
  }
  const consoleLines: string[] = [];
  page.on("console", (message) => sdkDebug && consoleLines.push(`${Date.now()} ${message.text()}`));

  await page.goto("http://127.0.0.1:4173/");
  const uid = await page.evaluate((cfg) => window.__start(cfg), {
    firebase: { apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY!, authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!, projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!, appId: env.NEXT_PUBLIC_FIREBASE_APP_ID! },
    email: account.email,
    password: account.password,
    listeners: listeners as never,
    sdkDebug,
    transport: transport as never,
    churn,
    firestoreBeforeAuth,
    staggerMs,
    burstAfterMs,
  });
  const marks = async () => (await page.evaluate(() => window.__marks)) as { at: number; ev: string; data?: Record<string, unknown> }[];
  const waitFor = async (predicate: (m: { at: number; ev: string; data?: Record<string, unknown> }) => boolean, windowMs: number) => {
    const deadline = Date.now() + windowMs;
    for (;;) {
      const found = (await marks()).find(predicate);
      if (found || Date.now() > deadline) return found ?? null;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const first = await waitFor((m) => m.ev === `snapshot:${measure}` && m.data?.fromCache === false, 60_000);

  await new Promise((r) => setTimeout(r, delay));
  // A rota do app só aceita até hoje+400: datas de 2027 nesse modo; nos demais, 2028.
  const date = writeMode === "api" ? `2027-0${1 + (run % 8)}-2${run % 10}` : `2028-0${1 + (run % 9)}-1${run % 10}`;
  const n = Date.now() % 1_000_000;
  const commitStart = Date.now();
  if (measure === "calendar" && writeMode === "api") {
    const response = await fetch(`${PUBLISHED}/api/school/calendar`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await apiToken()}`, "x-vercel-protection-bypass": bypassSecret() },
      body: JSON.stringify({ key: `sonda-${Date.now()}`, action: "set", date, kind: "extra", reason: "Sonda de latência (fictícia)" }),
    });
    if (!response.ok) throw new Error(`rota do app recusou a escrita: ${response.status}`);
  } else if (measure === "calendar" && writeMode === "tx") {
    await db.runTransaction(async (tx) => {
      await tx.getAll(db.doc(`users/${uid}`), db.doc(`calendarDays/${date}`));
      tx.set(db.doc(`calendarDays/${date}`), { date, kind: "extra", reason: "Sonda de latência (fictícia)" });
    });
  } else if (measure === "calendar") await db.doc(`calendarDays/${date}`).set({ date, kind: "extra", reason: "Sonda de latência (fictícia)" });
  else await db.doc(`foundationProbes/${uid}`).set({ n }, { merge: true });
  const commitEnd = Date.now();
  // Janela de MEDIÇÃO (não é asserção de teste): até 60 s para observar a entrega.
  const updated = await waitFor(
    (m) =>
      m.at >= commitStart &&
      m.ev === `snapshot:${measure}` &&
      (measure === "calendar" ? ((m.data?.changes as string[] | undefined) ?? []).includes(`added:${date}`) : m.data?.n === n),
    60_000,
  );
  const all = await marks();
  const rendered = updated ? all.find((m) => m.ev === `render:${measure}` && m.at >= updated.at) : null;
  if (measure === "calendar" && writeMode === "api") {
    const cleared = await fetch(`${PUBLISHED}/api/school/calendar`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await apiToken()}`, "x-vercel-protection-bypass": bypassSecret() },
      body: JSON.stringify({ key: `sonda-limpa-${Date.now()}`, action: "clear", date }),
    });
    if (!cleared.ok) console.log(`AVISO: limpeza de ${date} pela rota respondeu ${cleared.status}`);
  } else if (measure === "calendar") await db.doc(`calendarDays/${date}`).delete();
  await new Promise((r) => setTimeout(r, 500));
  await context.close();

  const at = (ev: string) => all.find((m) => m.ev === ev)?.at ?? null;
  const channelOpen = net.length ? Math.min(...net.map((r) => r.start)) : null;
  const deliveredBack = updated ? net.filter((r) => r.kind === "BACK" && r.end !== null && r.end >= commitStart).sort((a, b) => a.end! - b.end!)[0] : undefined;
  const result = {
    run,
    authMs: (at("auth:ready") ?? 0) - (at("auth:start") ?? 0),
    subscribeToFirstSnapshotMs: first ? first.at - (at(`subscribe:${measure}`) ?? first.at) : null,
    writeAfterFirstSnapshotMs: first ? commitStart - first.at : null,
    commitMs: commitEnd - commitStart,
    commitToSnapshotMs: updated ? updated.at - commitEnd : null,
    snapshotToRenderMs: updated && rendered ? rendered.at - updated.at : null,
    channelOpenToDeliveryMs: updated && channelOpen ? updated.at - channelOpen : null,
    deliveringBackchannel: deliveredBack ? { startedAfterCommitMs: deliveredBack.start - commitEnd, endedAfterCommitMs: deliveredBack.end! - commitEnd, bytes: deliveredBack.bytes } : null,
    listenRequests: net
      .sort((a, b) => a.start - b.start)
      .map((r) => ({ ...r, start: r.start - (channelOpen ?? r.start), end: r.end === null ? null : r.end - (channelOpen ?? r.start) })),
    requestStarts: starts.map((s) => ({ ...s, at: s.at - (starts[0]?.at ?? s.at) })),
    backchannelChunks: chunks.map((c) => ({ afterCommitMs: c.at - commitEnd, bytes: c.bytes })),
    channelServers: servers,
    errors: all.filter((m) => m.ev.startsWith("error:")).map((m) => `${m.ev}=${String(m.data)}`),
    sdkLog: sdkDebug ? consoleLines.map((line) => sanitize(line, uid)) : undefined,
  };
  results.push(result);
  const concurrentFwd = starts.filter((s) => s.kind === "FWD").length;
  const ips = [...new Set(servers.map((s) => `${s.kind}@${s.ip}`))];
  console.log(`   servidores do canal: ${ips.join(" ")}`);
  if (flag("cdp")) {
    const after = chunks.filter((c) => c.at >= commitStart).map((c) => `${c.at - commitEnd}ms/${c.bytes}B`);
    console.log(`   blocos do GET de retorno após o commit: ${after.slice(0, 6).join(" ") || "nenhum"}`);
  }
  console.log(`   requisições do canal: ${starts.length} (FWD ${concurrentFwd}); parâmetros do 2º FWD: ${starts.filter((s) => s.kind === "FWD")[1]?.params ?? "-"}`);
  console.log(`#${run} commit→snapshot=${result.commitToSnapshotMs ?? "NÃO ENTREGUE (60 s)"} ms | escrita ${result.writeAfterFirstSnapshotMs} ms após 1º snapshot | canal aberto→entrega=${result.channelOpenToDeliveryMs} ms | render=${result.snapshotToRenderMs} ms`);
}
await browser.close();
server.close();

mkdirSync(join(here, "results"), { recursive: true });
const file = join(here, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}-${scenario}.json`);
writeFileSync(file, JSON.stringify({ scenario, browser: `${browserName} ${version}`, transport, listeners, measure, delayMs: delay, churn, firestoreBeforeAuth, writeMode, staggerMs, burstAfterMs, pin, runs: results }, null, 1));
console.log(`resultado: ${file}`);
process.exit(0);
