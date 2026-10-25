#!/usr/bin/env python3
"""Static validation for the NINE TO RUIN pre-implementation documentation bundle."""
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def load(name):
    with (ROOT / 'data' / name).open(encoding='utf-8') as f:
        return json.load(f)

def validate():
    balance = load('balance.v0.json')
    items = load('items.v0.json')['items']
    lines = load('lines.v0.json')['lines']
    symbols = balance['symbols']
    assert balance['round']['baseHands'] == 4
    assert len(balance['round']['roundTargets']) == 10
    assert [int(x['targetScore']) for x in balance['round']['roundTargets']] == [120,250,550,1200,3000,7500,18000,45000,120000,300000]
    assert len(symbols) == 5 and sum(s['weight'] for s in symbols) == 100
    assert len(lines) == 8 and len({ln['id'] for ln in lines}) == 8
    assert all(len(ln['indices']) == 3 and len(set(ln['indices'])) == 3 and all(0 <= idx < 9 for idx in ln['indices']) for ln in lines)
    assert len(items) == 27 and len({it['id'] for it in items}) == 27
    assert all(it['price'] > 0 and it['maxStacks'] >= 1 for it in items)
    assert all(it['slot'] in ('permanent','charged','timed') for it in items)
    kinds = {it['effect']['kind'] for it in items}
    assert len(kinds) >= 12
    for it in items:
        if it['slot'] == 'charged':
            assert it['initialCharges'] >= 1
        if it['slot'] == 'timed':
            assert it['durationSpins'] >= 1
        trigger = it['effect'].get('triggerChanceBasisPoints')
        if trigger is not None:
            assert 0 < trigger <= 10000
        if 'extraFactor' in it['effect']:
            frac = it['effect']['extraFactor']
            assert frac['num'] >= 0 and frac['den'] > 0
    # Validate all relative md links exist (ignore URL/fragments).
    files = list(ROOT.rglob('*.md'))
    broken = []
    for path in files:
        content = path.read_text(encoding='utf-8')
        for href in re.findall(r'(?<!!)\[[^]]+\]\(([^)]+)\)',content):
            href=href.split('#',1)[0]
            if '://' in href or href.startswith('#') or not href: continue
            if not (path.parent / href).exists(): broken.append((path.relative_to(ROOT),href))
    assert not broken, f'Broken relative links: {broken}'
    print(f'PASS: {len(files)} Markdown documents, {len(items)} items, {len(lines)} paylines, 5 symbols, 10 round goals')
    print(f'PASS: document links and economic/scoring config sanity checks')

if __name__ == '__main__':
    validate()
