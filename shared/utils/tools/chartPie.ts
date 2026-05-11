import { tool } from 'ai';
import { z } from 'zod';
import type { UIToolInvocation } from 'ai';

export type PieChartUIToolInvocation = UIToolInvocation<typeof pieChartTool>;

export const pieChartTool = tool({
  description: [
    'Create a PIE or DONUT chart to show PROPORTIONS of a single whole — i.e. how a total breaks down across a small number of mutually-exclusive categories.',
    'Use only when the values truly sum to a meaningful total (e.g. share of modalities in a study, distribution of patient genders, % of files by type) AND there are at most 6–7 slices.',
    'Default visual is a donut (a ring); set `variant: "pie"` for a solid pie. ALWAYS honor the user\'s wording: if the user says "pie", "pie chart", or "slice of pie" set `variant: "pie"`; if the user says "donut", "doughnut", or "ring" set `variant: "donut"`. If the user does not specify, omit `variant` (donut is the default).',
    'Do NOT use this tool to compare absolute values across categories — `bar_chart` is almost always clearer.',
    'Do NOT use this tool when there are many categories (>6–7) — slices become unreadable; use `bar_chart` instead.',
    'Do NOT use this tool for ordered/time-series data — use `chart` (line) or `area_chart`.',
  ].join(' '),
  inputSchema: z.object({
    title: z.string().optional().describe('Title of the chart'),
    data: z.array(z.object({
      label: z.string().describe('Display label for this slice (shown in the legend and tooltip)'),
      value: z.number().describe('Numeric value for this slice; must be >= 0. Slices are auto-normalised, so raw counts or percentages both work.'),
      color: z.string().describe('Hex color code for this slice (e.g. "#3b82f6")'),
    })).min(2).max(8).describe('Array of slices (2 to 8). Each slice is a category contributing to the whole.'),
    variant: z.enum(['donut', 'pie']).optional().describe('Visual style. "donut" (default) renders a ring; "pie" renders a filled circle. MUST be set to "pie" when the user explicitly asks for a pie chart, and to "donut" when the user explicitly asks for a donut/doughnut/ring chart. Omit otherwise to use the donut default.'),
  }),
  execute: async ({ title, data, variant }) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { title, data, variant };
  },
});
