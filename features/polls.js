/**
 * features/polls.js — FINAL REWRITE
 * WhatsApp-style polls for Community Posts + World Chat
 *
 * ARCHITECTURE (why previous versions failed):
 * ─────────────────────────────────────────────────────────────
 *  OLD APPROACH (broken):
 *   posts.js calls `window.renderPollWidget()` inside _buildCard.
 *   But posts.js is an ES module that may run BEFORE polls.js
 *   finishes loading → window.renderPollWidget is undefined → nothing renders.
 *
 *  NEW APPROACH (reliable):
 *   1. polls.js sets window.renderPollWidget SYNCHRONOUSLY at module
 *      top level (before any await/auth), so it's always available.
 *   2. MutationObservers are also started immediately at module level
 *      (not gated on auth), so they catch every DOM change.
 *   3. posts.js just stamps data-doc / data-col on a host div.
 *      polls.js observer upgrades it when it appears in the DOM.
 *   4. chat.js calls window.renderPollWidget (returning a placeholder
 *      string), observer upgrades that placeholder too.
 *
 * DATA MODEL (Firestore):
 *   groupMessages / posts doc → .poll field:
 *   {
 *     question:      string,
 *     options:       [{ text: string }, ...],
 *     votes:         { [uid]: number | number[] },
 *     allowMultiple: boolean,
 *     expiresAt:     Timestamp | null,
 *     createdBy:     uid,
 *   }
 * ─────────────────────────────────────────────────────────────
 */

import { db } from '../firebase-config.js';
import { onAuthChange, currentUser, currentProfile, showToast } from '../auth.js';
import {
  collection, addDoc, doc, updateDoc, onSnapshot,
  serverTimestamp, getDoc, getDocs, deleteField
} from 'https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js';

/* ══════════════════════════════════════════════════════════════
   1.  STYLES  (injected once, immediately)
══════════════════════════════════════════════════════════════ */
(function _css() {
  if (document.getElementById('wap-poll-css')) return;
  const el = document.createElement('style');
  el.id = 'wap-poll-css';
  el.textContent = /* css */`

/* ─── WhatsApp poll card ─────────────────────────────────── */
.wap-poll{
  background:#1b3d2f;
  border-radius:13px;
  overflow:hidden;
  width:100%;
  max-width:310px;
  font-family:var(--font-body,'Jost',sans-serif);
  box-shadow:0 2px 14px rgba(0,0,0,.28);
  margin:.2rem 0;
  -webkit-user-select:none;user-select:none;
}
.mine .wap-poll{background:#0e3326;}

.wap-poll-top{padding:.82rem 1rem .55rem;}
.wap-poll-q{
  font-size:.94rem;font-weight:600;
  color:#e8f5ee;line-height:1.35;margin-bottom:.32rem;
}
.wap-poll-sub{
  display:flex;align-items:center;gap:.3rem;
  font-size:.7rem;color:#7db89a;
}

/* options */
.wap-poll-opts{padding:.05rem 0 .1rem;}
.wap-poll-opt{
  display:flex;flex-direction:column;
  padding:.48rem 1rem .38rem;
  cursor:pointer;border:none;
  background:transparent;width:100%;text-align:left;
  transition:background .14s;
}
.wap-poll-opt:hover:not([disabled]){background:rgba(255,255,255,.055);}
.wap-poll-opt[disabled]{cursor:default;}

.wap-poll-opt-row{
  display:flex;align-items:center;gap:.6rem;margin-bottom:.28rem;
}
.wap-poll-radio{
  width:20px;height:20px;border-radius:50%;
  border:2px solid #4caf50;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;
  transition:background .2s,border-color .2s;
}
.wap-poll-opt.sel .wap-poll-radio{background:#4caf50;}
.wap-poll-dot{
  width:8px;height:8px;border-radius:50%;
  background:#fff;opacity:0;transition:opacity .2s;
}
.wap-poll-opt.sel .wap-poll-dot{opacity:1;}
.wap-poll-txt{flex:1;font-size:.87rem;color:#e8f5ee;line-height:1.3;}
.wap-poll-cnt{
  font-size:.8rem;color:#7db89a;min-width:16px;text-align:right;flex-shrink:0;
}

/* bar */
.wap-poll-track{
  height:4px;background:rgba(255,255,255,.1);
  border-radius:2px;overflow:hidden;
}
.wap-poll-fill{
  height:100%;border-radius:2px;background:#4caf50;
  transition:width .5s cubic-bezier(.16,1,.3,1);
}
.wap-poll-opt.sel .wap-poll-fill{
  background:linear-gradient(90deg,#4caf50,#66bb6a);
}

/* meta row */
.wap-poll-meta{
  display:flex;align-items:center;justify-content:flex-end;
  padding:.28rem .9rem .52rem;
  font-size:.64rem;color:#7db89a;gap:.4rem;
}
.wap-poll-ended{
  margin-right:auto;font-size:.59rem;font-weight:700;
  letter-spacing:.07em;text-transform:uppercase;
  color:#e05c6a;background:rgba(224,92,106,.15);
  border:1px solid rgba(224,92,106,.3);
  border-radius:50px;padding:.1rem .45rem;
}
.wap-change-vote{
  background:none;border:none;cursor:pointer;
  color:#7db89a;font-size:.64rem;
  font-family:var(--font-body,'Jost',sans-serif);
  padding:.12rem .4rem;border-radius:5px;margin-right:auto;
  transition:color .15s;
}
.wap-change-vote:hover{color:#e8f5ee;}

/* view votes */
.wap-poll-divider{height:1px;background:rgba(255,255,255,.09);margin:0 .6rem;}
.wap-view-btn{
  display:block;width:100%;padding:.68rem 1rem;
  background:transparent;border:none;cursor:pointer;
  font-family:var(--font-body,'Jost',sans-serif);
  font-size:.83rem;color:#7db89a;text-align:center;
  transition:background .14s,color .14s;
}
.wap-view-btn:hover{background:rgba(255,255,255,.05);color:#e8f5ee;}

/* ─── Toolbar buttons ────────────────────────────────────── */
.wap-post-poll-btn{
  display:inline-flex;align-items:center;gap:.3rem;
  padding:.3rem .68rem;border-radius:9px;
  border:1px solid rgba(167,139,202,.38);
  background:rgba(167,139,202,.08);
  color:var(--clr-accent,#a78bca);
  font-family:var(--font-body,'Jost',sans-serif);
  font-size:.73rem;font-weight:500;cursor:pointer;
  transition:all .2s;white-space:nowrap;
}
.wap-post-poll-btn:hover{background:var(--clr-accent,#a78bca);color:#fff;border-color:var(--clr-accent,#a78bca);}
.wap-post-poll-btn.on{background:rgba(72,187,120,.12);border-color:rgba(72,187,120,.4);color:#48bb78;}
.wap-post-poll-btn.on:hover{background:#48bb78;color:#fff;border-color:#48bb78;}

.wap-chat-poll-btn{
  display:flex;align-items:center;justify-content:center;
  width:33px;height:33px;border-radius:8px;flex-shrink:0;
  border:1px solid var(--clr-border,rgba(200,190,210,.38));
  background:transparent;color:var(--clr-muted,#7a7590);
  font-size:.9rem;cursor:pointer;transition:all .2s;
}
.wap-chat-poll-btn:hover{background:var(--clr-accent,#a78bca);color:#fff;border-color:var(--clr-accent,#a78bca);}

/* ─── Creation bottom-sheet ──────────────────────────────── */
.wap-overlay{
  position:fixed;inset:0;z-index:900;
  background:rgba(10,8,20,.54);
  backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
  display:flex;align-items:flex-end;justify-content:center;
  animation:wap-fi .2s ease both;
}
@keyframes wap-fi{from{opacity:0}to{opacity:1}}

.wap-sheet{
  width:min(500px,100vw);max-height:94vh;
  display:flex;flex-direction:column;
  background:var(--clr-modal-bg,rgba(252,250,255,.98));
  border-radius:24px 24px 0 0;
  border:1px solid var(--clr-modal-border,rgba(167,139,202,.2));
  border-bottom:none;
  box-shadow:0 -8px 50px rgba(100,80,140,.2);
  overflow:hidden;
  animation:wap-su .35s cubic-bezier(.16,1,.3,1) both;
}
@keyframes wap-su{from{transform:translateY(105%)}to{transform:none}}

.wap-handle{
  width:36px;height:4px;border-radius:2px;
  background:var(--clr-border2,rgba(167,139,202,.35));
  margin:.68rem auto .1rem;flex-shrink:0;
}
.wap-sh-head{
  display:flex;align-items:center;justify-content:space-between;
  padding:.72rem 1.35rem .62rem;
  border-bottom:1px solid var(--clr-border,rgba(200,190,210,.28));
  flex-shrink:0;
}
.wap-sh-title{
  font-family:var(--font-display,'Cormorant Garamond',serif);
  font-size:1.18rem;font-weight:600;
  color:var(--clr-text,#2e2c3a);
  display:flex;align-items:center;gap:.45rem;
}
.wap-sh-close{
  width:29px;height:29px;border-radius:50%;
  border:1px solid var(--clr-border);background:transparent;
  color:var(--clr-muted);font-size:.76rem;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:all .2s;
}
.wap-sh-close:hover{background:var(--clr-danger,#e05c6a);color:#fff;border-color:var(--clr-danger);transform:rotate(90deg);}

.wap-sh-body{flex:1;overflow-y:auto;padding:1rem 1.35rem 1.1rem;scrollbar-width:thin;}

.wap-field-lbl{
  display:block;font-size:.63rem;font-weight:600;
  letter-spacing:.1em;text-transform:uppercase;
  color:var(--clr-muted,#7a7590);margin-bottom:.38rem;
}
.wap-q-input{
  width:100%;padding:.73rem .92rem;
  background:var(--clr-input-bg,rgba(255,255,255,.75));
  border:1.5px solid var(--clr-border);border-radius:12px;
  color:var(--clr-text);
  font-family:var(--font-body,'Jost',sans-serif);
  font-size:.9rem;outline:none;resize:none;line-height:1.5;
  transition:border-color .2s,box-shadow .2s;margin-bottom:.95rem;
}
.wap-q-input:focus{border-color:var(--clr-accent,#a78bca);box-shadow:0 0 0 3px rgba(167,139,202,.1);}
.wap-q-input::placeholder{color:var(--clr-muted);}

.wap-opts-list{display:flex;flex-direction:column;gap:.42rem;margin-bottom:.55rem;}
.wap-opt-row{display:flex;align-items:center;gap:.42rem;animation:wap-oi .22s cubic-bezier(.16,1,.3,1) both;}
@keyframes wap-oi{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:none}}
.wap-opt-num{
  width:21px;height:21px;border-radius:50%;flex-shrink:0;
  border:1.5px solid var(--clr-border2,rgba(167,139,202,.38));
  display:flex;align-items:center;justify-content:center;
  font-size:.63rem;font-weight:700;color:var(--clr-muted);
}
.wap-opt-inp{
  flex:1;padding:.58rem .83rem;
  background:var(--clr-input-bg);border:1.5px solid var(--clr-border);
  border-radius:10px;color:var(--clr-text);
  font-family:var(--font-body,'Jost',sans-serif);font-size:.83rem;
  outline:none;transition:border-color .2s,box-shadow .2s;
}
.wap-opt-inp:focus{border-color:var(--clr-accent,#a78bca);box-shadow:0 0 0 3px rgba(167,139,202,.1);}
.wap-opt-inp::placeholder{color:var(--clr-muted);}
.wap-opt-del{
  width:27px;height:27px;border-radius:50%;flex-shrink:0;
  border:1px solid var(--clr-border);background:transparent;
  color:var(--clr-muted);font-size:.7rem;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:all .18s;
}
.wap-opt-del:hover{background:var(--clr-danger,#e05c6a);color:#fff;border-color:var(--clr-danger);}

.wap-add-opt{
  width:100%;padding:.48rem;background:transparent;
  border:1.5px dashed rgba(167,139,202,.38);border-radius:9px;
  color:var(--clr-accent,#a78bca);
  font-family:var(--font-body,'Jost',sans-serif);
  font-size:.77rem;font-weight:500;cursor:pointer;
  display:flex;align-items:center;justify-content:center;gap:.32rem;
  transition:all .2s;
}
.wap-add-opt:hover{background:rgba(167,139,202,.07);border-style:solid;}

.wap-settings{display:flex;flex-direction:column;gap:.46rem;margin-top:.88rem;}
.wap-setting{
  display:flex;align-items:center;justify-content:space-between;
  padding:.58rem .83rem;
  background:var(--clr-surface,rgba(255,255,255,.68));
  border:1px solid var(--clr-border);border-radius:11px;
}
.wap-set-info{display:flex;flex-direction:column;gap:.1rem;}
.wap-set-name{font-size:.81rem;color:var(--clr-text);font-weight:500;}
.wap-set-hint{font-size:.67rem;color:var(--clr-muted);}

.wap-toggle{position:relative;width:36px;height:21px;flex-shrink:0;}
.wap-toggle input{opacity:0;width:0;height:0;position:absolute;}
.wap-tog-track{
  position:absolute;inset:0;border-radius:10px;
  background:var(--clr-border);cursor:pointer;transition:background .25s;
}
.wap-tog-track::after{
  content:'';position:absolute;left:3px;top:3px;
  width:15px;height:15px;border-radius:50%;background:#fff;
  box-shadow:0 1px 4px rgba(0,0,0,.2);
  transition:transform .25s cubic-bezier(.34,1.56,.64,1);
}
.wap-toggle input:checked+.wap-tog-track{background:var(--clr-accent,#a78bca);}
.wap-toggle input:checked+.wap-tog-track::after{transform:translateX(15px);}

.wap-dur-sel{
  padding:.28rem .55rem;border-radius:7px;
  border:1px solid var(--clr-border);
  background:var(--clr-input-bg);color:var(--clr-text);
  font-family:var(--font-body,'Jost',sans-serif);font-size:.77rem;
  outline:none;cursor:pointer;
}

.wap-sh-foot{
  padding:.82rem 1.35rem .95rem;
  border-top:1px solid var(--clr-border,rgba(200,190,210,.25));
  display:flex;gap:.52rem;flex-shrink:0;
}
.wap-btn-primary{
  flex:1;padding:.76rem 1rem;
  background:linear-gradient(135deg,var(--clr-accent,#a78bca),var(--clr-accent2,#f0a8b0));
  color:#fff;border:none;border-radius:12px;
  font-family:var(--font-body,'Jost',sans-serif);
  font-size:.87rem;font-weight:500;cursor:pointer;
  letter-spacing:.03em;transition:opacity .2s,transform .15s;
}
.wap-btn-primary:hover{opacity:.9;transform:translateY(-1px);}
.wap-btn-primary:active{transform:scale(.97);}
.wap-btn-primary:disabled{opacity:.42;pointer-events:none;}
.wap-btn-cancel{
  padding:.76rem 1rem;border-radius:12px;
  border:1px solid var(--clr-border);background:transparent;
  color:var(--clr-muted);
  font-family:var(--font-body,'Jost',sans-serif);font-size:.87rem;
  cursor:pointer;transition:all .2s;
}
.wap-btn-cancel:hover{background:var(--clr-surface2);color:var(--clr-text);}

/* ─── View-votes sheet ───────────────────────────────────── */
.wvt-overlay{
  position:fixed;inset:0;z-index:950;
  background:rgba(10,8,20,.58);
  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  display:flex;align-items:flex-end;justify-content:center;
  animation:wap-fi .2s ease both;
}
.wvt-sheet{
  width:min(480px,100vw);max-height:88vh;
  display:flex;flex-direction:column;
  background:var(--clr-modal-bg,rgba(252,250,255,.98));
  border-radius:24px 24px 0 0;
  border:1px solid var(--clr-modal-border,rgba(167,139,202,.2));
  border-bottom:none;overflow:hidden;
  box-shadow:0 -8px 50px rgba(100,80,140,.2);
  animation:wap-su .35s cubic-bezier(.16,1,.3,1) both;
}
.wvt-head{
  display:flex;align-items:center;justify-content:space-between;
  padding:.82rem 1.35rem .7rem;
  border-bottom:1px solid var(--clr-border);flex-shrink:0;
}
.wvt-title{
  font-family:var(--font-display,'Cormorant Garamond',serif);
  font-size:1.08rem;font-weight:600;color:var(--clr-text);
}
.wvt-close{
  width:27px;height:27px;border-radius:50%;
  border:1px solid var(--clr-border);background:transparent;
  color:var(--clr-muted);font-size:.72rem;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:all .2s;
}
.wvt-close:hover{background:var(--clr-danger);color:#fff;border-color:var(--clr-danger);transform:rotate(90deg);}
.wvt-tabs{
  display:flex;border-bottom:1px solid var(--clr-border);
  flex-shrink:0;overflow-x:auto;scrollbar-width:none;
}
.wvt-tabs::-webkit-scrollbar{display:none;}
.wvt-tab{
  padding:.58rem .95rem;background:transparent;border:none;
  border-bottom:2px solid transparent;margin-bottom:-1px;
  font-family:var(--font-body,'Jost',sans-serif);font-size:.72rem;
  font-weight:500;color:var(--clr-muted);cursor:pointer;
  white-space:nowrap;transition:color .2s,border-color .2s;
  display:flex;align-items:center;gap:.28rem;
}
.wvt-tab.active{color:var(--clr-accent,#a78bca);border-bottom-color:var(--clr-accent,#a78bca);}
.wvt-badge{
  font-size:.6rem;font-weight:700;padding:.08rem .35rem;
  border-radius:50px;background:rgba(167,139,202,.15);color:var(--clr-accent);
}
.wvt-tab.active .wvt-badge{background:var(--clr-accent);color:#fff;}
.wvt-body{flex:1;overflow-y:auto;scrollbar-width:thin;}
.wvt-row{
  display:flex;align-items:center;gap:.65rem;
  padding:.68rem 1.35rem;
  border-bottom:1px solid var(--clr-border,rgba(200,190,210,.14));
  animation:wap-oi .22s cubic-bezier(.16,1,.3,1) both;
}
.wvt-av{
  width:34px;height:34px;border-radius:50%;flex-shrink:0;
  background:linear-gradient(135deg,var(--clr-accent,#a78bca),var(--clr-accent2,#f0a8b0));
  display:flex;align-items:center;justify-content:center;
  font-family:var(--font-display,'Cormorant Garamond',serif);
  font-size:.92rem;font-weight:600;color:#fff;overflow:hidden;
}
.wvt-av img{width:100%;height:100%;object-fit:cover;border-radius:50%;}
.wvt-name{font-size:.83rem;color:var(--clr-text);font-weight:500;}
.wvt-role{font-size:.67rem;color:var(--clr-muted);}
.wvt-empty{
  display:flex;flex-direction:column;align-items:center;
  justify-content:center;padding:3rem 1.5rem;
  color:var(--clr-muted);font-size:.8rem;gap:.55rem;
}
.wvt-empty-ico{font-size:1.8rem;opacity:.45;}

/* dark */
[data-theme="dark"] .wap-sheet,
[data-theme="dark"] .wvt-sheet{background:rgba(15,12,28,.98);}
`;
  document.head.appendChild(el);
})();

/* ══════════════════════════════════════════════════════════════
   2.  STATE
══════════════════════════════════════════════════════════════ */
const _liveUnsubs = new Map();    // docId → Firestore unsubscribe
let   _pendingPoll = null;        // poll data attached to next post

/* ══════════════════════════════════════════════════════════════
   3.  window._pendingPoll  (posts.js reads this)
══════════════════════════════════════════════════════════════ */
Object.defineProperty(window, '_pendingPoll', {
  get()  { return _pendingPoll;  },
  set(v) { _pendingPoll = v; },
  configurable: true,
});

/* ══════════════════════════════════════════════════════════════
   4.  window.renderPollWidget  ← called by chat.js
   Returns an HTML string placeholder; MutationObserver upgrades it.
   Set SYNCHRONOUSLY here so it's always available regardless of
   when this module finishes executing relative to chat.js / posts.js.
══════════════════════════════════════════════════════════════ */
window.renderPollWidget = function(pollData, docId, colName) {
  if (!pollData || !docId) return '';
  // Return a zero-state snapshot plus the upgrade hook attributes
  return `<div class="wap-poll-ph" data-doc="${_esc(docId)}" data-col="${_esc(colName)}">
    ${_staticPollHTML(pollData, docId, colName)}
  </div>`;
};

/* ══════════════════════════════════════════════════════════════
   5.  MutationObservers  — started IMMEDIATELY (no auth gate)
   Watches for two selector types:
     .wap-poll-ph[data-doc]   → chat bubble placeholders
     .wap-post-poll[data-doc] → post feed host divs
══════════════════════════════════════════════════════════════ */
function _startObserver(rootId) {
  // Try now, retry when element appears
  const tryAttach = () => {
    const root = document.getElementById(rootId);
    if (!root) { setTimeout(tryAttach, 300); return; }
    const obs = new MutationObserver(() => _upgradeRoot(root));
    obs.observe(root, { childList: true, subtree: true });
    _upgradeRoot(root); // upgrade anything already in DOM
  };
  tryAttach();
}

['groupMessages', 'postsFeed'].forEach(_startObserver);

function _upgradeRoot(root) {
  root.querySelectorAll('.wap-poll-ph[data-doc]').forEach(ph => {
    const docId  = ph.dataset.doc;
    const colName = ph.dataset.col;
    if (!docId || !colName) return;
    // Remove attributes immediately to prevent double-processing
    delete ph.dataset.doc;
    delete ph.dataset.col;
    _attachLive(ph, docId, colName);
  });
  root.querySelectorAll('.wap-post-poll[data-doc]').forEach(host => {
    const docId  = host.dataset.doc;
    const colName = host.dataset.col;
    if (!docId || !colName) return;
    delete host.dataset.doc;
    delete host.dataset.col;
    _attachLive(host, docId, colName);
  });
}

/* ══════════════════════════════════════════════════════════════
   6.  LIVE ATTACHMENT — attaches onSnapshot to a container el
══════════════════════════════════════════════════════════════ */
function _attachLive(container, docId, colName) {
  _liveUnsubs.get(docId)?.();

  const ref = _makeRef(docId, colName);
  if (!ref) return;

  const unsub = onSnapshot(ref, snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    const poll = data.poll || data.pollData;
    if (!poll) return;
    const time = _extractTime(data);
    container.innerHTML = _pollHTML(poll, docId, colName, time);
    _bindEvents(container, docId, colName);
  }, err => console.warn('[polls] snapshot:', err));

  _liveUnsubs.set(docId, unsub);
}

/* ══════════════════════════════════════════════════════════════
   7.  RENDER — full WhatsApp poll HTML
══════════════════════════════════════════════════════════════ */
function _staticPollHTML(poll, docId, colName) {
  return _pollHTML(poll, docId, colName, '');
}

function _pollHTML(poll, docId, colName, time) {
  const uid      = currentUser?.uid;
  const votes    = poll.votes || {};
  const myVote   = votes[uid];
  const hasVoted = myVote !== undefined && myVote !== null
                   && !(Array.isArray(myVote) && !myVote.length);
  const expired  = poll.expiresAt
    ? new Date(poll.expiresAt?.toDate?.() || poll.expiresAt) < new Date()
    : false;
  const show     = hasVoted || expired;

  const totalVoters = Object.keys(votes).length;
  const tallies = (poll.options || []).map((_, i) =>
    Object.values(votes).filter(v =>
      Array.isArray(v) ? v.includes(i) : v === i
    ).length
  );

  const optsHTML = (poll.options || []).map((opt, i) => {
    const count  = tallies[i];
    const pct    = totalVoters > 0 ? Math.round(count / totalVoters * 100) : 0;
    const isMyOpt = Array.isArray(myVote) ? myVote.includes(i) : myVote === i;
    const cls = 'wap-poll-opt' + (show ? ' wp-voted' : '') + (isMyOpt ? ' sel' : '');
    return `<button class="${cls}" data-idx="${i}" ${show || expired ? 'disabled' : ''}>
      <div class="wap-poll-opt-row">
        <div class="wap-poll-radio"><div class="wap-poll-dot"></div></div>
        <span class="wap-poll-txt">${_esc(opt.text)}</span>
        ${show ? `<span class="wap-poll-cnt">${count}</span>` : ''}
      </div>
      <div class="wap-poll-track">
        <div class="wap-poll-fill" style="width:${show ? pct : 0}%"></div>
      </div>
    </button>`;
  }).join('');

  const subIcon = poll.allowMultiple
    ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#7db89a" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/><polyline points="20 12 9 23 4 18"/></svg> Select one or more`
    : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#7db89a" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg> Select one`;

  return `<div class="wap-poll">
    <div class="wap-poll-top">
      <div class="wap-poll-q">${_esc(poll.question)}</div>
      <div class="wap-poll-sub">${subIcon}</div>
    </div>
    <div class="wap-poll-opts">${optsHTML}</div>
    <div class="wap-poll-meta">
      ${expired ? '<span class="wap-poll-ended">Poll ended</span>' : ''}
      ${hasVoted && !expired
        ? `<button class="wap-change-vote" data-doc="${_esc(docId)}" data-col="${_esc(colName)}">Change vote</button>`
        : ''}
      ${totalVoters} vote${totalVoters !== 1 ? 's' : ''}
      ${time ? `· ${time}` : ''}
      ${poll.expiresAt && !expired ? `· ends ${_fmtDate(poll.expiresAt)}` : ''}
    </div>
    <div class="wap-poll-divider"></div>
    <button class="wap-view-btn" data-doc="${_esc(docId)}" data-col="${_esc(colName)}">View votes</button>
  </div>`;
}

/* ══════════════════════════════════════════════════════════════
   8.  BIND EVENTS on rendered poll
══════════════════════════════════════════════════════════════ */
function _bindEvents(container, docId, colName) {
  container.querySelectorAll('.wap-poll-opt:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!currentUser) { showToast('Login to vote'); return; }
      _vote(docId, colName, parseInt(btn.dataset.idx));
    });
  });
  container.querySelectorAll('.wap-change-vote').forEach(btn => {
    btn.addEventListener('click', () => _clearVote(docId, colName));
  });
  container.querySelectorAll('.wap-view-btn').forEach(btn => {
    btn.addEventListener('click', () => _openViewVotes(docId, colName));
  });
}

/* ══════════════════════════════════════════════════════════════
   9.  VOTE + CLEAR VOTE
══════════════════════════════════════════════════════════════ */
async function _vote(docId, colName, optIdx) {
  const ref = _makeRef(docId, colName);
  if (!ref || !currentUser) return;
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const poll = snap.data().poll;
    if (!poll) return;
    if (poll.expiresAt) {
      const exp = poll.expiresAt.toDate?.() || new Date(poll.expiresAt);
      if (exp < new Date()) { showToast('This poll has ended'); return; }
    }
    const cur = (poll.votes || {})[currentUser.uid];
    let newVal;
    if (poll.allowMultiple) {
      const arr = Array.isArray(cur) ? [...cur] : cur !== undefined ? [cur] : [];
      newVal = arr.includes(optIdx) ? arr.filter(v => v !== optIdx) : [...arr, optIdx];
      if (!newVal.length) newVal = deleteField();
    } else {
      newVal = optIdx;
    }
    await updateDoc(ref, { [`poll.votes.${currentUser.uid}`]: newVal });
  } catch(e) { showToast('Vote failed'); console.error(e); }
}

async function _clearVote(docId, colName) {
  const ref = _makeRef(docId, colName);
  if (!ref || !currentUser) return;
  try {
    await updateDoc(ref, { [`poll.votes.${currentUser.uid}`]: deleteField() });
    showToast('Vote cleared — pick again');
  } catch(e) { showToast('Error: ' + e.message); }
}

/* ══════════════════════════════════════════════════════════════
   10.  VIEW VOTES SHEET — live, shows voted + not voted
══════════════════════════════════════════════════════════════ */

// Extra CSS for the enhanced voter sheet
(function _voteSheetCSS() {
  if (document.getElementById('wvt-extra-css')) return;
  const s = document.createElement('style');
  s.id = 'wvt-extra-css';
  s.textContent = `
  /* Search bar inside view-votes sheet */
  .wvt-search-wrap {
    padding: .55rem 1.2rem .3rem;
    flex-shrink: 0;
  }
  .wvt-search {
    width: 100%;
    padding: .48rem .85rem .48rem 2.1rem;
    background: var(--clr-input-bg, rgba(255,255,255,.75));
    border: 1.5px solid var(--clr-border, rgba(200,190,210,.38));
    border-radius: 50px;
    font-family: var(--font-body,'Jost',sans-serif);
    font-size: .8rem;
    color: var(--clr-text, #2e2c3a);
    outline: none;
    transition: border-color .2s, box-shadow .2s;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%237a7590' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: .7rem center;
  }
  .wvt-search:focus { border-color: var(--clr-accent,#a78bca); box-shadow: 0 0 0 3px rgba(167,139,202,.1); }
  .wvt-search::placeholder { color: var(--clr-muted,#7a7590); }

  /* Summary bar */
  .wvt-summary {
    display: flex;
    gap: .6rem;
    padding: .45rem 1.2rem .55rem;
    flex-shrink: 0;
    border-bottom: 1px solid var(--clr-border, rgba(200,190,210,.2));
  }
  .wvt-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
    padding: .42rem .5rem;
    border-radius: 10px;
    background: var(--clr-surface, rgba(255,255,255,.68));
    border: 1px solid var(--clr-border);
    gap: .1rem;
  }
  .wvt-stat-num {
    font-family: var(--font-display,'Cormorant Garamond',serif);
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--clr-text, #2e2c3a);
    line-height: 1;
  }
  .wvt-stat-num.voted   { color: #4caf50; }
  .wvt-stat-num.pending { color: var(--clr-accent, #a78bca); }
  .wvt-stat-lbl {
    font-size: .62rem;
    font-weight: 500;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--clr-muted, #7a7590);
  }

  /* Voter row — enhanced */
  .wvt-row {
    display: flex;
    align-items: center;
    gap: .65rem;
    padding: .65rem 1.2rem;
    border-bottom: 1px solid var(--clr-border, rgba(200,190,210,.14));
    animation: wap-oi .24s cubic-bezier(.16,1,.3,1) both;
    transition: background .15s;
  }
  .wvt-row:hover { background: rgba(167,139,202,.04); }

  .wvt-av {
    width: 38px; height: 38px;
    border-radius: 50%; flex-shrink: 0;
    background: linear-gradient(135deg,var(--clr-accent,#a78bca),var(--clr-accent2,#f0a8b0));
    display: flex; align-items: center; justify-content: center;
    font-family: var(--font-display,'Cormorant Garamond',serif);
    font-size: 1rem; font-weight: 600; color: #fff;
    overflow: hidden; position: relative;
  }
  .wvt-av img { width:100%; height:100%; object-fit:cover; border-radius:50%; }

  /* Status dot on avatar */
  .wvt-av-dot {
    position: absolute; bottom: 0; right: 0;
    width: 11px; height: 11px; border-radius: 50%;
    border: 2px solid var(--clr-modal-bg, #fff);
  }
  .wvt-av-dot.voted   { background: #4caf50; }
  .wvt-av-dot.pending { background: var(--clr-muted, #7a7590); }

  .wvt-info { flex: 1; min-width: 0; }
  .wvt-name {
    font-size: .84rem; color: var(--clr-text,#2e2c3a);
    font-weight: 500; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .wvt-role {
    font-size: .67rem; color: var(--clr-muted,#7a7590); margin-top: .05rem;
  }

  /* Vote choice chips */
  .wvt-choices {
    display: flex; flex-wrap: wrap; gap: .25rem;
    justify-content: flex-end; flex-shrink: 0; max-width: 130px;
  }
  .wvt-choice-chip {
    font-size: .62rem;
    background: rgba(76,175,80,.15);
    color: #4caf50;
    border: 1px solid rgba(76,175,80,.3);
    border-radius: 50px;
    padding: .1rem .45rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100px;
  }
  .wvt-pending-chip {
    font-size: .62rem;
    background: rgba(167,139,202,.1);
    color: var(--clr-muted, #7a7590);
    border: 1px solid rgba(167,139,202,.2);
    border-radius: 50px;
    padding: .1rem .45rem;
  }

  /* Live pulse indicator in header */
  .wvt-live-dot {
    display: inline-flex;
    align-items: center;
    gap: .3rem;
    font-size: .65rem;
    color: #4caf50;
    font-family: var(--font-body,'Jost',sans-serif);
    margin-left: auto;
  }
  .wvt-live-dot::before {
    content: '';
    display: inline-block;
    width: 7px; height: 7px;
    border-radius: 50%;
    background: #4caf50;
    animation: wvt-pulse 2s ease-in-out infinite;
  }
  @keyframes wvt-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: .5; transform: scale(1.3); }
  }

  /* Section divider inside list */
  .wvt-section-lbl {
    padding: .5rem 1.2rem .2rem;
    font-size: .62rem;
    font-weight: 600;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--clr-muted, #7a7590);
    position: sticky; top: 0; z-index: 1;
    background: var(--clr-modal-bg, rgba(252,250,255,.98));
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    display: flex; align-items: center; gap: .5rem;
  }
  .wvt-section-lbl::after {
    content: '';
    flex: 1; height: 1px;
    background: var(--clr-border, rgba(200,190,210,.3));
  }

  [data-theme="dark"] .wvt-section-lbl { background: rgba(15,12,28,.98); }
  [data-theme="dark"] .wvt-search { background-color: rgba(255,255,255,.07); }
  `;
  document.head.appendChild(s);
})();

async function _openViewVotes(docId, colName) {
  const ref = _makeRef(docId, colName);
  if (!ref) return;

  const ov = document.createElement('div');
  ov.className = 'wvt-overlay';
  ov.innerHTML = `
    <div class="wvt-sheet">
      <div class="wvt-head">
        <div class="wvt-title">📊 Poll Results</div>
        <span class="wvt-live-dot">Live</span>
        <button class="wvt-close">✕</button>
      </div>
      <div class="wvt-summary" id="wvtSummary">
        <div class="wvt-stat"><div class="wvt-stat-num" id="wvtTotalNum">–</div><div class="wvt-stat-lbl">Total voters</div></div>
        <div class="wvt-stat"><div class="wvt-stat-num voted" id="wvtVotedNum">–</div><div class="wvt-stat-lbl">Voted</div></div>
        <div class="wvt-stat"><div class="wvt-stat-num pending" id="wvtPendingNum">–</div><div class="wvt-stat-lbl">Not voted</div></div>
      </div>
      <div class="wvt-tabs" id="wvtTabs"></div>
      <div class="wvt-search-wrap">
        <input class="wvt-search" id="wvtSearch" type="text" placeholder="Search by name…">
      </div>
      <div class="wvt-body" id="wvtBody">
        <div class="wvt-empty"><div class="wvt-empty-ico">⏳</div>Loading…</div>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const close = () => {
    pollUnsub?.();
    ov.querySelector('.wvt-sheet').style.transform = 'translateY(100%)';
    setTimeout(() => ov.remove(), 340);
  };
  ov.querySelector('.wvt-close').addEventListener('click', close);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  document.addEventListener('keydown', function kh(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', kh); }});

  // Load all users from Firestore once
  let allProfiles = {};
  try {
    const usersSnap = await getDocs(collection(db, 'users'));
    usersSnap.forEach(d => { allProfiles[d.id] = d.data(); });
  } catch(e) {
    console.warn('[polls] could not load users:', e);
  }

  let activeTab = 0;
  let searchQ   = '';
  let pollData  = null;
  let pollUnsub = null;

  // Search input
  document.getElementById('wvtSearch').addEventListener('input', e => {
    searchQ = e.target.value.toLowerCase().trim();
    if (pollData) _render(pollData);
  });

  // Live subscription to the poll document
  pollUnsub = onSnapshot(ref, snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    pollData = data.poll || data.pollData;
    if (!pollData) return;
    _render(pollData);
  }, err => {
    document.getElementById('wvtBody').innerHTML =
      `<div class="wvt-empty"><div class="wvt-empty-ico">⚠️</div>Could not load</div>`;
  });

  function _render(poll) {
    const votes    = poll.votes || {};
    const options  = poll.options || [];
    const votedIds = Object.keys(votes);
    const allIds   = Object.keys(allProfiles);
    const notVotedIds = allIds.filter(uid =>
      !votedIds.includes(uid) && allProfiles[uid]?.profileComplete && !allProfiles[uid]?.banned
    );

    // Update summary numbers
    document.getElementById('wvtTotalNum').textContent  = votedIds.length + notVotedIds.length;
    document.getElementById('wvtVotedNum').textContent  = votedIds.length;
    document.getElementById('wvtPendingNum').textContent = notVotedIds.length;

    // Build tab definitions
    const tabDefs = [
      { key: 'all',      label: 'All',        icon: '📊', uids: [...votedIds, ...notVotedIds] },
      { key: 'voted',    label: 'Voted',      icon: '✅', uids: votedIds },
      { key: 'pending',  label: 'Not voted',  icon: '⏳', uids: notVotedIds },
      ...options.map((o, i) => ({
        key: `opt${i}`, label: o.text, icon: '·',
        uids: votedIds.filter(uid => {
          const v = votes[uid];
          return Array.isArray(v) ? v.includes(i) : v === i;
        }),
        optIdx: i,
      })),
    ];

    // (Re)build tabs only once; after that just update badges
    const tabsEl = document.getElementById('wvtTabs');
    if (!tabsEl.children.length) {
      tabDefs.forEach((t, i) => {
        const tab = document.createElement('button');
        tab.className = 'wvt-tab' + (i === activeTab ? ' active' : '');
        tab.dataset.tabIdx = i;
        const lbl = t.label.length > 13 ? t.label.slice(0, 12) + '…' : t.label;
        tab.innerHTML = `${_esc(lbl)} <span class="wvt-badge" id="wvtBadge${i}">${t.uids.length}</span>`;
        tab.addEventListener('click', () => { activeTab = i; _renderList(poll, tabDefs); });
        tabsEl.appendChild(tab);
      });
    } else {
      tabDefs.forEach((t, i) => {
        const badge = document.getElementById(`wvtBadge${i}`);
        if (badge) badge.textContent = t.uids.length;
      });
    }

    _renderList(poll, tabDefs);
  }

  function _renderList(poll, tabDefs) {
    const bodyEl = document.getElementById('wvtBody');
    if (!bodyEl) return;

    // Sync active tab highlight
    document.getElementById('wvtTabs')?.querySelectorAll('.wvt-tab').forEach((t, i) => {
      t.classList.toggle('active', i === activeTab);
    });

    const tab  = tabDefs[activeTab];
    const uids = tab ? tab.uids : [];
    const votes = poll.votes || {};
    const options = poll.options || [];

    // Apply search filter
    const filtered = uids.filter(uid => {
      if (!searchQ) return true;
      const name = (allProfiles[uid]?.name || '').toLowerCase();
      return name.includes(searchQ);
    });

    if (!filtered.length) {
      bodyEl.innerHTML = searchQ
        ? `<div class="wvt-empty"><div class="wvt-empty-ico">🔍</div>No matches for "${_esc(searchQ)}"</div>`
        : `<div class="wvt-empty"><div class="wvt-empty-ico">${tab?.key === 'pending' ? '🎉' : '🔕'}</div>${tab?.key === 'pending' ? 'Everyone voted!' : 'No votes yet'}</div>`;
      return;
    }

    // For "All" tab: show voted section first, then not-voted section
    let html = '';
    if (tab?.key === 'all') {
      const votedFiltered   = filtered.filter(uid => votes[uid] !== undefined);
      const pendingFiltered = filtered.filter(uid => votes[uid] === undefined);
      if (votedFiltered.length) {
        html += `<div class="wvt-section-lbl">✅ Voted (${votedFiltered.length})</div>`;
        html += votedFiltered.map((uid, i) => _voterRow(uid, votes, options, allProfiles, i, true)).join('');
      }
      if (pendingFiltered.length) {
        html += `<div class="wvt-section-lbl">⏳ Not voted yet (${pendingFiltered.length})</div>`;
        html += pendingFiltered.map((uid, i) => _voterRow(uid, votes, options, allProfiles, i, false)).join('');
      }
    } else {
      html = filtered.map((uid, i) =>
        _voterRow(uid, votes, options, allProfiles, i, votes[uid] !== undefined)
      ).join('');
    }

    bodyEl.innerHTML = html;
  }
}

/* ══════════════════════════════════════════════════════════════
   10b.  VOTER ROW builder (used by _openViewVotes)
══════════════════════════════════════════════════════════════ */
function _voterRow(uid, votes, options, profiles, delay, hasVoted) {
  const p     = profiles[uid] || {};
  const name  = p.name  || uid.slice(0, 8);
  const init  = (name[0] || '?').toUpperCase();
  const photo = p.photoURL || '';
  const role  = p.role  || '';

  // Build choice chips for what they voted for
  let choicesHTML = '';
  if (hasVoted && votes[uid] !== undefined) {
    const v = votes[uid];
    const picked = Array.isArray(v) ? v : [v];
    choicesHTML = `<div class="wvt-choices">${
      picked.map(idx => {
        const optText = options[idx]?.text || `Option ${idx + 1}`;
        const lbl = optText.length > 12 ? optText.slice(0, 11) + '…' : optText;
        return `<span class="wvt-choice-chip" title="${_esc(optText)}">${_esc(lbl)}</span>`;
      }).join('')
    }</div>`;
  } else {
    choicesHTML = `<div class="wvt-choices"><span class="wvt-pending-chip">Not voted</span></div>`;
  }

  const avContent = photo
    ? `<img src="${_esc(photo)}" alt="${_esc(init)}" onerror="this.style.display='none'">${init}`
    : init;

  return `<div class="wvt-row" style="animation-delay:${delay * 22}ms">
    <div class="wvt-av">
      ${avContent}
      <div class="wvt-av-dot ${hasVoted ? 'voted' : 'pending'}"></div>
    </div>
    <div class="wvt-info">
      <div class="wvt-name">${_esc(name)}</div>
      ${role ? `<div class="wvt-role">${_esc(role)}</div>` : ''}
    </div>
    ${choicesHTML}
  </div>`;
}

/* ══════════════════════════════════════════════════════════════
   11.  POLL CREATION MODAL
══════════════════════════════════════════════════════════════ */
function _openCreator(ctaText, onDone) {
  const ov = document.createElement('div');
  ov.className = 'wap-overlay';
  ov.innerHTML = `
    <div class="wap-sheet">
      <div class="wap-handle"></div>
      <div class="wap-sh-head">
        <div class="wap-sh-title">📊 New Poll</div>
        <button class="wap-sh-close">✕</button>
      </div>
      <div class="wap-sh-body">
        <span class="wap-field-lbl">Question</span>
        <textarea class="wap-q-input" rows="2" maxlength="240"
          placeholder="Ask something to the class…" id="wapQ"></textarea>
        <span class="wap-field-lbl">Options <em style="text-transform:none;letter-spacing:0;font-weight:400;font-size:.6rem">(2–10)</em></span>
        <div class="wap-opts-list" id="wapOpts">
          ${[1,2].map(n => `<div class="wap-opt-row">
            <div class="wap-opt-num">${n}</div>
            <input class="wap-opt-inp" type="text" placeholder="Option ${n}" maxlength="120">
            <button class="wap-opt-del" type="button">✕</button>
          </div>`).join('')}
        </div>
        <button class="wap-add-opt" id="wapAddOpt" type="button">＋ Add option</button>
        <div class="wap-settings">
          <div class="wap-setting">
            <div class="wap-set-info">
              <div class="wap-set-name">☑ Allow multiple answers</div>
              <div class="wap-set-hint">Each person can pick more than one option</div>
            </div>
            <label class="wap-toggle">
              <input type="checkbox" id="wapMulti">
              <div class="wap-tog-track"></div>
            </label>
          </div>
          <div class="wap-setting">
            <div class="wap-set-info">
              <div class="wap-set-name">⏱ Poll duration</div>
              <div class="wap-set-hint">Auto-close the poll after this period</div>
            </div>
            <select class="wap-dur-sel" id="wapDur">
              <option value="0">No limit</option>
              <option value="1">1 day</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
              <option value="14">2 weeks</option>
            </select>
          </div>
        </div>
      </div>
      <div class="wap-sh-foot">
        <button class="wap-btn-cancel" id="wapCancel">Cancel</button>
        <button class="wap-btn-primary" id="wapDone">${_esc(ctaText)}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const close = () => {
    ov.querySelector('.wap-sheet').style.transform = 'translateY(105%)';
    setTimeout(() => ov.remove(), 340);
  };
  ov.querySelector('.wap-sh-close').addEventListener('click', close);
  document.getElementById('wapCancel').addEventListener('click', close);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });

  const optList = document.getElementById('wapOpts');
  document.getElementById('wapAddOpt').addEventListener('click', () => {
    const rows = optList.querySelectorAll('.wap-opt-row');
    if (rows.length >= 10) { showToast('Maximum 10 options'); return; }
    const n = rows.length + 1;
    const row = document.createElement('div');
    row.className = 'wap-opt-row';
    row.innerHTML = `<div class="wap-opt-num">${n}</div>
      <input class="wap-opt-inp" type="text" placeholder="Option ${n}" maxlength="120">
      <button class="wap-opt-del" type="button">✕</button>`;
    optList.appendChild(row);
    _bindDel(row.querySelector('.wap-opt-del'), optList);
    row.querySelector('.wap-opt-inp').focus();
  });
  optList.querySelectorAll('.wap-opt-del').forEach(b => _bindDel(b, optList));

  document.getElementById('wapDone').addEventListener('click', () => {
    const q = document.getElementById('wapQ').value.trim();
    if (!q) { showToast('Please enter a question'); return; }
    const opts = [...optList.querySelectorAll('.wap-opt-inp')]
      .map(i => i.value.trim()).filter(Boolean);
    if (opts.length < 2) { showToast('Need at least 2 options'); return; }
    const days = parseInt(document.getElementById('wapDur').value || '0');
    onDone({
      question:      q,
      options:       opts.map(t => ({ text: t })),
      votes:         {},
      allowMultiple: document.getElementById('wapMulti').checked,
      expiresAt:     days > 0 ? new Date(Date.now() + days * 86400000) : null,
      createdBy:     currentUser?.uid || '',
    });
    close();
  });
}

function _bindDel(btn, list) {
  btn.addEventListener('click', () => {
    if (list.querySelectorAll('.wap-opt-row').length <= 2) { showToast('Minimum 2 options'); return; }
    btn.closest('.wap-opt-row').remove();
    list.querySelectorAll('.wap-opt-num').forEach((el, i) => el.textContent = i + 1);
  });
}

/* ══════════════════════════════════════════════════════════════
   12.  INJECT UI BUTTONS (after auth)
══════════════════════════════════════════════════════════════ */
onAuthChange((user, profile) => {
  if (!user || !profile?.profileComplete || profile.banned) return;

  // Retry loop: postMediaRow appears dynamically after auth
  const tryInjectPost = () => {
    if (document.getElementById('wapPollPostBtn')) return;
    const row = document.getElementById('postMediaRow');
    if (!row) { setTimeout(tryInjectPost, 300); return; }
    const btn = document.createElement('button');
    btn.id = 'wapPollPostBtn';
    btn.type = 'button';
    btn.className = 'wap-post-poll-btn';
    btn.textContent = '📊 Poll';
    btn.addEventListener('click', () => {
      if (_pendingPoll) {
        _pendingPoll = null;
        btn.textContent = '📊 Poll';
        btn.classList.remove('on');
        showToast('Poll removed');
      } else {
        _openCreator('Attach to Post', data => {
          _pendingPoll = data;
          btn.textContent = '✓ Poll attached';
          btn.classList.add('on');
          showToast('Poll attached — click Share Post ✦');
        });
      }
    });
    row.appendChild(btn);
  };
  tryInjectPost();

  // Chat poll button
  const tryInjectChat = () => {
    if (document.getElementById('wapPollChatBtn')) return;
    const bar = document.querySelector('#msgGroupPanel .chat-input-bar');
    if (!bar) { setTimeout(tryInjectChat, 300); return; }
    const btn = document.createElement('button');
    btn.id = 'wapPollChatBtn';
    btn.type = 'button';
    btn.className = 'wap-chat-poll-btn';
    btn.title = 'Create Poll';
    btn.textContent = '📊';
    btn.addEventListener('click', () => {
      if (!currentUser) { showToast('Login to create polls'); return; }
      _openCreator('Post Poll to Chat', async data => {
        try {
          await addDoc(collection(db, 'groupMessages'), {
            type:      'poll',
            poll:      data,
            name:      currentProfile?.name || 'Anonymous',
            role:      currentProfile?.role  || '',
            uid:       currentUser.uid,
            timestamp: serverTimestamp(),
          });
          showToast('Poll sent! 📊');
        } catch(e) { showToast('Error: ' + e.message); }
      });
    });
    const send = bar.querySelector('#groupSendBtn');
    bar.insertBefore(btn, send);
  };
  tryInjectChat();
});

/* ══════════════════════════════════════════════════════════════
   13.  HELPERS
══════════════════════════════════════════════════════════════ */
function _makeRef(docId, colName) {
  if (!colName || !docId) return null;
  const p = colName.split('/');
  if (p.length === 1) return doc(db, p[0], docId);
  if (p.length === 3) return doc(db, p[0], p[1], p[2], docId);
  return null;
}
function _extractTime(data) {
  const ts = data.timestamp || data.createdAt;
  if (!ts?.toDate) return '';
  return ts.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function _esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _fmtDate(ts) {
  try { return (ts.toDate?.() || new Date(ts)).toLocaleDateString('en-IN',{day:'numeric',month:'short'}); }
  catch { return ''; }
}
