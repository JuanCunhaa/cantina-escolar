# Critérios de aceite — infrastructure-ui

## A32

Build, checagem TypeScript strict, lint e testes passam; aplicação funciona em homologação com Firebase Auth/Firestore/Storage, sem arquivos locais como banco.

## A34

Listeners atualizam saldo/pedidos/estoque após commit, usam escopo autorizado e desligam no logout/troca de aluno; dado de cache não confirma compra.

## A35

Callback transacional em retry não chama pagamento/email nem duplica movimentos; documentos de uso diário/semanal impedem contorno dos limites concorrentes.

## A36

Fotos são enviadas ao Storage somente por operador autorizado; tamanho/tipo são validados, fallback funciona e arquivo privado não vaza por URL de produto.

## A37

Interface funciona por teclado e no celular, respeita reduced motion e evita excesso de cards; animação não impede venda/entrega.
