/**
 * chat.js — UPGRADED
 * Fixes: private chat Firestore path secured (privateChats/{convId}/messages),
 * own-message delete, media uploads via Cloudinary,
 * unread message badge/count, smooth transitions.
 */

import {
  collection, addDoc, query, orderBy, limit,
  onSnapshot, deleteDoc, doc, serverTimestamp,
  getDocs, updateDoc, setDoc, getDoc, increment,
  arrayUnion, arrayRemove, where} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

import { db }                             from "./firebase-config.js";
import { onAuthChange, showToast,
         currentUser, currentProfile }    from "./auth.js";

/* ══ CLOUDINARY ═════════════════════════════════════════════════ */
const CLOUD_NAME    = "dsbsinbun";
const UPLOAD_PRESET = "ghost_user";
const MAX_IMG_SIZE  = 5  * 1024 * 1024;
const MAX_VID_SIZE  = 100 * 1024 * 1024;

/* ══ DOM REFS ════════════════════════════════════════════════════ */
const chatAuthNotice  = document.getElementById("chatAuthNotice");
const chatUI          = document.getElementById("chatUI");
const groupMessages   = document.getElementById("groupMessages");
const privateMessages = document.getElementById("privateMessages");
const groupChatInput  = document.getElementById("groupChatInput");
const privateChatInput= document.getElementById("privateChatInput");
const groupSendBtn    = document.getElementById("groupSendBtn");
const privateSendBtn  = document.getElementById("privateSendBtn");
const chatTabs        = document.querySelectorAll(".chat-tab");
const groupPanel      = document.getElementById("groupChatPanel");
const privatePanel    = document.getElementById("privateChatPanel");
const usersList       = document.getElementById("usersList");
const privateInputWrap= document.getElementById("privateInputWrap");
const privateChatHdr  = document.getElementById("privateChatHeader");
const selectUserHint  = document.getElementById("selectUserHint");

let _groupUnsub    = null;
let _privateUnsub  = null;
let _activePrivate = null;

/* ══ INJECT MEDIA BUTTONS ═══════════════════════════════════════ */
function _injectChatMediaUI() {
  // Group chat media button
  const gBar = document.querySelector("#msgGroupPanel .chat-input-bar") 
               || document.querySelector("#groupChatPanel .chat-input-bar")
               || (groupSendBtn && groupSendBtn.closest(".chat-input-bar"));
  if (gBar && !document.getElementById("groupMediaBtn")) {
    const lbl = document.createElement("label");
    lbl.className = "chat-media-btn";
    lbl.title = "Send image/video";
    lbl.innerHTML = `📎<input type="file" id="groupMediaInput" accept="image/*,video/*" hidden />`;
    const _gsb = document.getElementById("groupSendBtn"); gBar.insertBefore(lbl, _gsb);
    document.getElementById("groupMediaInput").addEventListener("change", e => _handleChatMedia(e, "group"));
  }
  // Private chat media button
  const pBar = document.querySelector("#privateInputWrap");
  if (pBar && !document.getElementById("privateMediaBtn")) {
    const lbl = document.createElement("label");
    lbl.id = "privateMediaBtn";
    lbl.className = "chat-media-btn";
    lbl.title = "Send image/video";
    lbl.innerHTML = `📎<input type="file" id="privateMediaInput" accept="image/*,video/*" hidden />`;
    pBar.insertBefore(lbl, privateSendBtn);
    document.getElementById("privateMediaInput").addEventListener("change", e => _handleChatMedia(e, "private"));
  }
  // Add unread badge to nav tab if not exists
  _injectUnreadBadge();
}

function _injectUnreadBadge() {
  const chatNav = document.querySelector('.nav__links a[href="#chat"]');
  if (chatNav && !chatNav.querySelector(".unread-badge")) {
    const badge = document.createElement("span");
    badge.className = "unread-badge";
    badge.id = "chatUnreadBadge";
    badge.hidden = true;
    chatNav.appendChild(badge);
  }
}

async function _handleChatMedia(e, type) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  const isVideo = file.type.startsWith("video/");
  if (isVideo && file.size > MAX_VID_SIZE) return showToast("Video exceeds 100MB limit.");
  if (!isVideo && file.size > MAX_IMG_SIZE) return showToast("Image exceeds 5MB limit.");

  showToast("Uploading media…");
  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("upload_preset", UPLOAD_PRESET);
    const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/${isVideo?"video":"image"}/upload`;
    const res = await fetch(url, { method: "POST", body: fd });
    const data = await res.json();
    if (!data.secure_url) throw new Error("No URL returned");

    const mediaPayload = { url: data.secure_url, type: isVideo ? "video" : "image" };
    if (type === "group") {
      await addDoc(collection(db, "groupMessages"), {
        text: "", media: mediaPayload,
        uid: currentUser.uid, name: currentProfile.name, role: currentProfile.role,
        timestamp: serverTimestamp()
      });
    } else if (_activePrivate) {
      const convId = _convId(currentUser.uid, _activePrivate.uid);
      await addDoc(collection(db, "privateChats", convId, "messages"), {
        text: "", media: mediaPayload,
        uid: currentUser.uid, name: currentProfile.name, role: currentProfile.role,
        timestamp: serverTimestamp()
      });
    }
    showToast("Media sent ✦");
  } catch (err) {
    console.error("chat media upload:", err);
    showToast("Media upload failed.");
  }
}

/* ══ AUTH GATE ══════════════════════════════════════════════════ */
onAuthChange((user, profile) => {
  if (user && profile?.profileComplete && !profile.banned) {
    chatAuthNotice.hidden = true;
    chatUI.hidden         = false;
    _startGroupChat();
    _loadUsersList();
    _injectChatMediaUI();
    _listenUnread();
  } else {
    chatAuthNotice.hidden = false;
    chatUI.hidden         = true;
    _groupUnsub?.();   _groupUnsub   = null;
    _privateUnsub?.(); _privateUnsub = null;
  }
});

/* ══ TAB SWITCHING ══════════════════════════════════════════════ */
chatTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    chatTabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const isGroup = tab.dataset.tab === "group";
    groupPanel.hidden   = !isGroup;
    privatePanel.hidden =  isGroup;
    if (!isGroup) _loadUsersList();
    if (isGroup) {
      // Clear unread when opening group chat
      _clearGroupUnread();
    }
  });
});

/* ══ UNREAD MESSAGE SYSTEM ══════════════════════════════════════ */
let _unreadUnsub = null;

function _listenUnread() {
  if (!currentUser) return;
  _unreadUnsub?.();
  const ref = doc(db, "users", currentUser.uid);
  _unreadUnsub = onSnapshot(ref, snap => {
    const data  = snap.data() || {};
    const count = (data.unreadGroupCount || 0) + (data.unreadPrivateCount || 0);
    const badge = document.getElementById("chatUnreadBadge");
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? "99+" : count;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  });
}

async function _clearGroupUnread() {
  if (!currentUser) return;
  await updateDoc(doc(db, "users", currentUser.uid), { unreadGroupCount: 0 }).catch(() => {});
}

/* ══ GROUP CHAT ═════════════════════════════════════════════════ */
function _startGroupChat() {
  _groupUnsub?.();
  const q = query(collection(db, "groupMessages"), orderBy("timestamp", "asc"), limit(150));
  _groupUnsub = onSnapshot(q, snap => {
    groupMessages.innerHTML = "";
    snap.forEach(d => _appendBubble(groupMessages, d.id, d.data(), "group"));
    _scrollBottom(groupMessages);
  }, err => console.error("group chat:", err));
}

groupSendBtn?.addEventListener("click", _sendGroup);
groupChatInput?.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); _sendGroup(); }
});

async function _sendGroup() {
  const text = groupChatInput?.value.trim();
  if (!text || !currentUser || !currentProfile) return;
  if (text.length > 280) return showToast("Max 280 characters.");
  groupChatInput.value = "";
  await addDoc(collection(db, "groupMessages"), {
    text, uid: currentUser.uid,
    name: currentProfile.name, role: currentProfile.role,
    timestamp: serverTimestamp()
  }).catch(() => showToast("Failed to send."));
}

/* ══ PRIVATE CHAT — Users list ══════════════════════════════════ */
async function _loadUsersList() {
  if (!currentUser) return;
  const usersList = document.getElementById("usersList");
  if (!usersList) return;
  usersList.innerHTML = `<p class="chat-hint" style="padding:1rem;color:var(--clr-muted);font-size:.85rem;">Loading…</p>`;
  try {
    const snap = await getDocs(collection(db, "users"));
    usersList.innerHTML = "";
    snap.forEach(d => {
      const u = d.data();
      if (d.id === currentUser.uid || !u.profileComplete || u.banned) return;

      const name = u.name || u.displayName || "Unknown";
      const role = u.role ? (u.role.charAt(0).toUpperCase() + u.role.slice(1)) : "";
      const isOnline = u.online === true;
      const lastSeen = isOnline ? "Online" : (u.lastSeen ? _relTime(u.lastSeen) : "Offline");
      const initial = name[0].toUpperCase();

      const row = document.createElement("div");
      row.className = "dm-user-row";
      row.dataset.uid = d.id;
      row.innerHTML = `
        <div class="dm-user-avatar" style="position:relative;">
          ${u.photoURL
            ? `<img src="${_esc(u.photoURL)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.remove()">`
            : initial}
          ${isOnline ? '<span class="dm-online-dot"></span>' : ''}
        </div>
        <div class="dm-user-info">
          <span class="dm-user-name">${_esc(name)}</span>
          <span class="dm-user-meta">${role} · ${lastSeen}</span>
        </div>
        <span class="user-unread-dot" id="udot-${d.id}" hidden></span>`;

      row.addEventListener("click", () => _openDM({ uid: d.id, name, role: u.role }, row));
      usersList.appendChild(row);
    });
    if (!usersList.children.length)
      usersList.innerHTML = `<p class="chat-hint" style="padding:1rem;color:var(--clr-muted);font-size:.85rem;">No other users yet.</p>`;
  } catch(e) {
    usersList.innerHTML = `<p class="chat-hint" style="padding:1rem;color:var(--clr-muted);font-size:.85rem;">Error loading users.</p>`;
  }
}

function _relTime(ts) {
  try {
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff/60) + "m ago";
    if (diff < 86400) return Math.floor(diff/3600) + "h ago";
    return Math.floor(diff/86400) + "d ago";
  } catch(e) { return ""; }
}

function _openDM(peer, btn) {
  _activePrivate = peer;

  // Switch to conversation view
  const usersView = document.getElementById("dmUsersView");
  const convoView = document.getElementById("dmConvoView");
  if (usersView) usersView.hidden = true;
  if (convoView) convoView.hidden = false;

  // Update header
  const hdr = document.getElementById("privateChatHeader");
  const statusEl = document.getElementById("dmConvoStatus");
  const avatarEl = document.getElementById("dmConvoAvatar");
  if (hdr) hdr.textContent = peer.name;
  if (statusEl) statusEl.textContent = peer.role ? (peer.role.charAt(0).toUpperCase() + peer.role.slice(1)) : "";
  if (avatarEl) avatarEl.textContent = peer.name[0].toUpperCase();

  // Back button
  const backBtn = document.getElementById("dmBackBtn");
  if (backBtn) {
    backBtn.onclick = () => {
      if (convoView) convoView.hidden = true;
      if (usersView) usersView.hidden = false;
    };
  }

  if (selectUserHint) selectUserHint.hidden = true;

  document.querySelectorAll(".dm-user-row").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");

  _privateUnsub?.(); _privateUnsub = null;
  const convId = _convId(currentUser.uid, peer.uid);

  // FIXED: secure path privateChats/{convId}/messages
  const q = query(
    collection(db, "privateChats", convId, "messages"),
    orderBy("timestamp", "asc"),
    limit(100)
  );
  privateMessages.innerHTML = "";
  _privateUnsub = onSnapshot(q, snap => {
    privateMessages.innerHTML = "";
    snap.forEach(d => _appendBubble(privateMessages, d.id, d.data(), "private", convId));
    _scrollBottom(privateMessages);
  }, err => console.error("private chat:", err));

  // Mark as read
  _clearPrivateUnread(convId);
}

async function _clearPrivateUnread(convId) {
  if (!currentUser) return;
  const key = `unread_${convId}`;
  await updateDoc(doc(db, "users", currentUser.uid), { [key]: 0 }).catch(() => {});
  // Hide dot
  const dot = document.getElementById(`udot-${_activePrivate?.uid}`);
  if (dot) dot.hidden = true;
}

privateSendBtn?.addEventListener("click", _sendPrivate);
privateChatInput?.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); _sendPrivate(); }
});

async function _sendPrivate() {
  const text = privateChatInput?.value.trim();
  if (!text || !currentUser || !currentProfile || !_activePrivate) return;
  if (text.length > 280) return showToast("Max 280 characters.");
  privateChatInput.value = "";

  // FIXED: secure path privateChats/{convId}/messages
  const convId = _convId(currentUser.uid, _activePrivate.uid);
  await addDoc(collection(db, "privateChats", convId, "messages"), {
    text, uid: currentUser.uid,
    name: currentProfile.name, role: currentProfile.role,
    timestamp: serverTimestamp()
  }).catch(() => showToast("Failed to send."));
}

/* ══ RENDER CHAT BUBBLE ═════════════════════════════════════════ */
function _appendBubble(container, msgId, data, type, convId) {
  const mine   = data.uid === currentUser?.uid;
  // UPGRADED: users can delete own messages; admin/mod can delete any
  const canDel = mine || currentProfile?.admin || currentProfile?.moderator;

  const time = data.timestamp?.toDate
    ? data.timestamp.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  const wrap = document.createElement("div");
  wrap.className = `chat-bubble-wrap ${mine ? "mine" : "theirs"}`;

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";

  let innerHTML = !mine
    ? `<span class="chat-bubble__author">${_esc(data.name)} <em class="chat-bubble__role-tag">${data.role}</em></span>`
    : "";

  // Poll message
  if (data.type === "poll" && data.poll) {
    bubble.innerHTML = innerHTML + `<span class="chat-bubble__time">${time}</span>`;
    // Render poll widget asynchronously after bubble is in DOM
    wrap.appendChild(bubble);
    setTimeout(() => {
      const collection_name = type === "group" ? "groupMessages" : `privateChats/${convId}/messages`;
      if (window.renderPollWidget) {
        bubble.innerHTML = (mine ? "" : `<span class="chat-bubble__author">${_esc(data.name)} <em class="chat-bubble__role-tag">${data.role}</em></span>`)
          + window.renderPollWidget(data.poll, msgId, collection_name)
          + `<span class="chat-bubble__time">${time}</span>`;
      }
    }, 50);
    if (canDel) {
      const delBtn = document.createElement("button");
      delBtn.className = "chat-del-btn"; delBtn.title = "Delete message"; delBtn.textContent = "🗑";
      delBtn.addEventListener("click", async () => {
        if (!confirm("Delete this message?")) return;
        const ref = type === "group" ? doc(db, "groupMessages", msgId) : doc(db, "privateChats", convId, "messages", msgId);
        await deleteDoc(ref).catch(() => showToast("Delete failed."));
      });
      wrap.appendChild(delBtn);
    }
    container.appendChild(wrap);
    return;
  }

  if (data.media) {
    if (data.media.type === "video") {
      innerHTML += `<video src="${_esc(data.media.url)}" class="chat-media" controls preload="metadata"></video>`;
    } else {
      innerHTML += `<img src="${_esc(data.media.url)}" class="chat-media" alt="media" loading="lazy" />`;
    }
  }
  if (data.text) {
    innerHTML += `<span class="chat-bubble__text">${_esc(data.text)}</span>`;
  }
  innerHTML += `<span class="chat-bubble__time">${time}</span>`;

  bubble.innerHTML = innerHTML;
  wrap.appendChild(bubble);

  if (canDel) {
    const delBtn = document.createElement("button");
    delBtn.className = "chat-del-btn";
    delBtn.title = "Delete message";
    delBtn.textContent = "🗑";
    delBtn.addEventListener("click", async () => {
      if (!confirm("Delete this message?")) return;
      // FIXED: correct Firestore paths
      const ref = type === "group"
        ? doc(db, "groupMessages", msgId)
        : doc(db, "privateChats", convId, "messages", msgId);
      await deleteDoc(ref).catch(() => showToast("Delete failed."));
    });
    wrap.appendChild(delBtn);
  }

  container.appendChild(wrap);
}

/* ══ HELPERS ════════════════════════════════════════════════════ */
function _convId(a, b) { return [a, b].sort().join("_"); }
function _scrollBottom(el) { el.scrollTop = el.scrollHeight; }
function _esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ══ TYPING INDICATORS ══════════════════════════════════════════ */


let _typingTimer = null;
let _isTyping = false;

function _setTyping(chatId, isTyping) {
  if (!currentUser) return;
  const ref = doc(db, 'typing', `${chatId}_${currentUser.uid}`);
  if (isTyping) {
    setDoc(ref, {
      uid: currentUser.uid,
      name: currentProfile?.displayName || currentProfile?.name || 'Someone',
      chatId,
      ts: serverTimestamp()
    }).catch(() => {});
  } else {
    deleteDoc(ref).catch(() => {});
  }
}

function _attachTypingListener(chatId, indicatorEl) {
  if (!indicatorEl) return;
  const q = query(
    collection(db, 'typing'),
    where('chatId', '==', chatId)
  );
  return onSnapshot(q, snap => {
    const typers = snap.docs
      .map(d => d.data())
      .filter(t => t.uid !== currentUser?.uid)
      .map(t => t.name);

    if (typers.length === 0) {
      indicatorEl.innerHTML = '';
    } else {
      const names = typers.slice(0, 2).join(', ');
      const extra = typers.length > 2 ? ` +${typers.length - 2} more` : '';
      indicatorEl.innerHTML = `
        <div class="typing-dots"><span></span><span></span><span></span></div>
        <span>${names}${extra} ${typers.length === 1 ? 'is' : 'are'} typing...</span>`;
    }
  }, () => {});
}

// Attach typing events to group chat input
if (groupChatInput) {
  groupChatInput.addEventListener('input', () => {
    if (!_isTyping) { _isTyping = true; _setTyping('group', true); }
    clearTimeout(_typingTimer);
    _typingTimer = setTimeout(() => { _isTyping = false; _setTyping('group', false); }, 2000);
  });
  groupChatInput.addEventListener('blur', () => { _isTyping = false; _setTyping('group', false); });
}

// Start group typing indicator
const _groupTypingEl = document.getElementById('groupTypingIndicator');
onAuthChange(user => {
  if (user && _groupTypingEl) _attachTypingListener('group', _groupTypingEl);
});

/* ══ MESSAGE SEEN TICKS ═════════════════════════════════════════ */
// Mark private messages as seen when opened
async function _markPrivateSeen(convId) {
  if (!currentUser) return;
  try {
    const q = query(
      collection(db, 'privateChats', convId, 'messages'),
      where('seenBy', 'not-in', [[currentUser.uid]]),
      limit(50)
    );
    const snap = await getDocs(q);
    snap.docs.forEach(d => {
      if (d.data().authorId !== currentUser.uid) {
        updateDoc(d.ref, { seenBy: arrayUnion(currentUser.uid) }).catch(() => {});
      }
    });
    // Clear unread notification
    const notifQ = query(
      collection(db, 'users', currentUser.uid, 'notifications'),
      where('type', '==', 'dm'),
      where('read', '==', false)
    );
    const nSnap = await getDocs(notifQ);
    nSnap.docs.forEach(d => updateDoc(d.ref, { read: true }).catch(() => {}));
  } catch(e) {}
}

// Add seen status to rendered private messages
function _renderSeenStatus(msg, currentUid) {
  if (msg.authorId !== currentUid) return '';
  const seen = msg.seenBy?.filter(id => id !== currentUid).length > 0;
  return `<span class="msg-ticks ${seen ? 'seen' : 'sent'}">${seen ? '✓✓' : '✓'}</span>`;
}

// Export for use in profile like feature
export { _markPrivateSeen };
