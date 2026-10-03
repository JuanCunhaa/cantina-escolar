// Linha de base da reprodução mínima SEM navegador: o mesmo Web SDK (firebase 12.19.0) em Node usa gRPC/HTTP2, não
// WebChannel. Mesma conta fixture, backend, listeners e escrita (Admin SDK). Uma instância nova por rodada (canal novo).
// Uso: node tools/listener-repro/node-baseline.ts --runs 30 --delay 2000
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.STAGING_TARGET = "staging";
const { loadTarget } = await import("../../scripts/staging/target.ts");
const { admin } = await import("../../scripts/staging/admin.ts");
const { loadManifest } = await import("../../scripts/staging/fixtures.ts");
const { deleteApp, initializeApp } = await import("firebase/app");
const { getAuth, signInWithEmailAndPassword } = await import("firebase/auth");
const { collection, doc, getFirestore, onSnapshot, orderBy, query, terminate } = await import("firebase/firestore");

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const runs = Number(arg("runs", "10"));
const delay = Number(arg("delay", "2000"));
const target = loadTarget();
const account = loadManifest(target)!.accounts.admin!;
const env = target.serverEnv;
const { db: adminDb } = admin(target);
const results: Record<string, unknown>[] = [];

for (let run = 1; run <= runs; run++) {
  const app = initializeApp({ apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY, authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID, appId: env.NEXT_PUBLIC_FIREBASE_APP_ID }, `base-${run}-${Date.now()}`);
  const authStart = Date.now();
  const { user } = await signInWithEmailAndPassword(getAuth(app), account.email, account.password);
  const authReady = Date.now();
  const db = getFirestore(app);
  const date = `2028-1${run % 3}-0${1 + (run % 9)}`;
  let firstAt = 0;
  let deliveredAt = 0;
  const subscribeAt = Date.now();
  const stops = [
    onSnapshot(doc(db, "users", user.uid), () => undefined),
    onSnapshot(query(collection(db, "classes"), orderBy("name")), () => undefined),
    onSnapshot(query(collection(db, "shifts"), orderBy("name")), () => undefined),
    onSnapshot(collection(db, "calendarDays"), { includeMetadataChanges: true }, (snap) => {
      if (!firstAt && !snap.metadata.fromCache) firstAt = Date.now();
      if (!deliveredAt && snap.docs.some((d) => d.id === date)) deliveredAt = Date.now();
    }),
  ];
  while (!firstAt) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, delay));
  const commitStart = Date.now();
  await adminDb.doc(`calendarDays/${date}`).set({ date, kind: "extra", reason: "Sonda de latência (fictícia)" });
  const commitEnd = Date.now();
  const deadline = Date.now() + 60_000; // janela de MEDIÇÃO
  while (!deliveredAt && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  await adminDb.doc(`calendarDays/${date}`).delete();
  for (const stop of stops) stop();
  await terminate(db);
  await deleteApp(app);
  const result = { run, authMs: authReady - authStart, subscribeToFirstSnapshotMs: firstAt - subscribeAt, commitMs: commitEnd - commitStart, commitToSnapshotMs: deliveredAt ? deliveredAt - commitEnd : null, subscribeToDeliveryMs: deliveredAt ? deliveredAt - subscribeAt : null };
  results.push(result);
  console.log(`#${run} commit→snapshot=${result.commitToSnapshotMs ?? "NÃO ENTREGUE (60 s)"} ms | inscrição→entrega=${result.subscribeToDeliveryMs} ms`);
}
const dir = join(fileURLToPath(new URL(".", import.meta.url)), "results");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-NODE-grpc.json`), JSON.stringify({ scenario: "NODE-grpc", transport: "gRPC (Web SDK em Node)", delayMs: delay, runs: results }, null, 1));
process.exit(0);
