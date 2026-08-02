/// <reference types="vite/client" />

import type { MartBoxApi } from '../../preload/index'

declare global {
  interface Window {
    api: MartBoxApi
  }
}
