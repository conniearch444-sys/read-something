import path from 'path-browserify';

export const camelCase = (str: string) => str.replace(/-([a-z])/gi, (_, c: string) => c.toUpperCase());

export const pathCompat = {
  resolve: (...args: string[]) => path.resolve(...args),
  basename: (p: string, ext?: string) => path.basename(p, ext),
  extname: (p: string) => path.extname(p),
  dirname: (p: string) => path.dirname(p),
  isAbsolutePosix: (p: string) => path.isAbsolute(p),
  joinPosix: (...args: string[]) => path.join(...args),
};

export { pathCompat as path };

type TocAstNode = {
  '#name': string;
  '$'?: Record<string, string>;
  '_'?: string;
  children: TocAstNode[];
  [key: string]: unknown;
};

const collectDirectText = (element: Element) => {
  let text = '';
  element.childNodes.forEach((child) => {
    if (child.nodeType !== Node.TEXT_NODE) return;
    text += child.textContent || '';
  });
  return text.replace(/\s+/g, ' ').trim();
};

const convertElementToTocAstNode = (element: Element): TocAstNode => {
  const node: TocAstNode = {
    '#name': element.tagName.toLowerCase(),
    children: [],
  };

  if (element.attributes.length > 0) {
    const attrs: Record<string, string> = {};
    Array.from(element.attributes).forEach((attr) => {
      attrs[attr.name] = attr.value;
    });
    node.$ = attrs;
  }

  const text = collectDirectText(element);
  if (text) {
    node._ = text;
  }

  const childElements = Array.from(element.children);
  const childNodes = childElements.map((child) => convertElementToTocAstNode(child));
  node.children = childNodes;

  childNodes.forEach((childNode) => {
    const key = childNode['#name'];
    const grouped = (node[key] as TocAstNode[] | undefined) || [];
    grouped.push(childNode);
    node[key] = grouped;
  });

  return node;
};

const emptyWrapperResult = { wrapper: { children: [] as TocAstNode[] } };

export const parsexml = async (str: string) => {
  try {
    const doc = new DOMParser().parseFromString(str || '', 'text/html');
    const wrapper = doc.querySelector('wrapper');
    if (!wrapper) return emptyWrapperResult;
    const children = Array.from(wrapper.children).map((child) => convertElementToTocAstNode(child));
    return { wrapper: { children } };
  } catch {
    return emptyWrapperResult;
  }
};
