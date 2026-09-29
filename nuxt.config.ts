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
    fonts: true,
    prose: false,
  },

  /**
   * Fully offline icons.
   *
   * `provider: 'none'` stops the Iconify API from being contacted at runtime;
   * every icon must then come from the client bundle, or it renders as nothing
   * (the console warns `[Icon] failed to load icon ...` when the network is
   * unreachable).
   *
   * Scanning is off by default, so it is enabled here and pointed at the places
   * that actually reference icons: our own app code, shared utilities, and
   * `@nuxt/ui`'s own components — that last one matters most, because its 44
   * built-in lucide icons live in a `node_modules` path that the scanner skips
   * by default. `refs/` and `test/` are excluded purely to keep the scan fast.
   *
   * Note: scanning is static, so it only sees literal icon names. Icons picked
   * by a runtime expression (e.g. `iconForModel()` in shared/utils/models.ts)
   * are not detected and must be listed in `icons` below.
   */
  icon: {
    provider: 'none',
    clientBundle: {
      scan: {
        globInclude: [
          '{app,shared}/**/*.{vue,ts}',
          'node_modules/@nuxt/ui/dist/**',
        ],
        globExclude: [
          'node_modules',
          'test',
          'refs',
          'dist',
          '.output',
          '.nuxt',
        ],
      },
    },
  },

  runtimeConfig: {
    public: {
      // When the static SPA is served separately from the API, set
      // NUXT_PUBLIC_API_BASE to the API origin. Empty string = same origin.
      apiBase: '',

      appTitle: '', // NUXT_PUBLIC_APP_TITLE
      appDescription: '', // NUXT_PUBLIC_APP_DESCRIPTION
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
