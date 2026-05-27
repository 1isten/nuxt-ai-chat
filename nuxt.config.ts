// https://nuxt.com/docs/api/configuration/nuxt-config
//
// This project is built as a static SPA (`nuxt generate`). The /api/* and
// /auth/* endpoints under server/ are written so they can also be imported
// into a separate vanilla h3 server (e.g. inside an Electron app). See
// the README and `examples/standalone-server.js`.
export default defineNuxtConfig({
  // Static SPA: no SSR. `nuxt generate` produces a deployable static bundle.
  ssr: false,
  ...(process.env.PACK_ENV === 'electron' ? {
    app: {
      baseURL: '.',
      // buildAssetsDir: '/assets/',
    },
    router: {
      options: {
        hashMode: true,
      },
    },
  } : {
    devServer: {
      host: '127.0.0.1',
      port: 18041,
    },
  }),

  routeRules: {
    // '/api/proxy/deepseek/v1/**': { csurf: false },
  },

  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@comark/nuxt',
    '@vueuse/nuxt',
    // '@nuxthub/core',     // disabled: db is provided via server/utils/db.ts (libsql)
    // 'nuxt-auth-utils',   // disabled: auth is provided via server/utils/auth.ts stub
    'nuxt-charts',
    'nuxt-csurf',
  ],

  devtools: {
    enabled: false,
  },

  css: ['~/assets/css/main.css'],

  colorMode: {
    preference: 'dark',
    fallback: 'dark',
    storage: 'sessionStorage',
  },

  ui: {
    theme: {
      colors: [
        'primary',
        'secondary',
        'tertiary', // extra
        'success',
        'info',
        'warning',
        'error',
      ],
    },
    // prose: true,
    fonts: true,
  },
  runtimeConfig: {
    public: {
      // When the static SPA is served separately from the API, set
      // NUXT_PUBLIC_API_BASE to the API origin. Empty string = same origin.
      apiBase: '',
    },
  },

  experimental: {
    viewTransition: true,
  },

  compatibilityDate: '2024-07-11',

  nitro: {
    experimental: {
      openAPI: true,
    },
  },

  // hub block dropped — not deploying to NuxtHub.
  // hub: { db: 'sqlite', blob: true },

  vite: {
    optimizeDeps: {
      include: [
        'striptags', // CJS
        'motion-v',
        'date-fns',
        '@ai-sdk/vue',
        'ai',
        '@shikijs/langs/html',
        '@shikijs/langs/css',
        '@shikijs/langs/python',
        '@shikijs/langs/sql',
        '@shikijs/langs/go',
        '@shikijs/langs/rust',
        '@shikijs/langs/java',
        '@shikijs/langs/c',
        '@shikijs/langs/cpp',
        '@shikijs/langs/ruby',
        '@shikijs/langs/php',
        '@shikijs/langs/swift',
        '@shikijs/langs/kotlin',
        '@shikijs/langs/diff',
        '@shikijs/langs/dockerfile',
        '@shikijs/langs/xml',
        '@shikijs/langs/toml',
        '@shikijs/langs/graphql',
      ],
    },
  },

  eslint: {
    config: {
      stylistic: {
        indent: 2,
        quotes: 'single',
        semi: true,
        commaDangle: 'always-multiline',
        braceStyle: '1tbs',
        arrowParens: true,
      },
    },
  },

  fonts: {
    providers: {
      google: false,
      googleicons: false,
      fontshare: false,
    },
    priority: ['fontsource', 'bunny'],
    defaults: {
      subsets: ['latin'],
      weights: [400, 500, 600, 700],
      styles: ['normal', 'italic'],
    },
    // processCSSVariables: true,
  },
});
