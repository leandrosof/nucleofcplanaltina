# Instruções do projeto — Núcleo FC (futebol)

> Leia este arquivo inteiro antes de implementar qualquer mudança.
> Ele consolida as decisões e o plano de conversão do Bate Lata (vôlei) para o futebol da igreja.

## 1. Contexto

- Projeto novo, separado do Bate Lata (`E:\projetos_github\Bate Lata`).
- Pasta/repositório: `E:\projetos_github\arena-do-futebol`.
- Nome de trabalho do app: **Núcleo FC** (pode ser ajustado nas configurações/branding).
- Base de código copiada do Bate Lata; ainda contém o domínio e os textos de vôlei.
- **Futebol somente** neste app. O vôlei continua no Bate Lata.

## 2. Estado atual (já feito)

- Neon novo provisionado e conectado:
  - Host pooled e unpooled configurados em `.env.local` e `.env.production.local`.
  - **Nunca versionar esses arquivos nem imprimir as credenciais.**
  - Usuário atual: `neondb_owner` (owner). A role `nucleo-fc` existe, mas ainda não foi usada.
- Driver mantido: `postgres.js` + `drizzle-orm/postgres-js`.
  - Motivo: o app tem 37 usos de `db.transaction`; o driver `neon-http` não suporta transações.
- Migrações + seed aplicados no Neon: 18 tabelas, `settings` (1) e temporada ativa (1); `users/events/games = 0`.
- `npm run build` passou; `next start` + `GET /api/health` retornou `200 {"status":"ok"}`.
- `yarn dev` usa o Neon (decisão do time) e roda migrate + seed a cada subida.
- `git init` feito, **sem commit**.

## 3. Decisões fechadas (não reabrir sem pedir)

1. **Só futebol.** Remover referências a vôlei do produto.
2. **Sempre gratuito.** Remover TODO o fluxo de pagamento (Pix, comprovante, pré-inscrição paga, aprovação).
3. **Membro x Convidado**:
   - Obrigatório no cadastro e editável pelo admin.
   - Badge "Membro"/"Convidado" no painel admin, lista de jogadores, presenças, perfil e cards de time.
   - **Ranking único**, com selo e filtro "todos / membros / convidados".
4. **Tamanho do time: 6 a 11 jogadores de linha**, editável durante o evento. O goleiro é uma vaga adicional.
   - A mudança vale para o **próximo jogo**; o jogo em andamento usa substituições.
5. **Nomes dos times**: `Time 1`, `Time 2`, `Time 3`... por evento.
   - Reinicia em `Time 1` a cada evento/sessão.
   - Dentro do mesmo evento, nunca repete número; se remontar, continua `Time 3`, `Time 4`...
6. **Cores: apenas Azul e Vermelho** (coletes).
   - Azul = lado A; Vermelho = lado B.
   - Toda partida é sempre Azul x Vermelho; a cor identifica o lado, não o time.
   - Remover as demais cores da paleta.
7. **Empate permitido**.
   - `winnerTeamId = null` no empate; placar preservado.
   - Ao finalizar empate, o admin confirma **quem permanece**.
   - Sugestão automática: o time que venceu a última partida daquela quadra (pré-selecionado).
   - A escolha vale só para a rotação; no ranking é empate.
8. **Goleiros**:
   - Preferência no cadastro/perfil: `Goleiro fixo`, `Jogador de linha`, `Posso jogar no gol`.
   - Override opcional por evento na presença.
   - No sorteio, distribuir goleiros fixos um por time; restante pela fila.
   - Time sem goleiro fixo fica com a vaga pendente; o organizador escolhe manualmente.
   - Goleiro temporário não "gruda" no time: após a partida volta à fila/posição normal.
   - Registrar posição (`GOALKEEPER`/`FIELD`) e `temporaryGoalkeeper` na partida.
9. **Ranking conta pessoas, não times**.
   - Adicionar empates (`draws`) e pontuação configurável `pointsDraw`.
   - `losses = played - wins - draws`.
   - `pontos = wins*pointsWin + draws*pointsDraw + losses*pointsLoss`.
10. **Exibição das partidas**: sempre com contexto para não repetir "Time 1 x Time 2".
    - Formato: `Sábado, 08/11 • Partida 3` e `Time 1 (nomes...) 2 x 1 Time 2 (nomes...)`.
    - Usar `games.sequence` como número da partida dentro da sessão; agrupar histórico por evento.

## 4. Modelo de dados proposto

| Tabela | Campo | Observação |
|---|---|---|
| `users` | `member_type` (`MEMBER`/`GUEST`) | obrigatório no cadastro |
| `users` | `goalkeeper_preference` (`FIXED`/`FIELD`/`ANY`) | `FIXED` = goleiro fixo; `ANY` = posso ir no gol |
| `attendances` | `goalkeeper_preference` (nullable) | override do dia |
| `game_players` | `position` (`GOALKEEPER`/`FIELD`) | default `FIELD` |
| `game_players` | `temporary_goalkeeper` (boolean) | default `false` |
| `settings` | `points_draw` (integer) | default 1 |
| `settings` | `default_team_size` | default 7 |
| `attendance_status` | remover `PENDING_PAYMENT` | fica `CONFIRMED`, `WAITLIST`, `CANCELLED` |
| `games` | `winner_team_id` | já é nullable; usar `null` em empate |
| `draw_teams` | sem mudança | nome gerado `Time N`, cor azul/vermelho |

## 5. Remoção total de pagamento (checklist)

- `src/db/schema.ts`: remover enums `eventPaymentMode`/`paymentProofStatus`, `PENDING_PAYMENT`, campos `paymentMode`, `priceCents`, `paymentProofUpload`, aprovação/reserva de pagamento, tabela `paymentProofs`, campos Pix de `settings` e `PaymentReceipt`.
- `src/lib/validations.ts`: remover campos de pagamento do `eventSchema`.
- `src/actions/admin.ts`: remover lógica `PAID`/preço/comprovante/Pix.
- `src/actions/attendance.ts`: remover ramos `PENDING_PAYMENT`, e-mails de pagamento e `adminClearPaymentProofAction`; `promoteNext` sempre cria `CONFIRMED`.
- `src/lib/pre-registration.ts`: deletar.
- `src/app/api/cron/expire-pre-registrations/route.ts`: deletar.
- `src/lib/email.ts`: remover e-mails de pagamento/pré-inscrição.
- `src/lib/money.ts`: remover se ficar sem uso.
- `src/components/features/payment-proof-preview.tsx` e `payment-proof-upload.tsx`: deletar.
- `src/app/api/payment-proof/[attendanceId]/route.ts`: deletar.
- `src/components/features/attendance-controls.tsx`: limpar props/estados de pagamento.
- Páginas `admin/eventos`, `event-calendar`, `admin/config` (Pix), `inicio`, `jogos`, `presencas`: remover UI de pagamento.
- `src/db/queries/events.ts`: remover joins/campos de comprovante e `pendingPayment`.
- `README.md`, `docs/*`, `.env.example`: remover Pix/pagamento e `CRON_SECRET`.
- Testes: remover/atualizar casos de pagamento.

## 6. Mudanças por arquivo (referência)

- `src/lib/teams.ts`
  - `TEAM_SIZE_OPTIONS = [6, 7, 8, 9, 10, 11]`.
  - `TEAM_PALETTE_SEED` só com Azul `#2f6bff` e Vermelho `#ef4444`.
  - `teamVisualForIndex`: `name = Time ${index + 1}`; cor alternando azul/vermelho (par = azul, ímpar = vermelho).
  - Remover `TEAM_NAMES`.
- `src/lib/validations.ts`
  - Mensagens "Escolha de 6 a 11 jogadores por time".
  - `settingsSchema` aceita `pointsDraw` e 6–11.
  - Remover pagamento; adicionar `memberType` e `goalkeeperPreference` no cadastro/perfil.
- `src/lib/draw.ts`
  - Ajustar mensagens de tamanho (6–11). O algoritmo já suporta qualquer `teamSize`.
- `src/lib/racha.ts`
  - `planNextMatch` precisa receber o lado que permanece no empate (rotação), separado do resultado do ranking.
  - Preferência de goleiro não deve alterar a ordem da fila.
- `src/actions/games.ts`
  - Permitir empate em `finishGameAction` e `correctResultAction`; `winnerTeamId = null`.
- `src/actions/racha.ts`
  - `finalizeMatchAction`: aceitar `stayingSide` no empate; usar para a rotação; gravar `winnerTeamId = null`.
  - Nova ação `updateRachaTeamSizeAction(drawId, 6..11)` (vale para o próximo jogo).
  - Validações de início/fim devem usar o elenco real da partida, não `draw.teamSize`.
  - Nova ação para definir/trocar goleiro por time.
  - Criar times com nome `Time N` e cor azul/vermelho; distribuir goleiros fixos.
- `src/db/queries/ranking.ts`
  - Contar `draws`; `losses = played - wins - draws`; incluir `pointsDraw`.
- `src/db/queries/games.ts`
  - Incluir `position`/`temporaryGoalkeeper` nos participantes para o histórico.
- `src/lib/surface.ts` + formulários de evento
  - Pisos de futebol: Campo, Society, Futsal, Areia (ou vocabulário neutro).
- Branding
  - `src/app/manifest.ts`, `src/app/layout.tsx`, `src/lib/email.ts`, `src/components/layout/brand.tsx` (ícone), `bottom-nav.tsx`, `termos`, `page.tsx`, `inicio`, `admin/config`, `scripts/seed.ts`, `scripts/demo.ts`, `README.md`, `docs/*`, `package.json`.
- Cadastro/perfil/painel
  - Formulário de cadastro com Membro/Convidado e preferência de gol.
  - Admin de jogadores: badge e edição de membro/convidado e preferência.
- Partidas/racha
  - Seletor de goleiro por time; editor de tamanho do time; diálogo de empate; exibir `Partida N` e jogadores.

## 7. Ordem de execução recomendada

1. **Base e limpeza**: rebranding, remover pagamento, `Time N`, 6–11, cores azul/vermelho, pisos.
2. **Regras**: empate + `pointsDraw` + escolha de quem permanece; edição de tamanho.
3. **Cadastros**: Membro/Convidado + preferência de goleiro; badges no painel.
4. **Goleiros**: distribuição no sorteio, seleção manual, rotação e histórico.
5. **Migração limpa**: gerar migração nova (idealmente squash das migrações antigas) e aplicar no Neon.
6. **Testes e docs**: unitários, integração, e2e e documentação.
7. **Deploy**: Vercel + variáveis de ambiente + domínio.

## 8. Comandos

```bash
# desenvolvimento (usa Neon; roda migrate + seed)
yarn dev

# gerar migração após mudanças no schema
yarn db:generate

# aplicar migrações + seed no banco de produção (lê .env.production.local)
yarn db:setup:prod

# qualidade
yarn lint
yarn typecheck
yarn test
yarn test:e2e

# build e execução
npm run build
npm start
```

Verificação mínima:

```bash
# health check (deve retornar 200 {"status":"ok"})
curl http://localhost:3000/api/health
```

## 9. Segurança e ambiente

- **Nunca** commitar `.env.local`/`.env.production.local` (já estão no `.gitignore`).
- **Nunca** imprimir senhas em logs, docs ou respostas.
- A role usada hoje é `neondb_owner`. A senha foi exposta em chat; **rotacionar após o setup**.
- Se quiser usar a role `nucleo-fc` (menor privilégio), rodar como owner:
  ```sql
  GRANT CONNECT ON DATABASE neondb TO "nucleo-fc";
  GRANT USAGE, CREATE ON SCHEMA public TO "nucleo-fc";
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "nucleo-fc";
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "nucleo-fc";
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "nucleo-fc";
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "nucleo-fc";
  ```
  Depois trocar `DATABASE_URL`/`DATABASE_URL_UNPOOLED` para `nucleo-fc`.

## 10. Regras do Next.js

- Este projeto usa uma versão do Next.js com mudanças em relação ao conhecimento padrão.
- Antes de escrever código, ler os guias em `node_modules/next/dist/docs/` (ver `AGENTS.md`).
- Não remover o bloco `nextjs-agent-rules` do `AGENTS.md`; ele é regravado pelo `next dev`.

## 11. Definition of done

- Não há referências a pagamento/Pix/comprovante nem a vôlei na UI.
- Cadastro exige Membro/Convidado e preferência de goleiro.
- Times são `Time 1..N`, azul x vermelho, com `Partida N` no histórico.
- Empate permitido, com escolha de quem permanece e ranking com `pointsDraw`.
- Tamanho 6–11 editável (próximo jogo).
- Goleiro fixo/temporário/manual funcionando e registrado.
- Ranking único com selo Membro/Convidado e filtro.
- `yarn lint`, `yarn typecheck`, `yarn test` e `npm run build` passando.
- `/api/health` retorna 200 no ambiente configurado.
