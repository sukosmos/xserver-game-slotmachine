function key(node) {
  return node.nodeType === 1 ? node.getAttribute('data-render-key') ?? node.id : null;
}

function compatible(current, next) {
  return current && current.nodeType === next.nodeType && current.nodeName === next.nodeName
    && current.namespaceURI === next.namespaceURI && key(current) === key(next);
}

function patch(current, next) {
  if (current.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  for (const attribute of [...current.attributes]) {
    // Keep user-expanded score/settlement details open during updates.
    if (current.localName === 'details' && attribute.name === 'open') continue;
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  patchChildren(current, next);
}

function patchChildren(parent, next) {
  let cursor = parent.firstChild;
  for (const desired of [...next.childNodes]) {
    let match = cursor;
    while (match && !compatible(match, desired)) match = match.nextSibling;
    if (!match) {
      parent.insertBefore(desired.cloneNode(true), cursor);
      continue;
    }
    if (match !== cursor) parent.insertBefore(match, cursor);
    patch(match, desired);
    cursor = match.nextSibling;
  }
  while (cursor) {
    const nextSibling = cursor.nextSibling;
    cursor.remove();
    cursor = nextSibling;
  }
}

/** Keep unchanged SVGs and animated elements connected across presentation stages. */
export function renderInto(container, html) {
  const template = container.ownerDocument.createElement('template');
  template.innerHTML = html;
  patchChildren(container, template.content);
}
