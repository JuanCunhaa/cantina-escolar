"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { api, errorText } from "@/lib/api-client";
import { localDateOf } from "@/lib/dates/school-time";
import { formatBRL } from "@/lib/money/format";
import { useFamilyStudents } from "@/modules/guardians/use-family-students";
import { clockLabel, longDayLabel } from "@/modules/menu/format";
import { ENTRY_TYPES, type EntryType } from "../model";
import type { StatementPage } from "../queries";

const TYPE_LABEL: Record<EntryType, string> = {
  topup: "Recarga",
  advance_purchase: "Compra antecipada",
  counter_purchase: "Compra no balcão",
  order_refund: "Reembolso de pedido",
  transfer_out: "Transferência enviada",
  transfer_in: "Transferência recebida",
  adjustment: "Ajuste",
};

type Entries = StatementPage["entries"];
type State = { key: string; status: "loading" | "ready" | "error"; code: string | null; entries: Entries; next: string | null; loadingMore: boolean; moreError: boolean };
const INITIAL: State = { key: "", status: "loading", code: null, entries: [], next: null, loadingMore: false, moreError: false };

/**
 * Extrato (livro) por aluno, paginado por cursor, com filtros de tipo e período. Movimentos são imutáveis: não há
 * edição. Cada troca de conta, aluno ou filtro abre uma nova geração e descarta respostas em voo da anterior.
 */
export function Statement({ user }: { user: User }) {
  const family = useFamilyStudents(user.uid);
  const [chosen, setChosen] = useState("");
  const students = family.students;
  const studentId = students.some((s) => s.id === chosen) ? chosen : (students[0]?.id ?? "");
  const [type, setType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [raw, setState] = useState<State>(INITIAL);
  const generation = useRef(0);
  const userRef = useRef(user);
  const nextRef = useRef<string | null>(null);
  const uid = user.uid;
  const key = `${uid}|${studentId}|${type}|${from}|${to}`;
  // Estado de outro aluno/filtro/conta nunca é exibido: a chave diferente volta a "carregando".
  const state = raw.key === key ? raw : { ...INITIAL, key };
  useEffect(() => {
    userRef.current = user;
    nextRef.current = state.next;
  });

  const url = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams({ studentId });
      for (const [k, v] of [["type", type], ["from", from], ["to", to], ["cursor", cursor]] as const) if (v) params.set(k, v);
      return `/api/wallets/entries?${params}`;
    },
    [studentId, type, from, to],
  );

  const load = useCallback(async () => {
    const started = ++generation.current;
    const result = await api<StatementPage>(userRef.current, "GET", url(), undefined, { timeoutMs: 15000 });
    if (started !== generation.current) return;
    setState(result.ok ? { ...INITIAL, key, status: "ready", entries: result.data.entries, next: result.data.nextCursor } : { ...INITIAL, key, status: "error", code: result.error });
  }, [url, key]);

  useEffect(() => {
    if (!studentId) return;
    void load();
    return () => {
      generation.current += 1;
    };
  }, [studentId, load]);

  const loadMore = async () => {
    const cursor = nextRef.current;
    if (!cursor) return;
    const started = generation.current;
    setState((s) => (s.key === key ? { ...s, loadingMore: true, moreError: false } : s));
    const result = await api<StatementPage>(userRef.current, "GET", url(cursor), undefined, { timeoutMs: 15000 });
    if (started !== generation.current) return;
    setState((s) => {
      if (s.key !== key) return s;
      if (!result.ok) return { ...s, loadingMore: false, moreError: true };
      const known = new Set(s.entries.map((e) => e.id));
      return { ...s, loadingMore: false, entries: [...s.entries, ...result.data.entries.filter((e) => !known.has(e.id))], next: result.data.nextCursor };
    });
  };

  if (family.status === "loading") return <p role="status">Carregando os alunos…</p>;
  if (family.status === "error" || students.length === 0)
    return (
      <section>
        <h1>Extrato</h1>
        <p role={family.status === "error" ? "alert" : undefined}>{family.status === "error" ? "Não foi possível carregar os alunos vinculados." : "Nenhum aluno vinculado a esta conta."}</p>
      </section>
    );
  const names = new Map(students.map((s) => [s.id, s.name]));
  return (
    <section data-testid="statement">
      <h1>Extrato</h1>
      <p className="muted">Livro de movimentos da carteira de cada aluno, do mais novo ao mais antigo. Movimentos não são editados: correções entram como novos movimentos.</p>
      <form className="toolbar" aria-label="Filtros do extrato" onSubmit={(e) => e.preventDefault()}>
        <div className="field">
          <label htmlFor="st-student">Aluno</label>
          <select id="st-student" value={studentId} onChange={(e) => setChosen(e.target.value)}>
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="st-type">Tipo</label>
          <select id="st-type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Todos</option>
            {ENTRY_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="st-from">De</label>
          <input id="st-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="st-to">Até</label>
          <input id="st-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </div>
      </form>
      <div role="status" aria-live="polite">
        {state.status === "loading" && <p>Carregando o extrato…</p>}
      </div>
      {state.status === "error" && (
        <div role="alert" className="notice notice-error" data-testid="statement-error">
          <p>{errorText(state.code ?? "internal")}</p>
          <button type="button" className="secondary" onClick={() => void load()}>
            Tentar de novo
          </button>
        </div>
      )}
      {state.status === "ready" && state.entries.length === 0 && <p data-testid="statement-empty">Nenhum movimento neste filtro.</p>}
      {state.status === "ready" && state.entries.length > 0 && (
        <div className="table-scroll">
          <table className="data-table" data-testid="statement-table">
            <caption className="visually-hidden">Movimentos de {names.get(studentId)}</caption>
            <thead>
              <tr>
                <th scope="col">Quando</th>
                <th scope="col">Movimento</th>
                <th scope="col">Valor</th>
                <th scope="col">Saldo após</th>
              </tr>
            </thead>
            <tbody>
              {state.entries.map((e) => (
                <tr key={e.id} data-testid="statement-row">
                  <td>{e.createdAt ? `${longDayLabel(localDateOf(new Date(e.createdAt)))} ${clockLabel(e.createdAt)}` : "—"}</td>
                  <td>
                    {TYPE_LABEL[e.type] ?? "Movimento"}
                    {e.counterpartStudentId ? ` (${names.get(e.counterpartStudentId) ?? "outro aluno"})` : ""}
                    {e.orderId && (
                      <>
                        {" · "}
                        <Link href={`/portal/pedidos/${e.orderId}`}>pedido</Link>
                      </>
                    )}
                  </td>
                  <td>{formatBRL(e.amountCents)}</td>
                  <td>{formatBRL(e.balanceAfterCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {state.status === "ready" && state.next && (
        <div>
          <button type="button" className="secondary" disabled={state.loadingMore} onClick={() => void loadMore()} data-testid="statement-more">
            {state.loadingMore ? "Carregando…" : "Carregar mais movimentos"}
          </button>
          {state.moreError && (
            <p role="alert" className="notice notice-error">
              Não foi possível carregar mais. Tente de novo.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
