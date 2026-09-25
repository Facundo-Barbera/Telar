const { describe, expect, test } = require("bun:test");
const path = require("node:path");

const { installDownloadHandler, uniqueDownloadPath, safeFilename } = require("./browser-downloads");

const DIR = path.join("/fixture", "Downloads");

/** A disk that holds exactly `names` in DIR, and records every mkdir. */
function fakeFs(names = []) {
  const files = new Set(names.map((name) => path.join(DIR, name)));
  return { files, made: [], existsSync: (candidate) => files.has(candidate), mkdirSync(dir) { this.made.push(dir); } };
}

/** A Chromium session: `will-download` is the only event it needs to carry. */
function fakeSession() {
  const listeners = [];
  return {
    on(event, listener) { if (event === "will-download") listeners.push(listener); },
    download(item, webContents = null) { for (const listener of listeners) listener({}, item, webContents); },
  };
}

/** A DownloadItem. `savePath` stays null unless the handler sets one — which
 *  is exactly the case Electron answers with its Save dialog. */
function fakeItem(url, filename) {
  const done = [];
  return {
    savePath: null,
    getURL: () => url,
    getFilename: () => filename,
    setSavePath(target) { this.savePath = target; },
    getSavePath() { return this.savePath ?? ""; },
    once(event, listener) { if (event === "done") done.push(listener); },
    finish(state) { for (const listener of done) listener({}, state); },
  };
}

describe("picking where a download lands", () => {
  test("a free name is used as the site gave it", () => {
    expect(uniqueDownloadPath(DIR, "report.pdf", () => false)).toBe(path.join(DIR, "report.pdf"));
  });

  test("a taken name gets the next free (n), the way browsers number them", () => {
    const disk = fakeFs(["report.pdf", "report (1).pdf"]);
    expect(uniqueDownloadPath(DIR, "report.pdf", disk.existsSync)).toBe(path.join(DIR, "report (2).pdf"));
    const bare = fakeFs(["README"]);
    expect(uniqueDownloadPath(DIR, "README", bare.existsSync)).toBe(path.join(DIR, "README (1)"));
  });

  test("a name cannot leave the folder or hide itself", () => {
    expect(safeFilename("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFilename(".hidden")).toBe("hidden");
    expect(safeFilename("")).toBe("download");
    expect(path.dirname(uniqueDownloadPath(DIR, "a/b\\c.txt", () => false))).toBe(DIR);
  });
});

describe("the will-download handler", () => {
  test("it sets a save path in the Downloads folder, so no dialog is shown", () => {
    const ses = fakeSession();
    const disk = fakeFs();
    const started = [];
    installDownloadHandler(ses, { directory: () => DIR, fs: disk, onStarted: (download) => started.push(download) });
    const item = fakeItem("https://example.com/files/report.pdf", "report.pdf");
    ses.download(item);
    expect(item.savePath).toBe(path.join(DIR, "report.pdf"));
    expect(disk.made).toEqual([DIR]);
    expect(started).toMatchObject([{ path: path.join(DIR, "report.pdf"), filename: "report.pdf", url: "https://example.com/files/report.pdf" }]);
  });

  test("two downloads of one name in flight never share a path, and a finished one frees it", () => {
    const ses = fakeSession();
    const finished = [];
    installDownloadHandler(ses, { directory: () => DIR, fs: fakeFs(["file.pdf"]), onFinished: (download) => finished.push(download) });
    const first = fakeItem("https://a.example/file.pdf", "file.pdf");
    const second = fakeItem("https://b.example/file.pdf", "file.pdf");
    ses.download(first);
    ses.download(second);
    expect(first.savePath).toBe(path.join(DIR, "file (1).pdf"));
    expect(second.savePath).toBe(path.join(DIR, "file (2).pdf"));
    // Cancelled: nothing is on disk under that name, so it is free again.
    first.finish("cancelled");
    const third = fakeItem("https://c.example/file.pdf", "file.pdf");
    ses.download(third);
    expect(third.savePath).toBe(path.join(DIR, "file (1).pdf"));
    expect(finished).toMatchObject([{ state: "cancelled", path: path.join(DIR, "file (1).pdf") }]);
  });

  test("an asked download gets no save path — Electron shows its dialog — and reports where the person chose", () => {
    const ses = fakeSession();
    const disk = fakeFs();
    const started = [];
    const finished = [];
    installDownloadHandler(ses, {
      directory: () => DIR,
      fs: disk,
      shouldAsk: (url) => url === "https://example.com/cat.png",
      onStarted: (download) => started.push(download),
      onFinished: (download) => finished.push(download),
    });
    const item = fakeItem("https://example.com/cat.png", "cat.png");
    ses.download(item);
    expect(item.savePath).toBeNull();
    expect(started).toEqual([]);
    // The dialog answered with a place of the person's own.
    item.savePath = path.join("/fixture", "Pictures", "cat.png");
    item.finish("completed");
    expect(finished).toMatchObject([{ state: "completed", path: path.join("/fixture", "Pictures", "cat.png"), filename: "cat.png" }]);
  });
});
