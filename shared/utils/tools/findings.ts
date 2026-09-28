import { tool } from 'ai';
import { z } from 'zod';
import type { UIToolInvocation } from 'ai';

export type FindingsUIToolInvocation = UIToolInvocation<typeof findingsTool>;

export const findingsTool = tool({
  description: [
    'Present structured ANALYSIS FINDINGS as a findings card.',
    'Use it after ROI measurements, segmentation, volume scans or any other quantitative image analysis, instead of dumping raw data as text.',
    'Every finding needs a `label`; `value`, `severity` and `detail` are optional.',
  ].join(' '),
  inputSchema: z.object({
    title: z.string().optional().describe('Title of the findings card'),
    summary: z.string().optional().describe('Optional one-line summary shown in a banner above the list.'),
    findings: z.array(z.object({
      label: z.string().describe('The observation itself; required, and rendered as the row title.'),
      value: z.union([z.string(), z.number()]).optional().describe('Optional measured value shown next to the label.'),
      severity: z.enum(['critical', 'warning', 'abnormal', 'normal', 'info']).optional().describe('Optional severity, which drives the row icon and colour.'),
      detail: z.string().optional().describe('Optional supporting detail shown under the label.'),
    })).describe('One entry per observation; must contain at least one.'),
  }),
  execute: async ({ title, summary, findings }) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // `error` is only set by the server-side tool that performs the real call.
    return { error: undefined as string | undefined, title, summary, findings };
  },
});
