/** Map a value onto an evenly spaced discrete or continuous slider. */
export function sliderProgress(value: number, min: number, max: number, steps?: readonly number[]): number {
  if (steps && steps.length > 1) {
    if (value <= steps[0]) return 0;
    if (value >= steps[steps.length - 1]) return 1;
    for (let i = 1; i < steps.length; i++) {
      if (value <= steps[i]) {
        const span = steps[i] - steps[i - 1];
        const fraction = span > 0 ? (value - steps[i - 1]) / span : 0;
        return (i - 1 + fraction) / (steps.length - 1);
      }
    }
  }
  return max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
}

/** Accessibility increments advance to the next actual step, including legacy values between steps. */
export function adjustedSliderValue(value: number, direction: 1 | -1, min: number, max: number, steps?: readonly number[], decimalPlaces = 0): number {
  if (steps && steps.length > 1) {
    if (direction > 0) return steps.find(step => step > value) ?? steps[steps.length - 1];
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i] < value) return steps[i];
    return steps[0];
  }
  const amount = 10 ** -decimalPlaces;
  return Number(Math.max(min, Math.min(max, value + direction * amount)).toFixed(decimalPlaces));
}
