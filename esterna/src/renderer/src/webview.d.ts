import type { DetailedHTMLProps, HTMLAttributes } from 'react'

// tag <webview> di Electron (scheda Regia con il pannello del server)
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { src?: string; partition?: string }
    }
  }
}
