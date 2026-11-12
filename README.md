# VERA ETO — Plano de Manutenção

App de campo para o técnico **inspecionar todas as estruturas da rede de média tensão (MT) urbana de Palmas e
Taquaralto** e montar a lista do que precisa de manutenção até **31/12/2027**. Tem o mesmo visual e o mesmo jeito
de usar do VERA (vegetação): o técnico abre o mapa, toca no poste, registra e segue. Funciona sem internet e
envia quando o sinal volta.

## O que o técnico faz

1. Entra com nome e sobrenome (equipe Palmas).
2. Na aba **Quadras** vê as quadras que o gestor deu a ele e as que estão perto.
3. No **Mapa**, o botão ➜ leva ao poste pendente mais perto. Toca no poste e escolhe:
   - **Sem anomalia** — um toque. O app já abre o próximo poste da quadra.
   - **Registrar anomalia** — o checklist: poste (trincado, inclinado, base comprometida), cruzeta, isolador,
     para-raios, chave, transformador, aterramento, estai, cabo/conector, vegetação e outro. Em cada item marca o
     defeito, a prioridade (**urgente · até 6 meses · até dez/2027**) e anexa a foto.
   - **Não localizado** ou **Sem acesso**, com o motivo.
4. Se o GPS estiver a mais de 60 m do poste, o app pede confirmação.

Cores no mapa: branco falta · verde sem anomalia · laranja anomalia · vermelho urgente · cinza não localizado.

## Painel do gestor

Aba **Painel**: estruturas inspecionadas, quanto falta, quantas por dia útil faltam para fechar em 31/12/2027
(dias úteis sem feriados nacionais, do Tocantins e de Palmas), ritmo dos últimos 10 dias úteis, anomalias por
prioridade, andamento por local e por técnico, **lista de manutenção** com fotos e CSV, e **distribuição de
quadras** (exige o PIN do gestor).

## A base

`scripts/monta_base.py` gera `dados/base.json` e `dados/rede.json`.

| | |
|---|---|
| Alimentadores | 39 AL das SE Palmas II, III, IV e Taquaralto II. Fora: LD (rural) e Taquaruçu |
| Estruturas MT | **29.521** — pela quadra: Palmas 20.861 · Taquaralto 8.660 (pela SE do alimentador: 21.167 · 8.354) |
| De onde vêm | índice de ativos do ARGOS 25.221 · início de vão de MT 1.938 · poste do VERA na ponta de vão 1.772 · poste do VERA que segura equipamento 102 · equipamento sem poste na base 488 |
| Equipamento no poste | do ARGOS, ligado ao poste MT mais perto até 5 m (transformador 4.427, chave fusível 1.815, chave faca 876, religador 57…) |
| Quadras | **105 da programação do gestor** (`dados/fontes/Programação de Palmas.kml` e `…Taquaralto.kml`) com 25.456 estruturas; poste a até 100 m de uma área entra nela (é a avenida entre quadras). As outras **4.065** ficam em **116 setores «fora da programação»** (grade de 700 m), com o nome da quadra mais próxima |

Por que não só o VERA ou só o ARGOS: o VERA tem 52 mil postes nesses alimentadores, mas metade é baixa tensão; o
ARGOS só tem os de MT (25 mil) e traz os equipamentos. A base junta os dois pela régua acima.

Para refazer (depois de atualizar o ARGOS, o VERA ou o KML das quadras):

```bash
python3 scripts/monta_base.py <ARGOS teste/dados> <vera-vegetacao dados/CENTRO>
```

Depois suba a versão em `config.js` e `sw.js` (as duas) para o celular baixar a base nova.

## Onde os dados ficam

Supabase, projeto «LGRSV's Project», tabelas com prefixo `pm_` (`supabase/schema.sql`). **Não há token no app**: a
chave em `config.js` é a pública, feita para ficar no navegador. As regras do banco só deixam **acrescentar**
inspeção e foto — ninguém apaga nem altera pelo app; o estado de um poste é a última inspeção dele e o histórico
fica inteiro. Fotos no bucket privado `pm-fotos` (1280 px, ~200 KB cada, com o código do poste e a hora
carimbados). Distribuir quadra só pela função `pm_atribui`, com o PIN do gestor.

Plano gratuito do Supabase: 1 GB de foto para o projeto inteiro (hoje 320 MB já usados por outro app) — dá
cerca de 3.500 fotos. Política de foto a definir (`fotoObrigatoria` em `config.js`).

## Publicar

GitHub Pages do repositório (Settings → Pages → branch `main`, pasta raiz). Endereço:
`https://lgrsv.github.io/plano-da-manutencao/`.
