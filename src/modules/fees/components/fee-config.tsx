"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import { errorText } from "@/lib/api-client";
import { formatBRL } from "@/lib/money/format";
import { brDate } from "@/modules/cash/components/cash-text";
import { useServerQuery } from "@/modules/orders/use-operations";
import { usePosSubmit } from "@/modules/pos/use-pos";
import { PAYMENT_LABEL } from "@/modules/payments/methods";
import { FEE_METHODS, SOURCE_KIND_LABEL, type FeeMethod, type SourceKind } from "../fee-model";
import type { FeeConfig } from "../fee-queries";
import { FinanceTabs } from "./finance-tabs";

type Message = { kind: "ok" | "error"; text: string };

/** "3,00" → 300 pontos-base (0,01% cada); no máximo 2 casas; inválido = null. */
export function parsePercentBp(text: string): number | null {
  const m = /^(\d{1,2})(?:[.,](\d{1,2}))?\s*%?$/.exec(text.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp <= 3000 ? bp : null;
}
export const percentText = (bp: number): string => `${(bp / 100).toFixed(2).replace(".", ",")}%`;

const STATE_TEXT = { in_effect: "Em vigor", future: "Futura", superseded: "Substituída", withdrawn: "Retirada" } as const;

export type FeeConfigViewProps = {
  config: FeeConfig;
  message: Message | null;
  locked: boolean;
  onCreateSource: (b: { kind: SourceKind; code: string; name: string; methods: FeeMethod[]; fictitious: boolean }) => void;
  onToggleSource: (sourceId: string, active: boolean, reason: string) => void;
  onPublish: (b: { sourceId: string; method: FeeMethod; effectiveFrom: string; enabled: boolean; percentBp: number; fixedCents: number; settlementDays: number; fictitious: boolean; reason: string }) => void;
  onWithdraw: (b: { sourceId: string; method: FeeMethod; version: number; reason: string }) => void;
};

function SourceForm({ production, locked, onCreate }: { production: boolean; locked: boolean; onCreate: FeeConfigViewProps["onCreateSource"] }) {
  const [kind, setKind] = useState<SourceKind>("terminal");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [methods, setMethods] = useState<FeeMethod[]>(["card_debit", "card_credit"]);
  const [fictitious, setFictitious] = useState(!production);
  const options = kind === "provider" ? (["pix", "card_credit"] as FeeMethod[]) : FEE_METHODS;
  const valid = /^[a-z0-9]{2,24}$/.test(code) && name.trim().length >= 2 && methods.length > 0 && !(production && fictitious);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onCreate({ kind, code, name: name.trim(), methods: methods.filter((m) => options.includes(m)), fictitious });
      }}
    >
      <h2>Cadastrar provedor ou maquininha</h2>
      <div className="form-grid">
        <fieldset className="choice-group">
          <legend>Tipo</legend>
          {(["terminal", "provider"] as SourceKind[]).map((k) => (
            <label key={k}>
              <input type="radio" name="src-kind" checked={kind === k} onChange={() => setKind(k)} /> {SOURCE_KIND_LABEL[k]}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="src-code">Código (letras minúsculas e números)</label>
          <input type="text" id="src-code" value={code} maxLength={24} onChange={(e) => setCode(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="src-name">Nome</label>
          <input type="text" id="src-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </div>
        <fieldset className="choice-group">
          <legend>Meios aceitos</legend>
          {options.map((m) => (
            <label key={m}>
              <input type="checkbox" checked={methods.includes(m)} onChange={(e) => setMethods(e.target.checked ? [...methods, m] : methods.filter((x) => x !== m))} /> {PAYMENT_LABEL[m]}
            </label>
          ))}
        </fieldset>
      </div>
      <label>
        <input type="checkbox" checked={fictitious} disabled={production} onChange={(e) => setFictitious(e.target.checked)} /> Cadastro FICTÍCIO (homologação; recusado em produção)
      </label>
      <div className="checkout-actions">
        <button type="submit" disabled={locked || !valid} data-testid="src-create">
          Cadastrar
        </button>
      </div>
    </form>
  );
}

function RuleForm({ config, locked, onPublish }: { config: FeeConfig; locked: boolean; onPublish: FeeConfigViewProps["onPublish"] }) {
  const active = config.sources.filter((s) => s.active);
  const [sourceId, setSourceId] = useState(active[0]?.sourceId ?? "default");
  const source = active.find((s) => s.sourceId === sourceId) ?? active[0];
  const methods = (source?.methods ?? FEE_METHODS) as FeeMethod[];
  const [method, setMethod] = useState<FeeMethod>(methods[0] ?? "pix");
  const [effectiveFrom, setEffectiveFrom] = useState(config.today);
  const [enabled, setEnabled] = useState(true);
  const [percent, setPercent] = useState("");
  const [fixed, setFixed] = useState("");
  const [days, setDays] = useState("0");
  const [fictitious, setFictitious] = useState(source?.fictitious ?? !config.production);
  const [reason, setReason] = useState("");
  const bp = percent.trim() === "" ? 0 : parsePercentBp(percent);
  const fixedCents = fixed.trim() === "" ? 0 : /^\d+(?:,\d{1,2})?$/.test(fixed.trim()) ? Math.round(Number(fixed.replace(",", ".")) * 100) : null;
  const dayCount = /^\d{1,2}$/.test(days.trim()) ? Number(days) : null;
  const valid = bp !== null && fixedCents !== null && fixedCents <= 10_000 && dayCount !== null && dayCount <= 90 && reason.trim().length >= 10 && effectiveFrom >= config.today && !(config.production && fictitious) && methods.includes(method);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onPublish({ sourceId, method, effectiveFrom, enabled, percentBp: bp, fixedCents: fixedCents!, settlementDays: dayCount!, fictitious, reason: reason.trim() });
      }}
    >
      <h2>Publicar nova versão de regra</h2>
      <p className="muted">Uma versão nunca é editada: mudar a regra cria uma versão com vigência a partir de hoje ou depois. Recebimentos já lançados guardam a versão que usaram.</p>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="rule-source">Fonte</label>
          <select
            id="rule-source"
            value={sourceId}
            onChange={(e) => {
              const s = active.find((x) => x.sourceId === e.target.value);
              setSourceId(e.target.value);
              setMethod((s?.methods[0] as FeeMethod | undefined) ?? "pix");
              setFictitious(s?.fictitious ?? !config.production);
            }}
          >
            {active.map((s) => (
              <option key={s.sourceId} value={s.sourceId}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rule-method">Meio</label>
          <select id="rule-method" value={method} onChange={(e) => setMethod(e.target.value as FeeMethod)}>
            {methods.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_LABEL[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rule-from">Vigência a partir de</label>
          <input id="rule-from" type="date" min={config.today} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="rule-percent">Taxa percentual (ex.: 3,00)</label>
          <input type="text" id="rule-percent" inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} data-testid="rule-percent" />
        </div>
        <div className="field">
          <label htmlFor="rule-fixed">Taxa fixa, R$ (opcional)</label>
          <input type="text" id="rule-fixed" inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="rule-days">Prazo de liquidação (dias corridos)</label>
          <input type="text" id="rule-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
        <div className="field field-wide">
          <label htmlFor="rule-reason">Motivo / origem dos valores (mínimo 10 caracteres)</label>
          <input type="text" id="rule-reason" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="rule-reason" />
        </div>
      </div>
      <label>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Regra ativa (desmarque para encerrar a estimativa a partir da vigência)
      </label>
      <br />
      <label>
        <input type="checkbox" checked={fictitious} disabled={config.production || source?.fictitious === true} onChange={(e) => setFictitious(e.target.checked)} /> Regra FICTÍCIA (homologação; recusada em produção)
      </label>
      <div className="checkout-actions">
        <button type="submit" disabled={locked || !valid} data-testid="rule-publish">
          Publicar versão
        </button>
      </div>
    </form>
  );
}

/** Cadastro de meios/provedores/maquininhas e regras versionadas (parte visual). Nenhum percentual ou prazo é presumido. */
export function FeeConfigView({ config, message, locked, onCreateSource, onToggleSource, onPublish, onWithdraw }: FeeConfigViewProps) {
  const [reasonFor, setReasonFor] = useState<{ key: string; text: string } | null>(null);
  const nameOf = (sourceId: string) => config.sources.find((s) => s.sourceId === sourceId)?.name ?? sourceId;
  return (
    <section aria-labelledby="fees-title">
      <h1 id="fees-title">Financeiro</h1>
      <FinanceTabs current="/operacao/financeiro/taxas" />
      <p className="muted">
        Taxas e prazos vêm do que a escola contratou; nada aqui é presumido. Regras de exemplo ficam marcadas como FICTÍCIAS e não valem em produção. A taxa estimada é só uma previsão: o valor real é conferido na aba Conferência.
      </p>
      {!config.production && (
        <p role="note" className="notice" data-testid="fees-env">
          Ambiente de homologação: cadastros e regras FICTÍCIOS são permitidos.
        </p>
      )}
      {message && (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "notice notice-error" : "notice"} data-testid="fees-message">
          {message.text}
        </p>
      )}

      <h2>Provedores e maquininhas</h2>
      <ul className="plain-list" data-testid="fees-sources">
        {config.sources.map((s) => (
          <li key={s.sourceId}>
            <strong>{s.name}</strong> · {s.kind === "default" ? "Fonte padrão" : SOURCE_KIND_LABEL[s.kind]} · {s.methods.map((m) => PAYMENT_LABEL[m]).join(", ")} · {s.active ? "Ativo" : "Arquivado"}
            {s.kind !== "default" && (
              <>
                {" "}
                {reasonFor?.key === s.sourceId ? (
                  <span>
                    <input type="text" aria-label="Motivo" maxLength={200} value={reasonFor.text} onChange={(e) => setReasonFor({ key: s.sourceId, text: e.target.value })} />{" "}
                    <button type="button" className="secondary" disabled={locked || reasonFor.text.trim().length < 10} onClick={() => onToggleSource(s.sourceId, !s.active, reasonFor.text.trim())}>
                      Confirmar
                    </button>
                  </span>
                ) : (
                  <button type="button" className="secondary" onClick={() => setReasonFor({ key: s.sourceId, text: "" })}>
                    {s.active ? "Arquivar" : "Reativar"}
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>

      <h2>Regras por fonte e meio</h2>
      {config.series.length === 0 && <p className="muted">Nenhuma regra cadastrada: as taxas ficam sem estimativa e pendentes de conferência.</p>}
      {config.series.map((s) => (
        <div key={s.seriesId} data-testid={`fees-series-${s.seriesId}`}>
          <h3>
            {nameOf(s.sourceId)} · {PAYMENT_LABEL[s.method]}
            {s.blockedInProduction && <span className="badge badge-warn"> regra fictícia ignorada em produção</span>}
          </h3>
          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">Versões da regra</caption>
              <thead>
                <tr>
                  <th scope="col">Versão</th>
                  <th scope="col">Vigência</th>
                  <th scope="col">Situação</th>
                  <th scope="col">Percentual</th>
                  <th scope="col">Fixa</th>
                  <th scope="col">Liquidação</th>
                  <th scope="col">Origem</th>
                  <th scope="col">Ação</th>
                </tr>
              </thead>
              <tbody>
                {s.versions.map((v) => (
                  <tr key={v.n}>
                    <th scope="row">v{v.n}</th>
                    <td>{brDate(v.effectiveFrom)}</td>
                    <td>
                      {STATE_TEXT[v.state]}
                      {!v.enabled ? " · encerra a estimativa" : ""}
                    </td>
                    <td>{percentText(v.percentBp)}</td>
                    <td>{formatBRL(v.fixedCents)}</td>
                    <td>D+{v.settlementDays}</td>
                    <td>
                      {v.fictitious ? <span className="badge badge-warn">FICTÍCIA</span> : "Real"} <span className="muted">{v.reason}</span>
                    </td>
                    <td>
                      {v.state === "future" &&
                        (reasonFor?.key === `${s.seriesId}:${v.n}` ? (
                          <span>
                            <input type="text" aria-label="Motivo da retirada" maxLength={200} value={reasonFor.text} onChange={(e) => setReasonFor({ key: `${s.seriesId}:${v.n}`, text: e.target.value })} />{" "}
                            <button type="button" className="secondary" disabled={locked || reasonFor.text.trim().length < 10} onClick={() => onWithdraw({ sourceId: s.sourceId, method: s.method, version: v.n, reason: reasonFor.text.trim() })}>
                              Confirmar
                            </button>
                          </span>
                        ) : (
                          <button type="button" className="secondary" onClick={() => setReasonFor({ key: `${s.seriesId}:${v.n}`, text: "" })}>
                            Retirar
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <RuleForm config={config} locked={locked} onPublish={onPublish} />
      <SourceForm production={config.production} locked={locked} onCreate={onCreateSource} />
    </section>
  );
}

export function FeeConfigPage({ user }: { user: User }) {
  const q = useServerQuery<FeeConfig>(user, "/api/admin/finance/fees", "");
  const submit = usePosSubmit(user);
  const [message, setMessage] = useState<Message | null>(null);

  async function run(url: string, body: Record<string, unknown>, ok: string) {
    setMessage(null);
    const r = await submit.submit(url, body);
    if (!r) return;
    setMessage(r.ok ? { kind: "ok", text: ok } : { kind: "error", text: FEE_ERRORS[r.error] ?? errorText(r.error) });
    q.reload();
  }
  if (q.status === "loading") return <p role="status" className="muted">Carregando…</p>;
  if (!q.data) return <p role="alert" className="notice notice-error">{errorText(q.errorCode ?? "internal")}</p>;
  return (
    <FeeConfigView
      config={q.data}
      message={message}
      locked={submit.busy || submit.uncertain}
      onCreateSource={(b) => void run("/api/admin/finance/sources", b, "Cadastro criado.")}
      onToggleSource={(sourceId, active, reason) => void run("/api/admin/finance/sources/active", { sourceId, active, reason }, active ? "Cadastro reativado." : "Cadastro arquivado.")}
      onPublish={(b) => void run("/api/admin/finance/rules", b, "Nova versão publicada. Lançamentos anteriores não mudam.")}
      onWithdraw={(b) => void run("/api/admin/finance/rules/withdraw", b, "Versão futura retirada.")}
    />
  );
}

const FEE_ERRORS: Record<string, string> = {
  source_exists: "Já existe um cadastro com este código.",
  source_not_found: "Cadastro não encontrado.",
  source_inactive: "Cadastro arquivado: reative-o antes de publicar regra.",
  method_not_in_source: "O cadastro não aceita este meio.",
  fictitious_mismatch: "Regra e cadastro precisam ser ambos fictícios ou ambos reais.",
  fictitious_in_production: "Dados fictícios não são aceitos em produção.",
  effective_in_past: "A vigência não pode ser anterior a hoje: regras não são retroativas.",
  effective_not_after_last: "A vigência precisa ser posterior à da última versão.",
  too_many_versions: "Limite de versões desta regra atingido.",
  version_in_effect: "A versão já está em vigor: publique uma nova em vez de retirá-la.",
  already_withdrawn: "Versão já retirada.",
  version_not_found: "Versão não encontrada.",
  source_reserved: "A fonte padrão não pode ser arquivada.",
};
