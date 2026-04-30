<script setup lang="ts">
const { skills, enabledCount, isEnabled, toggle, refreshSkills } = useSkills();

onMounted(() => {
  void refreshSkills();
});

const open = ref(false);

const items = computed(() =>
  skills.value.map((s) => ({
    type: 'checkbox' as const,
    label: s.name,
    description: s.description,
    checked: isEnabled(s.name),
    onUpdateChecked(checked: boolean) {
      toggle(s.name, checked);
    },
    // Keep the menu open after a click so users can toggle multiple skills.
    onSelect(e: Event) {
      e.preventDefault();
    },
  })),
);
</script>

<template>
  <UDropdownMenu
    v-if="skills.length > 0"
    v-model:open="open"
    :items="items"
    :ui="{ content: 'max-w-96' }"
    :content="{ align: 'start', side: 'bottom', sideOffset: 6 }"
    size="sm"
  >
    <template #item-description="{ item }">
      <span :title="item.description">{{ item.description }}</span>
    </template>
    <UButton
      icon="i-lucide-wand-sparkles"
      size="sm"
      color="neutral"
      variant="ghost"
      :title="enabledCount > 0 ? `${enabledCount} skill${enabledCount === 1 ? '' : 's'} active` : 'Skills'"
      class="p-1.5 data-[state=open]:bg-elevated"
    >
      <span v-if="enabledCount > 0" class="text-xs text-muted">
        {{ enabledCount }}
      </span>
    </UButton>
  </UDropdownMenu>
</template>
