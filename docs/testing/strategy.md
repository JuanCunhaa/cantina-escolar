## 20. Testes e critérios de aceite obrigatórios

Faça testes de domínio em TypeScript, integração com Firebase Emulator Suite (Auth, Firestore e Storage quando aplicável), testes de Security Rules e E2E dos caminhos principais. Inclua testes concorrentes das transações. Mock não prova rules ou integridade; emulador não é evidência de todos os comportamentos/índices/latência de produção, então valide também o fluxo em projeto de homologação com valores fictícios e gateway sandbox. Testes devem verificar regras do negócio e riscos reais.
