// Pure functions for two-way scroll sync between the editor and the preview.

/** One rendered block and the source line it starts at. */
export interface ScrollSample {
  line: number;
  top: number;
}

const MAX_SAMPLES = 2000;

/**
 * Positions of the rendered blocks inside `container`, measured from the top of
 * its content. Above `MAX_SAMPLES` blocks the list is thinned by a fixed step,
 * always keeping the last block.
 */
export function buildSamples(container: HTMLElement): ScrollSample[] {
  const elements = Array.from(container.querySelectorAll<HTMLElement>("[data-source-line]"));
  if (elements.length === 0) return [];

  const step = Math.ceil(elements.length / MAX_SAMPLES);
  const picked = step > 1 ? elements.filter((_, index) => index % step === 0) : elements.slice();
  const last = elements[elements.length - 1];
  if (picked[picked.length - 1] !== last) picked.push(last);

  const origin = container.getBoundingClientRect().top - container.scrollTop;
  const samples: ScrollSample[] = [];
  for (const element of picked) {
    const line = Number(element.dataset.sourceLine);
    if (!Number.isFinite(line)) continue;
    samples.push({ line, top: element.getBoundingClientRect().top - origin });
  }
  return samples;
}

/** Scroll offset the preview should take to show `line`. */
export function computeTarget(samples: ScrollSample[], line: number): number {
  return interpolate(
    samples,
    line,
    (sample) => sample.line,
    (sample) => sample.top
  );
}

/** Source line under scroll offset `top`. */
export function computeLine(samples: ScrollSample[], top: number): number {
  return Math.round(
    interpolate(
      samples,
      top,
      (sample) => sample.top,
      (sample) => sample.line
    )
  );
}

function interpolate(
  samples: ScrollSample[],
  value: number,
  keyOf: (sample: ScrollSample) => number,
  valueOf: (sample: ScrollSample) => number
): number {
  if (samples.length === 0) return 0;
  if (value <= keyOf(samples[0])) return valueOf(samples[0]);

  const last = samples.length - 1;
  if (value >= keyOf(samples[last])) return valueOf(samples[last]);

  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (keyOf(samples[middle]) <= value) low = middle;
    else high = middle;
  }

  const start = keyOf(samples[low]);
  const span = keyOf(samples[high]) - start;
  if (span <= 0) return valueOf(samples[high]);

  const ratio = (value - start) / span;
  return valueOf(samples[low]) + (valueOf(samples[high]) - valueOf(samples[low])) * ratio;
}
