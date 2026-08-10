<script setup lang="ts">
const colorMode = useColorMode();

const color = computed(() => colorMode.value === 'dark' ? '#1b1718' : 'white');

useHead({
  meta: [
    { charset: 'utf-8' },
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    { key: 'theme-color', name: 'theme-color', content: color },
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' },
  ],
  htmlAttrs: {
    lang: 'en',
  },
});

const appTitle = useState('app-title', () => (useRuntimeConfig().public.appTitle || 'AI Chatbot') as string);
const appDescription = useState('app-description', () => (useRuntimeConfig().public.appDescription || 'AI chatbot made with Nuxt UI.') as string);

const title = appTitle.value;
const description = appDescription.value;

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogImage: 'https://ui.nuxt.com/assets/templates/nuxt/chat-light.png',
  twitterCard: 'summary_large_image',
});
</script>

<template>
  <UApp :toaster="{ position: 'top-right' }" :tooltip="{ delayDuration: 200 }">
    <NuxtLoadingIndicator color="var(--ui-primary)" />

    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
