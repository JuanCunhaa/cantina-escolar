"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { User } from "firebase/auth";
import { errorText } from "@/lib/api-client";
import { localDateOf } from "@/lib/dates/school-time";
import { formatBRL } from "@/lib/money/format";
import { parseBRLToCents } from "@/lib/money/parse";
import { clockLabel, dayMonth } from "@/modules/menu/format";
import { useServerQuery } from "@/modules/orders/use-operations";
import { StudentPicker } from "@/modules/pos/components/student-picker";
import type { PosRoster, PosStudentRow } from "@/modules/pos/queries";
import { usePosSubmit } from "@/modules/pos/use-pos";
import { isUncertain } from "@/modules/wallet/operation";
import { applyReading, type WalletView } from "@/modules/wallet/view";
import { PAYMENT_LABEL, PAYMENT_METHODS, type PaymentMethod } from "../methods";
import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, normalizeReference, referenceRequired } from "../topup-model";
import type { TopupList, TopupStudent, TopupView } from "../topup-queries";
import { settlementText, statusText } from "./topup-text";

type Fields = { amountText: string; method: PaymentMethod; reference: string; feeText: string; expectedOn: string; payerName: string; note: string; confirmed: boolean };
const EMPTY: Fields = { amountText: "", method: "pix", reference: "", feeText: "", expectedOn: "", payerName: "", note: "", confirmed: false };

const REFERENCE_LABEL: Record<PaymentMethod, string> = {
  cash: "Nº do recibo em dinheiro (opcional)",
  pix: "ID da transação Pix (E2E) no extrato",
  card_debit: "NSU e código de autorização do comprovante da maquininha",
  card_credit: "NSU e código de autorização do comprovante da maquininha",
};

/** Taxa digitada → centavos; vazio = não informada; "0" = zero; inválido = null. */
function feeOf(f: Fields): number | undefined | null {
  if (f.method === "cash" || f.feeText.trim() === "") return undefined;
  if (/^\s*0+([.,]0{1,2})?\s*$/.test(f.feeText)) return 0;
  return parseBRLToCents(f.feeText);
}

function validate(f: Fields): { amountCents: number | null; feeCents: number | undefined | null; problems: string[] } {
  const amountCents = parseBRLToCents(f.amountText);
  const feeCents = feeOf(f);
  const problems: string[] = [];
  if (amountCents === null || amountCents < MIN_TOPUP_CENTS || amountCents > MAX_TOPUP_CENTS) problems.push(`Informe o valor recebido entre ${formatBRL(MIN_TOPUP_CENTS)} e ${formatBRL(MAX_TOPUP_CENTS)}.`);
  if (referenceRequired(f.method) && normalizeReference(f.reference).length < 4) problems.push("Informe a referência do comprovante (pelo menos 4 letras ou números).");
  if (feeCents === null || (typeof feeCents === "number" && amountCents !== null && feeCents > amountCents)) problems.push("Taxa inválida: use um valor como 1,50, que não passe do valor recebido.");
  return { amountCents, feeCents, problems };
}

function refusalText(code: string): string {
  if (code === "balance_limit") return "A carteira passaria do limite de saldo. Confira o valor.";
  return errorText(code);
}

/**
 * Secretaria/administração: aluno por busca nominal (turma/turno, homônimos destacados) → recebimento → revisão → confirmação.
 * A recarga só aparece como feita pela RESPOSTA do servidor; resposta perdida mantém a MESMA chave para o reenvio, e o saldo
 * exibido só avança por `version` (uma leitura antiga não o faz regredir).
 */
export function TopupDesk({ user }: { user: User }) {
  const roster = useServerQuery<PosRoster>(user, "/api/topups/students", "", true, false);
  const [picked, setPicked] = useState<PosStudentRow | null>(null);
  const detail = useServerQuery<TopupStudent>(user, "/api/topups/students", `id=${picked?.id ?? ""}`, picked !== null);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [reviewing, setReviewing] = useState(false);
  const [done, setDone] = useState<TopupView | null>(null);
  const [message, setMessage] = useState<{ text: string; topupId?: string } | null>(null);
  const [commandWallet, setCommandWallet] = useState<{ studentId: string; view: WalletView } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const submit = usePosSubmit(user);
  const [dayDate, setDayDate] = useState(() => localDateOf(new Date()));
  const [onlyMine, setOnlyMine] = useState(false);
  const day = useServerQuery<TopupList>(user, "/api/topups", `date=${dayDate}${onlyMine ? "&mine=1" : ""}`);
  const locked = submit.busy || submit.uncertain;
  const student = detail.data && detail.data.student.id === picked?.id ? detail.data : null;

  // Saldo exibido = leitura de MAIOR `version` entre a resposta do comando e a leitura do servidor (nunca regride).
  const wallet: WalletView | null = student ? applyReading(commandWallet?.studentId === student.student.id ? commandWallet.view : null, { ...student.wallet, source: "read" }) : null;
  useEffect(() => {
    if (done) resultRef.current?.focus();
  }, [done]);

  const check = validate(fields);
  const amount = check.amountCents ?? 0;
  const fee = check.feeCents;

  function pick(row: PosStudentRow) {
    if (locked) return;
    setPicked(row);
    setCommandWallet(null);
    setFields(EMPTY);
    setReviewing(false);
    setDone(null);
    setMessage(null);
  }

  async function confirm() {
    if (!student || check.problems.length > 0 || !fields.confirmed) return;
    const body: Record<string, unknown> = { studentId: student.student.id, amountCents: amount, method: fields.method, receivedConfirmed: true };
    if (fields.reference.trim()) body.reference = fields.reference.trim();
    if (typeof fee === "number") body.feeCents = fee;
    if (fields.expectedOn && fields.method.startsWith("card")) body.expectedSettlementOn = fields.expectedOn;
    if (fields.payerName.trim()) body.payerName = fields.payerName.trim();
    if (fields.note.trim()) body.note = fields.note.trim();
    setMessage(null);
    const result = await submit.submit<TopupView & { replayed: boolean }>("/api/topups", body);
    if (!result) return;
    if (result.ok) {
      setDone(result.data);
      setCommandWallet((w) => ({ studentId: result.data.student.id, view: applyReading(w?.studentId === result.data.student.id ? w.view : null, { balanceCents: result.data.balanceAfterCents, version: result.data.walletSeq, source: "command" }) }));
      setReviewing(false);
      setFields(EMPTY);
      detail.reload();
      day.reload();
    } else if (!isUncertain(result)) {
      setMessage({ text: refusalText(result.error), topupId: typeof result.details?.topupId === "string" ? result.details.topupId : undefined });
    }
  }


  return (
    <section className="topups" aria-labelledby="topups-title">
      <h1 id="topups-title">Recebimentos e recargas</h1>
      <p className="muted">Registre somente recebimentos já conferidos: dinheiro contado, Pix visto na conta, cartão aprovado na maquininha. O valor recebido entra inteiro na carteira; a taxa do meio de pagamento é despesa da cantina.</p>

      <div className="pos-layout">
        <div>
          {roster.status === "error" && <p role="alert" className="notice notice-error">{errorText(roster.errorCode ?? "internal")}</p>}
          {roster.status === "loading" && <p className="muted">Carregando alunos…</p>}
          {roster.data && <StudentPicker prefix="topup" rows={roster.data.students} truncated={roster.data.truncated} disabled={locked} onPick={pick} inputRef={searchRef} />}

          {picked && (
            <section className="pos-selected" aria-labelledby="topup-student-name" data-testid="topup-student">
              <h2 id="topup-student-name">{picked.name}</h2>
              <p>
                {picked.className ?? "Sem turma"} · {picked.shiftName ?? "Sem turno"} · matrícula {picked.enrollment}
              </p>
              {detail.status === "error" && <p role="alert" className="notice notice-error">{errorText(detail.errorCode ?? "internal")}</p>}
              <p className="pos-balance">
                Saldo atual: <strong data-testid="topup-balance">{wallet ? formatBRL(wallet.balanceCents) : "…"}</strong>
              </p>
              {student && student.recent.length > 0 && (
                <>
                  <h3>Últimas recargas deste aluno</h3>
                  <ul className="plain-list">
                    {student.recent.map((t) => (
                      <li key={t.topupId}>
                        <Link href={`/operacao/recebimentos/${t.topupId}`}>
                          {dayMonth(t.receivedOn)} · {formatBRL(t.creditedCents)} · {PAYMENT_LABEL[t.method]}
                        </Link>{" "}
                        <span className="muted">{statusText(t)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </div>

        <section className="pos-cart" aria-labelledby="topup-form-title" data-testid="topup-form">
          <h2 id="topup-form-title">{reviewing ? "Revisar recebimento" : "Recebimento"}</h2>
          {!picked && !done && <p className="muted">Escolha o aluno pela busca para registrar o recebimento.</p>}

          {done && (
            <div className="pos-receipt" data-testid="topup-done">
              <h3 ref={resultRef} tabIndex={-1}>
                Recarga registrada
              </h3>
              <p role="status" data-testid="topup-done-text">
                {formatBRL(done.creditedCents)} creditados na carteira de {done.student.name}. Saldo depois: <strong>{formatBRL(done.balanceAfterCents)}</strong>.
              </p>
              <p>
                <Link href={`/operacao/recebimentos/${done.topupId}`} data-testid="topup-receipt-link">
                  Abrir comprovante
                </Link>
              </p>
            </div>
          )}

          {picked && student && student.student.status !== "active" && <p role="alert" className="notice notice-error">Aluno inativo: não recebe recarga.</p>}

          {picked && student && student.student.status === "active" && !reviewing && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (check.problems.length === 0) {
                  setReviewing(true);
                  setDone(null);
                  setMessage(null);
                }
              }}
            >
              <div className="field">
                <label htmlFor="topup-amount">Valor recebido (R$)</label>
                <input id="topup-amount" type="text" inputMode="decimal" autoComplete="off" value={fields.amountText} disabled={locked} placeholder="50,00" onChange={(e) => setFields({ ...fields, amountText: e.target.value })} data-testid="topup-amount" />
              </div>
              <fieldset className="pos-direct">
                <legend>Forma de recebimento</legend>
                <div className="choice-group" role="radiogroup" aria-label="Forma de recebimento">
                  {PAYMENT_METHODS.map((m) => (
                    <label key={m}>
                      <input type="radio" name="topup-method" value={m} checked={fields.method === m} disabled={locked} onChange={() => setFields({ ...fields, method: m, feeText: m === "cash" ? "" : fields.feeText, expectedOn: m.startsWith("card") ? fields.expectedOn : "" })} data-testid={`topup-method-${m}`} />
                      {PAYMENT_LABEL[m]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="field">
                <label htmlFor="topup-reference">{REFERENCE_LABEL[fields.method]}</label>
                <input id="topup-reference" type="text" autoComplete="off" maxLength={60} value={fields.reference} disabled={locked} onChange={(e) => setFields({ ...fields, reference: e.target.value })} data-testid="topup-reference" />
              </div>
              <div className="form-grid">
                {fields.method !== "cash" && (
                  <div className="field">
                    <label htmlFor="topup-fee">Taxa do meio de pagamento, R$ (se já souber)</label>
                    <input id="topup-fee" type="text" inputMode="decimal" value={fields.feeText} disabled={locked} onChange={(e) => setFields({ ...fields, feeText: e.target.value })} data-testid="topup-fee" />
                  </div>
                )}
                {fields.method.startsWith("card") && (
                  <div className="field">
                    <label htmlFor="topup-expected">Liquidação prevista (opcional)</label>
                    <input id="topup-expected" type="date" value={fields.expectedOn} disabled={locked} onChange={(e) => setFields({ ...fields, expectedOn: e.target.value })} />
                  </div>
                )}
                <div className="field">
                  <label htmlFor="topup-payer">Quem pagou (opcional)</label>
                  <input id="topup-payer" type="text" maxLength={80} value={fields.payerName} disabled={locked} onChange={(e) => setFields({ ...fields, payerName: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="topup-note">Observação da conferência (opcional)</label>
                <input id="topup-note" type="text" maxLength={200} value={fields.note} disabled={locked} onChange={(e) => setFields({ ...fields, note: e.target.value })} />
              </div>
              {fields.amountText.trim() !== "" && check.problems.length > 0 && (
                <ul role="alert" className="notice notice-error plain-list">
                  {check.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              <div className="checkout-actions">
                <button type="submit" disabled={check.problems.length > 0 || locked} data-testid="topup-review">
                  Revisar recebimento
                </button>
              </div>
            </form>
          )}

          {picked && student && reviewing && (
            <div data-testid="topup-review-panel">
              <dl className="receipt-grid">
                <dt>Aluno</dt>
                <dd>
                  <strong>{student.student.name}</strong> · {student.student.className ?? "Sem turma"} · {student.student.shiftName ?? "Sem turno"}
                </dd>
                <dt>Crédito na carteira</dt>
                <dd data-testid="topup-review-credit">
                  <strong>{formatBRL(amount)}</strong> (valor recebido inteiro)
                </dd>
                <dt>Forma</dt>
                <dd>{PAYMENT_LABEL[fields.method]}</dd>
                <dt>Taxa e líquido</dt>
                <dd data-testid="topup-review-net">
                  {fields.method === "cash" ? "Sem taxa · líquido " + formatBRL(amount) : fee === undefined ? "Taxa a conferir depois" : `Taxa ${formatBRL(fee ?? 0)} (despesa da cantina) · líquido ${formatBRL(amount - (fee ?? 0))}`}
                </dd>
                {fields.method.startsWith("card") && (
                  <>
                    <dt>Liquidação</dt>
                    <dd>Aprovado na maquininha · dinheiro ainda não está no banco{fields.expectedOn ? ` (previsto para ${dayMonth(fields.expectedOn)})` : ""}</dd>
                  </>
                )}
                <dt>Referência</dt>
                <dd>{fields.reference.trim() || "—"}</dd>
                <dt>Saldo depois</dt>
                <dd>{wallet ? formatBRL(wallet.balanceCents + amount) : "…"}</dd>
              </dl>
              <label className="check-line">
                <input type="checkbox" checked={fields.confirmed} disabled={locked} onChange={(e) => setFields({ ...fields, confirmed: e.target.checked })} data-testid="topup-confirmed" />
                <span>
                  Confirmo que conferi o recebimento de {formatBRL(amount)} em {PAYMENT_LABEL[fields.method].toLowerCase()}
                  {fields.method === "pix" ? " na conta da cantina" : fields.method.startsWith("card") ? " (aprovado na maquininha)" : ""}.
                </span>
              </label>
              <div className="checkout-actions">
                <button type="button" disabled={!fields.confirmed || submit.busy} aria-busy={submit.busy} onClick={() => void confirm()} data-testid="topup-confirm">
                  {submit.uncertain ? "Tentar novamente a mesma recarga" : `Confirmar recarga de ${formatBRL(amount)}`}
                </button>
                <button type="button" className="secondary" disabled={locked} onClick={() => setReviewing(false)}>
                  Voltar e corrigir
                </button>
              </div>
            </div>
          )}

          {message && (
            <p role="alert" className="notice notice-error" data-testid="topup-message">
              {message.text}
              {message.topupId && (
                <>
                  {" "}
                  <Link href={`/operacao/recebimentos/${message.topupId}`}>Ver o recebimento já lançado</Link>
                </>
              )}
            </p>
          )}
          {submit.uncertain && (
            <p role="alert" className="notice notice-error" data-testid="topup-uncertain">
              Sem resposta do servidor. A recarga pode ter sido registrada: use “Tentar novamente a mesma recarga” (não credita duas vezes).
            </p>
          )}
        </section>
      </div>

      <section className="topup-day" aria-labelledby="topup-day-title">
        <h2 id="topup-day-title">Conferência do dia</h2>
        <div className="toolbar toolbar-compact no-print">
          <div className="field">
            <label htmlFor="topup-day-date">Data</label>
            <input id="topup-day-date" type="date" value={dayDate} onChange={(e) => e.target.value && setDayDate(e.target.value)} />
          </div>
          <label className="check-line">
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} data-testid="topup-only-mine" />
            <span>Só os meus lançamentos</span>
          </label>
        </div>
        {day.status === "error" && <p role="alert" className="notice notice-error">{errorText(day.errorCode ?? "internal")}</p>}
        {day.status === "loading" && <p className="muted">Carregando…</p>}
        {day.data && day.data.topups.length === 0 && <p className="muted">Nenhum recebimento lançado nesta data.</p>}
        {day.data && day.data.topups.length > 0 && (
          <>
            <p data-testid="topup-day-totals">
              {day.data.totals.count} recebimento(s) · creditado {formatBRL(day.data.totals.creditedCents)}
              {PAYMENT_METHODS.filter((m) => day.data!.totals.byMethod[m] > 0).map((m) => ` · ${PAYMENT_LABEL[m]} ${formatBRL(day.data!.totals.byMethod[m])}`)}
              {day.data.totals.reversedCents > 0 && ` · estornado ${formatBRL(day.data.totals.reversedCents)}`}
              {` · taxas informadas ${formatBRL(day.data.totals.feeInformedCents)}`}
              {day.data.totals.feePendingCount > 0 && ` · ${day.data.totals.feePendingCount} taxa(s) a conferir`}
            </p>
            <table className="data-table stock-table" data-testid="topup-day-table">
              <caption className="visually-hidden">Recebimentos da data</caption>
              <thead>
                <tr>
                  <th scope="col">Hora</th>
                  <th scope="col">Aluno</th>
                  <th scope="col">Forma</th>
                  <th scope="col" className="checkout-amount">Creditado</th>
                  <th scope="col" className="checkout-amount">Líquido</th>
                  <th scope="col">Situação</th>
                  <th scope="col">Operador</th>
                </tr>
              </thead>
              <tbody>
                {day.data.topups.map((t) => (
                  <tr key={t.topupId} data-testid="topup-day-row">
                    <td data-label="Hora">{t.receivedAt ? clockLabel(t.receivedAt) : "—"}</td>
                    <th scope="row" data-label="Aluno">
                      <Link href={`/operacao/recebimentos/${t.topupId}`}>{t.student.name}</Link>
                    </th>
                    <td data-label="Forma">
                      {PAYMENT_LABEL[t.method]}
                      {t.reference ? ` · ${t.reference}` : ""}
                    </td>
                    <td className="checkout-amount" data-label="Creditado">{formatBRL(t.creditedCents)}</td>
                    <td className="checkout-amount" data-label="Líquido">{t.netCents === null ? "taxa a conferir" : formatBRL(t.netCents)}</td>
                    <td data-label="Situação">
                      {statusText(t)}
                      <br />
                      <span className="muted">{settlementText(t.settlement)}</span>
                    </td>
                    <td data-label="Operador">{t.operatorName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {day.data.truncated && <p className="notice">Lista cortada no limite: filtre por operador.</p>}
          </>
        )}
      </section>
    </section>
  );
}
