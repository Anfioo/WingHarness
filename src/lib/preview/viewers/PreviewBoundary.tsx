import { Component } from 'react'
import type { ReactNode } from 'react'

export class PreviewBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  render() {
    return this.state.error ? <div className="error-view">无法预览此文件：{this.state.error}</div> : this.props.children
  }
}
