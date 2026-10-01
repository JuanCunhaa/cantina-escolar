---
name: cantina-release
description: "Preparar evidências, configuração, backup/restauração e entrega Vercel/Firebase da Cantina Escolar; não publica automaticamente."
---

# Preparar entrega

1. Ler docs/tasks/F24.md, docs/deployment.md, docs/delivery.md e pendências externas. Conferir evidência A01–A38 e CI sem transformar pendência de sandbox em sucesso.
2. Conferir versões/lockfile/runtime, separação emulator/homologação/produção, segredos, domínios, callbacks, regiões, rules/índices, bucket R2 (privado, por ambiente) e planos/custos atuais (nada de assinatura/faturamento sem autorização).
3. Validar bootstrap/migrações idempotentes/dry-run, backup/restauração em homologação, reconstrução e guia operacional. Seeds nunca entram em produção por build.
4. Preparar checklist concreto e comandos de implantação revisáveis. Operações reais só dentro de autorização já existente; skill sozinha não autoriza deploy, faturamento ou movimentação de dinheiro.
5. Entregar status, evidências e bloqueios específicos. Atualizar PROGRESS.md; não declarar operação pronta com API/credencial ausente.
