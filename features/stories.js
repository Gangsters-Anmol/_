/**
 * features/stories.js
 * ─────────────────────────────────────────────────────────────────
 * PURELY ADDITIVE — does not modify any existing file.
 *
 * Firestore schema:
 *   stories/{uid}/items/{storyId}
 *     type:      "text" | "image" | "video"
 *     content:   string  (text stories)
 *     mediaUrl:  string  (image/video stories)
 *     bg:        string  (CSS gradient for text stories)
 *     createdAt: timestamp
 *     expiresAt: timestamp  (createdAt + 24h)
 *     seenBy:    [uid, ...]
 * ─────────────────────────────────────────────────────────────────
 */

import {
  collection, doc, addDoc, deleteDoc, updateDoc,
  getDocs, query, where, orderBy,
  Timestamp, arrayUnion
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

import { db }                                        from "../firebase-config.js";
import { onAuthChange, currentUser, currentProfile } from "../auth.js";

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════════════════════ */
const STORY_DURATION = 5000;
const STORY_TTL      = 24 * 60 * 60 * 1000;
const CLOUD_NAME     = "dsbsinbun";
// FIX: ml_default is a signed/restricted preset that rejects browser uploads.
// ghost_user is the correct unsigned preset used by chat.js — works for images AND videos.
const UPLOAD_PRESET  = "ghost_user";
const MAX_MEDIA_SIZE = 20 * 1024 * 1024;

const BG_GRADIENTS = [
  "linear-gradient(135deg,#c8a96e,#8b5e3c)",
  "linear-gradient(135deg,#2c3e50,#4a6741)",
  "linear-gradient(135deg,#8e44ad,#3498db)",
  "linear-gradient(135deg,#e74c3c,#c0392b)",
  "linear-gradient(135deg,#16a085,#2980b9)",
  "linear-gradient(135deg,#1a1613,#3d2b1f)",
  "linear-gradient(135deg,#f39c12,#d35400)",
  "linear-gradient(135deg,#27ae60,#2ecc71)",
];

/* ═══════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════════ */
let _trayInjected   = false;
let _viewerTimer    = null;
let _currentStories = [];
let _currentIdx     = 0;
let _touchStartX    = 0;

/* ═══════════════════════════════════════════════════════════════
   INJECT CSS
════════════════════════════════════════════════════════════════ */
(function _injectCSS() {
  if (document.getElementById("stories-css-link")) return;
  const link = document.createElement("link");
  link.id   = "stories-css-link";
  link.rel  = "stylesheet";
  link.href = "features/stories.css";
  document.head.appendChild(link);
})();

/* ═══════════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════════════ */
function _isExpired(data) {
  const exp = data.expiresAt?.toDate?.()?.getTime?.() || 0;
  return Date.now() > exp;
}

function _timeAgo(date) {
  if (!date) return "";
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60)   return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function _esc(s) {
  return String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function _toast(msg) {
  const el = document.getElementById("toastNotif");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 3000);
}

/* ═══════════════════════════════════════════════════════════════
   LOAD ALL ACTIVE STORIES
════════════════════════════════════════════════════════════════ */
async function _loadAllStories() {
  const usersSnap = await getDocs(
    query(collection(db, "users"), where("profileComplete", "==", true))
  ).catch(() => null);
  if (!usersSnap) return [];

  const results = [];

  await Promise.all(usersSnap.docs.map(async uDoc => {
    const uid  = uDoc.id;
    const user = uDoc.data();
    if (user.banned) return;

    const storiesSnap = await getDocs(
      query(collection(db, "stories", uid, "items"), orderBy("createdAt", "asc"))
    ).catch(() => null);
    if (!storiesSnap || storiesSnap.empty) return;

    const active = storiesSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(s => !_isExpired(s));
    if (!active.length) return;

    results.push({
      uid,
      name:     user.name     || "?",
      role:     user.role     || "",
      photoURL: user.photoURL || null,
      stories:  active,
    });
  }));

  return results;
}

/* ═══════════════════════════════════════════════════════════════
   BUILD TRAY
════════════════════════════════════════════════════════════════ */
async function _buildTray() {
  const tray = document.getElementById("storyTray");
  if (!tray) return;

  tray.innerHTML = `<div style="display:flex;align-items:center;padding:.5rem 0;">
    <div style="width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:fspin .75s linear infinite;flex-shrink:0;"></div>
  </div>`;

  const allStories = await _loadAllStories();
  tray.innerHTML = "";

  /* Own item first */
  const myEntry = allStories.find(e => e.uid === currentUser?.uid);
  _appendTrayItem(tray, {
    uid:      currentUser.uid,
    name:     currentProfile.name,
    photoURL: currentProfile.photoURL || null,
    stories:  myEntry?.stories || [],
    isOwn:    true,
  });

  /* Others */
  for (const entry of allStories) {
    if (entry.uid === currentUser.uid) continue;
    _appendTrayItem(tray, { ...entry, isOwn: false });
  }
}

function _appendTrayItem(tray, { uid, name, photoURL, stories, isOwn }) {
  const hasStories = stories.length > 0;
  const allSeen    = hasStories && stories.every(
    s => Array.isArray(s.seenBy) && s.seenBy.includes(currentUser?.uid)
  );
  const initials = (name || "?")[0].toUpperCase();

  let ringClass = "story-ring";
  if (isOwn && !hasStories)       ringClass += " story-ring--add";
  else if (!hasStories || allSeen) ringClass += " story-ring--seen";

  const item = document.createElement("div");
  item.className   = "story-item";
  item.dataset.uid = uid;
  item.innerHTML   = `
    <div class="story-item__ring-wrap">
      <div class="${ringClass}"></div>
      <div class="story-item__avatar">
        ${photoURL
          ? `<img src="${_esc(photoURL)}" alt="${_esc(name)}" onerror="this.remove()" />`
          : initials
        }
      </div>
      ${isOwn ? `<div class="story-item__add-btn">+</div>` : ""}
    </div>
    <span class="story-item__label ${(!hasStories || allSeen) ? "story-item__label--muted" : ""}">
      ${isOwn ? "Your Story" : _esc(name.split(" ")[0])}
    </span>`;

  item.addEventListener("click", () => {
    if (isOwn && !hasStories) {
      _openCreateModal();
    } else {
      _openViewer(uid, stories, name, photoURL);
    }
  });

  tray.appendChild(item);
}

/* ═══════════════════════════════════════════════════════════════
   INJECT TRAY
════════════════════════════════════════════════════════════════ */
function _injectTray() {
  if (_trayInjected) return;

  const postsUI = document.getElementById("postsUI");
  if (!postsUI) return;

  const target = document.getElementById("feedTabBar")
               || document.getElementById("postsFeed");
  if (!target) return;

  _trayInjected = true;

  const wrap = document.createElement("div");
  wrap.id        = "storyTrayWrap";
  wrap.className = "story-tray-wrap glass-panel";
  wrap.style.cssText = "padding:.75rem 1rem .25rem;margin-bottom:1rem;";
  wrap.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem;">
      <span style="font-family:'Cormorant Garamond',serif;font-size:1rem;font-weight:600;color:var(--text);">✦ Stories</span>
      <button id="addStoryBtn" style="font-family:'Jost',sans-serif;font-size:.72rem;color:var(--accent);background:none;border:none;cursor:pointer;padding:0;font-weight:500;">+ Add yours</button>
    </div>
    <div class="story-tray" id="storyTray"></div>`;

  postsUI.insertBefore(wrap, target);

  document.getElementById("addStoryBtn")
    ?.addEventListener("click", _openCreateModal);

  _buildTray();
  setInterval(_buildTray, 120_000);
}

/* ═══════════════════════════════════════════════════════════════
   CREATE MODAL
════════════════════════════════════════════════════════════════ */
function _openCreateModal() {
  document.getElementById("storyCreateModal")?.remove();

  let _type   = "text";
  let _bg     = BG_GRADIENTS[0];
  let _staged = null;
  let _objURL = null;

  const overlay = document.createElement("div");
  overlay.id        = "storyCreateModal";
  overlay.className = "story-create-overlay";
  overlay.innerHTML = `
    <div class="story-create-panel">
      <button class="story-create-panel__close" id="scClose">✕</button>
      <h2>Create Story</h2>

      <div class="story-type-toggle">
        <button class="story-type-btn active" data-type="text">✍️ Text</button>
        <button class="story-type-btn" data-type="media">🖼 Photo / Video</button>
      </div>

      <div id="scTextSection">
        <div class="story-text-preview" id="scTextPreview" style="background:${BG_GRADIENTS[0]}">
          <p id="scPreviewText"></p>
        </div>
        <div class="story-bg-picker" id="scBgPicker">
          ${BG_GRADIENTS.map((g, i) =>
            `<div class="story-bg-swatch${i===0?" active":""}"
                  data-bg="${_esc(g)}" style="background:${g}"></div>`
          ).join("")}
        </div>
        <textarea class="story-text-input" id="scTextInput"
          placeholder="What's on your mind?" maxlength="200" rows="3"></textarea>
      </div>

      <div id="scMediaSection" hidden>
        <div class="story-media-dropzone" id="scDropzone">
          <input type="file" id="scFileInput" accept="image/*,video/*" hidden />
          <span class="story-media-dropzone__icon">📎</span>
          Click to choose or drag & drop<br/>
          <span style="font-size:.7rem;opacity:.7;">Image or Video · Max 20 MB</span>
        </div>
      </div>

      <div class="story-upload-progress" id="scProgress">
        <div class="story-upload-progress__bar" id="scProgressBar"></div>
      </div>

      <p class="story-create-status" id="scStatus"></p>
      <button class="story-post-btn" id="scPostBtn">Share Story ✦</button>
    </div>`;

  document.body.appendChild(overlay);

  const closeBtn    = overlay.querySelector("#scClose");
  const typeBtns    = overlay.querySelectorAll(".story-type-btn");
  const textSection = overlay.querySelector("#scTextSection");
  const mediaSection= overlay.querySelector("#scMediaSection");
  const textPreview = overlay.querySelector("#scTextPreview");
  const previewText = overlay.querySelector("#scPreviewText");
  const textInput   = overlay.querySelector("#scTextInput");
  const bgPicker    = overlay.querySelector("#scBgPicker");
  const dropzone    = overlay.querySelector("#scDropzone");
  const fileInput   = overlay.querySelector("#scFileInput");
  const postBtn     = overlay.querySelector("#scPostBtn");
  const statusEl    = overlay.querySelector("#scStatus");
  const progress    = overlay.querySelector("#scProgress");
  const progressBar = overlay.querySelector("#scProgressBar");

  const _close = () => { if (_objURL) URL.revokeObjectURL(_objURL); overlay.remove(); };
  closeBtn.addEventListener("click", _close);
  overlay.addEventListener("click", e => { if (e.target === overlay) _close(); });

  /* Type toggle */
  typeBtns.forEach(btn => btn.addEventListener("click", () => {
    typeBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    _type = btn.dataset.type;
    textSection.hidden  = _type !== "text";
    mediaSection.hidden = _type !== "media";
  }));

  /* Text preview */
  textInput.addEventListener("input", () => {
    previewText.textContent = textInput.value;
  });

  /* Background picker */
  bgPicker.querySelectorAll(".story-bg-swatch").forEach(sw => {
    sw.addEventListener("click", () => {
      bgPicker.querySelectorAll(".story-bg-swatch").forEach(s => s.classList.remove("active"));
      sw.classList.add("active");
      _bg = sw.dataset.bg;
      textPreview.style.background = _bg;
    });
  });

  /* Media staging */
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("drag-over"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
  dropzone.addEventListener("drop", e => {
    e.preventDefault(); dropzone.classList.remove("drag-over");
    const f = e.dataTransfer.files?.[0]; if (f) _stage(f);
  });
  fileInput.addEventListener("change", e => {
    const f = e.target.files?.[0]; if (f) _stage(f); fileInput.value = "";
  });

  function _stage(file) {
    const isImg = file.type.startsWith("image/");
    const isVid = file.type.startsWith("video/");
    if (!isImg && !isVid) { _setStatus("Only images and videos allowed.", "error"); return; }
    if (file.size > MAX_MEDIA_SIZE) { _setStatus("File must be under 20 MB.", "error"); return; }
    _staged = file;
    if (_objURL) URL.revokeObjectURL(_objURL);
    _objURL = URL.createObjectURL(file);

    const prev = document.createElement("div");
    prev.className = "story-media-preview";
    prev.innerHTML = isVid
      ? `<video src="${_objURL}" muted playsinline style="width:100%;height:100%;object-fit:cover;"></video>`
      : `<img src="${_objURL}" style="width:100%;height:100%;object-fit:cover;" />`;
    const rm = document.createElement("button");
    rm.className = "story-media-preview__remove";
    rm.textContent = "✕";
    rm.addEventListener("click", () => {
      prev.replaceWith(dropzone);
      _staged = null;
      if (_objURL) { URL.revokeObjectURL(_objURL); _objURL = null; }
    });
    prev.appendChild(rm);
    dropzone.replaceWith(prev);
    _setStatus("", "");
  }

  function _setStatus(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className   = `story-create-status${cls ? " " + cls : ""}`;
  }

  /* Post */
  postBtn.addEventListener("click", async () => {
    if (!currentUser) return;
    if (_type === "text" && !textInput.value.trim()) {
      _setStatus("Please write something.", "error"); return;
    }
    if (_type === "media" && !_staged) {
      _setStatus("Please choose a photo or video.", "error"); return;
    }

    postBtn.disabled = true;
    _setStatus(_type === "media" ? "Uploading…" : "Posting…", "");

    try {
      const now     = Timestamp.now();
      const expires = Timestamp.fromMillis(Date.now() + STORY_TTL);
      let data = { createdAt: now, expiresAt: expires, seenBy: [] };

      if (_type === "text") {
        Object.assign(data, { type: "text", content: textInput.value.trim(), bg: _bg });
      } else {
        progress.style.display = "block";
        const url = await _uploadMedia(_staged, pct => { progressBar.style.width = pct + "%"; });
        progress.style.display = "none";
        Object.assign(data, {
          type:     _staged.type.startsWith("video/") ? "video" : "image",
          mediaUrl: url,
        });
      }

      await addDoc(collection(db, "stories", currentUser.uid, "items"), data);
      _setStatus("Story posted! ✓", "success");
      _close();
      _toast("Story shared! ✦");
      setTimeout(_buildTray, 500);

    } catch (err) {
      progress.style.display = "none";
      postBtn.disabled = false;
      _setStatus(err.message || "Failed to post story.", "error");
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   CLOUDINARY UPLOAD
════════════════════════════════════════════════════════════════ */
function _uploadMedia(file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("upload_preset", UPLOAD_PRESET);
    const type = file.type.startsWith("video/") ? "video" : "image";
    const xhr  = new XMLHttpRequest();
    xhr.open("POST", `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/${type}/upload`);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100));
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        const d = JSON.parse(xhr.responseText);
        d.secure_url ? resolve(d.secure_url) : reject(new Error("No URL returned."));
      } else {
        // Parse Cloudinary's JSON error body for a human-readable reason
        let reason = "Upload failed (status " + xhr.status + ").";
        try {
          const errData = JSON.parse(xhr.responseText);
          if (errData?.error?.message) reason = errData.error.message;
        } catch (_) { /* use default reason */ }
        reject(new Error(reason));
      }
    };
    xhr.onerror = () => reject(new Error("Network error."));
    xhr.send(fd);
  });
}

/* ═══════════════════════════════════════════════════════════════
   STORY VIEWER
════════════════════════════════════════════════════════════════ */
function _openViewer(uid, stories, name, photoURL) {
  _currentStories = stories.map(s => ({ ...s, uid, name, photoURL }));
  _currentIdx     = 0;
  _renderViewer();
}

function _renderViewer() {
  document.getElementById("storyViewerOverlay")?.remove();
  clearTimeout(_viewerTimer);

  if (!_currentStories.length || _currentIdx >= _currentStories.length) {
    _closeViewer(); return;
  }

  const story    = _currentStories[_currentIdx];
  const isOwn    = story.uid === currentUser?.uid;
  const seenBy   = Array.isArray(story.seenBy) ? story.seenBy : [];
  const initials = (story.name || "?")[0].toUpperCase();

  /* Progress segments */
  const segs = _currentStories.map((_, i) => {
    let cls = "story-progress-fill";
    if (i < _currentIdx)  cls += " story-progress-fill--done";
    if (i === _currentIdx) cls += " story-progress-fill--active";
    return `<div class="story-progress-segment">
      <div class="${cls}" ${i === _currentIdx
        ? `style="--story-duration:${STORY_DURATION/1000}s"` : ""}></div>
    </div>`;
  }).join("");

  /* Slide background */
  let bgHTML = "";
  if (story.type === "text") {
    bgHTML = `<div class="story-slide__bg">
      <div class="story-slide__text-bg" style="background:${_esc(story.bg || BG_GRADIENTS[0])}">
        <p>${_esc(story.content || "")}</p>
      </div></div>`;
  } else if (story.type === "image") {
    bgHTML = `<div class="story-slide__bg"><img src="${_esc(story.mediaUrl)}" alt="Story"/></div>`;
  } else {
    bgHTML = `<div class="story-slide__bg"><video src="${_esc(story.mediaUrl)}" autoplay muted playsinline loop></video></div>`;
  }

  const overlay = document.createElement("div");
  overlay.id        = "storyViewerOverlay";
  overlay.className = "story-viewer-overlay";
  overlay.innerHTML = `
    <div class="story-slide" id="svSlide">
      ${bgHTML}
      <div class="story-viewer__topbar">
        <div class="story-progress-bars">${segs}</div>
        <div class="story-viewer__header-row">
          <div class="story-viewer__avatar">
            ${story.photoURL
              ? `<img src="${_esc(story.photoURL)}" alt="${_esc(story.name)}" onerror="this.remove()"/>`
              : initials}
          </div>
          <span class="story-viewer__name">${_esc(story.name)}</span>
          <span class="story-viewer__time">${_timeAgo(story.createdAt?.toDate?.())}</span>
          <button class="story-viewer__close" id="svClose">✕</button>
        </div>
      </div>
      <div class="story-tap-prev" id="svPrev"></div>
      <div class="story-tap-next" id="svNext"></div>
      ${isOwn ? `
        <div class="story-viewer__seen" id="svSeenBtn" role="button" tabindex="0"
             style="cursor:pointer;pointer-events:all;">
          👁 ${seenBy.filter(u => u !== currentUser.uid).length} views
          ${seenBy.filter(u => u !== currentUser.uid).length > 0 ? '<span style="font-size:.65rem;opacity:.75;margin-left:.25rem;">· tap to see who</span>' : ''}
        </div>
        <button class="story-viewer__delete" id="svDelete">🗑 Delete</button>
      ` : ""}
    </div>`;

  document.body.appendChild(overlay);

  /* Mark seen */
  if (!isOwn && !seenBy.includes(currentUser?.uid)) {
    updateDoc(doc(db, "stories", story.uid, "items", story.id), {
      seenBy: arrayUnion(currentUser.uid)
    }).catch(() => {});
    _currentStories[_currentIdx].seenBy = [...seenBy, currentUser.uid];
  }

  /* Seen-by panel (own story only) */
  overlay.querySelector("#svSeenBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const viewers = seenBy.filter(u => u !== currentUser.uid);
    _showViewersList(viewers, story.uid, story.id, overlay);
  });

  /* Bind controls */
  overlay.querySelector("#svClose")?.addEventListener("click", _closeViewer);
  overlay.querySelector("#svPrev")?.addEventListener("click",  _prevStory);
  overlay.querySelector("#svNext")?.addEventListener("click",  _nextStory);

  /* Keyboard */
  const onKey = e => {
    if (e.key === "ArrowRight" || e.key === " ") _nextStory();
    if (e.key === "ArrowLeft")  _prevStory();
    if (e.key === "Escape")     _closeViewer();
  };
  document.addEventListener("keydown", onKey);
  overlay.querySelector("#svClose")?.addEventListener("click", () =>
    document.removeEventListener("keydown", onKey)
  );

  /* Touch swipe */
  overlay.addEventListener("touchstart", e => { _touchStartX = e.touches[0].clientX; }, { passive: true });
  overlay.addEventListener("touchend",   e => {
    const dx = e.changedTouches[0].clientX - _touchStartX;
    if (Math.abs(dx) > 50) dx < 0 ? _nextStory() : _prevStory();
  }, { passive: true });

  /* Press-and-hold to pause */
  const slide = overlay.querySelector("#svSlide");
  let _paused = false;
  slide?.addEventListener("pointerdown", () => {
    _paused = true;
    clearTimeout(_viewerTimer);
    const fill = overlay.querySelector(".story-progress-fill--active");
    if (fill) fill.style.animationPlayState = "paused";
  });
  slide?.addEventListener("pointerup", () => {
    if (!_paused) return;
    _paused = false;
    const fill = overlay.querySelector(".story-progress-fill--active");
    if (fill) fill.style.animationPlayState = "running";
    _viewerTimer = setTimeout(_nextStory, STORY_DURATION);
  });

  /* Delete own story */
  overlay.querySelector("#svDelete")?.addEventListener("click", async () => {
    if (!confirm("Delete this story?")) return;
    try {
      await deleteDoc(doc(db, "stories", currentUser.uid, "items", story.id));
      _currentStories.splice(_currentIdx, 1);
      if (!_currentStories.length) { _closeViewer(); _buildTray(); return; }
      if (_currentIdx >= _currentStories.length) _currentIdx--;
      _renderViewer();
      _buildTray();
    } catch { _toast("Failed to delete story."); }
  });

  /* Auto-advance */
  _viewerTimer = setTimeout(_nextStory, STORY_DURATION);
}

/* ═══════════════════════════════════════════════════════════════
   VIEWERS LIST PANEL
════════════════════════════════════════════════════════════════ */
async function _showViewersList(viewerUids, storyUid, storyId, parentOverlay) {
  /* Remove any existing panel */
  document.getElementById("storyViewersPanel")?.remove();

  const panel = document.createElement("div");
  panel.id        = "storyViewersPanel";
  panel.className = "story-viewers-panel";
  panel.innerHTML = `
    <div class="story-viewers-panel__handle"></div>
    <div class="story-viewers-panel__header">
      <span class="story-viewers-panel__title">👁 Viewed by</span>
      <button class="story-viewers-panel__close" id="svpClose">✕</button>
    </div>
    <div class="story-viewers-panel__list" id="svpList">
      <div class="story-viewers-loading">
        <div class="story-viewers-spinner"></div>
        <span>Loading viewers…</span>
      </div>
    </div>`;

  /* Append inside the viewer overlay so it stays above the story */
  parentOverlay.appendChild(panel);

  /* Animate in */
  requestAnimationFrame(() => panel.classList.add("story-viewers-panel--open"));

  const _closePanel = () => {
    panel.classList.remove("story-viewers-panel--open");
    setTimeout(() => panel.remove(), 300);
  };

  panel.querySelector("#svpClose")?.addEventListener("click", _closePanel);

  /* Tap outside panel (but inside overlay) closes it */
  parentOverlay.addEventListener("click", function _outsideClick(e) {
    if (!panel.contains(e.target) && e.target !== parentOverlay.querySelector("#svSeenBtn")) {
      _closePanel();
      parentOverlay.removeEventListener("click", _outsideClick);
    }
  });

  const list = panel.querySelector("#svpList");

  if (!viewerUids || viewerUids.length === 0) {
    list.innerHTML = `
      <div class="story-viewers-empty">
        <span>👀</span>
        <p>No one has viewed this story yet.</p>
        <small>Share your story with classmates!</small>
      </div>`;
    return;
  }

  /* Fetch all viewer profiles in parallel */
  try {
    const { getDoc: gd, doc: fd } = await import(
      "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js"
    );

    const profiles = await Promise.all(
      viewerUids.map(async uid => {
        try {
          const snap = await gd(fd(db, "users", uid));
          if (snap.exists()) return { uid, ...snap.data() };
        } catch { /* silent */ }
        return { uid, name: "Unknown User", role: "", photoURL: null };
      })
    );

    list.innerHTML = "";

    profiles.forEach((u, i) => {
      const initials = (u.name || "?")[0].toUpperCase();
      const row = document.createElement("div");
      row.className = "story-viewer-row";
      row.style.animationDelay = `${i * 40}ms`;
      row.innerHTML = `
        <div class="story-viewer-row__avatar">
          ${u.photoURL
            ? `<img src="${_esc(u.photoURL)}" alt="${_esc(u.name)}" onerror="this.parentElement.textContent='${initials}'" />`
            : initials
          }
        </div>
        <div class="story-viewer-row__info">
          <span class="story-viewer-row__name">${_esc(u.name || "Unknown")}</span>
          ${u.role ? `<span class="story-viewer-row__role">${_esc(u.role)}</span>` : ""}
        </div>
        <span class="story-viewer-row__check">✓</span>`;

      /* Clicking a viewer opens their profile */
      row.addEventListener("click", () => {
        window.open(`profile.html?user=${u.uid}`, "_blank");
      });

      list.appendChild(row);
    });

  } catch (err) {
    list.innerHTML = `<div class="story-viewers-empty"><span>⚠️</span><p>Failed to load viewers.</p></div>`;
    console.warn("_showViewersList:", err);
  }
}
function _nextStory() {
  clearTimeout(_viewerTimer);
  _currentIdx++;
  if (_currentIdx >= _currentStories.length) { _closeViewer(); return; }
  _renderViewer();
}

function _prevStory() {
  clearTimeout(_viewerTimer);
  _currentIdx = Math.max(0, _currentIdx - 1);
  _renderViewer();
}

function _closeViewer() {
  clearTimeout(_viewerTimer);
  document.getElementById("storyViewerOverlay")?.remove();
}

/* ═══════════════════════════════════════════════════════════════
   BOOT
════════════════════════════════════════════════════════════════ */
onAuthChange((user, profile) => {
  if (user && profile?.profileComplete && !profile.banned) {
    const tryInject = (tries = 0) => {
      const postsUI = document.getElementById("postsUI");
      if (postsUI && !postsUI.hidden) { _injectTray(); return; }
      if (tries < 30) setTimeout(() => tryInject(tries + 1), 300);
    };
    tryInject();
  } else {
    _trayInjected = false;
    _closeViewer();
    document.getElementById("storyTrayWrap")?.remove();
  }
});
