let engine: Promise<typeof import('pptxviewjs')> | undefined

export function presentationEngine(): Promise<typeof import('pptxviewjs')> {
  if (!engine) {
    const fileReader = window.FileReader
    engine = import('pptxviewjs').finally(() => { window.FileReader = fileReader })
  }
  return engine
}
