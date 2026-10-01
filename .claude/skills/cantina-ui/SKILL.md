---
name: cantina-ui
description: "Construir telas e componentes responsivos, acessíveis e clean com fotos e realtime na Cantina Escolar."
---

# Implementar interface

1. Ler docs/design.md e o trecho da tela em docs/screens.md; consultar domínio para preço, estado e ações permitidas.
2. Implementar fluxo real com dados persistidos, handlers e leituras autorizadas. Usar listas/tabelas/seções abertas; cards só onde úteis. Fotos consistentes/fallback, pt-BR/BRL/data local/aluno claramente identificados.
3. Mostrar loading, vazio, erro, reconexão/cache e indisponibilidade. Não confirmar operação financeira por animação/dado otimista; impedir clique duplo com idempotência servidor.
4. Aplicar teclado/foco/labels/contraste, mobile/tablet/desktop e reduced motion. Animação curta nunca atrasa venda/entrega nem oculta preço/turno/aluno.
5. Acionar cantina-testing para E2E do caminho alterado e inspeção visual pertinente; inspecionar render, não somente snapshot textual.
6. Se problema é listener/sessão/upload, usar cantina-firebase; restrições e autorização exigem cantina-security. Não copiar dados reais de crianças para exemplos.
