<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Instruções do projeto (Núcleo FC)

Este repositório é a conversão do Bate Lata (vôlei) para um app de **futebol**.
Antes de implementar qualquer mudança, leia e siga o arquivo [`INSTRUCOES.md`](./INSTRUCOES.md) na raiz do projeto.

Resumo: app só de futebol, gratuito, times `Time 1..N` em azul/vermelho, tamanho 6–11 editável,
empates permitidos (admin escolhe quem permanece), goleiros fixo/temporário/manual,
cadastro Membro/Convidado e ranking único com `pointsDraw`. Pagamento deve ser removido por completo.
