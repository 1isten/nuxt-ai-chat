<script setup lang="ts">
const props = defineProps<{
  invocation: FindingsUIToolInvocation;
}>();

const color = computed(() => {
  return ({
    'output-error': 'bg-muted text-error',
  })[props.invocation.state as string] || 'bg-muted text-white';
});

const icon = computed(() => {
  return ({
    'input-available': 'i-lucide-clipboard-list',
    'output-error': 'i-lucide-triangle-alert',
  })[props.invocation.state as string] || 'i-lucide-loader-circle';
});

const message = computed(() => {
  return ({
    'input-available': 'Analyzing findings...',
    'output-error': 'Failed to generate findings',
  })[props.invocation.state as string] || 'Loading analysis...';
});

const severityConfig: Record<string, { color: string; bg: string; icon: string }> = {
  critical: { color: 'text-error', bg: 'bg-error/10', icon: 'i-lucide-octagon-alert' },
  warning: { color: 'text-warning', bg: 'bg-warning/10', icon: 'i-lucide-triangle-alert' },
  abnormal: { color: 'text-warning', bg: 'bg-warning/10', icon: 'i-lucide-circle-alert' },
  normal: { color: 'text-success', bg: 'bg-success/10', icon: 'i-lucide-check-circle' },
  info: { color: 'text-primary', bg: 'bg-primary/10', icon: 'i-lucide-info' },
};

function severityStyle(severity?: string) {
  const s = severity || 'info';
  return severityConfig[s] || severityConfig.info;
}

const findings = computed(() => {
  return props.invocation.output?.findings || [];
});

const title = computed(() => {
  return props.invocation.output?.title || 'Analysis Findings';
});

const summary = computed(() => {
  return props.invocation.output?.summary || null;
});
</script>

<template>
  <div v-if="invocation.state === 'output-available'" class="my-5">
    <div class="flex items-center gap-2 mb-3">
      <UIcon name="i-lucide-clipboard-list" class="size-5 text-primary shrink-0" />
      <div class="min-w-0">
        <h3 class="text-lg font-semibold truncate">
          {{ title }}
        </h3>
      </div>
    </div>

    <div class="rounded-lg border border-default overflow-hidden">
      <!-- Summary banner -->
      <div
        v-if="summary"
        class="px-4 py-2.5 bg-elevated/50 border-b border-default"
      >
        <p class="text-sm text-muted leading-relaxed">{{ summary }}</p>
      </div>

      <!-- Findings list -->
      <div class="divide-y divide-default">
        <div
          v-for="(finding, index) in findings"
          :key="index"
          class="px-4 py-3 flex items-start gap-3 hover:bg-elevated/30 transition-colors"
        >
          <!-- Severity icon -->
          <div
            class="size-8 rounded-md flex items-center justify-center shrink-0 mt-0.5"
            :class="severityStyle(finding.severity).bg"
          >
            <UIcon
              :name="severityStyle(finding.severity).icon"
              class="size-4"
              :class="severityStyle(finding.severity).color"
            />
          </div>

          <!-- Content -->
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2 flex-wrap">
              <span class="text-sm font-medium text-highlighted truncate">
                {{ finding.label }}
              </span>
              <span
                v-if="finding.value !== undefined"
                class="text-sm font-semibold"
                :class="severityStyle(finding.severity).color"
              >
                {{ finding.value }}
              </span>
            </div>
            <p
              v-if="finding.detail"
              class="text-xs text-muted mt-1 leading-relaxed"
            >
              {{ finding.detail }}
            </p>
          </div>
        </div>
      </div>

      <!-- Empty state -->
      <div
        v-if="!findings.length"
        class="px-4 py-8 text-center text-sm text-dimmed"
      >
        No findings to display
      </div>
    </div>
  </div>
</template>
