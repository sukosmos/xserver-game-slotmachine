export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Presentation only: endpoints come from the server, intermediate numbers are never submitted. */
export function interpolateScore(from, to, thousandths) {
  const step = BigInt(Math.max(0, Math.min(1000, Math.floor(thousandths))));
  return String(BigInt(from) + (BigInt(to) - BigInt(from)) * step / 1000n);
}

export async function presentSpin({ event, presentation, fast = false, reduced = false, show, fill, wait = delay }) {
  const pause = (normal, quick = normal / 2) => wait(fast ? quick : normal);
  if (!reduced) { show('stopping', { board: event.rawBoard }); await pause(560, 260); }
  const changed = event.rawBoard.some((id, i) => id !== event.board[i]);
  if (changed) { show('raw', { board: event.rawBoard }); await pause(reduced ? 120 : 280); }
  show('reveal', { board: event.board }); await pause(reduced ? 80 : 200);
  const effects = presentation?.effects ?? [];
  // Batches keep large builds readable without making each spin excessively long.
  for (let index = 0; index < effects.length; index += 3) {
    show('effects', { effects: effects.slice(index, index + 3), board: event.board });
    await pause(700, 400);
  }
  show('score', { board: event.board });
  await fill(reduced ? 0 : fast ? 280 : 650);
  if (event.settlement) {
    show('clear', { reward: event.settlement.reward, board: event.board });
    await pause(1050, 650);
  }
}
