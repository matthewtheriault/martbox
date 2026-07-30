/// <reference types="vite/client" />

import type { OvrlookApi } from '../../preload/index'

declare global {
  interface Window {
    api: OvrlookApi
  }
}
