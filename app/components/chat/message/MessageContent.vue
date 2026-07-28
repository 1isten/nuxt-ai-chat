<script setup lang="ts">
import { isReasoningUIPart, isTextUIPart, isToolUIPart, getToolName } from 'ai';
import type { UIMessage } from 'ai';
import { isPartStreaming, isToolStreaming } from '@nuxt/ui/utils/ai';

defineProps<{
  message: UIMessage;
  editing: boolean;
}>();

const emit = defineEmits<{
  save: [message: UIMessage, text: string];
  cancelEdit: [];
}>();

function getToolInputSuffix(part: unknown): string | undefined {
  const input = (part as { input?: Record<string, unknown> }).input;
  if (!input) return undefined;
  const vals = Object.values(input).filter((v) => typeof v === 'string' && v.trim().length > 0) as string[];
  if (!vals.length) return undefined;
  const s = vals[0]!;
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

function formatToolOutput(output: unknown): string {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  return JSON.stringify(output, null, 2);
}
</script>

<template>
  <template v-for="(part, index) in getMergedParts(message.parts)" :key="`${message.id}-${part.type}-${index}`">
    <UChatReasoning
      v-if="isReasoningUIPart(part)"
      :text="part.text"
      :streaming="isPartStreaming(part)"
      chevron="leading"
    >
      <ChatComark
        :markdown="part.text"
        :streaming="isPartStreaming(part)"
      />
    </UChatReasoning>

    <template v-else-if="isToolUIPart(part)">
      <ChatToolChart
        v-if="getToolName(part) === 'chart'"
        :invocation="{ ...(part as ChartUIToolInvocation) }"
      />
      <ChatToolChartBar
        v-else-if="getToolName(part) === 'bar_chart'"
        :invocation="{ ...(part as BarChartUIToolInvocation) }"
      />
      <ChatToolChartDonut
        v-else-if="getToolName(part) === 'donut_chart'"
        :invocation="{ ...(part as DonutChartUIToolInvocation) }"
      />
      <ChatToolChartArea
        v-else-if="getToolName(part) === 'area_chart'"
        :invocation="{ ...(part as AreaChartUIToolInvocation) }"
      />
      <ChatToolFindings
        v-else-if="getToolName(part) === 'findings'"
        :invocation="{ ...(part as FindingsUIToolInvocation) }"
      />
      <ChatToolHistogram
        v-else-if="getToolName(part) === 'histogram'"
        :invocation="{ ...(part as HistogramUIToolInvocation) }"
      />
      <ChatToolWeather
        v-else-if="getToolName(part) === 'weather'"
        :invocation="{ ...(part as WeatherUIToolInvocation) }"
      />
      <UChatTool
        v-else-if="getToolName(part) === 'web_search' || getToolName(part) === 'google_search'"
        :text="isToolStreaming(part) ? 'Searching the web...' : 'Searched the web'"
        :suffix="getSearchQuery(part)"
        :streaming="isToolStreaming(part)"
        chevron="leading"
      >
        <ChatToolSources :sources="getSources(part)" />
      </UChatTool>
      <UChatTool
        v-else
        :text="getToolName(part)"
        :suffix="getToolInputSuffix(part)"
        :streaming="isToolStreaming(part)"
        variant="card"
        chevron="leading"
      >
        <div class="space-y-2">
          <template v-if="(part as any).input && Object.keys((part as any).input).length > 0">
            <p class="text-xs font-medium uppercase tracking-wide opacity-50">
              Input
            </p>
            <pre class="text-xs font-mono whitespace-pre-wrap break-all">{{ JSON.stringify((part as any).input, null, 2) }}</pre>
          </template>
          <template v-if="(part as any).state === 'output-available'">
            <p class="text-xs font-medium uppercase tracking-wide opacity-50">
              Output
            </p>
            <pre class="text-xs font-mono whitespace-pre-wrap break-all">{{ formatToolOutput((part as any).output) }}</pre>
          </template>
          <template v-else-if="(part as any).state === 'output-error'">
            <p class="text-xs font-medium uppercase tracking-wide text-error">
              Error
            </p>
            <pre class="text-xs font-mono whitespace-pre-wrap break-all">{{ (part as any).errorText }}</pre>
          </template>
        </div>
      </UChatTool>
    </template>

    <template v-else-if="isTextUIPart(part)">
      <ChatComark
        v-if="message.role === 'assistant'"
        :markdown="part.text"
        :streaming="isPartStreaming(part)"
      />
      <template v-else-if="message.role === 'user'">
        <ChatMessageEdit
          v-if="editing"
          :message="message"
          :text="part.text"
          @save="(msg, text) => emit('save', msg, text)"
          @cancel="emit('cancelEdit')"
        />
        <p v-else class="whitespace-pre-wrap">
          {{ part.text }}
        </p>
      </template>
    </template>
  </template>
</template>
