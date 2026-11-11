const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const background = fs.readFileSync(path.join(ROOT, "extension/src/background.js"), "utf8");
const content = fs.readFileSync(path.join(ROOT, "extension/src/content.js"), "utf8");
const resolverStart = background.indexOf("async function resolveDownloadUrl(item) {");
const resolverEnd = background.indexOf("// ---- The shared capture pipeline", resolverStart);
assert.notEqual(resolverStart, -1, "the final-URL resolver exists");
assert.notEqual(resolverEnd, -1, "the final-URL resolver has a clear end");
const resolverSource = background.slice(resolverStart, resolverEnd).trim();
const sourceUrlStart = background.indexOf("function captureRequestUrl(item) {");
const sourceUrlEnd = background.indexOf("B.downloads.onCreated.addListener", sourceUrlStart);
assert.notEqual(sourceUrlStart, -1, "the original-request URL selector exists");
assert.notEqual(sourceUrlEnd, -1, "the original-request URL selector has a clear end");
const sourceUrlFunction = background.slice(sourceUrlStart, sourceUrlEnd).trim();

function createResolver(downloadItem) {
  const listeners = new Set();
  const context = {
    B: {
      downloads: {
        onChanged: {
          addListener(listener) {
            listeners.add(listener);
          },
          removeListener(listener) {
            listeners.delete(listener);
          },
        },
        async search() {
          return [{ ...downloadItem }];
        },
      },
    },
    FINAL_URL_SETTLE_MS: 5,
    FINAL_URL_TIMEOUT_MS: 100,
    isHandoffable(value) {
      return typeof value === "string" && /^https?:\/\//i.test(value);
    },
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
    },
    console,
  };
  vm.runInNewContext(
    `${resolverSource}\nglobalThis.resolveDownloadUrl = resolveDownloadUrl;`,
    context
  );
  return {
    resolve: context.resolveDownloadUrl,
    publishFinalUrl(url) {
      downloadItem.finalUrl = url;
      for (const listener of listeners) {
        listener({ id: downloadItem.id, finalUrl: { current: url } });
      }
    },
    publishBytes(bytes) {
      downloadItem.bytesReceived = bytes;
    },
  };
}

test("waits through intermediate CDN URLs until the browser receives the file", async () => {
  const initial = "https://example.test/download/package.zip";
  const intermediate = "https://download-cdn.example.test/prepare/package.zip?signature=pending";
  const final = "https://objects.example.test/releases/package.zip?signature=ready";
  const download = {
    id: 7,
    url: initial,
    finalUrl: initial,
    bytesReceived: 0,
    state: "in_progress",
  };
  const resolver = createResolver(download);
  setTimeout(() => resolver.publishFinalUrl(intermediate), 10);
  setTimeout(() => resolver.publishFinalUrl(final), 25);
  setTimeout(() => resolver.publishBytes(16), 40);

  assert.equal(await resolver.resolve({ id: 7, url: initial, finalUrl: initial }), final);
});

test("replays the source download URL instead of a browser-issued CDN signature", () => {
  const context = {
    isHandoffable(value) {
      return typeof value === "string" && /^https?:\/\//i.test(value);
    },
  };
  vm.runInNewContext(
    `${sourceUrlFunction}\nglobalThis.captureRequestUrl = captureRequestUrl;`,
    context
  );

  const source = "https://www.jetbrains.com.cn/idea/download/idea-2026.3.exe";
  const browserSignedUrl = "https://download-cdn.example.test/idea-2026.3.exe?signature=browser";
  assert.equal(context.captureRequestUrl({ url: source, finalUrl: browserSignedUrl }), source);
});

test("a download with no response or settled URL is left with the browser", async () => {
  const initial = "https://example.test/download/package.zip";
  const resolver = createResolver({
    id: 8,
    url: initial,
    finalUrl: initial,
    bytesReceived: 0,
    state: "in_progress",
  });

  assert.equal(await resolver.resolve({ id: 8, url: initial, finalUrl: initial }), null);
});

test("the content script does not pre-empt links using only their filename", () => {
  assert.doesNotMatch(content, /document\.addEventListener\(\s*["']click["']/);
  assert.doesNotMatch(content, /wingharness-capture-link/);
  assert.match(content, /wingharness-show-prompt/);
});
