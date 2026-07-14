(function installBigBriceyChatFormat(root) {
  function parseInlineText(value) {
    const text = String(value ?? "");
    const tokens = [];
    const pattern = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`)/g;
    let cursor = 0;
    let match;

    while ((match = pattern.exec(text))) {
      if (match.index > cursor) {
        tokens.push({ type: "text", text: text.slice(cursor, match.index) });
      }
      if (match[2] != null) tokens.push({ type: "strong", text: match[2] });
      else tokens.push({ type: "code", text: match[3] });
      cursor = pattern.lastIndex;
    }

    if (cursor < text.length) tokens.push({ type: "text", text: text.slice(cursor) });
    if (!tokens.length && text) tokens.push({ type: "text", text });
    return tokens;
  }

  function paragraphInlines(lines) {
    const inlines = [];
    lines.forEach((line, index) => {
      if (index) inlines.push({ type: "break" });
      inlines.push(...parseInlineText(line));
    });
    return inlines;
  }

  function parseChatText(value) {
    const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let paragraph = [];
    let list = null;

    function flushParagraph() {
      if (!paragraph.length) return;
      blocks.push({ type: "paragraph", inlines: paragraphInlines(paragraph) });
      paragraph = [];
    }

    function flushList() {
      if (!list) return;
      blocks.push(list);
      list = null;
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fence = line.match(/^\s*```[^`]*\s*$/);
      if (fence) {
        flushParagraph();
        flushList();
        const codeLines = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        blocks.push({ type: "code-block", text: codeLines.join("\n") });
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }

      const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (bullet || numbered) {
        flushParagraph();
        const type = bullet ? "unordered-list" : "ordered-list";
        if (list?.type !== type) {
          flushList();
          list = { type, items: [] };
        }
        list.items.push(parseInlineText((bullet || numbered)[1]));
        continue;
      }

      flushList();
      paragraph.push(line);
    }

    flushParagraph();
    flushList();
    return blocks;
  }

  function appendInlineTokens(parent, tokens, doc) {
    for (const token of tokens) {
      if (token.type === "break") {
        parent.appendChild(doc.createElement("br"));
        continue;
      }
      if (token.type === "strong" || token.type === "code") {
        const element = doc.createElement(token.type === "strong" ? "strong" : "code");
        element.appendChild(doc.createTextNode(token.text));
        parent.appendChild(element);
        continue;
      }
      parent.appendChild(doc.createTextNode(token.text));
    }
  }

  function renderChatText(container, value, suppliedDocument) {
    if (!container) return container;
    const doc = suppliedDocument || container.ownerDocument || root.document;
    if (!doc?.createElement || !doc?.createTextNode) return container;
    container.replaceChildren();

    for (const block of parseChatText(value)) {
      if (block.type === "paragraph") {
        const paragraph = doc.createElement("p");
        paragraph.className = "chat-paragraph";
        appendInlineTokens(paragraph, block.inlines, doc);
        container.appendChild(paragraph);
        continue;
      }

      if (block.type === "ordered-list" || block.type === "unordered-list") {
        const list = doc.createElement(block.type === "ordered-list" ? "ol" : "ul");
        list.className = "chat-list";
        for (const item of block.items) {
          const row = doc.createElement("li");
          appendInlineTokens(row, item, doc);
          list.appendChild(row);
        }
        container.appendChild(list);
        continue;
      }

      if (block.type === "code-block") {
        const pre = doc.createElement("pre");
        pre.className = "chat-code-block";
        const code = doc.createElement("code");
        code.appendChild(doc.createTextNode(block.text));
        pre.appendChild(code);
        container.appendChild(pre);
      }
    }

    return container;
  }

  function scrollChatToBottom(log, suppliedQueue) {
    if (!log) return;
    const queue =
      suppliedQueue ||
      (typeof root.requestAnimationFrame === "function"
        ? root.requestAnimationFrame.bind(root)
        : (callback) => root.setTimeout(callback, 0));
    log.scrollTop = log.scrollHeight;
    queue(() => {
      log.scrollTop = log.scrollHeight;
    });
  }

  root.BBChatFormat = Object.freeze({
    parseChatText,
    renderChatText,
    scrollChatToBottom,
  });
})(typeof window !== "undefined" ? window : globalThis);
