---
name: cantina-firebase
description: "Implementar Auth, Firestore, Storage, schema, consultas, índices, listeners e regras Firebase da Cantina Escolar."
---

# Implementar Firebase

1. Consultar rota da tarefa e somente schema/queries/Auth/rules relevantes em docs/firebase. Usar Firebase CLI e emuladores locais; plugin/MCP oficial é opcional para tarefa concreta na conta/projeto.
2. Planejar documentos pequenos, índices e consultas autorizáveis, isolamento entre famílias e separação de campos públicos/custos. Não tratar rules como filtro ou autorização por campo.
3. Implementar Web SDK autenticado para listeners e Admin SDK server-only para comandos. Server Admin exige autorização explícita porque ignora rules.
4. Para gravação sensível, usar cantina-finance e docs/firebase/transactions.md. Manter IDs/idempotência, todas as leituras antes das escritas, políticas/vínculos atuais e I/O externo fora do callback.
5. Atualizar firebase/firestore.rules, storage.rules e índices reais. Testar deny-by-default, família A versus B, acesso direto indevido e upload tipo/tamanho/caminho/papel no Emulator Suite.
6. Limitar consultas/listeners, cleanup, reconexão/cache e paginação; documentar consumo relevante. Migrar/seedar só ambiente explicitamente permitido, com dry-run quando aplicável.
7. Registrar evidência Firebase obtida. Emulador não comprova índice, latência, quota ou configuração cloud; manter homologação pendente quando ausente.

Documentação oficial a consultar sob demanda: docs/development-tools.md. Não criar/configurar projeto real, habilitar faturamento ou publicar rules por iniciar esta skill.
