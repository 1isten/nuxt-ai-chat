<script setup lang="ts">
const props = defineProps<{
  invocation: DonutChartUIToolInvocation;
}>();

const color = computed(() => {
  return ({
    'output-error': 'bg-muted text-error',
  })[props.invocation.state as string] || 'bg-muted text-white';
});

const icon = computed(() => {
  return ({
    'input-available': 'i-lucide-pie-chart',
    'output-error': 'i-lucide-triangle-alert',
  })[props.invocation.state as string] || 'i-lucide-loader-circle';
});

const message = computed(() => {
  return ({
    'input-available': 'Generating chart...',
    'output-error': 'Can\'t generate chart, please try again',
  })[props.invocation.state as string] || 'Loading chart data...';
});

const isPie = computed(() => props.invocation.output && (props.invocation as DonutChartUIToolInvocation).output?.variant === 'pie');

const seriesValues = (invocation: DonutChartUIToolInvocation): number[] => {
  if (!invocation.output?.data) return [];
  return invocation.output.data.map((d) => Number(d.value) || 0);
};

const total = (invocation: DonutChartUIToolInvocation): number => {
  return seriesValues(invocation).reduce((acc, v) => acc + v, 0);
};

const categories = (invocation: DonutChartUIToolInvocation): Record<string, BulletLegendItemInterface> => {
  if (!invocation.output?.data) return {};
  return invocation.output.data.reduce((acc: Record<string, BulletLegendItemInterface>, slice, i) => {
    acc[`slice_${i}`] = { name: slice.label, color: slice.color };
    return acc;
  }, {} as Record<string, BulletLegendItemInterface>);
};

const formatValue = (value: number | undefined): string => {
  if (value === undefined || value === null || Number.isNaN(value)) return 'N/A';
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};

const formatPct = (value: number, sum: number): string => {
  if (!sum) return '';
  return `${((value / sum) * 100).toFixed(1)}%`;
};
</script>

<template>
  <div v-if="invocation.state === 'output-available'" class="my-5">
    <div v-if="invocation.output.title" class="flex items-center gap-2 mb-2">
      <UIcon name="i-lucide-pie-chart" class="size-5 text-primary shrink-0" />
      <div class="min-w-0">
        <h3 class="text-lg font-semibold truncate">
          {{ invocation.output.title }}
        </h3>
      </div>
    </div>

    <div class="relative overflow-hidden">
      <div class="dot-pattern h-full -top-5 left-0 right-0" />

      <DonutChart
        :height="300"
        :radius="0"
        :arc-width="isPie ? 999 : 36"
        :data="seriesValues(invocation)"
        :categories="categories(invocation)"
        :pad-angle="0"
        :legend-position="LegendPosition.Bottom"
        :hide-legend="false"
        :show-tooltip="true"
      >
        <template #tooltip="{ values }">
          <div
            v-if="values"
            class="bg-muted/50 rounded-sm px-2 py-1 shadow-lg backdrop-blur-sm max-w-xs ring ring-offset-2 ring-offset-bg ring-default border border-default"
          >
            <div class="text-sm font-semibold text-highlighted mb-1">
              {{ values.label }}
            </div>
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-highlighted">
                {{ formatValue(values[values.label]) }}
              </span>
              <span class="text-xs text-muted">
                {{ formatPct(values[values.label], total(invocation)) }}
              </span>
            </div>
          </div>
        </template>
      </DonutChart>
    </div>
  </div>

  <div v-else class="rounded-xl px-5 py-4 my-5" :class="color">
    <div class="flex items-center justify-center h-44">
      <div class="text-center">
        <UIcon
          :name="icon"
          class="size-8 mx-auto mb-2"
          :class="[invocation.state === 'input-streaming' && 'animate-spin']"
        />
        <div class="text-sm">
          {{ message }}
        </div>
      </div>
    </div>
  </div>
</template>
