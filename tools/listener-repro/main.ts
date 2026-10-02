// Reprodução mínima (navegador): o MESMO Web SDK do projeto (firebase 12.19.0), login e-mail/senha e listeners no backend
// de homologação, sem nenhum código da aplicação. Registra marcos com Date.now() (mesmo relógio do executor, mesma máquina).
import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { collection, doc, getFirestore, initializeFirestore, onSnapshot, orderBy, query, setLogLevel, type Firestore } from "firebase/firestore";

type ListenerSet = "probe" | "calendar" | "page";
type Config = {
  firebase: { apiKey: string; authDomain: string; projectId: string; appId: string };
  email: string;
  password: string;
  listeners: ListenerSet[];
  sdkDebug: boolean;
  /** Só para comparação explícita; padrão = configuração do app (getFirestore). */
  transport: "default" | "forceLongPolling";
  /** Hipótese H-B: inscrever, cancelar e reinscrever o mesmo listener em sequência (como o React em modo estrito/remontagem). */
  churn: boolean;
  /** Hipótese H-A: criar a instância do Firestore antes do login (como o app, que a cria ao montar a sessão). */
  firestoreBeforeAuth: boolean;
  /** Hipótese H-C: intervalo (ms) entre as inscrições, cada uma em sua própria tarefa (como componentes montando em momentos diferentes). 0 = todas juntas. */
  staggerMs: number;
  /** Hipótese H-D: registrar o 1º listener (abre o canal) e, após N ms (abertura em andamento), todos os demais no mesmo tick. */
  burstAfterMs: number;
};
type Mark = { at: number; ev: string; data?: unknown };

const marks: Mark[] = [];
const mark = (ev: string, data?: unknown) => marks.push({ at: Date.now(), ev, data });
const out = document.getElementById("out")!;

declare global {
  interface Window {
    __marks: Mark[];
    __start: (cfg: Config) => Promise<string>;
  }
}
window.__marks = marks;

window.__start = async (cfg) => {
  if (cfg.sdkDebug) setLogLevel("debug");
  const app = initializeApp(cfg.firebase);
  const makeDb = (): Firestore => (cfg.transport === "forceLongPolling" ? initializeFirestore(app, { experimentalForceLongPolling: true }) : getFirestore(app));
  const early = cfg.firestoreBeforeAuth ? makeDb() : null;
  mark("auth:start");
  const credential = await signInWithEmailAndPassword(getAuth(app), cfg.email, cfg.password);
  mark("auth:ready");
  const uid = credential.user.uid;
  const db: Firestore = early ?? makeDb();
  /** Com `churn`, cada inscrição é feita, cancelada e refeita imediatamente (efeito duplo do React em modo estrito). */
  const listen: typeof onSnapshot = ((...args: unknown[]) => {
    if (cfg.churn) (onSnapshot as (...a: unknown[]) => () => void)(...args)();
    return (onSnapshot as (...a: unknown[]) => () => void)(...args);
  }) as typeof onSnapshot;

  const render = (name: string, text: string) => {
    out.textContent = `${name}: ${text}`;
    requestAnimationFrame(() => mark(`render:${name}`));
  };
  const fail = (name: string) => (error: { code?: string }) => mark(`error:${name}`, error.code ?? "unknown");

  // Ordem do app: sessão (users) primeiro, depois turmas/turnos e por fim o calendário.
  const registrations: (() => void)[] = [];
  if (cfg.listeners.includes("page")) {
    // Mesmo conjunto extra de listeners da tela do calendário do app (sessão + turmas/turnos ordenados por nome).
    for (const [name, ref] of [
      ["users", doc(db, "users", uid)],
      ["classes", query(collection(db, "classes"), orderBy("name"))],
      ["shifts", query(collection(db, "shifts"), orderBy("name"))],
    ] as const) {
      registrations.push(() => {
        mark(`subscribe:${name}`);
        let first = true;
        listen(ref as never, () => first && ((first = false), mark(`snapshot:${name}`)), fail(name));
      });
    }
  }
  if (cfg.listeners.includes("calendar")) registrations.push(() => {
    mark("subscribe:calendar");
    listen(
      collection(db, "calendarDays"),
      { includeMetadataChanges: true },
      (snap) => {
        mark("snapshot:calendar", { size: snap.size, fromCache: snap.metadata.fromCache, changes: snap.docChanges().map((c) => `${c.type}:${c.doc.id}`) });
        render("calendar", `${snap.size} dias`);
      },
      fail("calendar"),
    );
  });
  if (cfg.listeners.includes("probe")) registrations.push(() => {
    mark("subscribe:probe");
    listen(
      doc(db, "foundationProbes", uid),
      { includeMetadataChanges: true },
      (snap) => {
        mark("snapshot:probe", { n: snap.get("n") ?? null, fromCache: snap.metadata.fromCache });
        render("probe", String(snap.get("n") ?? "-"));
      },
      fail("probe"),
    );
  });
  if (cfg.burstAfterMs > 0) {
    const [first, ...rest] = registrations;
    first?.();
    await new Promise((resolve) => setTimeout(resolve, cfg.burstAfterMs));
    mark("burst");
    for (const register of rest) register();
  } else {
    for (const register of registrations) {
      register();
      if (cfg.staggerMs > 0) await new Promise((resolve) => setTimeout(resolve, cfg.staggerMs));
    }
  }
  return uid;
};
