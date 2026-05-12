import { tool } from 'ai';
import { z } from 'zod';
import type { UIToolInvocation } from 'ai';

export type ChartUIToolInvocation = UIToolInvocation<typeof chartTool>;

export const chartTool = tool({
  description: [
    'Create a LINE chart for continuous data plotted on an ORDERED x-axis (time series, dates, sequential indices, or any naturally ordered numeric axis).',
    'Use when showing trends, evolution over time, or comparing how multiple metrics change across an ordered axis.',
    'Examples: stock price over months, temperature over days, instance values across SeriesNumber.',
    'Do NOT use this tool to compare a small number of independent categories (modalities, patient names, file types) — use `bar_chart` for that.',
    'Do NOT use this tool to show parts of a single whole / proportions — use `donut_chart` for that.',
    'Do NOT use this tool when totals or cumulative magnitude matter more than the line — use `area_chart` for that.',
  ].join(' '),
  inputSchema: z.object({
    title: z.string().optional().describe('Title of the chart'),
    data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1).describe('REQUIRED: Array of data points (minimum 1 point). Each object must contain the xKey property and all series keys'),
    xKey: z.string().describe('The property name in data objects to use for x-axis values (e.g., "month", "date")'),
    series: z.array(z.object({
      key: z.string().describe('The property name in data objects for this series (must exist in all data points)'),
      name: z.string().describe('Display name for this series in the legend'),
      color: z.string().describe('Hex color code for this line (e.g., "#3b82f6" for blue, "#10b981" for green)'),
    })).min(1).describe('Array of series configurations (minimum 1 series). Each series represents one line on the chart'),
    xLabel: z.string().optional().describe('Optional label for x-axis'),
    yLabel: z.string().optional().describe('Optional label for y-axis'),
  }),
  execute: async ({ title, data, xKey, series, xLabel, yLabel }) => {
    // Create a delay to simulate the input-available state
    await new Promise((resolve) => setTimeout(resolve, 1500));

    return {
      title,
      data,
      xKey,
      series,
      xLabel,
      yLabel,
    };
  },
});
