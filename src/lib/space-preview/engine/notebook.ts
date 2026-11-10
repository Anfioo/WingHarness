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
    throw new Error('Only valid Jupyter Notebook v4 is supported.');
  if (notebook.cells.length > 500) throw new Error('The notebook exceeds 500 cells.');
  const language =
    typeof notebook.metadata?.language_info?.name === 'string'
      ? notebook.metadata.language_info.name
      : 'plaintext';
  let characters = 0;
  const bounded = (text: string) => {
    characters += text.length;
    if (characters > 1000000) throw new Error('The notebook body and outputs exceed 1,000,000 characters.');
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
        `<section class="notebook-cell"><div class="notebook-cell-label">[${index + 1}] ${cell.cell_type === 'code' ? escape(language) : 'Text'}</div><pre><code>${content}</code></pre>${outputs}</section>`,
      );
    }
  }
  return {
    html: cells.join('\n'),
    note: 'Notebook read-only preview · shows the saved code and text outputs, does not run cells; interactive charts and image outputs are not shown',
  };
}
