declare module '*.css'
declare module '*?url' {
  const url: string
  export default url
}
declare module '*?url&no-inline' {
  const url: string
  export default url
}
declare module '*?raw' {
  const text: string
  export default text
}
interface ImportMeta {
  /** Vite: elenco dei file che corrispondono allo schema, già risolti (eager). */
  glob<T>(pattern: string, opts: { eager: true; query?: string; import?: string }): Record<string, T>
}
