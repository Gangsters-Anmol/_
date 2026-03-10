/**
 * features/polls.js — FULL REWRITE
 * WhatsApp-style polls for Community Posts and World Chat
 * ─────────────────────────────────────────────────────────────
 * BUGS FIXED:
 *  • window.renderPollWidget was never set — chat.js couldn't call it
 *  • _submitPost() in posts.js never saved poll data (patched via hook)
 *  • _buildCard() in posts.js never rendered polls (patched via MutationObserver)
 *  • Vote storage used nested array update (Firestore doesn't support it)
 *    → now uses poll.votes.{uid} = optionIdx (simple map field update)
 *  • Chat poll used currentProfile?.displayName — field is 'name'
 *  • renderPollWidget had no live listener — votes required page reload
 *
 * DATA MODEL:
 *   post/groupMessage doc gets a 'poll' field:
 *   {
 *     question: string,
 *     options:  [{ text: string }, ...],          // static, no votes here
 *     votes:    { [uid]: number },                 // mutable vote map
 *     allowMultiple: boolean,
 *     expiresAt: Timestamp | null,
 *     createdBy: uid,
 *   }
 * ─────────────────────────────────────────────────────────────
 */

import { db } from '../firebase-config.js';
import { onAuthChange, currentUser, currentProfile, showToast } from '../auth.js';
import {
  collection, addDoc, doc, updateDoc, onSnapshot,
  serverTimestamp, getDoc
} from 'https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js';

/* ══════════════════════════════════════════════════════════════
   STYLES
══════════════════════════════════════════════════════════════ */
(function _injectStyles() {
  if (document.getElementById('polls-css')) return;
  const s = document.createElement('style');
  s.id = 'polls-css';
  s.textContent = `

  /* ── Modal overlay ──────────────────────────────────────── */
  .pw-overlay {
    position: fixed; inset: 0; z-index: 900;
    background: rgba(10,8,20,.52);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    display: flex; align-items: flex-end; justify-content: center;
    animation: pw-fadeIn .22s ease both;
  }
  @keyframes pw-fadeIn { from { opacity:0 } to { opacity:1 } }

  .pw-sheet {
    width: min(480px, 100vw);
    max-height: 92vh;
    background: var(--clr-modal-bg, rgba(252,250,255,.98));
    border-radius: 28px 28px 0 0;
    border: 1px solid var(--clr-modal-border, rgba(167,139,202,.2));
    border-bottom: none;
    box-shadow: 0 -8px 48px rgba(100,80,140,.18);
    display: flex; flex-direction: column;
    overflow: hidden;
    animation: pw-slideUp .34s cubic-bezier(.16,1,.3,1) both;
  }
  @keyframes pw-slideUp {
    from { transform: translateY(100%) }
    to   { transform: translateY(0) }
  }

  /* Drag handle */
  .pw-handle {
    width: 40px; height: 4px; border-radius: 2px;
    background: var(--clr-border2, rgba(167,139,202,.4));
    margin: .75rem auto .2rem;
    flex-shrink: 0;
  }

  /* Sheet header */
  .pw-sheet-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: .8rem 1.4rem .7rem;
    border-bottom: 1px solid var(--clr-border, rgba(200,190,210,.3));
    flex-shrink: 0;
  }
  .pw-sheet-title {
    font-family: var(--font-display,'Cormorant Garamond',serif);
    font-size: 1.25rem; font-weight: 600;
    color: var(--clr-text, #2e2c3a);
    display: flex; align-items: center; gap: .5rem;
  }
  .pw-sheet-close {
    width: 30px; height: 30px; border-radius: 50%;
    border: 1px solid var(--clr-border);
    background: transparent; color: var(--clr-muted);
    font-size: .8rem; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all .2s;
  }
  .pw-sheet-close:hover { background: var(--clr-danger,#e05c6a); color:#fff; border-color:var(--clr-danger); transform:rotate(90deg); }

  /* Scrollable body */
  .pw-sheet-body {
    flex: 1; overflow-y: auto; padding: 1.1rem 1.4rem;
    scrollbar-width: thin;
    scrollbar-color: var(--clr-border2) transparent;
  }
  .pw-sheet-body::-webkit-scrollbar { width: 3px }
  .pw-sheet-body::-webkit-scrollbar-thumb { background: var(--clr-border2); border-radius: 2px }

  /* Question input */
  .pw-question-wrap { margin-bottom: 1rem; }
  .pw-question-label {
    font-size: .67rem; font-weight: 600; letter-spacing: .1em;
    text-transform: uppercase; color: var(--clr-muted);
    margin-bottom: .45rem; display: block;
  }
  .pw-question-input {
    width: 100%; padding: .8rem 1rem;
    background: var(--clr-input-bg, rgba(255,255,255,.75));
    border: 1.5px solid var(--clr-border);
    border-radius: 14px;
    color: var(--clr-text); font-family: var(--font-body,'Jost',sans-serif);
    font-size: .92rem; outline: none; resize: none;
    transition: border-color .2s, box-shadow .2s;
    line-height: 1.5;
  }
  .pw-question-input:focus {
    border-color: var(--clr-accent, #a78bca);
    box-shadow: 0 0 0 3px rgba(167,139,202,.12);
  }
  .pw-question-input::placeholder { color: var(--clr-muted); }

  /* Options section */
  .pw-options-label {
    font-size: .67rem; font-weight: 600; letter-spacing: .1em;
    text-transform: uppercase; color: var(--clr-muted);
    margin-bottom: .55rem; display: block;
  }
  .pw-options-list { display: flex; flex-direction: column; gap: .5rem; margin-bottom: .6rem; }

  .pw-opt-row {
    display: flex; align-items: center; gap: .5rem;
    animation: pw-optIn .22s cubic-bezier(.16,1,.3,1) both;
  }
  @keyframes pw-optIn { from { opacity:0; transform:translateX(-8px) } to { opacity:1; transform:none } }

  .pw-opt-input {
    flex: 1; padding: .65rem .9rem;
    background: var(--clr-input-bg);
    border: 1.5px solid var(--clr-border);
    border-radius: 12px;
    color: var(--clr-text); font-family: var(--font-body,'Jost',sans-serif);
    font-size: .84rem; outline: none;
    transition: border-color .2s, box-shadow .2s;
  }
  .pw-opt-input:focus { border-color: var(--clr-accent); box-shadow: 0 0 0 3px rgba(167,139,202,.1); }
  .pw-opt-input::placeholder { color: var(--clr-muted); }

  .pw-opt-del {
    width: 28px; height: 28px; flex-shrink: 0; border-radius: 50%;
    border: 1px solid var(--clr-border); background: transparent;
    color: var(--clr-muted); font-size: .75rem; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all .18s;
  }
  .pw-opt-del:hover { background: var(--clr-danger,#e05c6a); color:#fff; border-color:var(--clr-danger); }

  .pw-add-opt-btn {
    display: flex; align-items: center; gap: .4rem;
    padding: .55rem .9rem; border-radius: 10px;
    border: 1.5px dashed var(--clr-border2, rgba(167,139,202,.4));
    background: transparent; color: var(--clr-accent);
    font-family: var(--font-body,'Jost',sans-serif);
    font-size: .78rem; font-weight: 500; cursor: pointer;
    width: 100%; justify-content: center;
    transition: all .2s;
  }
  .pw-add-opt-btn:hover { background: rgba(167,139,202,.08); border-style: solid; }

  /* Settings row */
  .pw-settings { display: flex; flex-direction: column; gap: .6rem; margin-top: .9rem; }
  .pw-setting-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: .6rem .9rem;
    background: var(--clr-surface, rgba(255,255,255,.68));
    border: 1px solid var(--clr-border);
    border-radius: 12px;
  }
  .pw-setting-label { font-size: .82rem; color: var(--clr-text2); display: flex; align-items: center; gap: .45rem; }
  .pw-setting-label span { font-size: .7rem; color: var(--clr-muted); }

  /* Toggle switch */
  .pw-toggle { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
  .pw-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
  .pw-toggle-slider {
    position: absolute; inset: 0; border-radius: 11px;
    background: var(--clr-border); cursor: pointer;
    transition: background .25s;
  }
  .pw-toggle-slider::after {
    content: ''; position: absolute;
    left: 3px; top: 3px; width: 16px; height: 16px;
    border-radius: 50%; background: #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,.2);
    transition: transform .25s cubic-bezier(.34,1.56,.64,1);
  }
  .pw-toggle input:checked + .pw-toggle-slider { background: var(--clr-accent, #a78bca); }
  .pw-toggle input:checked + .pw-toggle-slider::after { transform: translateX(16px); }

  /* Duration select */
  .pw-duration-select {
    padding: .3rem .6rem; border-radius: 8px;
    border: 1px solid var(--clr-border);
    background: var(--clr-input-bg);
    color: var(--clr-text); font-family: var(--font-body,'Jost',sans-serif);
    font-size: .78rem; outline: none; cursor: pointer;
  }

  /* Sheet footer */
  .pw-sheet-footer {
    padding: .9rem 1.4rem 1.1rem;
    border-top: 1px solid var(--clr-border, rgba(200,190,210,.25));
    display: flex; gap: .6rem; flex-shrink: 0;
    background: linear-gradient(135deg,
      rgba(167,139,202,.04), rgba(240,168,176,.02));
  }
  .pw-btn-primary {
    flex: 1; padding: .8rem 1.2rem;
    background: linear-gradient(135deg, var(--clr-accent,#a78bca), var(--clr-accent2,#f0a8b0));
    color: #fff; border: none; border-radius: 14px;
    font-family: var(--font-body,'Jost',sans-serif);
    font-size: .88rem; font-weight: 500; cursor: pointer;
    transition: opacity .2s, transform .15s;
    letter-spacing: .03em;
  }
  .pw-btn-primary:hover { opacity: .92; transform: translateY(-1px); }
  .pw-btn-primary:active { transform: scale(.97); }
  .pw-btn-primary:disabled { opacity: .5; pointer-events: none; }
  .pw-btn-secondary {
    padding: .8rem 1.2rem; border-radius: 14px;
    border: 1px solid var(--clr-border);
    background: transparent; color: var(--clr-muted);
    font-family: var(--font-body,'Jost',sans-serif);
    font-size: .88rem; cursor: pointer; transition: all .2s;
  }
  .pw-btn-secondary:hover { background: var(--clr-surface2); color: var(--clr-text); }

  /* ── Poll button in toolbars ────────────────────────────── */
  .pw-create-btn {
    display: flex; align-items: center; gap: .35rem;
    padding: .35rem .75rem; border-radius: 10px;
    border: 1px solid var(--clr-border2, rgba(167,139,202,.35));
    background: rgba(167,139,202,.08);
    color: var(--clr-accent, #a78bca);
    font-family: var(--font-body,'Jost',sans-serif);
    font-size: .76rem; font-weight: 500; cursor: pointer;
    transition: all .2s; white-space: nowrap; flex-shrink: 0;
  }
  .pw-create-btn:hover { background: var(--clr-accent); color:#fff; border-color:var(--clr-accent); }
  .pw-create-btn.has-poll {
    background: rgba(72,187,120,.1);
    border-color: rgba(72,187,120,.4); color: #48bb78;
  }
  .pw-create-btn.has-poll:hover { background: #48bb78; color:#fff; border-color:#48bb78; }

  /* Chat poll button */
  .pw-chat-btn {
    display: flex; align-items: center; justify-content: center;
    width: 34px; height: 34px; flex-shrink: 0; border-radius: 9px;
    border: 1px solid var(--clr-border);
    background: transparent; color: var(--clr-muted);
    font-size: 1rem; cursor: pointer; transition: all .2s;
  }
  .pw-chat-btn:hover { background: var(--clr-accent); color:#fff; border-color:var(--clr-accent); }

  /* ── Poll widget (rendered in feed / chat) ─────────────── */
  .pw-widget {
    background: var(--clr-surface, rgba(255,255,255,.68));
    border: 1px solid var(--clr-border);
    border-radius: 16px; overflow: hidden;
    margin: .35rem 0; max-width: 340px;
    box-shadow: 0 2px 12px rgba(100,80,140,.07);
    transition: box-shadow .2s;
  }
  .pw-widget:hover { box-shadow: 0 4px 20px rgba(100,80,140,.12); }

  .pw-widget-head {
    padding: .8rem 1rem .5rem;
    border-bottom: 1px solid var(--clr-border);
    display: flex; align-items: flex-start; gap: .55rem;
  }
  .pw-widget-icon {
    width: 28px; height: 28px; flex-shrink: 0; border-radius: 50%;
    background: linear-gradient(135deg, var(--clr-accent,#a78bca), var(--clr-accent2,#f0a8b0));
    display: flex; align-items: center; justify-content: center;
    font-size: .78rem; margin-top: .1rem;
  }
  .pw-widget-question {
    font-family: var(--font-body,'Jost',sans-serif);
    font-size: .88rem; font-weight: 500;
    color: var(--clr-text); line-height: 1.4; flex: 1;
  }

  .pw-widget-body { padding: .6rem .75rem; display: flex; flex-direction: column; gap: .38rem; }

  /* Option row */
  .pw-opt-row-widget {
    position: relative; cursor: pointer;
    border-radius: 10px; overflow: hidden;
    border: 1.5px solid var(--clr-border);
    transition: border-color .2s, transform .15s;
    min-height: 38px;
  }
  .pw-opt-row-widget:hover:not(.pw-voted):not(.pw-expired) {
    border-color: var(--clr-accent);
    transform: translateY(-1px);
    box-shadow: 0 3px 10px rgba(167,139,202,.15);
  }
  .pw-opt-row-widget:active:not(.pw-voted):not(.pw-expired) { transform: scale(.98); }
  .pw-opt-row-widget.pw-voted { cursor: default; }
  .pw-opt-row-widget.pw-my-vote { border-color: var(--clr-accent); }

  /* Fill bar behind option text */
  .pw-opt-fill {
    position: absolute; top: 0; left: 0; bottom: 0;
    border-radius: 8px;
    transition: width .55s cubic-bezier(.16,1,.3,1);
    pointer-events: none;
  }
  .pw-opt-row-widget.pw-my-vote .pw-opt-fill {
    background: linear-gradient(90deg,
      rgba(167,139,202,.22), rgba(240,168,176,.14));
  }
  .pw-opt-row-widget:not(.pw-my-vote) .pw-opt-fill {
    background: rgba(167,139,202,.09);
  }

  /* Option content */
  .pw-opt-content {
    position: relative; z-index: 1;
    display: flex; align-items: center;
    justify-content: space-between;
    padding: .55rem .8rem; gap: .5rem;
  }
  .pw-opt-text {
    font-family: var(--font-body,'Jost',sans-serif);
    font-size: .82rem; color: var(--clr-text); flex: 1;
    display: flex; align-items: center; gap: .4rem;
  }
  .pw-opt-check {
    width: 16px; height: 16px; border-radius: 50%;
    border: 1.5px solid var(--clr-border);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; font-size: .6rem;
    transition: all .2s;
    background: transparent;
  }
  .pw-opt-row-widget.pw-my-vote .pw-opt-check {
    background: var(--clr-accent); border-color: var(--clr-accent);
    color: #fff;
  }
  .pw-opt-right { display: flex; align-items: center; gap: .35rem; flex-shrink: 0; }
  .pw-opt-pct {
    font-size: .72rem; font-weight: 600;
    color: var(--clr-accent); min-width: 32px; text-align: right;
    transition: opacity .3s;
  }
  .pw-opt-count { font-size: .65rem; color: var(--clr-muted); }

  /* Voter avatars (shown on hover) */
  .pw-opt-voters {
    display: flex; padding: .1rem .8rem .45rem;
    gap: -4px; flex-wrap: wrap;
  }
  .pw-voter-chip {
    font-size: .6rem; color: var(--clr-muted);
    background: var(--clr-surface2);
    border-radius: 50px; padding: .12rem .5rem;
    margin: .1rem .15rem .1rem 0;
    border: 1px solid var(--clr-border);
    max-width: 80px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }

  /* Footer */
  .pw-widget-foot {
    padding: .45rem .9rem .65rem;
    display: flex; align-items: center; justify-content: space-between;
    border-top: 1px solid var(--clr-border);
    background: rgba(167,139,202,.025);
  }
  .pw-foot-meta {
    font-size: .68rem; color: var(--clr-muted);
    font-family: var(--font-body,'Jost',sans-serif);
    display: flex; align-items: center; gap: .4rem;
  }
  .pw-expired-badge {
    font-size: .6rem; font-weight: 600; letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--clr-danger,#e05c6a);
    background: rgba(224,92,106,.1);
    border: 1px solid rgba(224,92,106,.25);
    border-radius: 50px; padding: .12rem .55rem;
  }
  .pw-change-vote-btn {
    font-size: .68rem; color: var(--clr-accent);
    background: transparent; border: none; cursor: pointer;
    font-family: var(--font-body,'Jost',sans-serif);
    padding: .15rem .45rem; border-radius: 6px;
    transition: background .2s;
  }
  .pw-change-vote-btn:hover { background: rgba(167,139,202,.1); }

  /* Loading skeleton in widget */
  .pw-widget-loading {
    padding: .9rem 1rem;
    font-size: .78rem; color: var(--clr-muted);
    display: flex; align-items: center; gap: .5rem;
  }
  .pw-mini-spinner {
    width: 14px; height: 14px; border-radius: 50%;
    border: 2px solid var(--clr-border);
    border-top-color: var(--clr-accent);
    animation: pw-spin .7s linear infinite;
  }
  @keyframes pw-spin { to { transform: rotate(360deg); } }

  /* Dark mode */
  [data-theme="dark"] .pw-sheet { background: rgba(15,12,28,.98); }
  [data-theme="dark"] .pw-widget {
    background: rgba(255,255,255,.04);
    border-color: rgba(255,255,255,.1);
  }
  [data-theme="dark"] .pw-opt-row-widget.pw-my-vote .pw-opt-fill {
    background: linear-gradient(90deg, rgba(196,168,232,.22), rgba(244,184,196,.14));
  }
  [data-theme="dark"] .pw-opt-row-widget:not(.pw-my-vote) .pw-opt-fill {
    background: rgba(196,168,232,.08);
  }
  `;
  document.head.appendChild(s);
})();

/* ══════════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════════ */
let _pendingPollForPost = null;   // set when user creates a poll for a post
const _widgetUnsubs = new Map();  // docId → unsubscribe fn (prevents leaks)

/* ══════════════════════════════════════════════════════════════
   BOOT — inject buttons after auth resolves
══════════════════════════════════════════════════════════════ */
onAuthChange((user, profile) => {
  if (user && profile?.profileComplete && !profile.banned) {
    setTimeout(() => {
      _injectPostPollButton();
      _injectChatPollButton();
      _patchPostSubmit();
      _watchPostFeed();
    }, 400);
  }
});

/* ══════════════════════════════════════════════════════════════
   INJECT POLL BUTTON — Community Post composer
══════════════════════════════════════════════════════════════ */
function _injectPostPollButton() {
  if (document.getElementById('pwPostBtn')) return;
  const mediaRow = document.getElementById('postMediaRow');
  if (!mediaRow) return;

  const btn = document.createElement('button');
  btn.id = 'pwPostBtn';
  btn.type = 'button';
  btn.className = 'pw-create-btn';
  btn.innerHTML = '📊 Poll';
  btn.addEventListener('click', () => {
    if (_pendingPollForPost) {
      // Already has a poll — clicking again removes it
      _pendingPollForPost = null;
      btn.innerHTML = '📊 Poll';
      btn.classList.remove('has-poll');
      showToast('Poll removed');
    } else {
      _openPollModal('post', (pollData) => {
        _pendingPollForPost = pollData;
        btn.innerHTML = '✓ Poll Added';
        btn.classList.add('has-poll');
        showToast('Poll attached to post ✦');
      });
    }
  });
  mediaRow.appendChild(btn);
}

/* ══════════════════════════════════════════════════════════════
   INJECT POLL BUTTON — World Chat input bar
══════════════════════════════════════════════════════════════ */
function _injectChatPollButton() {
  if (document.getElementById('pwChatBtn')) return;
  const bar = document.querySelector('#msgGroupPanel .chat-input-bar');
  if (!bar) return;

  const btn = document.createElement('button');
  btn.id = 'pwChatBtn';
  btn.type = 'button';
  btn.className = 'pw-chat-btn';
  btn.title = 'Create Poll';
  btn.textContent = '📊';
  btn.addEventListener('click', () => {
    if (!currentUser) { showToast('Login to create polls'); return; }
    _openPollModal('chat', async (pollData) => {
      try {
        await addDoc(collection(db, 'groupMessages'), {
          type:       'poll',
          poll:       pollData,
          name:       currentProfile?.name || 'Anonymous',
          role:       currentProfile?.role || '',
          authorId:   currentUser.uid,
          createdAt:  serverTimestamp(),
        });
        showToast('Poll posted! 📊');
      } catch (e) {
        showToast('Failed to post poll: ' + e.message);
      }
    });
  });

  const sendBtn = bar.querySelector('.chat-send-btn');
  bar.insertBefore(btn, sendBtn);
}

/* ══════════════════════════════════════════════════════════════
   PATCH posts.js _submitPost to include poll
   Hooks into the existing submit button without modifying posts.js
══════════════════════════════════════════════════════════════ */
function _patchPostSubmit() {
  if (window.__pollPostPatched) return;
  window.__pollPostPatched = true;

  // Expose pending poll to posts.js via window
  Object.defineProperty(window, '_pendingPoll', {
    get() { return _pendingPollForPost; },
    set(v) { _pendingPollForPost = v; },
    configurable: true,
  });

  // Intercept the submit button to inject poll into Firestore doc
  const submitBtn = document.getElementById('submitPostBtn');
  if (!submitBtn) return;

  // Wrap the existing click handler: we listen AFTER it fires
  // and then update the just-created post with the poll data
  submitBtn.addEventListener('click', () => {
    if (!_pendingPollForPost) return;
    // Wait a tick for posts.js to call addDoc, then find the newest post
    const snapshot = _pendingPollForPost;
    _pendingPollForPost = null;
    const btn = document.getElementById('pwPostBtn');
    if (btn) { btn.innerHTML = '📊 Poll'; btn.classList.remove('has-poll'); }

    // Wait for posts.js to create the doc, then update it with poll
    setTimeout(async () => {
      try {
        const { collection: col, query, orderBy, limit, getDocs } =
          await import('https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js');
        const q = query(
          col(db, 'posts'),
          orderBy('timestamp', 'desc'),
          limit(1)
        );
        const snap = await getDocs(q);
        if (!snap.empty) {
          const postRef = snap.docs[0].ref;
          await updateDoc(postRef, { poll: snapshot });
        }
      } catch (e) {
        console.warn('poll patch failed:', e);
      }
    }, 800);
  }, true); // capture phase so it runs before existing handler
}

/* ══════════════════════════════════════════════════════════════
   WATCH POST FEED — inject poll widgets into post cards
   Uses MutationObserver since posts.js renders the cards
══════════════════════════════════════════════════════════════ */
function _watchPostFeed() {
  const feed = document.getElementById('postsFeed');
  if (!feed) return;

  const obs = new MutationObserver(mutations => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        const postId = node.dataset?.postId;
        if (!postId) return;
        // Give posts.js time to finish rendering, then inject poll
        setTimeout(() => _injectPollIntoCard(node, postId), 120);
      });
    });
  });
  obs.observe(feed, { childList: true });

  // Also inject into existing cards
  feed.querySelectorAll('[data-post-id]').forEach(card => {
    _injectPollIntoCard(card, card.dataset.postId);
  });
}

async function _injectPollIntoCard(card, postId) {
  if (card.querySelector('.pw-widget')) return; // already injected
  try {
    const snap = await getDoc(doc(db, 'posts', postId));
    if (!snap.exists() || !snap.data().poll) return;
    const pollData = snap.data().poll;
    const widget = _createWidget(pollData, postId, 'posts');
    // Insert after post content, before footer
    const footer = card.querySelector('.post-card__footer');
    if (footer) card.insertBefore(widget, footer);
    else card.appendChild(widget);
  } catch (e) {
    console.warn('poll inject:', e);
  }
}

/* ══════════════════════════════════════════════════════════════
   OPEN POLL CREATION MODAL (bottom sheet)
══════════════════════════════════════════════════════════════ */
function _openPollModal(context, onSubmit) {
  const overlay = document.createElement('div');
  overlay.className = 'pw-overlay';
  overlay.id = 'pwOverlay';

  overlay.innerHTML = `
    <div class="pw-sheet" id="pwSheet">
      <div class="pw-handle"></div>
      <div class="pw-sheet-header">
        <div class="pw-sheet-title">📊 New Poll</div>
        <button class="pw-sheet-close" id="pwSheetClose">✕</button>
      </div>
      <div class="pw-sheet-body">
        <div class="pw-question-wrap">
          <span class="pw-question-label">Question</span>
          <textarea class="pw-question-input" id="pwQuestion"
            placeholder="Ask something to the class…" rows="2" maxlength="240"></textarea>
        </div>
        <span class="pw-options-label">Options <em style="font-weight:400;text-transform:none;letter-spacing:0;font-size:.65rem;">(2–10)</em></span>
        <div class="pw-options-list" id="pwOptList">
          ${[1,2].map(i => `
            <div class="pw-opt-row">
              <input class="pw-opt-input" type="text" placeholder="Option ${i}" maxlength="120">
              <button class="pw-opt-del" type="button" title="Remove">✕</button>
            </div>`).join('')}
        </div>
        <button class="pw-add-opt-btn" id="pwAddOpt" type="button">+ Add option</button>
        <div class="pw-settings">
          <div class="pw-setting-row">
            <label class="pw-setting-label" for="pwMultiple">
              ☑ Allow multiple answers <span>Each person can pick more than one</span>
            </label>
            <label class="pw-toggle">
              <input type="checkbox" id="pwMultiple">
              <div class="pw-toggle-slider"></div>
            </label>
          </div>
          <div class="pw-setting-row">
            <label class="pw-setting-label" for="pwDuration">
              ⏱ Duration
            </label>
            <select class="pw-duration-select" id="pwDuration">
              <option value="0">No limit</option>
              <option value="1">1 day</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
              <option value="14">2 weeks</option>
            </select>
          </div>
        </div>
      </div>
      <div class="pw-sheet-footer">
        <button class="pw-btn-secondary" id="pwCancel">Cancel</button>
        <button class="pw-btn-primary" id="pwSubmit">
          ${context === 'chat' ? '📤 Post Poll' : '✓ Attach to Post'}
        </button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const close = () => {
    const sheet = document.getElementById('pwSheet');
    sheet?.style.setProperty('transform', 'translateY(100%)');
    setTimeout(() => overlay.remove(), 340);
  };

  document.getElementById('pwSheetClose').addEventListener('click', close);
  document.getElementById('pwCancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  // Add option
  const optList = document.getElementById('pwOptList');
  document.getElementById('pwAddOpt').addEventListener('click', () => {
    const rows = optList.querySelectorAll('.pw-opt-row');
    if (rows.length >= 10) { showToast('Maximum 10 options'); return; }
    const idx = rows.length + 1;
    const row = document.createElement('div');
    row.className = 'pw-opt-row';
    row.innerHTML = `
      <input class="pw-opt-input" type="text" placeholder="Option ${idx}" maxlength="120">
      <button class="pw-opt-del" type="button" title="Remove">✕</button>`;
    optList.appendChild(row);
    _bindDelBtn(row.querySelector('.pw-opt-del'), optList);
    row.querySelector('.pw-opt-input').focus();
  });

  optList.querySelectorAll('.pw-opt-del').forEach(btn => _bindDelBtn(btn, optList));

  // Submit
  document.getElementById('pwSubmit').addEventListener('click', () => {
    const question = document.getElementById('pwQuestion').value.trim();
    if (!question) { showToast('Please enter a question'); return; }

    const opts = [...optList.querySelectorAll('.pw-opt-input')]
      .map(i => i.value.trim()).filter(Boolean);
    if (opts.length < 2) { showToast('Need at least 2 options'); return; }

    const multiple = document.getElementById('pwMultiple').checked;
    const days     = parseInt(document.getElementById('pwDuration').value || '0');
    const expiresAt = days > 0
      ? new Date(Date.now() + days * 86400000)
      : null;

    const pollData = {
      question,
      options:       opts.map(text => ({ text })),
      votes:         {},        // { uid: optIdx } or { uid: [optIdx,...] } for multi
      allowMultiple: multiple,
      expiresAt,
      createdBy:     currentUser?.uid || '',
      createdAt:     new Date().toISOString(),
    };

    onSubmit(pollData);
    close();
  });
}

function _bindDelBtn(btn, optList) {
  btn.addEventListener('click', () => {
    if (optList.querySelectorAll('.pw-opt-row').length <= 2) {
      showToast('Minimum 2 options'); return;
    }
    btn.closest('.pw-opt-row').remove();
  });
}

/* ══════════════════════════════════════════════════════════════
   CREATE POLL WIDGET (returns a DOM element with live listener)
══════════════════════════════════════════════════════════════ */
function _createWidget(initialData, docId, collectionName) {
  const container = document.createElement('div');
  container.dataset.pollDoc = docId;
  container.dataset.pollCol = collectionName;

  // Render immediately with initial data
  _renderWidget(container, initialData, docId, collectionName);

  // Subscribe to live updates
  if (_widgetUnsubs.has(docId)) _widgetUnsubs.get(docId)();

  const ref = collectionName.includes('/')
    ? _docFromPath(collectionName, docId)
    : doc(db, collectionName, docId);

  if (ref) {
    const unsub = onSnapshot(ref, snap => {
      if (!snap.exists()) return;
      const poll = snap.data().poll;
      if (poll) _renderWidget(container, poll, docId, collectionName);
    });
    _widgetUnsubs.set(docId, unsub);
  }

  return container;
}

function _docFromPath(colPath, docId) {
  // Handle paths like "privateChats/convId/messages"
  const parts = colPath.split('/');
  if (parts.length === 1) return doc(db, parts[0], docId);
  if (parts.length === 3) return doc(db, parts[0], parts[1], parts[2], docId);
  return null;
}

/* ══════════════════════════════════════════════════════════════
   RENDER WIDGET (called on every live update)
══════════════════════════════════════════════════════════════ */
function _renderWidget(container, poll, docId, collectionName) {
  const uid      = currentUser?.uid;
  const votes    = poll.votes || {};
  const myVote   = votes[uid];                      // number or array or undefined
  const hasVoted = myVote !== undefined && myVote !== null;
  const expired  = poll.expiresAt
    ? new Date(poll.expiresAt?.toDate?.() || poll.expiresAt) < new Date()
    : false;
  const showResults = hasVoted || expired;

  // Tally votes per option
  const tallies = (poll.options || []).map((_, i) => {
    return Object.values(votes).filter(v =>
      Array.isArray(v) ? v.includes(i) : v === i
    ).length;
  });
  const totalVotes = Object.keys(votes).length;

  // Collect voter names (we only have UIDs; show initials for now)
  // For WhatsApp-style voter display, we'd need a user lookup, but we'll show counts
  const opts = (poll.options || []).map((opt, i) => {
    const count   = tallies[i];
    const pct     = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
    const isMyOpt = Array.isArray(myVote) ? myVote.includes(i) : myVote === i;
    return { ...opt, count, pct, isMyOpt, idx: i };
  });

  container.innerHTML = `
    <div class="pw-widget">
      <div class="pw-widget-head">
        <div class="pw-widget-icon">📊</div>
        <div class="pw-widget-question">${_esc(poll.question)}</div>
      </div>
      <div class="pw-widget-body">
        ${opts.map(opt => `
          <div class="pw-opt-row-widget
              ${showResults ? 'pw-voted' : ''}
              ${opt.isMyOpt ? 'pw-my-vote' : ''}
              ${expired ? 'pw-expired' : ''}"
            data-idx="${opt.idx}"
            data-doc="${_esc(docId)}"
            data-col="${_esc(collectionName)}">
            <div class="pw-opt-fill" style="width:${showResults ? opt.pct : 0}%"></div>
            <div class="pw-opt-content">
              <div class="pw-opt-text">
                <div class="pw-opt-check">${opt.isMyOpt ? '✓' : ''}</div>
                ${_esc(opt.text)}
              </div>
              <div class="pw-opt-right">
                ${showResults ? `
                  <span class="pw-opt-pct">${opt.pct}%</span>
                  <span class="pw-opt-count">${opt.count}</span>
                ` : ''}
              </div>
            </div>
          </div>`).join('')}
      </div>
      <div class="pw-widget-foot">
        <div class="pw-foot-meta">
          <span>${totalVotes} vote${totalVotes !== 1 ? 's' : ''}</span>
          ${poll.allowMultiple ? '<span>· Multiple choice</span>' : ''}
          ${expired
            ? '<span class="pw-expired-badge">Ended</span>'
            : poll.expiresAt
              ? `<span>· Ends ${_fmtDate(poll.expiresAt)}</span>`
              : ''}
        </div>
        ${hasVoted && !expired
          ? `<button class="pw-change-vote-btn"
               data-doc="${_esc(docId)}"
               data-col="${_esc(collectionName)}">
               Change vote
             </button>`
          : ''}
      </div>
    </div>`;

  // Bind vote clicks
  if (!showResults) {
    container.querySelectorAll('.pw-opt-row-widget').forEach(row => {
      row.addEventListener('click', () => {
        _castVote(row.dataset.doc, row.dataset.col, parseInt(row.dataset.idx), poll);
      });
    });
  }

  // Bind change-vote
  container.querySelector('.pw-change-vote-btn')?.addEventListener('click', e => {
    _clearVote(e.target.dataset.doc, e.target.dataset.col);
  });
}

/* ══════════════════════════════════════════════════════════════
   CAST VOTE
══════════════════════════════════════════════════════════════ */
async function _castVote(docId, collectionName, optIdx, poll) {
  if (!currentUser) { showToast('Login to vote'); return; }

  const ref = collectionName.includes('/')
    ? _docFromPath(collectionName, docId)
    : doc(db, collectionName, docId);
  if (!ref) return;

  try {
    // Re-fetch to get latest votes
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const freshPoll = snap.data().poll;
    if (!freshPoll) return;

    const freshVotes = freshPoll.votes || {};
    const myVote = freshVotes[currentUser.uid];

    // Check expired
    if (freshPoll.expiresAt) {
      const exp = freshPoll.expiresAt.toDate?.() || new Date(freshPoll.expiresAt);
      if (exp < new Date()) { showToast('This poll has ended'); return; }
    }

    let newVote;
    if (freshPoll.allowMultiple) {
      // Toggle this option in the array
      const arr = Array.isArray(myVote) ? [...myVote] : (myVote !== undefined ? [myVote] : []);
      if (arr.includes(optIdx)) {
        newVote = arr.filter(v => v !== optIdx);
        if (newVote.length === 0) newVote = null;
      } else {
        newVote = [...arr, optIdx];
      }
    } else {
      newVote = optIdx;
    }

    const update = {};
    if (newVote === null) {
      // Remove vote — use FieldValue.delete() equivalent
      const { deleteField } = await import('https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js');
      update[`poll.votes.${currentUser.uid}`] = deleteField();
    } else {
      update[`poll.votes.${currentUser.uid}`] = newVote;
    }

    await updateDoc(ref, update);
    showToast('Vote recorded! 📊');
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   CLEAR VOTE (change vote)
══════════════════════════════════════════════════════════════ */
async function _clearVote(docId, collectionName) {
  if (!currentUser) return;
  const ref = collectionName.includes('/')
    ? _docFromPath(collectionName, docId)
    : doc(db, collectionName, docId);
  if (!ref) return;
  try {
    const { deleteField } = await import('https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js');
    await updateDoc(ref, { [`poll.votes.${currentUser.uid}`]: deleteField() });
    showToast('Vote cleared — pick again');
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   window.renderPollWidget — called by chat.js for message bubbles
   Returns HTML string AND sets up a live listener on the element
══════════════════════════════════════════════════════════════ */
window.renderPollWidget = function(pollData, docId, collectionName) {
  if (!pollData) return '';
  // Return a placeholder; after insertion we'll upgrade it to a live widget
  const placeholderId = 'pw-ph-' + docId;
  requestAnimationFrame(() => {
    const ph = document.getElementById(placeholderId);
    if (!ph) return;
    const widget = _createWidget(pollData, docId, collectionName);
    ph.replaceWith(widget);
  });
  return `<div id="${placeholderId}" class="pw-widget-loading">
    <div class="pw-mini-spinner"></div> Loading poll…
  </div>`;
};

/* ══════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════ */
function _esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _fmtDate(ts) {
  try {
    const d = ts.toDate?.() || new Date(ts);
    return d.toLocaleDateString('en-IN', { day:'numeric', month:'short' });
  } catch { return ''; }
}
