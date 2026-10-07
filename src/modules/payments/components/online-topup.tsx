"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { api, errorText, newKey, type ApiResult } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import { parseBRLToCents } from "@/lib/money/parse";
import { useFamilyStudents } from "@/modules/guardians/use-family-students";
import { executeWithRetry } from "@/modules/wallet/operation";
import { useWallets, type WalletSlot } from "@/modules/wallet/use-wallets";
import type { IntentView } from "../online/intent-commands";
import { MercadoPagoCardBrick, type CardSubmission } from "./mercadopago-card-brick";

type ChannelInfo = { available: boolean; mode: "demo" | "live" | null };
type Config = { providerEnv: "sandbox" | "production" | null; pix: ChannelInfo; card: ChannelInfo & { installments: 1; publicConfig: Record<string, string> | null } };
type Channel = "pix" | "card";

type Op =
  | { phase: "idle" }
  | { phase: "review"; studentId: string; cents: number; channel: Channel }
  | { phase: "pending" }
  | { phase: "refused"; text: string }
  | { phase: "uncertain" };

const timeFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const CHANNEL_LABEL: Record<Channel, string> = { pix: "Pix", card: "Cartão de crédito (1x)" };
/** Acompanhamento do pagamento: 5 s nos primeiros 2 min, depois 20 s até ~15 min. Só CONSULTA o servidor (que consulta o provedor). */
const AUTO_RECONCILE = { fastTries: 24, fastEveryMs: 5000, slowTries: 40, slowEveryMs: 20000 };
const delayFor = (tries: number) => (tries < AUTO_RECONCILE.fastTries ? AUTO_RECONCILE.fastEveryMs : AUTO_RECONCILE.slowEveryMs);

/** "Indisponível" é resposta definitiva (nada gravado/cobrado), não falha transitória: não repetir. */
const definitiveUnavailable = <T,>(r: ApiResult<T>): ApiResult<T> => (!r.ok && r.error === "payment_unavailable" ? { ...r, status: 422 } : r);

/**
 * Recarga online pelo responsável (F18/F19): aluno, valor e meio → revisão → cobrança no provedor → acompanhamento. Gerar o
 * Pix ou enviar o cartão NÃO credita: o saldo só muda quando o SERVIDOR confirma o pagamento no provedor e lança o crédito
 * ("Crédito lançado"); a tela distingue "em processamento" disso, consulta o servidor enquanto espera e reconcilia o saldo
 * por versão da carteira (listener atrasado, leitura antiga e redirect nunca confirmam nem fazem o saldo regredir). Sem provedor
 * configurado o meio aparece indisponível (nunca há botão de simular pagamento). Resposta perdida repete a MESMA chave;
 * cobrança incerta é conciliada por consulta, sem gerar outra.
 */
export function OnlineTopup({ user }: { user: User }) {
  const family = useFamilyStudents(user.uid);
  const students = family.students.filter((s) => s.status === "active");
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState(false);
  const [studentId, setStudentId] = useState("");
  const [amount, setAmount] = useState("");
  const [channel, setChannel] = useState<Channel>("pix");
  const [demoCard, setDemoCard] = useState("demo_tok_approved");
  const [op, setOp] = useState<Op>({ phase: "idle" });
  const [intent, setIntent] = useState<IntentView | null>(null);
  const [checking, setChecking] = useState(false);
  const [history, setHistory] = useState<{ studentId: string; items: IntentView[] } | null>(null);
  const [historyTick, setHistoryTick] = useState(0);
  const [copied, setCopied] = useState(false);
  const attempt = useRef<{ sig: string; key: string } | null>(null);
  const inFlight = useRef(false);
  // Saldo exibido da carteira do aluno da recarga: leitura do servidor + listener, sempre reconciliados pela versão do livro.
  const walletHook = useWallets(user, intent ? [intent.studentId] : []);
  const creditedWallet = intent ? walletHook.wallets[intent.studentId] : undefined;

  useEffect(() => {
    let alive = true;
    void api<Config>(user, "GET", "/api/topups/online/config").then((r) => {
      if (!alive) return;
      if (r.ok) setConfig(r.data);
      else setConfigError(true);
    });
    return () => {
      alive = false;
    };
  }, [user]);

  const selected = studentId || students[0]?.id || "";
  // Meio escolhido indisponível com o outro disponível: usa o outro (estado derivado, sem efeito).
  const otherChannel: Channel = channel === "pix" ? "card" : "pix";
  const effective: Channel = config && !config[channel].available && config[otherChannel].available ? otherChannel : channel;

  // Histórico do aluno escolhido; `historyTick` relê depois de uma nova recarga. Resposta de outro aluno é descartada.
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    void api<{ intents: IntentView[] }>(user, "GET", `/api/topups/online?studentId=${encodeURIComponent(selected)}`).then((r) => {
      if (alive && r.ok) setHistory({ studentId: selected, items: r.data.intents });
    });
    return () => {
      alive = false;
    };
  }, [user, selected, historyTick]);
  const historyItems = history?.studentId === selected ? history.items : null;

  async function reconcile(id: string, resend = false) {
    setChecking(true);
    const r = await api<IntentView>(user, "POST", `/api/topups/online/${id}/reconcile`, resend ? { resend: true } : {}, { timeoutMs: 20000 });
    setChecking(false);
    if (r.ok) setIntent(r.data);
  }

  // Acompanhamento: enquanto a criação estiver incerta OU o pagamento aguardar confirmação, consulta o SERVIDOR (que consulta
  // o provedor). Nunca gera outra cobrança. O crédito só aparece quando a resposta traz a intenção `confirmed`.
  const intentId = intent?.intentId;
  const intentWatch = intent ? intent.needsReconcile || intent.awaitingConfirmation : false;
  useEffect(() => {
    if (!intentId || !intentWatch) return;
    let tries = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped || tries >= AUTO_RECONCILE.fastTries + AUTO_RECONCILE.slowTries) return;
      tries += 1;
      const r = await api<IntentView>(user, "POST", `/api/topups/online/${intentId}/reconcile`, {}, { timeoutMs: 20000 });
      if (stopped) return;
      if (r.ok) setIntent(r.data);
      if (!r.ok || r.data.needsReconcile || r.data.awaitingConfirmation) timer = setTimeout(tick, delayFor(tries));
    };
    timer = setTimeout(tick, AUTO_RECONCILE.fastEveryMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [user, intentId, intentWatch]);

  // Crédito JÁ lançado pelo servidor: aplica ao saldo exibido pela versão do livro (idempotente; nunca regride).
  const credit = intent?.credit ?? null;
  const credited = intent?.credited === true;
  const applyCredit = walletHook.applyConfirmedCredit;
  const creditStudent = intent?.studentId;
  useEffect(() => {
    if (!creditStudent || !credit || !credited) return;
    applyCredit({ studentId: creditStudent, entryId: credit.walletEntryId, walletSeq: credit.walletSeq, balanceAfterCents: credit.balanceAfterCents, amountCents: credit.amountCents, reason: "Recarga online" });
  }, [creditStudent, credit, credited, applyCredit]);

  function review(event: FormEvent) {
    event.preventDefault();
    const cents = parseBRLToCents(amount);
    if (cents === null || cents < 100) return setOp({ phase: "refused", text: "Informe um valor em reais a partir de R$ 1,00 (exemplo: 50,00)." });
    if (cents > 200_000) return setOp({ phase: "refused", text: "O valor máximo por recarga é R$ 2.000,00." });
    if (!selected) return setOp({ phase: "refused", text: "Escolha o aluno." });
    if (!config?.[effective].available) return setOp({ phase: "refused", text: errorText("payment_unavailable") });
    // Cartão real só pelo componente oficial do provedor (chave pública necessária): nunca dados de cartão em claro.
    if (effective === "card" && config.card.mode === "live" && !config.card.publicConfig?.publicKey) return setOp({ phase: "refused", text: errorText("payment_unavailable") });
    setOp({ phase: "review", studentId: selected, cents, channel: effective });
  }

  async function confirm(card?: CardSubmission) {
    if (op.phase !== "review" || inFlight.current) return;
    const { studentId: sid, cents, channel: ch } = op;
    const sig = `${sid}|${cents}|${ch}`;
    if (attempt.current?.sig !== sig) attempt.current = { sig, key: newKey() };
    // Demonstração (só emulador): token fictício; real: token, bandeira e pagador do componente do Mercado Pago.
    const cardData = card ?? { cardToken: demoCard, paymentMethodId: "visa", payer: { email: "demo@example.test", identification: { type: "CPF" as const, number: "12345678909" } } };
    const body = ch === "pix" ? { key: attempt.current.key, studentId: sid, amountCents: cents, channel: "pix" } : { key: attempt.current.key, studentId: sid, amountCents: cents, channel: "card", installments: 1, ...cardData };
    inFlight.current = true;
    setOp({ phase: "pending" });
    const outcome = await executeWithRetry(async () => definitiveUnavailable(await api<IntentView & { replayed: boolean }>(user, "POST", "/api/topups/online", body, { timeoutMs: 30000 })));
    inFlight.current = false;
    if (outcome.phase === "confirmed") {
      attempt.current = null;
      setIntent(outcome.data);
      setCopied(false);
      setAmount("");
      setOp({ phase: "idle" });
      setHistoryTick((t) => t + 1);
    } else if (outcome.phase === "refused") {
      attempt.current = null;
      setOp({ phase: "refused", text: errorText(outcome.error) });
    } else {
      setOp({ phase: "uncertain" });
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  /** Resposta perdida: a revisão reaparece com a MESMA chave guardada; confirmar repete a mesma operação (idempotente). */
  function confirmAgain() {
    if (op.phase !== "uncertain" || !attempt.current) return;
    const [sid, cents, ch] = attempt.current.sig.split("|");
    setOp({ phase: "review", studentId: sid!, cents: Number(cents), channel: ch as Channel });
  }

  const names = new Map(family.students.map((s) => [s.id, s.name]));
  const noChannel = config !== null && !config.pix.available && !config.card.available;
  const demo = config !== null && (config.pix.mode === "demo" || config.card.mode === "demo");
  const locked = op.phase === "pending" || op.phase === "uncertain" || op.phase === "review";

  return (
    <section>
      <h1>Recarregar carteira</h1>
      <p className="muted">
        O saldo só aumenta depois que o pagamento é <strong>confirmado</strong> pelo provedor. Gerar o Pix ou enviar o cartão ainda não credita nada. O valor
        pago é creditado integralmente; não há taxa para a família.
      </p>
      {config?.providerEnv === "sandbox" && (
        <p className="notice" data-testid="topup-sandbox">
          <strong>Ambiente de teste do Mercado Pago (sandbox)</strong>: nenhum valor real é cobrado. Use só dados de teste.
        </p>
      )}
      {demo && (
        <p className="notice" data-testid="topup-demo">
          <strong>Demonstração</strong>: ambiente de teste, sem provedor real. Nenhum valor é cobrado e nenhuma recarga desta tela é confirmada.
        </p>
      )}
      {!config && !configError && <p role="status">Consultando os meios de pagamento…</p>}
      {configError && (
        <p role="alert" className="notice notice-error">
          Não foi possível consultar os meios de pagamento. Verifique a conexão.
        </p>
      )}
      {noChannel && (
        <p className="notice" data-testid="topup-unavailable">
          Recarga online indisponível no momento. Faça a recarga na secretaria da escola (dinheiro, Pix ou cartão).
        </p>
      )}
      {family.status === "ready" && students.length === 0 && <p>Nenhum aluno ativo vinculado à sua conta.</p>}

      {config && !noChannel && students.length > 0 && (
        <form onSubmit={review} aria-labelledby="topup-form-title" data-testid="online-topup-form">
          <h2 id="topup-form-title">Nova recarga</h2>
          <fieldset disabled={locked} className="form-grid">
            <div className="field">
              <label htmlFor="topup-student">Aluno</label>
              <select id="topup-student" value={selected} onChange={(e) => setStudentId(e.target.value)}>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="topup-amount">Valor (R$)</label>
              <input id="topup-amount" type="text" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50,00" />
            </div>
            <fieldset className="choice-group">
              <legend>Forma de pagamento</legend>
              {(["pix", "card"] as const).map((ch) => (
                <label key={ch}>
                  <input type="radio" name="topup-channel" value={ch} checked={effective === ch} disabled={!config[ch].available} onChange={() => setChannel(ch)} data-testid={`topup-channel-${ch}`} />
                  {CHANNEL_LABEL[ch]}
                  {!config[ch].available && <span className="muted"> (indisponível)</span>}
                </label>
              ))}
            </fieldset>
            {effective === "card" && config.card.mode === "demo" && (
              <div className="field">
                <label htmlFor="topup-demo-card">Cartão de teste (demonstração)</label>
                <select id="topup-demo-card" value={demoCard} onChange={(e) => setDemoCard(e.target.value)}>
                  <option value="demo_tok_approved">Aprovado no provedor (fica em análise)</option>
                  <option value="demo_tok_declined">Recusado</option>
                </select>
              </div>
            )}
          </fieldset>
          {op.phase !== "review" && op.phase !== "uncertain" && (
            <button type="submit" disabled={locked}>
              {op.phase === "pending" ? "Gerando cobrança…" : "Revisar"}
            </button>
          )}
        </form>
      )}

      {op.phase === "review" && (
        <section aria-labelledby="topup-review-title" data-testid="topup-review">
          <h2 id="topup-review-title">Revise antes de gerar a cobrança</h2>
          <dl className="receipt-grid">
            <dt>Aluno</dt>
            <dd>{names.get(op.studentId)}</dd>
            <dt>Valor</dt>
            <dd>{formatBRL(op.cents)}</dd>
            <dt>Forma</dt>
            <dd>{op.channel === "card" ? "Cartão de crédito em 1 parcela" : "Pix"}</dd>
            <dt>Crédito na carteira</dt>
            <dd>{formatBRL(op.cents)}, depois da confirmação do pagamento</dd>
          </dl>
          {op.channel === "card" && config?.card.mode === "live" && config.card.publicConfig?.publicKey ? (
            <MercadoPagoCardBrick amountCents={op.cents} publicKey={config.card.publicConfig.publicKey} onSubmit={(card) => confirm(card)} />
          ) : (
            <button type="button" onClick={() => void confirm()}>
              {op.channel === "pix" ? "Gerar Pix" : "Pagar com cartão"}
            </button>
          )}{" "}
          <button type="button" className="secondary" onClick={() => setOp({ phase: "idle" })}>
            Voltar
          </button>
        </section>
      )}
      {op.phase === "pending" && (
        <p role="status" className="notice" data-testid="topup-status" data-phase="pending">
          Gerando a cobrança no provedor…
        </p>
      )}
      {op.phase === "refused" && (
        <p role="alert" className="notice notice-error" data-testid="topup-status" data-phase="refused">
          {op.text}
        </p>
      )}
      {op.phase === "uncertain" && (
        <div role="alert" className="notice" data-testid="topup-status" data-phase="uncertain">
          <p>Sem resposta do servidor. A cobrança pode ter sido gerada: repita para conferir — a mesma solicitação é reaproveitada, sem cobrança nova.</p>
          <button type="button" onClick={() => void confirmAgain()}>
            Conferir de novo
          </button>
        </div>
      )}

      {intent && <IntentPanel intent={intent} checking={checking} copied={copied} onCopy={copy} onReconcile={(resend) => void reconcile(intent.intentId, resend)} wallet={creditedWallet} />}

      <section aria-labelledby="topup-history-title">
        <h2 id="topup-history-title">Últimas recargas online{selected && names.get(selected) ? ` · ${names.get(selected)}` : ""}</h2>
        {historyItems === null && selected && <p role="status">Carregando…</p>}
        {historyItems?.length === 0 && <p className="muted">Nenhuma recarga online deste aluno.</p>}
        {historyItems && historyItems.length > 0 && (
          <ul className="plain-list" data-testid="topup-history">
            {historyItems.map((h) => (
              <li key={h.intentId} data-intent={h.intentId} data-status={h.displayStatus}>
                {timeFmt.format(new Date(h.createdAt))} · {CHANNEL_LABEL[h.channel]} · <strong>{formatBRL(h.amountCents)}</strong> · {h.statusLabel}
                {h.providerMode === "demo" && <span className="muted"> (demonstração)</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function IntentPanel({ intent, checking, copied, onCopy, onReconcile, wallet }: { intent: IntentView; checking: boolean; copied: boolean; onCopy: (text: string) => void; onReconcile: (resend: boolean) => void; wallet?: WalletSlot }) {
  const status = intent.displayStatus;
  return (
    <section aria-labelledby="topup-intent-title" data-testid="topup-intent" data-status={status} data-intent={intent.intentId}>
      <h2 id="topup-intent-title">
        Recarga de {formatBRL(intent.amountCents)} · {intent.studentName}
      </h2>
      <p role="status" data-testid="topup-intent-status">
        <strong>{intent.statusLabel}</strong>
        {intent.providerMode === "demo" && <span className="muted"> · demonstração, sem cobrança</span>}
      </p>
      {status === "awaiting_payment" && intent.pix && (
        <div className="pix-box">
          {intent.pix.qrImagePngBase64 && (
            // eslint-disable-next-line @next/next/no-img-element -- QR em data: URL devolvido pelo provedor; sem otimizador remoto.
            <img src={`data:image/png;base64,${intent.pix.qrImagePngBase64}`} alt={`QR Code Pix de ${formatBRL(intent.amountCents)}`} width={220} height={220} className="pix-qr" />
          )}
          <label htmlFor="pix-copy">Pix copia e cola</label>
          <textarea id="pix-copy" readOnly rows={3} value={intent.pix.copyPaste} data-testid="pix-copy" onFocus={(e) => e.currentTarget.select()} />
          <p>
            <button type="button" onClick={() => onCopy(intent.pix!.copyPaste)}>
              Copiar código
            </button>{" "}
            <span role="status">{copied ? "Código copiado." : ""}</span>
          </p>
          <p data-testid="pix-expiry">
            Válido até <strong>{timeFmt.format(new Date(intent.pix.expiresAt))}</strong>. Depois disso, gere outro Pix.
          </p>
          <p className="muted">O saldo será atualizado quando o pagamento for confirmado. Não pague o mesmo código duas vezes.</p>
        </div>
      )}
      {status === "expired" && (
        <p>
          Este Pix venceu sem confirmação. Se você pagou antes do vencimento, o valor será conciliado e creditado automaticamente; caso contrário, gere outro.
          {intent.awaitingConfirmation ? " Seguimos conferindo com o provedor." : ""}
        </p>
      )}
      {status === "processing" && (
        <p data-testid="topup-processing">
          Pagamento em processamento: o cartão foi enviado ao provedor e está em análise. <strong>Ainda não é saldo</strong>: o crédito só é lançado quando o pagamento for confirmado.
        </p>
      )}
      {intent.awaitingConfirmation && status === "awaiting_payment" && (
        <p className="muted" data-testid="topup-not-credited">
          Pagamento em processamento: nenhum crédito foi lançado ainda.
        </p>
      )}
      {status === "confirmed" && intent.credit && (
        <div data-testid="topup-credited" data-wallet-seq={intent.credit.walletSeq}>
          <p>
            <strong>Crédito lançado:</strong> {formatBRL(intent.credit.amountCents)} na carteira de {intent.studentName}. Saldo depois do crédito: <strong>{formatBRL(intent.credit.balanceAfterCents)}</strong>.
          </p>
          {intent.credit.afterExpiry && <p className="muted">O pagamento chegou depois da validade (ou da falha registrada) e foi creditado mesmo assim, uma única vez.</p>}
          {intent.reversal && <p role="status">Parte do pagamento foi devolvida: {formatBRL(intent.reversal.accountedCents)}.</p>}
        </div>
      )}
      {status === "reversed" && (
        <p role="status" className="notice" data-testid="topup-reversed">
          {intent.reversal?.cause === "chargeback" ? "Este pagamento foi contestado (chargeback)" : "Este pagamento foi devolvido"}: {formatBRL(intent.reversal?.accountedCents ?? intent.amountCents)} saiu da carteira.
          {intent.reversal && intent.reversal.pendingCents > 0 ? ` Havia ${formatBRL(intent.reversal.pendingCents)} já consumidos: a escola vai regularizar a pendência e novas compras ficam bloqueadas até lá.` : ""}
        </p>
      )}
      {status === "in_review" && (
        <p role="status" className="notice" data-testid="topup-review-notice">
          Recebemos o aviso de pagamento, mas ele precisa de conferência pela escola ({intent.review?.label ?? "divergência"}). <strong>Nenhum crédito foi lançado ainda.</strong> Procure a secretaria se
          precisar de ajuda.
        </p>
      )}
      {intent.credited && wallet?.view && (
        <p data-testid="topup-wallet" data-version={wallet.view.version} data-sync={wallet.sync}>
          Saldo atual da carteira: <strong data-testid="topup-wallet-balance">{formatBRL(wallet.view.balanceCents)}</strong>
        </p>
      )}
      {(status === "creating" || status === "creation_uncertain") && (
        <div>
          <p>A resposta do provedor não chegou. Estamos conferindo se a cobrança foi gerada — não gere outra recarga enquanto isso.</p>
          <button type="button" disabled={checking} onClick={() => onReconcile(false)}>
            {checking ? "Conferindo…" : "Conferir agora"}
          </button>
          {intent.channel === "pix" && intent.status === "creation_uncertain" && (
            <>
              {" "}
              <button type="button" className="secondary" disabled={checking} onClick={() => onReconcile(true)}>
                Tentar gerar o mesmo Pix
              </button>
            </>
          )}
        </div>
      )}
      {status === "failed" && intent.failure && (
        <p role="alert" className="notice notice-error">
          {intent.failure.message}
        </p>
      )}
    </section>
  );
}
