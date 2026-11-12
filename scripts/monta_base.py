"""Monta a base do Plano de Manutenção — inspeção da rede MT urbana de Palmas e Taquaralto.

Fontes (somente leitura):
  ARGOS  (LGRSV/Skills, pasta teste/dados): índice de ativos (poste, trafo, chave, religador…) com
         coordenada e trecho T1/T2/T3; vãos de MT por alimentador.
  VERA   (LGRSV/vera-vegetacao, pasta dados/CENTRO): postes por alimentador, usados só para conferência.

Régua:
  - Alimentadores AL (urbanos) das SE Palmas II (059122), Palmas III (097122), Palmas IV (060122) e
    Taquaralto II (099059). Fora: LD (rural) e Taquaruçu (AL01081100).
  - Estrutura MT = poste do índice do ARGOS nesses alimentadores + poste de início de vão de MT que não
    está no índice (coordenada tirada do vão).
  - Equipamento do ARGOS vai para o poste MT mais próximo, até 5 m. Mais longe, fica sem poste e é contado.
  - Quadra = área da programação do gestor (dados/fontes/Programação de Palmas.kml e de Taquaralto.kml).
    Poste fora delas, a até 100 m, vai para a mais próxima; o resto vira setor «fora da programação»
    (grade de 700 m, partida até 150 postes).

Uso: python3 scripts/monta_base.py <pasta teste/dados do ARGOS> <pasta dados/CENTRO do VERA>
"""
import collections
import glob
import json
import math
import os
import re
import sys

ARGOS = sys.argv[1] if len(sys.argv) > 1 else '/home/user/lgrsv/skills/teste/dados'
VERA = sys.argv[2] if len(sys.argv) > 2 else '/home/user/vera-vegetacao/dados/CENTRO'
SAIDA = os.path.join(os.path.dirname(__file__), '..', 'dados')

SES = {'059122': ('SE-2PA2', 'SE PALMAS II', 'Palmas'),
       '097122': ('SE-2PA3', 'SE PALMAS III', 'Palmas'),
       '060122': ('SE-2PA4', 'SE PALMAS IV', 'Palmas'),
       '099059': ('SE-2TQ2', 'SE TAQUARALTO II', 'Taquaralto')}
LADO_M = 700
MAX_POSTES = 150
MIN_POSTES = 20
RAIO_EQ_M = 5.0

NOME_EQ = {'TR': 'Transformador', '79': 'Religador', '78': 'Religador monofásico', 'DJ': 'Disjuntor',
           '03': 'Chave fusível', '33': 'Chave fusível', '02': 'Chave fusível', 'SEC': 'Chave de seccionamento',
           'FTR': 'Fusível de tronco', '40': 'Trip saver', '41': 'Trip saver', '88': 'Chave faca',
           '58': 'Regulador de tensão', '59': 'Banco de capacitor'}


def nome_eq(t):
    return NOME_EQ.get(t, 'Equipamento ' + t)


alims = sorted(os.path.basename(f)[:-5] for f in glob.glob(os.path.join(ARGOS, 'alimentadores', 'AL*.json'))
               if os.path.basename(f)[4:10] in SES)
assert alims, 'nenhum alimentador encontrado'
alset = set(alims)

# índice de ativos do ARGOS
postes = {}          # id -> [lat, lon, alimentador, trecho]
origem = {}          # id -> A índice ARGOS · V início de vão · P VERA na ponta de vão · E VERA com equipamento · S equipamento sem poste
equips = []          # (codigo, tipo, lat, lon, alimentador)
for f in glob.glob(os.path.join(ARGOS, 'ativos', '*.json')):
    for cod, regs in json.load(open(f)).items():
        for r in regs:
            al, tipo, trecho, _, lat, lon = r[:6]
            if al not in alset:
                continue
            if tipo == 'poste':
                if cod not in postes:
                    postes[cod] = [lat, lon, al, trecho]
                    origem[cod] = 'A'
            else:
                equips.append((cod, tipo, lat, lon, al))
n_indice = len(postes)

# vãos de MT: rede para o mapa e postes de início de vão que faltam no índice
rede = {}
vindo_do_vao = 0
for al in alims:
    d = json.load(open(os.path.join(ARGOS, 'alimentadores', al + '.json')))
    segs = []
    for v in d['vaos']:
        lon1, lat1, lon2, lat2 = v[:4]
        segs.append([round(lon1, 6), round(lat1, 6), round(lon2, 6), round(lat2, 6)])
        pid = v[6] if len(v) > 6 else ''
        if pid and pid not in postes:
            postes[pid] = [lat1, lon1, al, '']
            origem[pid] = 'V'
            vindo_do_vao += 1
    rede[al] = segs

# VERA: postes MT + BT. Entra só o poste do VERA que está na ponta de um vão de MT (até 1 m) e falta na base.
vera = {}
for al in alims:
    p = os.path.join(VERA, al + '.json')
    if os.path.exists(p):
        for x in json.load(open(p)):
            vera.setdefault(x['id'], (x['lat'], x['lon'], al))

KY = 111320.0
KX = KY * math.cos(math.radians(-10.25))
C = 0.0001


def monta_grade(d):
    g = collections.defaultdict(list)
    for k, v in d.items():
        g[(int(v[0] / C), int(v[1] / C))].append(k)
    return g


def mais_perto(g, d, la, lo):
    best, bd = None, 1e9
    gi, gj = int(la / C), int(lo / C)
    for i in (-1, 0, 1):
        for j in (-1, 0, 1):
            for k in g[(gi + i, gj + j)]:
                dd = math.hypot((d[k][0] - la) * KY, (d[k][1] - lo) * KX)
                if dd < bd:
                    best, bd = k, dd
    return best, bd


g_mt, g_vera = monta_grade(postes), monta_grade(vera)
da_ponta = 0
for al in alims:
    for s4 in rede[al]:
        for lo, la in ((s4[0], s4[1]), (s4[2], s4[3])):
            if mais_perto(g_mt, postes, la, lo)[1] <= 1:
                continue
            k, d = mais_perto(g_vera, vera, la, lo)
            if k is not None and d <= 1 and k not in postes:
                postes[k] = [vera[k][0], vera[k][1], al, '']
                origem[k] = 'P'
                da_ponta += 1
                g_mt[(int(vera[k][0] / C), int(vera[k][1] / C))].append(k)

# equipamento -> poste mais próximo (grade de ~11 m); código de equipamento é 2–3 caracteres
grade = g_mt
equips = [e for e in equips if re.fullmatch(r'[0-9]{2}|TR|DJ|SEC|FTR', e[1])]
eq_poste = collections.defaultdict(list)
sem_poste = collections.Counter()
promovidos = criados = 0
for cod, tipo, la, lo, al in equips:
    best, bd = mais_perto(grade, postes, la, lo)
    if best is not None and bd <= RAIO_EQ_M:
        eq_poste[best].append([cod, tipo])
        continue
    # sem poste MT perto: o poste do VERA (BT) que segura o equipamento é estrutura de MT
    k, d = mais_perto(g_vera, vera, la, lo)
    if k is not None and d <= RAIO_EQ_M and k not in postes:
        postes[k] = [vera[k][0], vera[k][1], al, '']
        origem[k] = 'E'
        promovidos += 1
    else:
        # nenhum poste na base: o próprio equipamento vira a estrutura a inspecionar
        k = cod
        postes[k] = [la, lo, al, '']
        origem[k] = 'S'
        criados += 1
        sem_poste[tipo] += 1
    grade[(int(postes[k][0] / C), int(postes[k][1] / C))].append(k)
    eq_poste[k].append([cod, tipo])

# ── quadras: as áreas da programação do gestor (KML em dados/fontes) ──────────────────────────────
# Cada polígono é uma quadra (rota de campo). Poste fora de todos os polígonos, mas a até ENCOSTA_M de um
# deles, vai para o mais próximo (é a avenida entre duas quadras). O resto vira setor «fora da programação»
# numa grade de LADO_M, partido até MAX_POSTES e com o setor pequeno juntado no vizinho.
import xml.etree.ElementTree as ET
NS = {'k': 'http://www.opengis.net/kml/2.2'}
FONTES = os.path.join(os.path.dirname(__file__), '..', 'dados', 'fontes')
KMLS = (('Programação de Palmas.kml', 'Palmas', 'PA'), ('Programação de Taquaralto.kml', 'Taquaralto', 'TQ'))
ENCOSTA_M = 100


def info_descricao(txt):
    t = ' '.join((txt or '').split())
    st = re.search(r'ST[AU]+TUS\s*:\s*([A-ZÇÃÕÉ ]+?)(?=\s+DATA|\s+\d|$)', t, re.I)
    dt = re.search(r'DATA\s*:\s*(\d{2}/\d{2}/\d{2,4})', t, re.I)
    qo = re.search(r'QUANTIDADE DE OS\s*:\s*(\d+)', t, re.I)
    ano = re.search(r'(20\d\d)', t)
    return {'status': st.group(1).strip().upper() if st else '', 'data': dt.group(1) if dt else '',
            'os': int(qo.group(1)) if qo and int(qo.group(1)) < 5000 else None,
            'ano': ano.group(1) if ano and not dt else ''}


areas = []
for arq, local, pref in KMLS:
    vistos = collections.Counter()
    n = 0
    for pm in ET.parse(os.path.join(FONTES, arq)).getroot().iter('{%s}Placemark' % NS['k']):
        anel = pm.find('.//k:Polygon/k:outerBoundaryIs/k:LinearRing/k:coordinates', NS)
        if anel is None:
            continue
        n += 1
        pts = [tuple(map(float, c.split(',')[:2])) for c in anel.text.split()]   # (lon, lat)
        nome = ' '.join(pm.find('k:name', NS).text.split()).replace(' (polígono)', '')
        vistos[nome] += 1
        if vistos[nome] > 1:
            nome += f' ({vistos[nome]})'
        d = pm.find('k:description', NS)
        area_m2 = abs(sum((pts[k][0] * pts[k + 1][1] - pts[k + 1][0] * pts[k][1]) for k in range(len(pts) - 1))) / 2 * KX * KY
        areas.append({'id': f'{pref}-{n:02d}', 'nome': nome, 'local': local, 'pts': pts, 'area': area_m2,
                      'prog': info_descricao(d.text if d is not None else ''),
                      'bb': (min(x for x, _ in pts), max(x for x, _ in pts), min(y for _, y in pts), max(y for _, y in pts))})


def dentro(x, y, pts):
    c = False
    j = len(pts) - 1
    for k in range(len(pts)):
        xi, yi = pts[k]
        xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = k
    return c


def dist_borda(x, y, pts):
    best = 1e18
    for k in range(len(pts) - 1):
        ax, ay = (pts[k][0] - x) * KX, (pts[k][1] - y) * KY
        bx, by = (pts[k + 1][0] - x) * KX, (pts[k + 1][1] - y) * KY
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        t = 0 if L == 0 else max(0, min(1, -(ax * dx + ay * dy) / L))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


membros = collections.defaultdict(list)
encostados = 0
sobra = []
GRAU = ENCOSTA_M / KY * 1.6
for pid, (la, lo, *_r) in postes.items():
    hits = [a for a in areas if a['bb'][0] <= lo <= a['bb'][1] and a['bb'][2] <= la <= a['bb'][3] and dentro(lo, la, a['pts'])]
    if hits:
        membros[min(hits, key=lambda a: a['area'])['id']].append(pid)   # sobreposição: a área menor
        continue
    perto = [(dist_borda(lo, la, a['pts']), a['id']) for a in areas
             if a['bb'][0] - GRAU <= lo <= a['bb'][1] + GRAU and a['bb'][2] - GRAU <= la <= a['bb'][3] + GRAU]
    perto = [x for x in perto if x[0] <= ENCOSTA_M]
    if perto:
        membros[min(perto)[1]].append(pid)
        encostados += 1
    else:
        sobra.append(pid)

cy, cx = LADO_M / KY, LADO_M / KX
celulas = collections.defaultdict(list)
for pid in sobra:
    la, lo = postes[pid][:2]
    celulas[(math.floor(la / cy), math.floor(lo / cx))].append(pid)


def parte(ids, caixa):
    """caixa = [lat_min, lon_min, lat_max, lon_max]; parte ao meio até caber."""
    if len(ids) <= MAX_POSTES:
        return [(ids, caixa)]
    la0, lo0, la1, lo1 = caixa
    if (la1 - la0) * KY >= (lo1 - lo0) * KX:
        m = (la0 + la1) / 2
        a = [p for p in ids if postes[p][0] >= m]   # norte primeiro
        b = [p for p in ids if postes[p][0] < m]
        return parte(a, [m, lo0, la1, lo1]) + parte(b, [la0, lo0, m, lo1])
    m = (lo0 + lo1) / 2
    a = [p for p in ids if postes[p][1] < m]        # oeste primeiro
    b = [p for p in ids if postes[p][1] >= m]
    return parte(a, [la0, lo0, la1, m]) + parte(b, [la0, m, la1, lo1])


mudou = True
while mudou:
    mudou = False
    for (i, j) in sorted(celulas, key=lambda k: len(celulas[k])):
        ids = celulas[(i, j)]
        if len(ids) >= MIN_POSTES:
            continue
        viz = [(i + a, j + b) for a in (-1, 0, 1) for b in (-1, 0, 1) if (a or b) and (i + a, j + b) in celulas]
        if not viz:
            continue
        alvo = min(viz, key=lambda k: len(celulas[k]))
        celulas[alvo] = celulas[alvo] + ids
        del celulas[(i, j)]
        mudou = True
        break

pedacos = []
for (i, j), ids in sorted(celulas.items(), key=lambda kv: (-kv[0][0], kv[0][1])):   # norte → sul, oeste → leste
    las = [postes[p][0] for p in ids]
    los = [postes[p][1] for p in ids]
    pedacos += parte(ids, [min(las), min(los), max(las), max(los)])


def casco(pts):
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts

    def cruz(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    baixo, cima = [], []
    for p in pts:
        while len(baixo) >= 2 and cruz(baixo[-2], baixo[-1], p) <= 0:
            baixo.pop()
        baixo.append(p)
    for p in reversed(pts):
        while len(cima) >= 2 and cruz(cima[-2], cima[-1], p) <= 0:
            cima.pop()
        cima.append(p)
    return baixo[:-1] + cima[:-1]


def registra(qid, nome, tipo, ids, contorno, prog=None, local=None):
    al_cont = collections.Counter(postes[p][2] for p in ids)
    if local is None:
        local = collections.Counter(SES[postes[p][2][4:10]][2] for p in ids).most_common(1)[0][0] if ids else ''
    q = {'id': qid, 'nome': nome, 'tipo': tipo, 'n': len(ids), 'local': local,
         'contorno': [[round(a, 6), round(b, 6)] for a, b in contorno],
         'centro': ([round(sum(postes[p][0] for p in ids) / len(ids), 6), round(sum(postes[p][1] for p in ids) / len(ids), 6)]
                    if ids else [round(sum(b for _, b in contorno) / len(contorno), 6), round(sum(a for a, _ in contorno) / len(contorno), 6)]),
         'alims': [a for a, _ in al_cont.most_common()]}
    if prog:
        q['prog'] = prog
    for p in ids:
        q_do_poste[p] = len(quadras)
    quadras.append(q)


quadras = []
q_do_poste = {}
for a in areas:
    registra(a['id'], a['nome'], 'programacao', membros.get(a['id'], []), [(lat, lon) for lon, lat in a['pts']],
             {k: v for k, v in a['prog'].items() if v}, a['local'])
# nome do setor de fora: a etiqueta de quadra mais próxima dos KML (pasta «Quadras Nome» e «ETIQUETAS»)
etiquetas = []
for arq, _l, _p in KMLS:
    for pm in ET.parse(os.path.join(FONTES, arq)).getroot().iter('{%s}Placemark' % NS['k']):
        pt = pm.find('.//k:Point/k:coordinates', NS)
        nm = pm.find('k:name', NS)
        if pt is not None and nm is not None and nm.text and 'Hotel' not in nm.text:
            lo, la = map(float, pt.text.strip().split(',')[:2])
            etiquetas.append((la, lo, ' '.join(nm.text.split())))
for n, (ids, _cx) in enumerate(pedacos, 1):
    cla = sum(postes[p][0] for p in ids) / len(ids)
    clo = sum(postes[p][1] for p in ids) / len(ids)
    d, rot = min((math.hypot((la - cla) * KY, (lo - clo) * KX), nm) for la, lo, nm in etiquetas)
    nome = f'Fora · perto de {rot}' if d <= 1500 else f'Fora da programação {n:02d}'
    registra(f'FS-{n:02d}', nome, 'fora', ids, casco([(postes[p][0], postes[p][1]) for p in ids]))

# saída compacta: poste = [id, lat, lon, ialim, iquadra, trecho, [[cod, tipo], ...], origem]
ial = {a: i for i, a in enumerate(alims)}
lista = []
for pid in sorted(postes, key=lambda p: (q_do_poste[p], -postes[p][0], postes[p][1])):
    la, lo, al, tr = postes[pid]
    lista.append([pid, round(la, 6), round(lo, 6), ial[al], q_do_poste[pid], tr, eq_poste.get(pid, []), origem[pid]])

tipos_eq = sorted({t for v in eq_poste.values() for _, t in v})
alim_info = []
for a in alims:
    se, se_nome, local = SES[a[4:10]]
    alim_info.append({'cod': a, 'se': se, 'se_nome': se_nome, 'local': local,
                      'n': sum(1 for x in lista if x[3] == ial[a])})

base = {'versao': 1, 'gerado': __import__('datetime').date.today().isoformat(),
        'regua': {'rede': 'MT', 'alimentadores': 'AL de SE Palmas II, III, IV e Taquaralto II (sem LD, sem Taquaruçu)',
                  'quadras': 'áreas da Programação de Palmas e de Taquaralto (KML do gestor); poste a até '
                             f'{ENCOSTA_M} m de uma área vai para ela; o resto em setores de {LADO_M} m',
                  'max_postes_setor': MAX_POSTES, 'raio_equipamento_m': RAIO_EQ_M},
        'nomes_eq': {t: nome_eq(t) for t in tipos_eq},
        'alimentadores': alim_info, 'quadras': quadras, 'postes': lista}

os.makedirs(SAIDA, exist_ok=True)
with open(os.path.join(SAIDA, 'base.json'), 'w') as f:
    json.dump(base, f, ensure_ascii=False, separators=(',', ':'))
with open(os.path.join(SAIDA, 'rede.json'), 'w') as f:
    json.dump({'alimentadores': alims, 'rede': [rede[a] for a in alims]}, f, separators=(',', ':'))

# conferências
assert len(lista) == len(postes) == len(q_do_poste)
assert sum(q['n'] for q in quadras) == len(lista)
assert all(q['n'] <= MAX_POSTES for q in quadras if q['tipo'] == 'fora')
tam = sorted(q['n'] for q in quadras)
print(f'alimentadores {len(alims)}: ' + ', '.join(alims))
print(f'postes MT {len(lista)} (índice ARGOS {n_indice} + início de vão {vindo_do_vao} + VERA na ponta de vão {da_ponta}); '
      f'{len(set(postes) - set(vera))} fora do VERA')
print('por local', collections.Counter(SES[x['cod'][4:10]][2] for x in alim_info for _ in range(x['n'])))
prog = [q for q in quadras if q['tipo'] == 'programacao']
fora = [q for q in quadras if q['tipo'] == 'fora']
print(f'quadras da programação {len(prog)} com {sum(q["n"] for q in prog)} postes ({encostados} encostados a até {ENCOSTA_M} m); vazias: ' + ', '.join(q['nome'] for q in prog if not q['n']))
print(f'setores fora da programação {len(fora)} com {sum(q["n"] for q in fora)} postes')
print(f'tamanho: mediana {tam[len(tam)//2]}, máx {tam[-1]} ({max(quadras, key=lambda q: q["n"])["nome"]}), mín {tam[0]}')
print('equipamentos em poste', collections.Counter(t for v in eq_poste.values() for _, t in v))
print(f'equipamento sem poste MT a ≤5 m: {promovidos} no poste do VERA, {criados} viraram estrutura própria', dict(sem_poste))
print('origem', collections.Counter(origem.values()))
assert len(origem) == len(postes)
print('postes com equipamento', len(eq_poste))
for f in ('base.json', 'rede.json'):
    print(f, os.path.getsize(os.path.join(SAIDA, f)) // 1024, 'KB')
