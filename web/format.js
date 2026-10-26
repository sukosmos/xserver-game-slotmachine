export function exactScore(value = '0') {
  return BigInt(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
export function compactScore(value = '0') {
  const number = BigInt(value);
  for (const [unit, suffix] of [[1000000000000n, '조'], [100000000n, '억'], [10000n, '만']]) {
    if (number >= unit) {
      const whole = number / unit, decimal = number % unit * 10n / unit;
      return `${exactScore(whole)}${decimal ? `.${decimal}` : ''}${suffix}`;
    }
  }
  return exactScore(number);
}
export function progress(score, target) {
  const value = BigInt(score) * 1000n / BigInt(target);
  return Number(value > 1000n ? 1000n : value < 0n ? 0n : value) / 10;
}
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
