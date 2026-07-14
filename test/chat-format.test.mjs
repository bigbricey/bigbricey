import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await import("../public/chat-format.js");

const {
  parseChatText,
  renderChatText,
  scrollChatToBottom,
} = globalThis.BBChatFormat || {};

class FakeNode {
  constructor(tagName = "div", text = null) {
    this.tagName = tagName.toUpperCase();
    this.rawText = text;
    this.children = [];
    this.className = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.scrolledIntoView = false;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  scrollIntoView() {
    this.scrolledIntoView = true;
  }

  get lastElementChild() {
    return [...this.children].reverse().find((child) => child.tagName !== "#TEXT") || null;
  }

  get textContent() {
    if (this.rawText != null) return this.rawText;
    return this.children.map((child) => child.textContent).join("");
  }
}

const fakeDocument = {
  createElement(tagName) {
    return new FakeNode(tagName);
  },
  createTextNode(text) {
    return new FakeNode("#text", String(text));
  },
};

function allTags(node) {
  return [node.tagName, ...node.children.flatMap(allTags)];
}

test("chat formatter recognizes paragraphs and consecutive bullet and numbered lists", () => {
  const blocks = parseChatText(
    "Here is the short version.\n\n- First thing\n- Second thing\n\n1. Start here\n2. Then this"
  );

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["paragraph", "unordered-list", "ordered-list"]
  );
  assert.deepEqual(blocks[1].items.map((item) => item[0].text), ["First thing", "Second thing"]);
  assert.deepEqual(blocks[2].items.map((item) => item[0].text), ["Start here", "Then this"]);
});

test("chat formatter preserves bold and inline code as safe structured tokens", () => {
  const [paragraph] = parseChatText("Use **two scoops** and check `fiber_g`.");

  assert.deepEqual(paragraph.inlines, [
    { type: "text", text: "Use " },
    { type: "strong", text: "two scoops" },
    { type: "text", text: " and check " },
    { type: "code", text: "fiber_g" },
    { type: "text", text: "." },
  ]);
});

test("chat renderer treats model supplied HTML as text instead of executable markup", () => {
  const container = new FakeNode("div");
  container.ownerDocument = fakeDocument;

  renderChatText(
    container,
    '<img src=x onerror="alert(1)"> **still safe**',
    fakeDocument
  );

  assert.equal(container.textContent, '<img src=x onerror="alert(1)"> still safe');
  assert.deepEqual(allTags(container), ["DIV", "P", "#TEXT", "STRONG", "#TEXT"]);
});

test("chat scrolling lands at the bottom again after the browser lays out formatted content", () => {
  const last = new FakeNode("div");
  const log = new FakeNode("div");
  log.children = [last];
  log.scrollHeight = 640;
  const queued = [];

  scrollChatToBottom(log, (callback) => queued.push(callback));

  assert.equal(log.scrollTop, 640);
  assert.equal(queued.length, 1);
  log.scrollHeight = 720;
  queued[0]();
  assert.equal(log.scrollTop, 720);
  assert.equal(last.scrolledIntoView, false);
});

test("chat markup exposes a polite conversation log and a real textarea label", () => {
  const html = readFileSync(new URL("../public/app.html", import.meta.url), "utf8");

  assert.match(
    html,
    /id="chatLog"[^>]*role="log"[^>]*aria-live="polite"[^>]*aria-relevant="additions text"/
  );
  assert.match(html, /<label[^>]*for="foodInput"[^>]*>Message BigBricey<\/label>/);
});

test("chat presentation uses safe rich rendering and no fake Done response", () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(source, /BBChatFormat\.renderChatText\(body, text\)/);
  assert.match(source, /chatLog\.setAttribute\("aria-busy", on \? "true" : "false"\)/);
  assert.doesNotMatch(source, /\|\| "Done\."/);
});
