// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const source = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? value.join('')
      : '';

export async function readNotebook(
  bytes: Uint8Array,
  markdown: (text: string) => Promise<string>,
  code: (text: string, language: string) => string,
) {
  const notebook = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells))
    throw new Error('只支持有效的 Jupyter Notebook v4。');
  if (notebook.cells.length > 500) throw new Error('Notebook 超过 500 个单元格。');
  const language =
    typeof notebook.metadata?.language_info?.name === 'string'
      ? notebook.metadata.language_info.name
      : 'plaintext';
  let characters = 0;
  const bounded = (text: string) => {
    characters += text.length;
    if (characters > 1000000) throw new Error('Notebook 正文与输出超过 1,000,000 字符。');
    return text;
  };
  const cells: string[] = [];
  for (const [index, cell] of notebook.cells.entries()) {
    const text = bounded(source(cell.source));
    if (cell.cell_type === 'markdown') cells.push(await markdown(text));
    else {
      const content = cell.cell_type === 'code' ? code(text, language) : escape(text);
      let outputs = '';
      if (Array.isArray(cell.outputs))
        for (const output of cell.outputs) {
          const plain =
            output.output_type === 'stream'
              ? source(output.text)
              : source(output.data?.['text/plain']);
          if (plain) outputs += `<pre class="notebook-output">${escape(bounded(plain))}</pre>`;
        }
      cells.push(
        `<section class="notebook-cell"><div class="notebook-cell-label">[${index + 1}] ${cell.cell_type === 'code' ? escape(language) : '文字'}</div><pre><code>${content}</code></pre>${outputs}</section>`,
      );
    }
  }
  return {
    html: cells.join('\n'),
    note: 'Notebook 只读预览 · 显示保存的代码和文本输出，不执行单元格；交互图表与图片输出暂不显示',
  };
}
