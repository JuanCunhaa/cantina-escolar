---
name: cantina-security
description: "Revisar autorização, isolamento, sessão, pagamentos, arquivos, segredos e dependências em mudanças da Cantina Escolar."
---

# Verificar segurança da mudança

1. Delimitar arquivos/comandos alterados e fronteira de confiança. Consultar docs/security.md e regras do domínio pertinentes; não repetir auditoria de toda a aplicação por alteração apenas visual.
2. Verificar autenticação/papel/vínculo/política atuais, acesso por ID manipulado, escrita direta Web SDK e negação entre famílias. Não confiar em filtro visual, claim antiga ou Admin SDK com rules corretas.
3. Em sessão/handler, revisar cookie/origem/CSRF/revogação conforme estratégia. Em arquivo, validar tipo/tamanho/caminho e impedir comprovante privado por URL pública.
4. Em finanças/webhook, revisar preço/valor/moeda/conta no servidor, assinatura, replay/ordem, saldo/refund e ausência de segredo em browser/log. Acionar cantina-finance quando tocar invariantes.
5. Usar Gitleaks com redaction para novos segredos e histórico na entrega; Semgrep com regras pertinentes para código sensível; auditoria do gerenciador para mudança de dependências. Comandos e instalação em docs/development-tools.md. Não substituir testes de autorização por scanners.
6. Testar os caminhos negativos reais com cantina-testing, corrigir falhas de escopo e registrar evidência/risco específico. Scanner ausente = não executado; teste não executado = não executado, nunca aprovação implícita.

Não enviar código/dados a serviço cloud de scanner sem necessidade/autorização. Fixar versão/regra na configuração da implementação; revisar licenças e findings, sem suprimir genericamente nem atualizar tudo indiscriminadamente.
