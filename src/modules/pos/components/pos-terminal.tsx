"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalOption } from "@/modules/fees/fee-queries";
import type { User } from "firebase/auth";
import { errorText } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import { longDayLabel } from "@/modules/menu/format";
import { useServerQuery } from "@/modules/orders/use-operations";
import type { CounterSaleResult, DirectSaleResult } from "../commands";
import { MAX_POS_LINES, MAX_POS_QUANTITY, PAYMENT_LABEL } from "../model";
import type { PosCatalog, PosRoster, PosStudent, PosStudentRow } from "../queries";
import { usePosSubmit } from "../use-pos";
import { bumpFrequent, defaultShiftId, readFrequent, type CartLine } from "../view";
import { ProductPicker } from "./product-picker";
import { EMPTY_DIRECT, feeCentsOf, SalePanel, type DirectFields } from "./sale-panel";
import { StudentPicker } from "./student-picker";

type Mode = "student" | "direct";
type Receipt = { kind: "student"; sale: CounterSaleResult; replayed: boolean } | { kind: "direct"; sale: DirectSaleResult; replayed: boolean };
type Wallet = { balanceCents: number; version: number };

const SERVICE_TEXT = { closed: "Hoje não é dia de atendimento (ou o turno não está ativo): o balcão não vende.", suspended: "O atendimento deste turno está suspenso hoje pelo cardápio: o balcão não vende." } as const;

/** Mensagem humana para a recusa do servidor, com o detalhe que ajuda o operador a decidir. */
function refusalText(code: string, details: Record<string, unknown> | undefined): string {
  if (code === "insufficient_stock") return `${errorText(code)}${typeof details?.available === "number" ? ` Livres agora: ${details.available}.` : ""}`;
  if (code === "insufficient_balance" && typeof details?.balanceCents === "number") return `Saldo insuficiente: o aluno tem ${formatBRL(details.balanceCents)} e a venda é de ${formatBRL(Number(details.requiredCents ?? 0))}.`;
  if (code === "entry_required") return `${errorText(code)}${typeof details?.missingUnits === "number" ? ` Registre a entrada de ${details.missingUnits} unidade(s) em Estoque.` : ""}`;
  if (code === "policy_denied") return "A política do responsável não permite esta compra (bloqueio ou limite do dia/semana). Retire os itens ou use uma autorização registrada.";
  return errorText(code);
}

/** PDV: aluno por busca nominal → produtos → carrinho → revisão → confirmação; ou venda direta sem aluno. */
export function PosTerminal({ user }: { user: User }) {
  // A lista de alunos (centenas de documentos) não é relida a cada volta do foco à aba: só no carregamento e pelo botão.
  const roster = useServerQuery<PosRoster>(user, "/api/pos/students", "", true, false);
  const [mode, setMode] = useState<Mode>("student");
  const [studentId, setStudentId] = useState<string | null>(null);
  const [picked, setPicked] = useState<PosStudentRow | null>(null);
  const detail = useServerQuery<PosStudent>(user, "/api/pos/students", `id=${studentId ?? ""}`, studentId !== null);
  const [directShift, setDirectShift] = useState("");
  const [direct, setDirect] = useState<DirectFields>(EMPTY_DIRECT);
  const terminals = useServerQuery<{ terminals: TerminalOption[] }>(user, "/api/finance/terminals", "", true, false);
  const [cart, setCart] = useState<CartLine[]>([]);
  // Preços devolvidos numa mudança de preço valem só para o cardápio carregado naquele momento: um cardápio recarregado os substitui.
  const [priceOverride, setPriceOverride] = useState<{ base: PosCatalog | null; map: Record<string, number> }>({ base: null, map: {} });
  const [exceptionId, setExceptionId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [frequent, setFrequent] = useState<Record<string, number>>(() => (typeof window === "undefined" ? {} : readFrequent()));
  const studentRef = useRef<HTMLInputElement>(null);
  const productRef = useRef<HTMLInputElement>(null);
  const receiptRef = useRef<HTMLHeadingElement>(null);
  const sale = usePosSubmit(user);

  const shifts = roster.data?.shifts;
  const shiftId = mode === "student" ? (detail.data?.student.shiftId ?? "") : directShift || (shifts ? defaultShiftId(shifts) : "");
  const catalog = useServerQuery<PosCatalog>(user, "/api/pos/catalog", `shiftId=${shiftId}`, shiftId !== "" && (mode === "direct" || studentId !== null));
  const products = useMemo(() => catalog.data?.products ?? [], [catalog.data]);
  const prices = useMemo(() => (priceOverride.base === catalog.data ? priceOverride.map : {}), [priceOverride, catalog.data]);
  const student = mode === "student" && detail.data && detail.data.student.id === studentId ? detail.data : null;
  // O saldo exibido é o de maior `version`: a resposta da venda nunca é substituída por uma leitura mais antiga.
  const balance = student ? (wallet && wallet.version >= student.wallet.version ? wallet.balanceCents : student.wallet.balanceCents) : null;
  const studentWithBalance = student && balance !== null ? { ...student, wallet: { ...student.wallet, balanceCents: balance } } : student;
  const locked = sale.busy || sale.uncertain;

  const blockedIds = useMemo(() => {
    if (!student || exceptionId) return new Set<string>();
    const ids = new Set<string>();
    for (const p of products) if (student.restrictions.blockedProductIds.includes(p.id) || student.restrictions.blockedCategoryIds.includes(p.categoryId)) ids.add(p.id);
    return ids;
  }, [student, products, exceptionId]);

  // Teclas rápidas: "/" foca a busca de aluno e F2 a busca de produto.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        studentRef.current?.focus();
      } else if (e.key === "F2") {
        e.preventDefault();
        productRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (receipt) receiptRef.current?.focus();
  }, [receipt]);

  function resetSale(keepStudent: boolean) {
    setCart([]);
    setPriceOverride({ base: null, map: {} });
    setExceptionId(null);
    setReviewing(false);
    setMessage(null);
    setDirect((d) => ({ ...EMPTY_DIRECT, paymentMethod: d.paymentMethod, buyerKind: d.buyerKind }));
    if (!keepStudent) {
      setStudentId(null);
      setPicked(null);
      setWallet(null);
    }
  }

  function chooseMode(next: Mode) {
    if (locked || next === mode) return;
    setMode(next);
    resetSale(false);
    setReceipt(null);
  }

  function pickStudent(row: PosStudentRow) {
    if (locked) return;
    resetSale(false);
    setReceipt(null);
    setStudentId(row.id);
    setPicked(row);
    setTimeout(() => productRef.current?.focus(), 0);
  }

  const add = useCallback(
    (productId: string, quantity: number) => {
      setReviewing(false);
      setMessage(null);
      setCart((current) => {
        const existing = current.find((l) => l.productId === productId);
        if (existing) return current.map((l) => (l.productId === productId ? { ...l, quantity: Math.min(MAX_POS_QUANTITY, l.quantity + quantity) } : l));
        return current.length >= MAX_POS_LINES ? current : [...current, { productId, quantity: Math.min(MAX_POS_QUANTITY, quantity) }];
      });
    },
    [],
  );
  const setQty = (productId: string, quantity: number) => {
    setReviewing(false);
    const max = products.find((p) => p.id === productId)?.availableUnits ?? MAX_POS_QUANTITY;
    setCart((current) =>
      current.flatMap((l) => (l.productId !== productId ? [l] : Number.isFinite(quantity) && quantity >= 1 ? [{ ...l, quantity: Math.min(quantity, MAX_POS_QUANTITY, Math.max(1, max)) }] : [])),
    );
  };

  /** Preço que o operador VÊ (o do cardápio carregado, ou o que o servidor devolveu numa mudança de preço). */
  const priceOf = (productId: string) => prices[productId] ?? products.find((p) => p.id === productId)?.priceCents ?? 0;
  const linesBody = () => cart.map((l) => ({ productId: l.productId, quantity: l.quantity, expectedPriceCents: priceOf(l.productId) }));

  function onRefused(code: string, details: Record<string, unknown> | undefined) {
    if (code === "price_changed") {
      const changes = (details?.changes ?? []) as { productId: string; currentPriceCents: number }[];
      // Os preços novos entram na lista e a tela volta ao carrinho: o operador vê o novo total e confirma de novo.
      setPriceOverride((o) => ({ base: catalog.data, map: { ...(o.base === catalog.data ? o.map : {}), ...Object.fromEntries(changes.map((c) => [c.productId, c.currentPriceCents])) } }));
      setReviewing(false);
      catalog.reload();
      setMessage({ kind: "error", text: `${errorText(code)} Novo total: ${formatBRL(Number((details?.cart as { totalCents?: number } | undefined)?.totalCents ?? 0))}.` });
      return;
    }
    setMessage({ kind: "error", text: refusalText(code, details) });
    if (["shift_changed", "item_unavailable", "insufficient_stock", "entry_required", "student_inactive", "policy_denied"].includes(code)) {
      setReviewing(false);
      catalog.reload();
      if (studentId) detail.reload();
    }
  }

  async function confirm() {
    setMessage(null);
    if (mode === "student" && student) {
      const result = await sale.submit<CounterSaleResult & { replayed: boolean }>("/api/pos/sales", { studentId: student.student.id, expectedShiftId: student.student.shiftId, lines: linesBody(), ...(exceptionId ? { exceptionId } : {}) });
      if (!result) return;
      if (!result.ok) {
        if (result.status !== 0 && result.status < 500 && result.status !== 408 && result.status !== 429) onRefused(result.error, result.details);
        return;
      }
      setWallet(result.data.wallet);
      setReceipt({ kind: "student", sale: result.data, replayed: result.data.replayed });
      bumpFrequent(cart.map((l) => l.productId));
      setFrequent(readFrequent());
      resetSale(true);
      detail.reload();
      catalog.reload();
    } else if (mode === "direct") {
      const fee = feeCentsOf(direct);
      const result = await sale.submit<DirectSaleResult & { replayed: boolean }>("/api/pos/direct-sales", {
        shiftId,
        lines: linesBody(),
        paymentMethod: direct.paymentMethod,
        receivedConfirmed: true,
        buyerKind: direct.buyerKind,
        ...(direct.buyerNote.trim() ? { buyerNote: direct.buyerNote.trim() } : {}),
        ...(typeof fee === "number" ? { feeCents: fee } : {}),
        ...(direct.sourceId ? { sourceId: direct.sourceId } : {}),
      });
      if (!result) return;
      if (!result.ok) {
        if (result.status !== 0 && result.status < 500 && result.status !== 408 && result.status !== 429) onRefused(result.error, result.details);
        return;
      }
      setReceipt({ kind: "direct", sale: result.data, replayed: result.data.replayed });
      bumpFrequent(cart.map((l) => l.productId));
      setFrequent(readFrequent());
      resetSale(false);
      catalog.reload();
    }
  }

  const effectiveProducts = useMemo(() => products.map((p) => (prices[p.id] !== undefined ? { ...p, priceCents: prices[p.id]! } : p)), [products, prices]);
  const serviceDown = catalog.data && catalog.data.service !== "open";
  const ready = (mode === "student" && studentId !== null && student !== null) || mode === "direct";

  return (
    <div className="pos" data-testid="pos">
      <h1>PDV de balcão</h1>
      <p className="muted">
        {(catalog.data?.today ?? roster.data?.today) ? `Hoje: ${longDayLabel((catalog.data?.today ?? roster.data?.today)!)} · ` : ""}atalhos: <kbd>/</kbd> aluno, <kbd>F2</kbd> produto, Enter na busca adiciona o primeiro resultado.
      </p>
      <div className="order-tabs" role="tablist" aria-label="Tipo de venda">
        <button type="button" role="tab" aria-selected={mode === "student"} className={mode === "student" ? "" : "secondary"} disabled={locked} onClick={() => chooseMode("student")} data-testid="pos-tab-student">Venda com saldo do aluno</button>
        <button type="button" role="tab" aria-selected={mode === "direct"} className={mode === "direct" ? "" : "secondary"} disabled={locked} onClick={() => chooseMode("direct")} data-testid="pos-tab-direct">Venda direta (sem aluno)</button>
      </div>

      {roster.status === "loading" && <p role="status">Carregando alunos…</p>}
      {roster.status === "error" && (
        <p role="alert" className="notice notice-error">
          {errorText(roster.errorCode ?? "internal")} <button type="button" className="secondary" onClick={roster.reload}>Tentar de novo</button>
        </p>
      )}

      {receipt && (
        <section aria-labelledby="pos-receipt-title" className="pos-receipt" data-testid="pos-receipt">
          <h2 id="pos-receipt-title" tabIndex={-1} ref={receiptRef}>{receipt.replayed ? "Venda já registrada" : "Venda registrada"}</h2>
          {receipt.kind === "student" ? (
            <p>
              <strong>{receipt.sale.studentName}</strong>: {formatBRL(receipt.sale.totalCents)} debitados da carteira e entregues. Saldo agora: <strong data-testid="pos-receipt-balance">{formatBRL(receipt.sale.wallet.balanceCents)}</strong>.
            </p>
          ) : (
            <p>
              Venda direta de {formatBRL(receipt.sale.totalCents)} recebida em {PAYMENT_LABEL[receipt.sale.paymentMethod].toLowerCase()}
              {receipt.sale.fee.status === "pending" ? " (taxa a conferir)" : receipt.sale.netCents !== null && receipt.sale.paymentMethod !== "cash" ? ` · líquido ${formatBRL(receipt.sale.netCents)}` : ""}.
            </p>
          )}
          <ul className="plain-list">
            {receipt.sale.items.map((i) => (
              <li key={i.lineNo}>
                {i.quantity}× {i.name} · {formatBRL(i.subtotalCents)}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => { setReceipt(null); if (mode === "student") { setStudentId(null); setPicked(null); setWallet(null); setTimeout(() => studentRef.current?.focus(), 0); } else productRef.current?.focus(); }} data-testid="pos-new-sale">
            Nova venda
          </button>
          {mode === "student" && (
            <button type="button" className="secondary" onClick={() => setReceipt(null)} data-testid="pos-same-student">
              Mais uma venda para o mesmo aluno
            </button>
          )}
        </section>
      )}

      {mode === "direct" && shifts && (
        <div className="field">
          <label htmlFor="pos-direct-shift">Turno do cardápio</label>
          <select id="pos-direct-shift" value={shiftId} disabled={locked} onChange={(e) => { setDirectShift(e.target.value); setCart([]); setPriceOverride({ base: null, map: {} }); setReviewing(false); }}>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      )}

      {mode === "student" && roster.data && !receipt && (!studentId || !picked) && (
        <StudentPicker rows={roster.data.students} truncated={roster.data.truncated} disabled={locked} onPick={pickStudent} inputRef={studentRef} />
      )}

      {mode === "student" && studentId && (
        <section aria-labelledby="pos-selected-title" className="pos-selected" data-testid="pos-selected">
          <h2 id="pos-selected-title">Aluno selecionado</h2>
          {detail.status === "loading" && <p role="status">Carregando o aluno…</p>}
          {detail.status === "error" && !detail.data && <p role="alert" className="notice notice-error">{errorText(detail.errorCode ?? "internal")}</p>}
          {studentWithBalance && (
            <>
              <p>
                <strong data-testid="pos-student-name">{studentWithBalance.student.name}</strong> · {studentWithBalance.student.className ?? "Sem turma"} · {studentWithBalance.student.shiftName ?? "Sem turno"} · matrícula {studentWithBalance.student.enrollment}
              </p>
              <p className="pos-balance">
                Saldo: <strong data-testid="pos-balance">{formatBRL(studentWithBalance.wallet.balanceCents)}</strong>
                {detail.refreshing && <span className="muted"> · atualizando…</span>}
              </p>
              {!studentWithBalance.counterAllowed && <p role="alert" className="notice notice-error" data-testid="pos-counter-blocked">Compra no balcão não liberada pelo responsável: a venda com saldo está bloqueada para este aluno.</p>}
              <ul className="plain-list pos-restrictions" aria-label="Restrições de hoje">
                <li>
                  Limite diário: {studentWithBalance.restrictions.dailyLimitCents === null ? "sem teto" : `${formatBRL(studentWithBalance.restrictions.dailyLimitCents)} (comprometido hoje ${formatBRL(studentWithBalance.restrictions.dayCommittedCents)})`}
                </li>
                <li>
                  Limite semanal: {studentWithBalance.restrictions.weeklyLimitCents === null ? "sem teto" : `${formatBRL(studentWithBalance.restrictions.weeklyLimitCents)} (semana de ${studentWithBalance.restrictions.weekStart.split("-").reverse().join("/")}: ${formatBRL(studentWithBalance.restrictions.weekCommittedCents)})`}
                </li>
                {studentWithBalance.restrictions.remainingTodayCents !== null && <li data-testid="pos-remaining">Ainda cabe hoje: <strong>{formatBRL(studentWithBalance.restrictions.remainingTodayCents)}</strong></li>}
                {blockedNames(studentWithBalance, products).length > 0 && <li>Bloqueado pelo responsável: {blockedNames(studentWithBalance, products).join(", ")}</li>}
              </ul>
              <button type="button" className="secondary" disabled={locked} onClick={() => { resetSale(false); setTimeout(() => studentRef.current?.focus(), 0); }} data-testid="pos-change-student">
                Trocar de aluno
              </button>
            </>
          )}
        </section>
      )}

      {ready && catalog.status === "loading" && <p role="status">Carregando produtos de hoje…</p>}
      {ready && catalog.status === "error" && !catalog.data && <p role="alert" className="notice notice-error">{errorText(catalog.errorCode ?? "internal")} <button type="button" className="secondary" onClick={catalog.reload}>Tentar de novo</button></p>}
      {serviceDown && <p role="alert" className="notice notice-error" data-testid="pos-service-down">{SERVICE_TEXT[catalog.data!.service as "closed" | "suspended"]}</p>}

      {ready && catalog.data && !serviceDown && (
        <div className="pos-layout">
          <ProductPicker products={effectiveProducts} cart={cart} disabled={locked || (mode === "student" && !student?.counterAllowed)} blockedIds={blockedIds} frequent={frequent} onAdd={add} searchRef={productRef} />
          <SalePanel
            mode={mode}
            cart={cart}
            products={effectiveProducts}
            student={studentWithBalance}
            balanceCents={balance}
            locked={locked}
            busy={sale.busy}
            uncertain={sale.uncertain}
            reviewing={reviewing}
            exceptionId={exceptionId}
            direct={direct}
            terminals={terminals.data?.terminals}
            message={message}
            onQty={setQty}
            onRemove={(id) => setQty(id, 0)}
            onClear={() => { setCart([]); setExceptionId(null); setMessage(null); }}
            onException={setExceptionId}
            onDirect={setDirect}
            onReview={() => { setMessage(null); setReviewing(true); }}
            onBack={() => setReviewing(false)}
            onConfirm={() => void confirm()}
          />
        </div>
      )}
    </div>
  );
}

function blockedNames(student: PosStudent, products: readonly { id: string; name: string; categoryId: string; categoryName: string }[]): string[] {
  const out = new Set<string>();
  for (const p of products) {
    if (student.restrictions.blockedProductIds.includes(p.id)) out.add(p.name);
    if (student.restrictions.blockedCategoryIds.includes(p.categoryId)) out.add(`categoria ${p.categoryName || p.categoryId}`);
  }
  return [...out];
}
