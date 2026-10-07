// Avaliação LOCAL dos resultados Veracode (nada é publicado na plataforma). Fail-closed: arquivo ausente, estrutura não
// reconhecida, análise incompleta ou achado acima do critério reprovam. Critérios (docs/testing/ci.md):
//   SAST (Pipeline Scan): severidade Very High (5) ou High (4) reprova; scan_status diferente de SUCCESS reprova.
//   SCA (agente, --no-upload): vulnerabilidade com CVSS ≥ 7,0 (High/Critical) em pacote da árvore de PRODUÇÃO reprova;
//   em pacote só de desenvolvimento é listada sem bloquear. Nenhuma linha de base automática.
// Uso: node scripts/ci/veracode-report.ts sast <results.json>
//      node scripts/ci/veracode-report.ts sca <srcclr.json> <npm-ls-prod.json>
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SEVERITY = ["Informational", "Very Low", "Low", "Medium", "High", "Very High"] as const;

type SastFinding = { severity: number; cwe_id?: string; issue_type?: string; title?: string; files?: { source_file?: { file?: string; line?: number } } };
type SastResults = { scan_status?: string; message?: string; modules?: string[]; findings?: SastFinding[]; scan_id?: string };

export function evaluateSast(results: SastResults) {
  const problems: string[] = [];
  if (results.scan_status !== "SUCCESS") problems.push(`análise SAST não concluída (scan_status: ${String(results.scan_status ?? "ausente")})`);
  if (!Array.isArray(results.findings)) problems.push("estrutura de resultados SAST não reconhecida (findings ausente)");
  const findings = Array.isArray(results.findings) ? results.findings : [];
  const bySeverity: Record<string, number> = {};
  for (const f of findings) bySeverity[SEVERITY[f.severity] ?? `sev${f.severity}`] = (bySeverity[SEVERITY[f.severity] ?? `sev${f.severity}`] ?? 0) + 1;
  const blocking = findings.filter((f) => f.severity >= 4);
  if (blocking.length) problems.push(`${blocking.length} achado(s) SAST Very High/High`);
  return {
    ok: problems.length === 0,
    problems,
    scan_id: results.scan_id ?? null,
    modules: results.modules ?? [],
    message: results.message ?? null,
    by_severity: bySeverity,
    blocking: blocking.slice(0, 50).map((f) => ({ severity: SEVERITY[f.severity] ?? f.severity, cwe: f.cwe_id ?? null, title: f.title ?? f.issue_type ?? null, file: f.files?.source_file?.file ?? null, line: f.files?.source_file?.line ?? null })),
  };
}

type ScaLibrary = { name?: string; coordinate1?: string; versions?: { version?: string }[] };
type ScaVuln = { title?: string; cve?: string; cvssScore?: number; cvss3Score?: number; libraries?: { _links?: { ref?: string } }[] };
type ScaRecord = { libraries?: ScaLibrary[]; vulnerabilities?: ScaVuln[] };
type NpmTree = { dependencies?: Record<string, NpmTree & { version?: string }> };

export function productionPackages(tree: NpmTree): Set<string> {
  const out = new Set<string>();
  const walk = (deps: NpmTree["dependencies"]) => {
    for (const [name, node] of Object.entries(deps ?? {})) {
      if (node.version) out.add(`${name}@${node.version}`);
      walk(node.dependencies);
    }
  };
  walk(tree.dependencies);
  return out;
}

type LockMeta = { version?: string; optional?: boolean; devOptional?: boolean; peer?: boolean; os?: string[]; cpu?: string[] };
export type Lockfile = { packages?: Record<string, LockMeta> };

/** Pacote da árvore de produção pode faltar no inventário do agente só se for opcional/de outra plataforma (não instalado). */
export function uncoveredProduction(prod: Set<string>, scanned: Set<string>, lock: Lockfile): { expected_missing: string[]; unexpected_missing: string[] } {
  const expected: string[] = [];
  const unexpected: string[] = [];
  const entries = Object.entries(lock.packages ?? {});
  for (const key of [...prod].filter((k) => !scanned.has(k)).sort((a, b) => a.localeCompare(b))) {
    const at = key.lastIndexOf("@");
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    const meta = entries.find(([path, m]) => path.endsWith(`node_modules/${name}`) && m.version === version)?.[1];
    const skippable = Boolean(meta && (meta.optional || meta.devOptional || meta.peer || meta.os || meta.cpu));
    (skippable ? expected : unexpected).push(key);
  }
  return { expected_missing: expected, unexpected_missing: unexpected };
}

export function evaluateSca(report: { records?: ScaRecord[] }, prod: Set<string>, lock?: Lockfile) {
  const problems: string[] = [];
  const record = report.records?.[0];
  if (!record || !Array.isArray(record.libraries) || !Array.isArray(record.vulnerabilities)) {
    return { ok: false, problems: ["estrutura do relatório SCA não reconhecida (records[0].libraries/vulnerabilities)"], libraries: 0, prod_expected: prod.size, findings: [], coverage: null };
  }
  if (!record.libraries.length) problems.push("SCA não identificou nenhuma dependência: análise ineficaz");
  const scanned = new Set(record.libraries.flatMap((l) => (l.versions ?? []).map((v) => `${l.coordinate1 ?? l.name ?? "?"}@${v.version}`)));
  const coverage = lock ? uncoveredProduction(prod, scanned, lock) : null;
  if (coverage?.unexpected_missing.length) problems.push(`dependência(s) de produção fora do inventário do SCA: ${coverage.unexpected_missing.slice(0, 10).join(", ")}`);
  const findings = record.vulnerabilities.flatMap((v) => {
    const score = Math.max(v.cvss3Score ?? 0, v.cvssScore ?? 0);
    return (v.libraries ?? []).map((ref) => {
      const index = Number(ref._links?.ref?.match(/libraries\/(\d+)/)?.[1]);
      const lib = Number.isInteger(index) ? record.libraries![index] : undefined;
      const name = lib?.coordinate1 ?? lib?.name ?? "?";
      const versions = (lib?.versions ?? []).map((x) => x.version).filter(Boolean) as string[];
      const inProd = versions.some((ver) => prod.has(`${name}@${ver}`));
      return { cve: v.cve ?? null, title: v.title ?? null, score, package: `${name}@${versions.join("|")}`, production: inProd, blocking: score >= 7 && inProd };
    });
  });
  const blocking = findings.filter((f) => f.blocking);
  if (blocking.length) problems.push(`${blocking.length} vulnerabilidade(s) CVSS ≥ 7 em dependência de produção`);
  if (findings.some((f) => f.package.startsWith("?@"))) problems.push("vulnerabilidade sem biblioteca identificável: revisar relatório completo");
  return { ok: problems.length === 0, problems, libraries: scanned.size, prod_expected: prod.size, findings, coverage };
}

const writeReport = (env: Record<string, string | undefined>, out: (text: string) => void, name: string, data: unknown, markdown: string) => {
  mkdirSync("ci-results", { recursive: true });
  writeFileSync(`ci-results/${name}.json`, `${JSON.stringify(data, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  out(markdown);
};
const load = (path: string | undefined) => {
  if (!path || !existsSync(path)) throw new Error(`relatório ausente: ${path ?? "(sem caminho)"}`);
  return JSON.parse(readFileSync(path, "utf8"));
};

/** CLI testável: devolve o código de saída. */
export function main(argv: string[], env: Record<string, string | undefined>, out: (text: string) => void = (text) => process.stdout.write(text)): number {
  const [kind, file, extra, lockPath] = argv;
  try {
    if (kind === "sast") {
      const r = evaluateSast(load(file) as SastResults);
      writeReport(env, out, "veracode-sast", r, `### ${r.ok ? "✅" : "❌"} Veracode Pipeline Scan (SAST)\n\n- Severidades: ${JSON.stringify(r.by_severity)}\n- Módulos: ${r.modules.join(", ") || "—"}\n${r.message ? `- Mensagem: ${r.message}\n` : ""}${r.problems.map((p) => `- ${p}\n`).join("")}`);
      return r.ok ? 0 : 1;
    } else if (kind === "sca") {
      const r = evaluateSca(load(file) as { records?: ScaRecord[] }, productionPackages(load(extra) as NpmTree), lockPath ? (load(lockPath) as Lockfile) : undefined);
      writeReport(env, out, "veracode-sca", r, `### ${r.ok ? "✅" : "❌"} Veracode SCA (agente, --no-upload)\n\n- Bibliotecas identificadas (nome@versão): ${r.libraries}; árvore de produção pelo npm ls: ${r.prod_expected}${r.coverage ? ` (fora do inventário: ${r.coverage.expected_missing.length} opcionais/de outra plataforma, ${r.coverage.unexpected_missing.length} inesperadas)` : ""}\n- Achados: ${r.findings.length} (bloqueantes: ${r.findings.filter((f) => f.blocking).length})\n${r.problems.map((p) => `- ${p}\n`).join("")}`);
      return r.ok ? 0 : 1;
    }
    console.error("Uso: node scripts/ci/veracode-report.ts sast <results.json> | sca <srcclr.json> <npm-ls-prod.json> [package-lock.json]");
    return 2;
  } catch (error) {
    console.error(`Avaliação Veracode reprovada: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
