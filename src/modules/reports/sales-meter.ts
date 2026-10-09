/**
 * Medidor de leituras do relatório de vendas (F21): conta, no servidor, os documentos que cada abertura consulta, por etiqueta.
 * É ESTIMATIVA do que a aplicação pediu ao Firestore (documentos devolvidos por consulta, mínimo 1 por consulta; agregação = 1 por
 * 1 000 entradas de índice, mínimo 1) — NÃO é a cobrança oficial, que só o console/faturamento do Firebase mostra. Serve para provar
 * que reabrir um período não relê o histórico e para orçar a cota gratuita (50 000 leituras/dia) das validações.
 */
export type ReadStats = { estimatedReads: number; estimatedWrites: number; byLabel: Record<string, number> };

export class ReadMeter {
  private total = 0;
  private writes = 0;
  private readonly labels: Record<string, number> = {};

  /** `n` documentos lidos sob a etiqueta. */
  read(label: string, n: number): void {
    const count = Math.max(0, Math.trunc(n));
    this.total += count;
    this.labels[label] = (this.labels[label] ?? 0) + count;
  }

  /** Consulta que devolveu `size` documentos: custa no mínimo 1 leitura mesmo vazia. */
  query(label: string, size: number): void {
    this.read(label, Math.max(1, size));
  }

  /** Agregação (count/sum): 1 leitura por 1 000 entradas de índice, no mínimo 1. */
  aggregate(label: string, matched: number): void {
    this.read(label, Math.max(1, Math.ceil(matched / 1000)));
  }

  write(n: number): void {
    this.writes += n;
  }

  snapshot(): ReadStats {
    return { estimatedReads: this.total, estimatedWrites: this.writes, byLabel: { ...this.labels } };
  }
}
