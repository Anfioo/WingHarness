/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** BUILD_DEV=1 at build time keeps the dev menu (reload + devtools) in a packaged build. */
  readonly BUILD_DEV?: string;
}
