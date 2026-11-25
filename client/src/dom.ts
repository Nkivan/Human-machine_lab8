// Typed element factory: el("button") is an HTMLButtonElement, el("input") an HTMLInputElement. No casts.
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text; // textContent, never innerHTML: no injection
  return node;
}
