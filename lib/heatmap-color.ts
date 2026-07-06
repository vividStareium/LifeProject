type Rgb = [number, number, number];

const colorStops: Array<{ at: number; rgb: Rgb }> = [
  { at: 0, rgb: [255, 255, 255] },
  { at: 0.05, rgb: [247, 252, 247] },
  { at: 0.25, rgb: [198, 230, 200] },
  { at: 0.5, rgb: [91, 176, 103] },
  { at: 0.75, rgb: [25, 130, 63] },
  { at: 0.95, rgb: [5, 63, 34] }
];

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

const interpolate = (left: Rgb, right: Rgb, ratio: number): Rgb => [
  Math.round(left[0] + (right[0] - left[0]) * ratio),
  Math.round(left[1] + (right[1] - left[1]) * ratio),
  Math.round(left[2] + (right[2] - left[2]) * ratio)
];

const rgbCss = ([red, green, blue]: Rgb) => `rgb(${red} ${green} ${blue})`;

export const completionHeatmapStyle = (completionPercent: number) => {
  const value = clamp(completionPercent, 0, 100);

  if (value >= 99.95) {
    return {
      backgroundColor: '#facc15',
      color: '#422006',
      boxShadow: 'inset 0 0 0 1px #ca8a04'
    };
  }

  const ratio = value / 100;
  const nextStopIndex = colorStops.findIndex((stop) => ratio <= stop.at);
  const right = colorStops[Math.max(1, nextStopIndex)];
  const left = colorStops[Math.max(0, colorStops.indexOf(right) - 1)];
  const segment = right.at - left.at || 1;
  const segmentRatio = clamp((ratio - left.at) / segment, 0, 1);
  const rgb = interpolate(left.rgb, right.rgb, segmentRatio);

  return {
    backgroundColor: rgbCss(rgb),
    color: ratio >= 0.5 ? '#f8fafc' : '#0f172a',
    boxShadow: 'inset 0 0 0 1px rgb(15 23 42 / 0.08)'
  };
};
