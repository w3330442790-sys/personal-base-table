import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  resetKey: unknown;
  children: ReactNode;
}

interface State {
  error: Error | null;
  resetKey: unknown;
}

/** 表格渲染兜底:单个渲染错误只影响内容区,不再让整个笔记视图空白。 */
export class TableErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (state.error && props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    if (!state.error && props.resetKey !== state.resetKey) return { resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[personal-base-table] 表格渲染失败", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <div className="workbook-crash" role="alert">
      <h3>表格渲染出错</h3>
      <p>数据没有丢失,文件也不会被改写。可以先撤销上一步,或重新打开这个文件。</p>
      <pre>{this.state.error.message}</pre>
      <button type="button" onClick={() => this.setState({ error: null })}>尝试重新渲染</button>
    </div>;
  }
}
