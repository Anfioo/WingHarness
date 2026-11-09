// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
// XMind archives are read with the same importer the mind-map viewer uses.
import type { NodeObj } from 'mind-elixir';

export interface XMindSheet {
  title: string;
  nodeData: NodeObj;
}

export async function readXMind(bytes: Uint8Array, name: string): Promise<XMindSheet[]> {
  const { importXMindFile, convertXmindToMindElixir } = await import('@mind-elixir/import-xmind');
  const source = await importXMindFile(new File([bytes as BlobPart], name));
  if (source.length === 0) throw new Error('This XMind file has no sheet to show.');
  return source.map((sheet) => ({
    title: sheet.title,
    nodeData: plainMindNode(convertXmindToMindElixir(sheet).nodeData),
  }));
}

function plainMindNode(node: NodeObj): NodeObj {
  return {
    id: node.id,
    topic: node.topic,
    expanded: node.expanded,
    children: node.children?.map(plainMindNode),
  };
}
