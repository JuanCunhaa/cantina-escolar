### 18.2 Security Rules e arquivos

Negue por padrão. Clientes podem ler apenas os documentos que suas permissões permitem e não podem escrever saldo, movimentos financeiros, preços autorizados, estoque, papéis, vínculos ou agregados. Preferencialmente, todas as alterações de negócio passam pelo servidor. Rules devem suportar listeners familiares de pedidos/carteira sem abrir coleção geral.

Lembre que rules autorizam documento inteiro, não ocultam campos individuais. Separe cadastro público de produto dos dados de custo/fornecedor, e perfil necessário de aluno dos dados administrativos restritos. Projeções de leitura são permitidas para essa separação; atualize-as de forma controlada. Não utilizar filtro visual como segurança.

Storage Rules: somente funcionários autorizados enviam/alteram fotos de produtos; validar caminho, tipo e tamanho. Imagens do cardápio seguem política de leitura apropriada; comprovantes privados não recebem URL pública permanente/token compartilhável como mecanismo de proteção. Associe metadados ao Firestore sem tornar o arquivo privado acessível a outra família. Defina limpeza de uploads abandonados e substituição de foto preservando pedidos antigos quando necessário.
