# Ponto de Prova

Sistema de cadastro gratuito de pessoas interessadas em trabalhar em concursos, em português, com front e back no mesmo projeto: Express 5, páginas HTML renderizadas no servidor e SQLite em `data/concurso.sqlite`. Requer Node.js 22.13 ou superior. Sem serviço externo de banco.

## Executar localmente

```powershell
npm install
Copy-Item .env.example .env
```

Edite `.env`: defina `ADMIN_PASSWORD` com pelo menos 12 caracteres e `SESSION_SECRET` com pelo menos 32 caracteres aleatórios. Gere segredos com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Defina outro segredo em `WEBHOOK_TOKEN` para o n8n.

```powershell
npm start
```

Abra http://localhost:3000 e acesse **Área do organizador** com login `admin` (ou `ADMIN_USERNAME`) e a senha inicial `ADMIN_PASSWORD`. Não há senha padrão nem dados fictícios. Cadastre um concurso, crie os links dos grupos em sua tela de gerenciamento e compartilhe-os. Use `npm run dev` durante desenvolvimento e `npm test` para os testes de integração.

## Funcionalidades

- Cadastro, edição, finalização e reabertura de cadastros para trabalhar em concursos, com organizadora, funções, remuneração e vagas, local, datas, chegada, início, término, link oficial e orientações.
- Página pública com informações e cadastro para trabalhar com nome, CPF válido, telefone e autorização de uso dos dados.
- Um link curto `/l/:codigo` por grupo. Contagem de cliques, visitantes estimados por sessão, confirmações por origem e últimos 50 acessos.
- Painel protegido com lista de confirmações (nome, CPF, telefone, concurso, grupo e origem), filtrável por concurso, limitada aos 500 registros recentes.
- Entrada de mensagens e confirmações pelo n8n, saída manual de mensagens e histórico dos últimos 100 envios/recebimentos.

Cliques são anônimos: não é possível descobrir nome ou CPF de alguém apenas por acessar um link. O grupo é atribuído pelo link do formulário enviado; links encaminhados continuam atribuídos ao grupo original. Contagens incluem repetições, robôs e prévias; visitantes são uma estimativa por sessão, não pessoas únicas. O cadastro é gratuito, destinado à equipe de trabalho e não garante contratação. A unicidade é por concurso + CPF; reenvios não sobrescrevem dados pessoais existentes.

## n8n: receber dados

No seu fluxo n8n, use HTTP Request para enviar `POST /api/webhooks/n8n` com `Content-Type: application/json` e `Authorization: Bearer SEU_WEBHOOK_TOKEN`.

Mensagem recebida no WhatsApp:

```json
{"event_id":"whatsapp-id-unico","type":"whatsapp.message","phone":"5511999999999","message":"Tenho uma dúvida sobre a prova"}
```

Confirmação recebida pelo fluxo (obtenha a autorização do participante antes de enviar `consent: true`):

```json
{"event_id":"confirmacao-id-unico","type":"registration.completed","contest_id":"550e8400-e29b-41d4-a716-446655440000","name":"Nome do participante","cpf":"CPF_VALIDO_COM_11_DIGITOS","phone":"5511999999999","pix_type":"email","pix_key":"colaborador@example.com","code":"CODIGO_DO_LINK_DO_GRUPO","consent":true}
```

`code` é opcional. Se informado, deve pertencer ao concurso. `event_id` é obrigatório e único globalmente; reenvios retornam `{ "ok": true, "duplicate": true }`. A gravação do evento e seus dados é transacional. Retornos: 200 aceito, 400 dados inválidos, 401 token inválido, 429 limite por minuto. O fluxo deve manter o mesmo event_id nas tentativas do mesmo evento.

## n8n: enviar mensagem

Configure `N8N_OUTBOUND_URL` com a URL do Webhook do seu fluxo e `N8N_OUTBOUND_TOKEN` com o segredo para autenticação por header no n8n. A central envia:

```json
{"event_id":"out-1","type":"whatsapp.send","phone":"5511999999999","message":"Sua prova será amanhã."}
```

O header `Authorization: Bearer ...` é incluído quando o token está configurado. O fluxo deve chamar seu provedor de WhatsApp e usar event_id para evitar duplicações. O sistema registra o aceite HTTP, falhas ou resultado incerto (timeout de 10 segundos). Não há tentativa automática: confira o n8n antes de repetir um envio incerto. O status de entrega do provedor não está integrado nesta versão.

## Acesso externo e operação

O servidor escuta apenas em `127.0.0.1`. Para links em celulares e n8n externo, configure um proxy HTTPS/túnel para a porta local e ajuste `BASE_URL` ao endereço público. `localhost` só funciona no próprio computador. A aplicação e o SQLite continuam no computador/servidor local; este projeto não foi publicado na nuvem.

Antes de operar publicamente, configure TLS e `NODE_ENV=production`; cookies seguros precisam que Express reconheça HTTPS. Para proxy local confiável, configure `app.set('trust proxy', 'loopback')` na criação do app e garanta que só o proxy alcance o servidor. Não confie indiscriminadamente em headers de proxies externos.

O back-office usa contas individuais e sessões persistentes em SQLite. Administradores gerenciam usuários e todos os concursos; gestores acessam somente seus próprios concursos. Para múltiplos processos, os limites por IP ainda precisam de armazenamento compartilhado. O limitador atual é por IP e rota, 30 tentativas/minuto para login, confirmação, cliques e webhook.

CPF e telefone são restritos ao painel, mas armazenados em texto no banco local. Restrinja acesso ao arquivo e aos backups, use criptografia de disco e estabeleça retenção/remoção dos dados. Para backup consistente simples, pare o servidor e copie a pasta `data` inteira. Não versione `.env` ou `data`. Datas de prova são informadas em horário de Brasília; eventos no histórico são exibidos em UTC.

## Estrutura

`src/app.js`: rotas e fluxos; `src/db.js`: esquema SQLite; `src/validation.js`: validações; `src/views.js`: componentes HTML com escape; `public/style.css`: interface responsiva; `test/app.test.js`: testes de autenticação, CSRF, cadastro, atribuição, duplicatas e webhook.

Referências: [Express 5](https://expressjs.com/en/5x/api.html) e [SQLite no Node.js](https://nodejs.org/api/sqlite.html). O módulo SQLite do Node 22 pode emitir um aviso experimental.

## Cadastros de trabalhadores e identificadores

Na tela de gerenciamento do concurso, **Finalizar cadastros** retira o concurso do portal público e bloqueia cadastros pelo formulário, links compartilhados e webhook. Os participantes existentes permanecem no painel. **Reabrir cadastros** torna o concurso público novamente. Enquanto finalizado, o bot e os lembretes vinculados também ficam indisponíveis para novos envios.

Os identificadores internos de concursos, participantes, grupos, FAQs, lembretes, mensagens e demais registros usam UUID v4. Rotas e APIs recebem UUIDs em texto, inclusive `contest_id`, `group_id` e `processing_id`; IDs numéricos antigos deixam de ser aceitos. Os códigos curtos `/l/:codigo` e identificadores externos do WhatsApp/n8n são preservados.

Ao iniciar a versão atual, a migração transacional converte o banco existente e seus vínculos, mantendo os dados e removendo a coluna de taxa. Atualize referências numéricas que tiver configurado em fluxos externos com os UUIDs obtidos no painel/API. Reinicie o servidor após atualizar o código; em `npm run dev`, o processo reinicia automaticamente.

## Chave Pix do colaborador

Novos cadastros exigem `pix_type` (`cpf`, `celular`, `email` ou `aleatoria`) e `pix_key`, tanto no formulário quanto no evento `registration.completed` do n8n. O sistema valida o formato, sem consultar a existência ou titularidade da chave no banco. Celular aceita DDD com número brasileiro e é salvo com `+55`; CPF é salvo sem pontuação.

O tipo e a chave completa ficam disponíveis na lista protegida de trabalhadores e na API administrativa de participantes. Não aparecem no portal público. Chaves são armazenadas em texto no banco local, inclusive quando o tipo é CPF; a proteção por hash do CPF de identificação não se aplica à chave usada para pagamentos. Cadastros anteriores permanecem com Pix não informado. Reenvios do mesmo CPF no mesmo concurso mantêm a chave existente. Exclusão e retenção do cadastro também removem seus dados Pix.

## Cargos e vínculos dos colaboradores

No gerenciamento do concurso, abra **Cadastrar / gerenciar cargos** para adicionar nome, período (`1` = Manhã, `2` = Tarde, `3` = Manhã e Tarde), valor em reais e quantidade de vagas. O valor é a remuneração pelo trabalho no período cadastrado. As vagas exibidas no concurso são a soma das quantidades dos cargos configurados.

Em **Trabalhadores → Definir cargos**, somente o organizador atribui ou remove os cargos. Um colaborador pode ter um cargo de manhã e outro à tarde no mesmo concurso; um cargo de Manhã e Tarde ocupa ambos os períodos. Não é permitido ultrapassar a quantidade de vagas, reduzir a quantidade abaixo dos vínculos existentes, excluir um cargo vinculado ou alterar seu período gerando conflito. Remover o colaborador também libera suas vagas.

O formulário público e o webhook cadastram o colaborador sem cargo; campos de atribuição enviados por essas entradas não são utilizados. Os cargos são exibidos como informação no portal. Cadastros existentes permanecem sem atribuição até a decisão do organizador. O campo antigo de funções é preservado como um cargo pendente de configuração, incluindo a remuneração anterior como referência. Revise e separe esse cadastro caso ele contenha várias funções. Nenhum período é presumido na migração.

API administrativa (sessão autenticada e CSRF): `GET/POST /api/concursos/:uuid/cargos`, `PUT/DELETE /api/concursos/:uuid/cargos/:cargo_uuid`. Para salvar um cargo, envie `name`, `period`, `amount` (reais, até duas casas decimais) e `quantity`. Para substituir os vínculos, use `PUT /api/participantes/:uuid/cargos` com `{ "role_ids": ["UUID_DO_CARGO"] }`; uma lista vazia remove todos. A lista administrativa de participantes inclui seus cargos em `roles`.

## Cadastro manual e CPF completo

No painel do concurso, **Cadastrar colaborador** permite salvar somente o nome. CPF, telefone e Pix são opcionais nessa entrada; quando preenchidos, são validados. Após salvar, o organizador pode definir os cargos. Use **Trabalhadores → Editar dados** para completar o cadastro posteriormente. Vários colaboradores sem CPF podem ser cadastrados no mesmo concurso; quando informado, o CPF permanece único por concurso. O formulário público mantém seus campos obrigatórios.

O CPF completo passa a ser armazenado em `cpf_full`, sem pontuação, e fica disponível no painel e na API administrativa. O hash em `cpf` continua sendo usado para localizar duplicatas. Cadastros antigos que só possuem hash precisam ter o CPF informado novamente, pois ele não pode ser reconstruído. CPFs legados ainda em texto são preservados antes da conversão para hash. Os dados completos não são exibidos no portal público.

## Back-office com usuários individuais

O primeiro acesso cria uma conta de administrador com login `admin` (personalizável por `ADMIN_USERNAME`) e a senha de `ADMIN_PASSWORD`, entre 12 e 128 caracteres. Os concursos anteriores são atribuídos a essa conta. Após a criação inicial, as senhas ficam no banco com scrypt e salt individual; alterar `ADMIN_PASSWORD` não redefine uma conta existente. Essa variável só é necessária na criação do primeiro administrador. Mantenha `SESSION_SECRET` estável para preservar sessões entre reinicializações.

Em **Usuários**, o administrador pode cadastrar contas, alterar nome/login/perfil, definir uma nova senha e desativar acessos. Os perfis são **Administrador** (todos os concursos e gestão de usuários) e **Gestor de concursos** (somente os próprios concursos, colaboradores, cargos, grupos e lembretes). O proprietário de um novo concurso é sempre o usuário autenticado, inclusive na API. O portal público continua exibindo concursos publicados de todos os organizadores. Histórico global e central de mensagens são exclusivos do administrador.

Sessões são persistidas no SQLite, expiram após oito horas e são invalidadas quando a senha, o perfil ou a ativação da conta mudam. O sistema impede desativar ou rebaixar o último administrador ativo. As ações registradas no histórico identificam o usuário responsável por nome, login e UUID. Entradas administrativas e APIs verificam o proprietário dos recursos; informar o UUID de outro gestor não concede acesso.
