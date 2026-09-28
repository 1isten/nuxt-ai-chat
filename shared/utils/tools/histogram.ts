import { tool } from 'ai';
import { z } from 'zod';
import type { UIToolInvocation } from 'ai';

export type HistogramUIToolInvocation = UIToolInvocation<typeof histogramTool>;

export const histogramTool = tool({
  description: [
    'Render a PIXEL INTENSITY HISTOGRAM as a bar chart with a statistical summary.',
    'Use it whenever you have a histogram from the frontend bridge (snapshot, ROI sample, or volume scan) instead of printing raw histogram JSON.',
    '`bins` must equal `counts.length` — one count per bin — and `max` must be greater than `min`, because the bar positions are derived from that range.',
  ].join(' '),
  inputSchema: z.object({
    title: z.string().optional().describe('Title of the chart'),
    bins: z.number().min(2).max(256).describe('Number of bins; must match the length of `counts`.'),
    min: z.number().describe('Lowest value of the scanned range.'),
    max: z.number().describe('Highest value of the scanned range; must be greater than `min`.'),
    counts: z.array(z.number()).describe('One count per bin, in ascending bin order; its length must equal `bins`.'),
    statistics: z.object({
      mean: z.number(),
      median: z.number(),
      stddev: z.number().optional(),
      min: z.number(),
      max: z.number(),
    }).optional().describe('Optional summary statistics shown above the bars.'),
    xLabel: z.string().optional().describe('Optional x-axis label'),
    yLabel: z.string().optional().describe('Optional y-axis label'),
  }),
  execute: async ({ title, bins, min, max, counts, statistics, xLabel, yLabel }) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // `error` is only set by the server-side tool that performs the real call.
    return { error: undefined as string | undefined, title, bins, min, max, counts, statistics, xLabel, yLabel };
  },
});
