/* Media Viewer for Google Drive — static SPA (no build step).
 * Auth: Google Identity Services token flow. Data: Drive REST API v3. */
(() => {
  "use strict";

  const CLIENT_ID = (window.APP_CONFIG || {}).clientId;
  const SCOPES =
    "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";
  const API = "https://www.googleapis.com/drive/v3";
  const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
  const FOLDER = "application/vnd.google-apps.folder";
  const MAX_INLINE_BYTES = 500 * 1024 * 1024; // bigger files: open in Drive instead

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
  };

  /* ---------- tiny helpers ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), 4000);
  }
  const fmtSize = (n) => {
    n = Number(n);
    if (!n && n !== 0) return "";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  };
  const qEsc = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const kindOf = (mime = "") =>
    mime === FOLDER ? "folder"
    : mime.startsWith("image/") ? "image"
    : mime.startsWith("video/") ? "video"
    : mime.startsWith("audio/") ? "audio"
    : mime === "application/pdf" ? "pdf" : "other";
  const ICON = { folder: "📁", image: "🖼️", video: "🎬", audio: "🎵", pdf: "📄", other: "📎" };

  /* ---------- auth ---------- */
  let token = null;
  let expiresAt = 0;
  let tokenClient = null;
  let pending = null; // {resolve, reject}

  function loadStoredToken() {
    try {
      const s = JSON.parse(store.get("pd_token") || "null");
      if (s && s.exp > Date.now() + 30000) { token = s.t; expiresAt = s.exp; }
    } catch { /* ignore */ }
  }
  function setToken(t, expiresInSec) {
    token = t;
    expiresAt = Date.now() + expiresInSec * 1000;
    store.set("pd_token", JSON.stringify({ t, exp: expiresAt }));
  }
  function clearToken() { token = null; expiresAt = 0; store.del("pd_token"); }

  function waitForGIS(ms = 10000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll() {
        if (window.google && google.accounts && google.accounts.oauth2) return resolve();
        if (Date.now() - t0 > ms) return reject(new Error("Could not load Google sign-in. Check your connection or ad-blocker."));
        setTimeout(poll, 60);
      })();
    });
  }
  async function ensureClient() {
    if (tokenClient) return tokenClient;
    await waitForGIS();
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (r) => {
        const p = pending; pending = null;
        if (!p) return;
        if (r.error) p.reject(new Error(r.error_description || r.error));
        else { setToken(r.access_token, Number(r.expires_in) || 3600); p.resolve(token); }
      },
      error_callback: (e) => {
        const p = pending; pending = null;
        if (p) p.reject(new Error(e && e.type === "popup_closed" ? "Sign-in was cancelled." : (e && e.message) || "Sign-in failed."));
      },
    });
    return tokenClient;
  }
  /** prompt: "" = silent if previously granted, "consent" = force, "select_account" */
  async function requestToken(prompt = "") {
    const c = await ensureClient();
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      c.requestAccessToken({ prompt });
    });
  }
  async function getToken() {
    if (token && expiresAt > Date.now() + 30000) return token;
    clearToken();
    return requestToken("");
  }

  async function authFetch(url, opts = {}, retry = true) {
    const t = await getToken();
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } });
    if (res.status === 401 && retry) { clearToken(); return authFetch(url, opts, false); }
    return res;
  }
  async function api(path, params) {
    const url = `${API}${path}?${new URLSearchParams(params)}`;
    const res = await authFetch(url);
    if (!res.ok) {
      let msg = `Drive error ${res.status}`;
      try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return res.json();
  }

  let me = null;
  async function loadUser() {
    const j = await api("/about", { fields: "user(displayName,emailAddress)" });
    me = j.user || {};
    $("userName").textContent = me.displayName || me.emailAddress || "";
  }

  /* ---------- router ---------- */
  const VIEWS = { "/": "login", "/main": "main", "/upload": "upload", "/callback": "callback" };

  function show(name) {
    for (const v of ["login", "main", "upload", "callback"]) $(`view-${v}`).hidden = v !== name;
    $("topbar").hidden = name === "login" || name === "callback";
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === name));
    $("boot").hidden = true;
  }
  function navigate(path, replace = false) {
    history[replace ? "replaceState" : "pushState"](null, "", path);
    route();
  }
  const signedIn = () => !!token && expiresAt > Date.now();

  async function route() {
    closeViewer();
    const url = new URL(location.href);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const view = VIEWS[path];

    if (view === "callback") return handleCallback(url);
    if (!view) { navigate("/main", true); return; }

    if (!signedIn()) {
      // A returning user can often re-auth silently; try only when not on the login page.
      if (view !== "login" && store.get("pd_signedin") === "1") {
        try { await requestToken(""); } catch { /* fall through to login */ }
      }
    }
    if (!signedIn()) { show("login"); return; }
    if (view === "login") { navigate("/main", true); return; }

    try { if (!me) await loadUser(); } catch (e) { return fail(e); }
    show(view);
    if (view === "main") enterMain(url);
    if (view === "upload") enterUpload();
  }
  function fail(e) {
    clearToken();
    store.del("pd_signedin");
    show("login");
    const el = $("loginError");
    el.textContent = e.message || String(e);
    el.hidden = false;
  }

  /** /callback: supports a legacy redirect-style OAuth response (#access_token=…); otherwise just continues. */
  function handleCallback(url) {
    show("callback");
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const err = url.searchParams.get("error") || hash.get("error");
    if (err) { $("cbMsg").textContent = `Sign-in failed: ${err}`; setTimeout(() => navigate("/", true), 2500); return; }
    const t = hash.get("access_token");
    if (t) { setToken(t, Number(hash.get("expires_in")) || 3600); store.set("pd_signedin", "1"); }
    navigate(signedIn() ? "/main" : "/", true);
  }

  /* ---------- library ---------- */
  const lib = { loc: "mine", kind: "all", search: "", crumbs: [{ id: "root", name: "My Drive" }], items: [], next: null, loading: false, seq: 0, ready: false, stale: false };

  function enterMain(url) {
    const folder = url.searchParams.get("folder");
    if (!lib.ready) {
      lib.ready = true;
      if (folder && folder !== "root") {
        lib.crumbs = [{ id: "root", name: "My Drive" }, { id: folder, name: "Folder" }];
        api(`/files/${encodeURIComponent(folder)}`, { fields: "name", supportsAllDrives: "true" })
          .then((f) => { lib.crumbs[1].name = f.name; renderCrumbs(); }).catch(() => {});
      }
      load(true);
    } else if (lib.stale) { lib.stale = false; load(true); }
  }
  const currentFolder = () => lib.crumbs[lib.crumbs.length - 1].id;

  function buildQuery() {
    const kinds = {
      all: "(mimeType='" + FOLDER + "' or mimeType contains 'image/' or mimeType contains 'video/' or mimeType contains 'audio/' or mimeType='application/pdf')",
      image: "(mimeType='" + FOLDER + "' or mimeType contains 'image/')",
      video: "(mimeType='" + FOLDER + "' or mimeType contains 'video/')",
      audio: "(mimeType='" + FOLDER + "' or mimeType contains 'audio/')",
      pdf: "(mimeType='" + FOLDER + "' or mimeType='application/pdf')",
    };
    const parts = ["trashed=false", kinds[lib.kind]];
    if (lib.search) parts.push(`name contains '${qEsc(lib.search)}'`);
    else if (lib.loc === "shared" && lib.crumbs.length === 1) parts.push("sharedWithMe=true");
    else parts.push(`'${qEsc(currentFolder())}' in parents`);
    return parts.join(" and ");
  }

  async function load(reset) {
    if (lib.loading && !reset) return;
    const seq = ++lib.seq;
    lib.loading = true;
    if (reset) { lib.items = []; lib.next = null; $("grid").replaceChildren(); }
    $("moreBtn").hidden = true;
    $("status").textContent = "Loading…";
    renderCrumbs();
    try {
      const params = {
        q: buildQuery(),
        pageSize: "60",
        orderBy: "folder,name_natural",
        fields: "nextPageToken,files(id,name,mimeType,size,thumbnailLink,webViewLink)",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      };
      if (lib.search) params.orderBy = "modifiedTime desc";
      if (!reset && lib.next) params.pageToken = lib.next;
      const j = await api("/files", params);
      if (seq !== lib.seq) return; // a newer request superseded this one
      const start = lib.items.length;
      lib.items.push(...j.files);
      lib.next = j.nextPageToken || null;
      const grid = $("grid");
      j.files.forEach((f, i) => grid.append(tile(f, start + i)));
      $("status").textContent = lib.items.length ? "" : (lib.search ? "No matches." : "Nothing here yet.");
      $("moreBtn").hidden = !lib.next;
    } catch (e) {
      if (seq === lib.seq) $("status").textContent = `Couldn't load files: ${e.message}`;
    } finally {
      if (seq === lib.seq) lib.loading = false;
    }
  }

  function tile(f, index) {
    const kind = kindOf(f.mimeType);
    const thumb = h("div", { class: "thumb" }, ICON[kind]);
    if (f.thumbnailLink && kind !== "folder") {
      const img = h("img", { loading: "lazy", alt: "", referrerpolicy: "no-referrer", src: f.thumbnailLink.replace(/=s\d+$/, "=s320") });
      img.addEventListener("load", () => thumb.replaceChildren(img, kind === "image" ? "" : h("span", { class: "badge" }, kind)));
    }
    const el = h("button", { class: "tile", type: "button", title: f.name }, thumb, h("div", { class: "name" }, f.name));
    el.addEventListener("click", () => (kind === "folder" ? openFolder(f) : openViewer(index)));
    return el;
  }

  function openFolder(f) {
    lib.search = "";
    $("searchInput").value = "";
    lib.crumbs.push({ id: f.id, name: f.name });
    syncUrl();
    load(true);
  }
  function renderCrumbs() {
    const nav = $("crumbs");
    nav.replaceChildren();
    if (lib.search) { nav.append(h("span", { class: "cur" }, `Search: “${lib.search}”`)); return; }
    lib.crumbs.forEach((c, i) => {
      if (i) nav.append("›");
      if (i === lib.crumbs.length - 1) nav.append(h("span", { class: "cur" }, c.name));
      else nav.append(h("button", { type: "button", onclick: () => { lib.crumbs = lib.crumbs.slice(0, i + 1); syncUrl(); load(true); } }, c.name));
    });
  }
  function syncUrl() {
    const f = currentFolder();
    store.set("pd_folder", f);
    store.set("pd_folder_name", lib.crumbs[lib.crumbs.length - 1].name);
    history.replaceState(null, "", f === "root" ? "/main" : `/main?folder=${encodeURIComponent(f)}`);
  }

  function setupLibraryControls() {
    document.querySelectorAll("[data-loc]").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll("[data-loc]").forEach((x) => x.classList.toggle("on", x === b));
      lib.loc = b.dataset.loc;
      lib.crumbs = [{ id: "root", name: lib.loc === "shared" ? "Shared with me" : "My Drive" }];
      lib.search = ""; $("searchInput").value = "";
      syncUrl(); load(true);
    }));
    document.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll("[data-kind]").forEach((x) => x.classList.toggle("on", x === b));
      lib.kind = b.dataset.kind; load(true);
    }));
    $("searchForm").addEventListener("submit", (e) => { e.preventDefault(); lib.search = $("searchInput").value.trim(); load(true); });
    $("searchInput").addEventListener("input", (e) => { if (!e.target.value && lib.search) { lib.search = ""; load(true); } });
    $("moreBtn").addEventListener("click", () => load(false));
  }

  /* ---------- viewer ---------- */
  const view = { index: -1, blobUrl: null, seq: 0 };
  const mediaIdx = () => lib.items.map((f, i) => (kindOf(f.mimeType) !== "folder" ? i : -1)).filter((i) => i >= 0);

  async function openViewer(index) {
    const f = lib.items[index];
    if (!f) return;
    view.index = index;
    const seq = ++view.seq;
    revokeBlob();
    const kind = kindOf(f.mimeType);
    $("viewer").hidden = false;
    document.body.style.overflow = "hidden";
    $("viewerTitle").textContent = f.name;
    const open = $("viewerOpen");
    if (f.webViewLink) open.href = f.webViewLink; else open.removeAttribute("href");
    $("viewerDl").removeAttribute("href");
    const body = $("viewerBody");
    const ids = mediaIdx();
    $("viewerPrev").hidden = ids[0] === index;
    $("viewerNext").hidden = ids[ids.length - 1] === index;

    if (Number(f.size) > MAX_INLINE_BYTES) {
      body.replaceChildren(`This file is ${fmtSize(f.size)} — too large to preview here. Use “Open in Drive”.`);
      return;
    }
    body.replaceChildren(h("div", { class: "spinner" }));
    try {
      const res = await authFetch(`${API}/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`);
      if (!res.ok) throw new Error(`Drive error ${res.status}`);
      const blob = await res.blob();
      if (seq !== view.seq) return;
      view.blobUrl = URL.createObjectURL(new Blob([blob], { type: f.mimeType }));
      const dl = $("viewerDl");
      dl.href = view.blobUrl; dl.download = f.name;
      let el;
      if (kind === "image") el = h("img", { src: view.blobUrl, alt: f.name });
      else if (kind === "video") el = h("video", { src: view.blobUrl, controls: "", autoplay: "", playsinline: "" });
      else if (kind === "audio") el = h("audio", { src: view.blobUrl, controls: "", autoplay: "" });
      else el = h("iframe", { src: view.blobUrl, title: f.name });
      body.replaceChildren(el);
    } catch (e) {
      if (seq === view.seq) body.replaceChildren(`Couldn't open this file: ${e.message}`);
    }
  }
  function revokeBlob() { if (view.blobUrl) { URL.revokeObjectURL(view.blobUrl); view.blobUrl = null; } }
  function closeViewer() {
    if ($("viewer").hidden) return;
    view.seq++;
    $("viewer").hidden = true;
    $("viewerBody").replaceChildren();
    document.body.style.overflow = "";
    revokeBlob();
  }
  function step(dir) {
    const ids = mediaIdx();
    const pos = ids.indexOf(view.index) + dir;
    if (pos >= 0 && pos < ids.length) openViewer(ids[pos]);
  }
  function setupViewer() {
    $("viewerClose").addEventListener("click", closeViewer);
    $("viewerPrev").addEventListener("click", () => step(-1));
    $("viewerNext").addEventListener("click", () => step(1));
    document.addEventListener("keydown", (e) => {
      if ($("viewer").hidden) return;
      if (e.key === "Escape") closeViewer();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    });
  }

  /* ---------- upload ---------- */
  function enterUpload() {
    $("uploadDest").textContent = store.get("pd_folder_name") || "My Drive";
  }
  function uploadParent() {
    const f = store.get("pd_folder");
    return f && f !== "root" ? f : null;
  }

  async function uploadOne(file, parent, onProgress) {
    const meta = { name: file.name };
    if (parent) meta.parents = [parent];
    const init = await authFetch(`${UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=id,name`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": file.type || "application/octet-stream",
        "X-Upload-Content-Length": String(file.size),
      },
      body: JSON.stringify(meta),
    });
    if (!init.ok) throw new Error(`Could not start upload (${init.status})`);
    const loc = init.headers.get("Location");
    if (!loc) throw new Error("Drive did not return an upload URL");
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", loc);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(JSON.parse(xhr.responseText || "{}")) : reject(new Error(`Upload failed (${xhr.status})`)));
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.send(file);
    });
  }

  function addUploads(files) {
    const parent = uploadParent();
    const list = $("uploads");
    for (const file of files) {
      const bar = h("i");
      const state = h("span", {}, "Uploading…");
      const li = h("li", {}, h("div", { class: "row" }, h("span", {}, `${file.name} · ${fmtSize(file.size)}`), state), h("div", { class: "bar" }, bar));
      list.prepend(li);
      uploadOne(file, parent, (p) => (bar.style.width = `${Math.round(p * 100)}%`))
        .then(() => { bar.style.width = "100%"; li.classList.add("done"); state.textContent = "Done"; lib.stale = true; })
        .catch((e) => { li.classList.add("fail"); bar.style.width = "100%"; state.textContent = e.message; });
    }
  }
  function setupUpload() {
    const drop = $("drop"), input = $("fileInput");
    input.addEventListener("change", () => { addUploads([...input.files]); input.value = ""; });
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => addUploads([...e.dataTransfer.files]));
  }

  /* ---------- boot ---------- */
  function setupAuthUi() {
    $("signInBtn").addEventListener("click", async () => {
      const err = $("loginError");
      err.hidden = true;
      try {
        await requestToken("select_account");
        store.set("pd_signedin", "1");
        me = null;
        navigate("/main", true);
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    });
    $("signOutBtn").addEventListener("click", () => {
      const t = token;
      clearToken(); store.del("pd_signedin"); store.del("pd_folder"); store.del("pd_folder_name");
      me = null; lib.ready = false; lib.items = []; lib.crumbs = [{ id: "root", name: "My Drive" }];
      if (t && window.google && google.accounts) google.accounts.oauth2.revoke(t, () => {});
      navigate("/", true);
    });
    document.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-nav]");
      if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(a.getAttribute("href")); }
    });
    window.addEventListener("popstate", route);
  }

  function start() {
    if (!CLIENT_ID) { document.body.textContent = "Missing Google client ID in js/config.js"; return; }
    loadStoredToken();
    setupAuthUi(); setupLibraryControls(); setupViewer(); setupUpload();
    route();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
