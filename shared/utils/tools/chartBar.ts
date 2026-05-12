import { tool } from 'ai';
import { z } from 'zod';
import type { UIToolInvocation } from 'ai';

export type BarChartUIToolInvocation = UIToolInvocation<typeof barChartTool>;

export const barChartTool = tool({
  description: [
    'Create a BAR chart to compare DISCRETE, INDEPENDENT categories (e.g. modalities, patient names, file types, countries, departments).',
    'Use this whenever the x-axis is a list of category labels rather than an ordered numeric/time axis, especially for counts, sums, averages, or comparisons across those categories.',
    'Supports grouped bars (multiple series), stacked bars (`stacked: true`), and horizontal layout (`horizontal: true`, useful when there are many long category labels).',
    'Examples: "instances per modality", "files per patient", "studies per year (as discrete buckets)", "sales by region".',
    'Do NOT use for ordered/continuous numeric axes — use `chart` (line) for trends.',
    'Do NOT use for proportions of a whole with few slices — use `donut_chart`.',
  ].join(' '),
  inputSchema: z.object({
    title: z.string().optional().describe('Title of the chart'),
    data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1).describe('REQUIRED: Array of data points (minimum 1). Each object must contain the xKey (category label) and every series key (numeric value).'),
    xKey: z.string().describe('The property name in data objects holding the CATEGORY label (e.g. "modality", "patient")'),
    series: z.array(z.object({
      key: z.string().describe('The property name in data objects for this series (must exist in all data points)'),
      name: z.string().describe('Display name for this series in the legend'),
      color: z.string().describe('Hex color code for this series (e.g. "#3b82f6")'),
    })).min(1).describe('Array of series configurations (minimum 1 series). Each series is one set of bars; multiple series produce grouped or stacked bars.'),
    stacked: z.boolean().optional().describe('If true, stack the series into a single bar per category instead of grouping them side-by-side. Use when the values sum to a meaningful total per category.'),
    horizontal: z.boolean().optional().describe('If true, render bars horizontally (categories on the y-axis). Prefer this when category labels are long.'),
    xLabel: z.string().optional().describe('Optional label for the category axis'),
    yLabel: z.string().optional().describe('Optional label for the value axis'),
  }),
  execute: async ({ title, data, xKey, series, stacked, horizontal, xLabel, yLabel }) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { title, data, xKey, series, stacked, horizontal, xLabel, yLabel };
  },
});
