import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

export function readDocuments(root = repositoryRoot) {
  const documents = new Map();
  for (const directory of ['', 'docs', 'data']) {
    for (const name of readdirSync(join(root, directory))) {
      if (name.endsWith('.md')) {
        const path = join(directory, name);
        documents.set(path, readFileSync(join(root, path), 'utf8'));
      }
    }
  }
  return documents;
}

const rows = (text) => text.split('\n').filter((line) => line.startsWith('|')).map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
const clean = (text) => text.replaceAll('**', '').replaceAll('`', '');

export function checkDocumentation(rules, documents) {
  const doc = (name) => {
    assert.ok(documents.has(name), `Missing document ${name}`);
    return documents.get(name);
  };
  const core = doc('docs/02-CORE_RULES.md');
  assert.ok(core.includes('item.effect.extraFactor.num / item.effect.extraFactor.den'), 'payout formula must reference JSON extraFactor');
  const coreRows = rows(core);
  const totalWeight = rules.symbols.reduce((sum, symbol) => sum + symbol.weight, 0);
  for (const symbol of rules.symbols) {
    const row = coreRows.find((cells) => cells[0] === symbol.id);
    assert.ok(row, `Missing symbol row ${symbol.id}`);
    assert.equal(row[1], symbol.display, `${symbol.id} display drift`);
    assert.equal(Number(row[2]), symbol.weight, `${symbol.id} weight drift`);
    assert.ok(Math.abs(Number(row[3].replace('%', '')) - symbol.weight / totalWeight * 100) < 0.011, `${symbol.id} probability drift`);
    assert.equal(row[4], symbol.basePoint.toString(), `${symbol.id} base score drift`);
    assert.equal(row[5], symbol.linePayout.toString(), `${symbol.id} payout drift`);
  }
  const targets = coreRows.filter((cells) => cells.length === 2 && /^\d+$/.test(cells[0]));
  assert.deepEqual(targets, rules.targets.map((target, index) => [String(index + 1), target.toString()]), 'round target table drift');
  assert.ok(doc('docs/05-PROGRESSION_RANKING.md').includes(`[${rules.targets.join(',')}]`), 'progression target list drift');

  const decisions = rows(doc('docs/10-DECISIONS.md')).map((row) => row.map(clean));
  const { round, economy, shop } = rules.balance;
  const decisionValues = {
    '기본 Hand': `${round.baseHands}회`, '초기 Coin': `${economy.startingCoins}`, '클리어 기본': `${economy.baseClearReward}`,
    '남은 Hand': `+${economy.unusedHandReward} coin/Hand`, '이자': `${economy.interestPerCoins}코인당 +1, 최대${economy.interestCap}`,
    '상점 진열': `${shop.slots}개`, '영구/제한 슬롯': `${shop.basePermanentItemSlots}/${shop.baseLimitedItemSlots}`,
    '최초 목표': `${rules.targets[0]}점`, '최종 목표': `${round.maxRoundMvp}라운드 승리`,
  };
  for (const [label, value] of Object.entries(decisionValues)) {
    assert.equal(decisions.find((row) => row[0] === label)?.[1], value, `decision drift: ${label}`);
  }

  const itemText = doc('docs/03-ITEM_SYSTEM.md');
  assert.ok(itemText.includes('`' + rules.balance.itemRules.boardModifierPriority.join('` → `') + '`'), 'board modifier priority drift');
  const itemRows = rows(itemText).map((row) => row.map(clean));
  for (const item of rules.catalog.items) {
    const { effect } = item;
    const path = `${item.id} documentation`;
    if (effect.kind === 'weight_add') {
      assert.ok(itemText.includes(`\`${item.nameKo}\`: +${effect.amount}(${item.price}코인, 최대 ${item.maxStacks})`), `${path}: weight/price/stack drift`);
    } else if (effect.kind === 'symbol_line_add_factor') {
      const percent = Number(effect.extraFactor.num) / Number(effect.extraFactor.den) * 100;
      assert.ok(itemText.includes(`\`${item.nameKo}\`: 추가 +${percent}%(${item.price}코인,`), `${path}: factor/price drift`);
    } else if (item.category !== 'economy') {
      const row = itemRows.find((cells) => cells[0] === item.nameKo);
      assert.ok(row, `${path}: missing row`);
      const priceText = row.at(-1);
      assert.equal(item.id === 'volatile_joker' ? Number(priceText.split('/')[1]) : Number(priceText.split('/')[0]), item.price, `${path}: price drift`);
      if (effect.triggerChanceBasisPoints !== undefined) {
        assert.match(row.join(' '), new RegExp(`(?:^|[^0-9])${effect.triggerChanceBasisPoints / 100}%`), `${path}: chance drift`);
      }
      if (item.slot === 'charged') assert.ok(row.join(' ').includes(`발동 ${item.initialCharges}회`), `${path}: charges drift`);
      if (item.slot === 'timed') assert.ok(row.join(' ').includes(`다음 ${item.durationSpins} Hand`), `${path}: duration drift`);
    }
  }
  const economyText = doc('docs/04-ECONOMY_SHOP.md');
  const economyRows = rows(economyText).map((row) => row.map(clean));
  for (const item of rules.catalog.items.filter((item) => item.category === 'economy')) {
    const row = economyRows.find((cells) => cells[0] === `${item.id} ${item.nameKo}`);
    assert.ok(row, `${item.id}: missing economy row`);
    assert.equal(Number(row[2]), item.price, `${item.id}: price drift`);
    assert.equal(row[3], item.maxStacks === 1 ? '유일' : `최대 ${item.maxStacks}`, `${item.id}: stack drift`);
    const effect = item.effect;
    const expectedEffects = {
      clear_base_coins_add: `기본 클리어 보상 +${effect.amount}`,
      interest_cap_add: `기본 이자 최대치 +${effect.amount}`,
      one_free_reroll_per_shop: `각 상점 ${effect.amount}회 무료 새로고침`,
      shop_item_cost_subtract: `모든 구매 가격 -${effect.amount}, 최소 ${effect.minPrice}`,
      chance_coins_on_clear: `라운드 성공 정산 시 ${effect.triggerChanceBasisPoints / 100}% 확률로 +${effect.coins}코인`,
    };
    assert.equal(row[1], expectedEffects[effect.kind], `${item.id}: economic effect drift`);
  }
  const formula = `coinReward = ${economy.baseClearReward} + handsRemaining + min(${economy.interestCap}, floor(coinsBeforeSettlement / ${economy.interestPerCoins}))`;
  assert.ok(economyText.includes(formula), 'coin reward formula drift');
  assert.ok(economyText.includes(`일반 ${shop.rarityWeight.common}%, 희귀 ${shop.rarityWeight.rare}%, 영웅 ${shop.rarityWeight.epic}%, 전설 ${shop.rarityWeight.legendary}%`), 'rarity weights drift');
  assert.ok(doc('data/README.md').includes(`**${rules.catalog.items.length}종**`), 'catalog count drift');
  return { documents: documents.size, items: rules.catalog.items.length, lines: rules.lines.length, symbols: rules.symbols.length, targets: rules.targets.length };
}

export function checkDocumentLinks(documents, root = repositoryRoot) {
  for (const [path, content] of documents) {
    for (const match of content.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
      const href = match[1].split('#')[0];
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      assert.ok(existsSync(resolve(root, dirname(path), href)), `Broken link in ${path}: ${href}`);
    }
  }
}
