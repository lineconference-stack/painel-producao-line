# Integração Omie → Painel de Produção

Este serviço consulta os pedidos de venda de **Line Conference** e **GLO Equipamentos** no Omie, transforma os itens em dados de produção e os disponibiliza para o painel. As credenciais nunca vão para o navegador ou GitHub Pages.

## Configuração inicial

1. Copie `.env.example` para `.env`.
2. No Omie de cada empresa, crie/consulte o aplicativo de integração e informe a respectiva `App Key` e `App Secret` no `.env`.
3. Execute `npm start` nesta pasta.
4. Publique este serviço em um servidor com endereço HTTPS. O painel será conectado a esse endereço.

## Rotas

- `GET /api/health` — confirma se o serviço está ligado e quais empresas estão configuradas.
- `POST /api/sync` — consulta os dois Omies imediatamente.
- `GET /api/orders` — fornece os pedidos normalizados ao painel.
- `POST /api/orders/{codigo}/status` — grava a etapa operacional no serviço.

O serviço também sincroniza a cada cinco minutos. A API do Omie oferece `ListarPedidos` e `ConsultarPedido` no módulo de Pedidos de Venda; este serviço usa os dois para obter a capa e todos os itens de cada pedido.

## Segurança

- Nunca envie as chaves por WhatsApp nem as publique no GitHub.
- Não faça upload do arquivo `.env`.
- Use um servidor HTTPS antes de cadastrar um webhook do Omie.
