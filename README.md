# Cliente ClickUp reutilizável

`clickup-api-client.mjs` é um cliente leve, sem dependências, para Node.js 18+ e a API oficial ClickUp v2. Ele substitui uma sequência de chamadas manuais pela mesma API diretamente — com paginação, cache da hierarquia por execução e retentativas conscientes de limite.

## Operações mapeadas desta conversa

| Necessidade | Método | Rota oficial v2 |
| --- | --- | --- |
| Localizar workspace | `getWorkspaces()` | `GET /team` |
| Navegar espaço/folder/lista | `getWorkspaceHierarchy()` | `GET /team/{team_id}/space`, `/space/{space_id}/folder`, `/folder/{folder_id}/list`, `/space/{space_id}/list` |
| Encontrar a lista `Sprint 0` | `findListByName(workspaceId, "Sprint 0")` | Hierarquia acima, uma vez por execução (em cache) |
| Consultar lista/task | `getList()`, `getTask()` | `GET /list/{list_id}`, `GET /task/{task_id}` |
| Buscar tasks por nome | `findTasksByName()` | `GET /list/{list_id}/task`, com páginas automáticas |
| Criar task | `createTask()` | `POST /list/{list_id}/task` |
| Criar subtask | `createSubtask()` / `createSubtasks()` | Mesmo `POST`, enviando `parent` |
| Atualizar task | `updateTask()` | `PUT /task/{task_id}` |

Na API v2, o campo/rota `team` equivale ao que a interface chama de **Workspace**. A página de tarefas inclui subtasks quando `subtasks=true`; a criação de uma subtask é a criação normal de task com o ID do pai em `parent`.

## Configuração

Crie um token pessoal em ClickUp (Settings → Apps → API Token) e exponha-o somente no ambiente local:

```bash
export CLICKUP_TOKEN='pk_seu_token_aqui'
# Opcionais:
export CLICKUP_MAX_RETRIES=6
export CLICKUP_CONCURRENCY=1
```

Não inclua o token no código, no README público nem no Git. Para uma integração usada por várias pessoas, troque o token pessoal pelo fluxo OAuth do ClickUp.

## Uso rápido

Veja os workspaces acessíveis:

```bash
node clickup-api-client.mjs workspaces
```

Veja toda a hierarquia de um workspace:

```bash
node clickup-api-client.mjs hierarchy 123456
```

Exemplo programático para localizar `Sprint 0`, encontrar/criar a task de documentação e criar as quatro subtarefas:

```js
import { ClickUpClient } from "./clickup-api-client.mjs";

const client = new ClickUpClient();
const [sprint0] = await client.findListByName("123456", "Sprint 0");
if (!sprint0) throw new Error("Lista Sprint 0 não encontrada");

let [documentation] = await client.findTasksByName(sprint0.id, "05. Documentação");
if (!documentation) {
  documentation = await client.createTask(sprint0.id, { name: "05. Documentação" });
}

await client.createSubtasks(sprint0.id, documentation.id, [
  { name: "Criar Home da documentação" },
  { name: "Criar páginas individuais da documentação" },
  { name: "Organizar estrutura e navegação entre as páginas" },
  { name: "Atualizar a documentação com o que já foi realizado" },
]);

await client.updateTask(documentation.id, { status: "in progress" });
```

`createSubtasks()` mantém a ordem dos resultados e, por padrão, envia uma requisição por vez. Aumente `CLICKUP_CONCURRENCY` apenas se o plano e a margem de quota comportarem isso.

## Continuar a Documentação da Sprint 0

O comando abaixo é idempotente: encontra a única lista `Sprint 0`, usa `05. Documentação` (ou a task antiga `Documentação`) como pai e cria **somente** as quatro subtarefas que ainda não existirem. Se houver mais de um workspace, informe o ID explicitamente.

```bash
export CLICKUP_TOKEN='pk_seu_token_aqui'
export CLICKUP_WORKSPACE_ID='123456' # obrigatório se o token acessa mais de um workspace
node continue-documentation.mjs
```

Se a lista tiver outro nome, use `CLICKUP_LIST_NAME`. O script para em casos ambíguos, sem criar nada, para evitar escrever na lista ou task errada.

## Paginação e limites

`iterateTasks()` percorre todas as páginas de `GET /list/{list_id}/task`; `listTasks()` devolve todas em um array. `findTasksByName()` usa o iterador, inclusive para tasks fechadas e subtasks por padrão.

Em `429`, o cliente aguarda até `X-RateLimit-Reset` (mais 250 ms) antes de tentar de novo. Em falhas transitórias `5xx` ou de rede, usa backoff exponencial com jitter. Ao esgotar `CLICKUP_MAX_RETRIES`, lança `ClickUpApiError`, contendo status e corpo da resposta para inspeção.

Isso não remove nem contorna o rate limit: a API oficial aplica quotas por token e plano. O cliente apenas reduz overhead (cache da hierarquia, busca paginada, lote controlado) e reage aos limites de forma previsível. A documentação atual informa 100, 1.000 ou 10.000 requisições/minuto por token, conforme o plano.

## Referências oficiais

- [Autenticação](https://developer.clickup.com/docs/authentication)
- [Workspaces autorizados](https://developer.clickup.com/reference/getauthorizedteams)
- [Criar task](https://developer.clickup.com/reference/createtask)
- [Listar tasks](https://developer.clickup.com/reference/gettasks)
- [Rate limits](https://developer.clickup.com/docs/rate-limits)
