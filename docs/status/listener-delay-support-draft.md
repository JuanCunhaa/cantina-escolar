# RASCUNHO — NÃO ENVIADO (revisão do dono antes de qualquer envio)

Relato técnico para o suporte do Firebase. Antes de enviar: confirmar o identificador do projeto a informar, anexar só os
JSON de `tools/listener-repro/results/` (sanitizados: sem token, e-mail, senha ou uid) e decidir se vale testar outra rede
primeiro (ver docs/status/listener-delay-investigation.md).

---

**Subject:** Web SDK onSnapshot: first change after channel open delivered ~25–30 s late (initial snapshot is immediate)

**Product:** Cloud Firestore, Web SDK `firebase` 12.19.0 (modular), default settings (`getFirestore(app)`; WebChannel
streaming with buffering-proxy auto-detection). Database location: `southamerica-east1`. Email/password Firebase Auth.

**Symptom**

In a browser, right after a page opens its Firestore channel and receives the initial snapshot of a listener
(~200 ms), the first subsequent change to a listened document is sometimes delivered only ~24–30 s after the channel was
opened (~21–27 s after the write commits). All later changes on the same channel arrive in milliseconds. The write itself
is committed normally (verified with the Admin SDK). No errors are reported to the listener.

**Minimal reproduction (no application code)**

A static page with only the Firebase Web SDK (same version), signing in with a test account and listening to a small
collection (`onSnapshot(collection(db, "calendarDays"))`, plus a few other listeners). A Node script commits a new
document with the Admin SDK ~2 s after the initial snapshot and measures when the listener sees it. Source and sanitized
results are attached.

- 162 browser runs on the minimal page (Chromium 153, Firefox 155, Edge): 7 delayed deliveries (24.0–27.2 s after commit;
  24.8–29.7 s after channel open). Delays happen in both Chromium and Firefox and in bursts over time (several within a few
  minutes, then none for a while).
- Same listeners and writes from Node with the same Web SDK (gRPC transport): 0 of 40 delayed (statistically inconclusive
  at the observed rate).
- In one delayed browser run, the forward channel and the backchannel used the same server address (IPv6), with a single
  backchannel GET; the client's first acknowledgment (`AID`) after the write only happened at ~28 s.
- In the full application (same SDK and project) with `experimentalForceLongPolling: true`, a delayed case was also
  observed: the backchannel GET stayed pending ~28 s and completed only then, carrying the change — i.e., the response was
  not available earlier on the wire. (20 later long-polling runs of the minimal page had no delayed case.)
- Delays occur with a plain Admin SDK `set` (also seen when the application writes through a transaction).
- Not affected by: rapid listen/unlisten of the same query (React Strict Mode pattern), bursts of listen requests during
  channel setup, creating Firestore before sign-in, number of listeners, or
  `experimentalLongPollingOptions.timeoutSeconds` (in the application, the pending GET still lasted ~28 s with 10 s
  requested).

**Questions**

1. Is there a known condition in which the WebChannel Listen backend withholds the first target change for a new channel
   until ~30 s (e.g., a backchannel/session routing or rotation interval)?
2. Can you check server-side logs for the attached timestamps (UTC) to see whether the change was routed late to the
   channel's backchannel?
3. Is there a recommended client setting to avoid it, other than relying on later changes?

**Environment:** Windows 11, residential connection in Brazil (dual-stack IPv4/IPv6), Chromium/Firefox via Playwright.
Only one network was tested so far.
