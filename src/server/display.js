/** Exact decimal rendering; never convert a scoring fraction to floating point. */
export function decimalRatio({ num, den }, places = 4) {
  const numerator = BigInt(num), denominator = BigInt(den), scale = 10n ** BigInt(places);
  const scaled = numerator * scale / denominator;
  const decimals = String(scaled % scale).padStart(places, '0').replace(/0+$/, '');
  return `${numerator * scale % denominator ? '≈' : ''}${scaled / scale}${decimals ? `.${decimals}` : ''}`;
}
export const percent = (factor) => `${decimalRatio({ num: BigInt(factor.num) * 100n, den: factor.den })}%`;
