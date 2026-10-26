import test from 'node:test';
import assert from 'node:assert/strict';
import { readDocuments, checkDocumentation, checkDocumentLinks } from '../scripts/spec-checks.js';
import { rules } from './helpers.js';

test('documentation tables and relative links agree with JSON catalogs', () => {
  const documents = readDocuments();
  checkDocumentation(rules, documents);
  checkDocumentLinks(documents);
});

for (const [file, before, after] of [
  ['docs/02-CORE_RULES.md', '| cherry | 🍒 | 30 |', '| cherry | 🍒 | 31 |'],
  ['docs/02-CORE_RULES.md', '| 1 | 120 |', '| 1 | 200 |'],
  ['docs/03-ITEM_SYSTEM.md', '+10(2코인, 최대 3)', '+10(9코인, 최대 3)'],
  ['docs/03-ITEM_SYSTEM.md', '16% 확률로', '17% 확률로'],
  ['docs/04-ECONOMY_SHOP.md', 'min(2, floor(coinsBeforeSettlement / 5))', 'min(3, floor(coinsBeforeSettlement / 5))'],
  ['docs/04-ECONOMY_SHOP.md', '기본 클리어 보상 +1', '기본 클리어 보상 +2'],
  ['docs/04-ECONOMY_SHOP.md', '25% 확률로 +3코인', '25% 확률로 +4코인'],
]) {
  test(`spec checker detects drift: ${before}`, () => {
    const documents = readDocuments();
    assert.ok(documents.get(file).includes(before));
    documents.set(file, documents.get(file).replace(before, after));
    assert.throws(() => checkDocumentation(rules, documents));
  });
}
