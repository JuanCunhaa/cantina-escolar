# Critérios de aceite — infrastructure-ui

## A32

Build, checagem TypeScript strict, lint e testes passam; aplicação funciona em homologação com Firebase Auth/Firestore e arquivos no R2 (bucket de homologação), sem arquivos locais como banco.

## A34

Listeners atualizam saldo/pedidos/estoque após commit, usam escopo autorizado e desligam no logout/troca de aluno; dado de cache não confirma compra.

## A35

Callback transacional em retry não chama pagamento/email nem duplica movimentos; documentos de uso diário/semanal impedem contorno dos limites concorrentes.

## A36

Fotos são enviadas ao R2 (por upload pelo servidor) somente por operador autorizado; tamanho/tipo/bytes são validados, não há sobrescrita de foto validada, fallback funciona e arquivo privado não vaza por URL de produto (leitura sempre pelo servidor, sem URL permanente).

## A37

Interface funciona por teclado e no celular, respeita reduced motion e evita excesso de cards; animação não impede venda/entrega.
