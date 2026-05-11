import { tool } from 'ai';
import { z } from 'zod';
import type { UIToolInvocation } from 'ai';

export type AreaChartUIToolInvocation = UIToolInvocation<typeof areaChartTool>;

export const areaChartTool = tool({
  description: [
    'Create an AREA chart to emphasize CUMULATIVE MAGNITUDE or COMPOSITION over an ordered axis (typically time or sequential index).',
    'Use when totals matter and especially when stacking multiple series whose sum is itself meaningful (e.g. cumulative file count by modality over time, total instances across categories per day).',
    'Set `stacked: true` to stack series; default is overlaid (semi-transparent) areas.',
    'For a pure trend line without filled area, prefer `chart` (line).',
    'Do NOT use for discrete independent categories — use `bar_chart`.',
    'Do NOT use for proportions of a single whole at a single point in time — use `donut_chart`.',
  ].join(' '),
  inputSchema: z.object({
    title: z.string().optional().describe('Title of the chart'),
    data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1).describe('REQUIRED: Array of data points (minimum 1). Each object must contain the xKey property and all series keys.'),
    xKey: z.string().describe('The property name in data objects to use for x-axis values (e.g. "month", "date", "index")'),
    series: z.array(z.object({
      key: z.string().describe('The property name in data objects for this series (must exist in all data points)'),
      name: z.string().describe('Display name for this series in the legend'),
      color: z.string().describe('Hex color code for this area (e.g. "#3b82f6")'),
    })).min(1).describe('Array of series configurations (minimum 1). Each series is one filled area on the chart.'),
    stacked: z.boolean().optional().describe('If true, stack the areas so their cumulative sum is shown. Use when the per-series total at each x is meaningful.'),
    xLabel: z.string().optional().describe('Optional label for x-axis'),
    yLabel: z.string().optional().describe('Optional label for y-axis'),
  }),
  execute: async ({ title, data, xKey, series, stacked, xLabel, yLabel }) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { title, data, xKey, series, stacked, xLabel, yLabel };
  },
});
