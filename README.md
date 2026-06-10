# Sistema de Figurinhas P2P

Aplicação Node.js sem servidor central para cadastrar, localizar e trocar figurinhas em uma rede P2P não estruturada. O transporte entre os nós usa WebSocket e mensagens JSON UTF-8.

## Recursos

- Os oito tipos obrigatórios: `HELLO`, `SEARCH`, `SEARCH_HIT`, `SEARCH_MISS`, `TRADE_OFFER`, `TRADE_ACCEPT`, `TRADE_REJECT` e `TRANSFER_CONFIRM`.
- Busca por inundação com TTL padrão 7, rota reversa e supressão persistente de `query_id`.
- Inventário persistente, iniciado com 28 cópias da figurinha autoral.
- Reserva de unidades durante negociações e bloqueio de inventário negativo.
- Descoberta de peers pelo campo `peers` de `HELLO`.
- Painel web para inventário, vizinhos, buscas e trocas.
- Extensão opcional `INVENTORY_REQUEST` / `INVENTORY_RESPONSE` para consultar um colega.

## Instalação

Requer Node.js 20 ou superior.

```powershell
npm install
Copy-Item config.example.json config.json
npm start
```

Na primeira execução, `config.json` também é criado automaticamente a partir do exemplo. Abra [http://localhost:8080](http://localhost:8080).

## Configuração

Edite `config.json`:

```json
{
  "peer_id": "ALUNO-01",
  "author_sticker": {
    "sticker_id": "FIG-01",
    "image_url": "https://servidor/FIG-01.png"
  },
  "host": "0.0.0.0",
  "port": 8080,
  "advertised_url": "ws://192.168.1.10:8080/p2p",
  "neighbors": [
    "ws://192.168.1.11:8080/p2p"
  ]
}
```

`advertised_url` precisa usar o IP que os outros computadores conseguem alcançar. Cada computador pode usar a porta obrigatória `8080`.

Para executar vários nós no mesmo computador, crie arquivos diferentes e altere as portas:

```powershell
$env:CONFIG_PATH="config.aluno-01.json"; npm start
$env:CONFIG_PATH="config.aluno-02.json"; npm start
```

Nesse cenário, use por exemplo as portas `8081` e `8082`, com URLs `ws://127.0.0.1:8081/p2p` e `ws://127.0.0.1:8082/p2p`.

## Busca

O nó de origem gera um UUID em `query_id` e registra a busca antes de enviá-la. Cada receptor:

1. Descarta a mensagem se o `query_id` já foi processado.
2. Registra o identificador.
3. Responde com `SEARCH_HIT` se possuir a figurinha.
4. Caso contrário, repassa aos vizinhos, exceto ao remetente, com `ttl - 1`.

As respostas percorrem a rota reversa guardada para o `query_id`. O `SEARCH_HIT` inclui `peer_url` como campo opcional para permitir uma conexão direta antes da troca.

## Troca

A proposta mantém a semântica de quem iniciou a negociação:

- `offer_sticker_id`: figurinha entregue por quem propõe.
- `want_sticker_id`: figurinha desejada por quem propõe.

O destinatário só consegue aceitar se tiver `want_sticker_id`. Após o `TRADE_ACCEPT`, o proponente atualiza seu inventário e envia `TRANSFER_CONFIRM`; o destinatário então faz a atualização complementar. O campo opcional `trade_id` torna o fluxo idempotente e associa todas as mensagens à proposta original.

## Testes

```powershell
npm test
```

Os testes incluem um cenário de rede com três nós, busca de `FIG-03` e troca concluída entre `ALUNO-01` e `ALUNO-03`.
