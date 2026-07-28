<script setup lang="ts">
const props = defineProps<{
  invocation: HistogramUIToolInvocation;
}>();

const color = computed(() => {
  return ({
    'output-error': 'bg-muted text-error',
  })[props.invocation.state as string] || 'bg-muted text-white';
});

const icon = computed(() => {
  return ({
    'input-available': 'i-lucide-chart-no-axes-column',
    'output-error': 'i-lucide-triangle-alert',
  })[props.invocation.state as string] || 'i-lucide-loader-circle';
});

const message = computed(() => {
  return ({
    'input-available': 'Computing histogram...',
    'output-error': 'Failed to generate histogram',
  })[props.invocation.state as string] || 'Loading histogram...';
});

const output = computed(() => props.invocation.output);

const chartData = computed(() => {
  const data = output.value;
  if (!data?.counts || !data?.bins) return [];
  const binWidth = (data.max - data.min) / data.bins;
  return data.counts.map((count: number, i: number) => ({
    bin: Math.round(data.min + binWidth * i + binWidth / 2),
    count,
  }));
});

const categories = computed<Record<string, BulletLegendItemInterface>>(() => ({
  count: { name: 'Pixel Count', color: '#60a5fa' },
}));

const formatValue = (value: string | number | undefined): string => {
  if (value === undefined || value === null) return 'N/A';
  if (typeof value === 'string') return value;
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
};

const statistics = computed(() => {
  const stats = output.value?.statistics;
  if (!stats) return null;
  return [
    { label: 'Min', value: formatValue(stats.min) },
    { label: 'Max', value: formatValue(stats.max) },
    { label: 'Mean', value: formatValue(stats.mean) },
    { label: 'Median', value: formatValue(stats.median) },
    { label: 'StdDev', value: formatValue(stats.stddev ?? stats.sdev) },
  ];
});
</script>

<template>
  <div v-if="invocation.state === 'output-available'" class="my-5">
    <div v-if="output.title" class="flex items-center gap-2 mb-2">
      <UIcon name="i-lucide-chart-no-axes-column" class="size-5 text-primary shrink-0" />
      <div class="min-w-0">
        <h3 class="text-lg font-semibold truncate">
          {{ output.title }}
        </h3>
      </div>
    </div>

    <div class="rounded-lg border border-default overflow-hidden">
      <!-- Statistics summary -->
      <div
        v-if="statistics"
        class="px-4 py-3 bg-elevated/50 border-b border-default"
      >
        <div class="flex flex-wrap gap-x-5 gap-y-1.5">
          <div
            v-for="stat in statistics"
            :key="stat.label"
            class="flex items-baseline gap-1.5"
          >
            <span class="text-xs text-dimmed font-medium">{{ stat.label }}</span>
            <span class="text-sm font-semibold text-highlighted">{{ stat.value }}</span>
          </div>
        </div>
      </div>

      <!-- Histogram bars -->
      <div class="relative overflow-hidden px-2 py-4">
        <div class="dot-pattern h-full -top-5 left-0 right-0" />

        <template v-if="chartData.length > 0">
          <BarChart
            :height="220"
            :data="chartData"
            :categories="categories"
            x-axis="bin"
            :y-axis="['count']"
            :x-label="output.xLabel || 'Intensity'"
            :y-label="output.yLabel || 'Pixel Count'"
            :y-grid-line="true"
            :hide-legend="true"
            :x-num-ticks="Math.min(8, Math.ceil(chartData.length / 10))"
            :y-num-ticks="4"
            :show-tooltip="true"
            :rounded-corners="0"
            :bar-margin="0"
          >
            <template #tooltip="{ values }">
              <div
                v-if="values"
                class="bg-muted/50 rounded-sm px-2 py-1 shadow-lg backdrop-blur-sm max-w-xs ring ring-offset-2 ring-offset-bg ring-default border border-default"
              >
                <div class="text-xs text-muted">
                  {{ output.xLabel || 'Intensity' }}: {{ values.bin }}
                </div>
                <div class="text-sm font-semibold text-highlighted">
                  {{ formatValue(values.count) }} pixels
                </div>
              </div>
            </template>
          </BarChart>
        </template>

        <div
          v-else
          class="flex items-center justify-center py-10 text-sm text-dimmed"
        >
          No histogram data
        </div>
      </div>
    </div>
  </div>
</template>
