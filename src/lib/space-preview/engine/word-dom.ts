// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import type { HElement } from 'docx-preview';

// docx-preview's supported h hook lets us mount its original pages before image tasks finish.
export function wordDom(
  target: Document,
  onWrapper: (wrapper: HTMLElement) => void,
  styles?: Set<string>,
) {
  const create = (value: HElement | Node | string): Node => {
    if (typeof value === 'string') return target.createTextNode(value);
    if ('nodeType' in value) return value as Node;
    const { ns, tagName, className, style, children, ...props } = value as HElement;
    if (tagName === '#comment') return target.createComment(String(children?.[0] ?? ''));
    const node =
      tagName === '#fragment'
        ? target.createDocumentFragment()
        : ns
          ? target.createElementNS(ns, tagName!)
          : target.createElement(tagName!);
    if (node.nodeType === 1) {
      const element = node as HTMLElement;
      if (className) element.setAttribute('class', className);
      if (typeof style === 'string') element.setAttribute('style', style);
      else if (style) Object.assign(element.style, style);
      for (const [key, property] of Object.entries(props))
        if (property !== undefined) Reflect.set(element, key, property);
    }
    children?.forEach((child) => node.appendChild(create(child)));
    if (tagName === 'style') {
      const css = node.textContent ?? '';
      if (!styles?.has(css)) {
        target.head.appendChild(node);
        styles?.add(css);
      }
    }
    if (className === 'docx-wrapper') onWrapper(node as HTMLElement);
    return node;
  };
  return create;
}
